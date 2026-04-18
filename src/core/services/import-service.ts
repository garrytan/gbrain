import { execFileSync } from 'child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { cpus, homedir, totalmem } from 'os';
import { dirname, join, relative } from 'path';
import type { BrainEngine } from '../engine.ts';
import { loadConfig } from '../config.ts';
import { createConnectedEngine, supportsParallelWorkers } from '../engine-factory.ts';
import { getEngineCapabilities } from '../engine-capabilities.ts';
import { buildPageChunks, importFile } from '../import-file.ts';
import { parseMarkdown, type ParsedMarkdown } from '../markdown.ts';
import { slugifyPath } from '../sync.ts';
import type { ChunkInput } from '../types.ts';
import { importContentHash, validateSlug } from '../utils.ts';

export interface ImportRunOptions {
  rootDir: string;
  noEmbed?: boolean;
  workers?: number;
  fresh?: boolean;
  checkpointPath?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface ImportCheckpoint {
  dir: string;
  totalFiles: number;
  processedIndex: number;
  completedFiles?: number;
  timestamp: string;
}

export type ImportEvent =
  | { type: 'imported'; slug: string; chunks: number }
  | { type: 'skipped'; reason?: string }
  | { type: 'error'; message: string };

export interface ImportRunSummary {
  durationSeconds: number;
  imported: number;
  skipped: number;
  errors: number;
  unchanged: number;
  chunksCreated: number;
  totalFiles: number;
  importedSlugs: string[];
}

export interface ImportPlan {
  allFiles: string[];
  files: string[];
  resumeIndex: number;
  resumed: boolean;
}

type PreparedImport =
  | {
      status: 'ready';
      filePath: string;
      relativePath: string;
      slug: string;
      parsed: ParsedMarkdown;
      hash: string;
      chunks: ChunkInput[];
    }
  | {
      status: 'skipped';
      filePath: string;
      relativePath: string;
      slug: string;
      error?: string;
      prepareFailed?: boolean;
    };

interface ImportServiceDeps {
  createConnectedEngine: typeof createConnectedEngine;
  importFile: typeof importFile;
  prepareImportFile: typeof prepareImportFile;
  commitPreparedImport: typeof commitPreparedImport;
  loadConfig: typeof loadConfig;
  getEngineCapabilities: typeof getEngineCapabilities;
  supportsParallelWorkers: typeof supportsParallelWorkers;
}

const DEFAULT_DEPS: ImportServiceDeps = {
  createConnectedEngine,
  importFile,
  prepareImportFile,
  commitPreparedImport,
  loadConfig,
  getEngineCapabilities,
  supportsParallelWorkers,
};

const MAX_FILE_SIZE = 5_000_000;

async function prepareImportFile(
  filePath: string,
  relativePath: string,
): Promise<PreparedImport> {
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    return { status: 'skipped', filePath, relativePath, slug: relativePath, error: `Skipping symlink: ${filePath}` };
  }

  const stat = lstatSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    return {
      status: 'skipped',
      filePath,
      relativePath,
      slug: relativePath,
      error: `File too large (${stat.size} bytes)`,
    };
  }

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseMarkdown(content, relativePath);
  const expectedSlug = slugifyPath(relativePath);
  let canonicalParsedSlug: string;
  try {
    canonicalParsedSlug = slugifyPath(validateSlug(parsed.slug));
  } catch {
    canonicalParsedSlug = parsed.slug;
  }

  if (canonicalParsedSlug !== expectedSlug) {
    return {
      status: 'skipped',
      filePath,
      relativePath,
      slug: expectedSlug,
      error:
        `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expectedSlug}" ` +
        `(from ${relativePath}). Remove the frontmatter "slug:" line or move the file.`,
    };
  }

  return {
    status: 'ready',
    filePath,
    relativePath,
    slug: expectedSlug,
    parsed,
    hash: importContentHash(parsed),
    chunks: buildPageChunks(parsed.compiled_truth, parsed.timeline, parsed.frontmatter),
  };
}

async function commitPreparedImport(
  engine: BrainEngine,
  prepared: PreparedImport,
): Promise<Awaited<ReturnType<typeof importFile>>> {
  if (prepared.status !== 'ready') {
    return {
      slug: prepared.slug,
      status: 'skipped',
      chunks: 0,
      error: prepared.error,
    };
  }

  const existing = await engine.getPage(prepared.slug);
  if (existing?.content_hash === prepared.hash) {
    return { slug: prepared.slug, status: 'skipped', chunks: 0 };
  }

  await engine.transaction(async (tx) => {
    if (existing) {
      await tx.createVersion(prepared.slug);
    }

    await tx.putPage(prepared.slug, {
      type: prepared.parsed.type,
      title: prepared.parsed.title,
      compiled_truth: prepared.parsed.compiled_truth,
      timeline: prepared.parsed.timeline || '',
      frontmatter: prepared.parsed.frontmatter,
      content_hash: prepared.hash,
    });

    const existingTags = await tx.getTags(prepared.slug);
    const newTags = new Set(prepared.parsed.tags);
    for (const old of existingTags) {
      if (!newTags.has(old)) {
        await tx.removeTag(prepared.slug, old);
      }
    }
    for (const tag of prepared.parsed.tags) {
      await tx.addTag(prepared.slug, tag);
    }

    await tx.deleteChunks(prepared.slug);
    await tx.upsertChunks(prepared.slug, prepared.chunks);
  });

  return {
    slug: prepared.slug,
    status: 'imported',
    chunks: prepared.chunks.length,
  };
}

export function defaultImportWorkers(): number {
  const cpuCount = cpus().length;
  const memGB = totalmem() / (1024 ** 3);
  const byPool = 8;
  const byCpu = Math.max(2, cpuCount);
  const byMem = Math.floor(memGB * 2);
  return Math.min(byPool, byCpu, byMem);
}

export function defaultImportCheckpointPath(): string {
  return join(homedir(), '.mbrain', 'import-checkpoint.json');
}

export function readImportCheckpoint(checkpointPath = defaultImportCheckpointPath()): ImportCheckpoint | null {
  if (!existsSync(checkpointPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(checkpointPath, 'utf-8')) as ImportCheckpoint;
  } catch {
    return null;
  }
}

export function resolveImportPlan(input: {
  rootDir: string;
  allFiles: string[];
  fresh?: boolean;
  checkpoint?: ImportCheckpoint | null;
}): ImportPlan {
  const { rootDir, allFiles, fresh = false, checkpoint } = input;

  if (
    !fresh &&
    checkpoint &&
    checkpoint.dir === rootDir &&
    checkpoint.totalFiles === allFiles.length
  ) {
    const resumeIndex = Math.max(0, Math.min(checkpoint.processedIndex, allFiles.length));
    return {
      allFiles,
      files: allFiles.slice(resumeIndex),
      resumeIndex,
      resumed: true,
    };
  }

  return {
    allFiles,
    files: allFiles,
    resumeIndex: 0,
    resumed: false,
  };
}

export function collectImportSummary(input: {
  totalFiles: number;
  events: ImportEvent[];
}): ImportRunSummary {
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let chunksCreated = 0;
  const importedSlugs: string[] = [];

  for (const event of input.events) {
    if (event.type === 'imported') {
      imported++;
      chunksCreated += event.chunks;
      importedSlugs.push(event.slug);
      continue;
    }

    skipped++;
    if (event.type === 'error') {
      errors++;
    }
  }

  return {
    durationSeconds: 0,
    imported,
    skipped,
    errors,
    unchanged: skipped - errors,
    chunksCreated,
    totalFiles: input.totalFiles,
    importedSlugs,
  };
}

export async function runImportService(
  engine: BrainEngine,
  options: ImportRunOptions,
  deps: ImportServiceDeps = DEFAULT_DEPS,
): Promise<ImportRunSummary> {
  const logger = options.logger ?? console;
  const allFiles = collectMarkdownFiles(options.rootDir);
  logger.log(`Found ${allFiles.length} markdown files`);

  const checkpointPath = options.checkpointPath ?? defaultImportCheckpointPath();
  const checkpoint = options.fresh ? null : readImportCheckpoint(checkpointPath);
  const plan = resolveImportPlan({
    rootDir: options.rootDir,
    allFiles,
    fresh: options.fresh,
    checkpoint,
  });

  if (plan.resumed) {
    logger.log(`Resuming from checkpoint: skipping ${plan.resumeIndex} already-processed files`);
  }

  const actualWorkers = Math.max(1, options.workers ?? defaultImportWorkers());

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;
  let chunksCreated = 0;
  const importedSlugs: string[] = [];
  const errorCounts: Record<string, number> = {};
  const startTime = Date.now();

  const logProgress = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = elapsed > 0 ? Math.round(processed / elapsed) : 0;
    const remaining = rate > 0 ? Math.round((plan.files.length - processed) / rate) : 0;
    const pct = plan.files.length === 0 ? 100 : Math.round((processed / plan.files.length) * 100);
    logger.log(
      `[mbrain import] ${processed}/${plan.files.length} (${pct}%) | ${rate} files/sec | imported: ${imported} | skipped: ${skipped} | errors: ${errors} | ETA: ${remaining}s`,
    );
  };

  const writeCheckpoint = () => {
    try {
      const cpDir = dirname(checkpointPath);
      if (!existsSync(cpDir)) {
        mkdirSync(cpDir, { recursive: true });
      }
      writeFileSync(checkpointPath, JSON.stringify({
        dir: options.rootDir,
        totalFiles: allFiles.length,
        processedIndex: plan.resumeIndex + processed,
        completedFiles: importedSlugs.length + skipped,
        timestamp: new Date().toISOString(),
      }));
    } catch {
      // Non-fatal.
    }
  };

  const finalizeImportResult = (relativePath: string, result: Awaited<ReturnType<typeof importFile>>) => {
    if (result.status === 'imported') {
      imported++;
      chunksCreated += result.chunks;
      importedSlugs.push(result.slug);
    } else {
      skipped++;
      if (result.error && result.error !== 'unchanged') {
        logger.error(`  Skipped ${relativePath}: ${result.error}`);
      }
    }

    processed++;
    if (processed % 100 === 0 || processed === plan.files.length) {
      logProgress();
      if (processed % 100 === 0) {
        writeCheckpoint();
      }
    }
  };

  const finalizeImportError = (relativePath: string, message: string) => {
    const errorKey = message.replace(/"[^"]*"/g, '""');
    errorCounts[errorKey] = (errorCounts[errorKey] || 0) + 1;
    if (errorCounts[errorKey] <= 5) {
      logger.error(`  Warning: skipped ${relativePath}: ${message}`);
    } else if (errorCounts[errorKey] === 6) {
      logger.error(`  (suppressing further "${errorKey.slice(0, 60)}..." errors)`);
    }
    errors++;
    skipped++;

    processed++;
    if (processed % 100 === 0 || processed === plan.files.length) {
      logProgress();
      if (processed % 100 === 0) {
        writeCheckpoint();
      }
    }
  };

  const processFile = async (activeEngine: BrainEngine, filePath: string) => {
    const relativePath = relative(options.rootDir, filePath);
    try {
      const result = await deps.importFile(activeEngine, filePath, relativePath, { noEmbed: options.noEmbed });
      finalizeImportResult(relativePath, result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      finalizeImportError(relativePath, message);
    }
  };

  if (actualWorkers > 1) {
    const config = deps.loadConfig();
    if (!config) {
      throw new Error('No brain configured. Run: mbrain init or set MBRAIN_DATABASE_URL / DATABASE_URL.');
    }

    const capabilities = deps.getEngineCapabilities(config);

    if (capabilities.parallelWorkers) {
      logger.log(`Using ${actualWorkers} parallel workers`);
      const workerEngines = await Promise.all(
        Array.from({ length: actualWorkers }, async () => deps.createConnectedEngine(config, { poolSize: 2 })),
      );

      let queueIndex = 0;
      await Promise.all(workerEngines.map(async (workerEngine) => {
        while (true) {
          const index = queueIndex++;
          if (index >= plan.files.length) break;
          await processFile(workerEngine, plan.files[index]);
        }
      }));

      await Promise.all(workerEngines.map(async (workerEngine) => workerEngine.disconnect()));
    } else if (capabilities.stagedImportConcurrency) {
      logger.log(`Using ${actualWorkers} staged import workers`);
      for (let batchStart = 0; batchStart < plan.files.length; batchStart += actualWorkers) {
        const batchFiles = plan.files.slice(batchStart, batchStart + actualWorkers);
        const preparedResults = new Array<PreparedImport>(batchFiles.length);
        let queueIndex = 0;
        await Promise.all(
          Array.from({ length: Math.min(actualWorkers, batchFiles.length) }, async () => {
            while (true) {
              const index = queueIndex++;
              if (index >= batchFiles.length) {
                break;
              }
              const filePath = batchFiles[index];
              const relativePath = relative(options.rootDir, filePath);
              try {
                preparedResults[index] = await deps.prepareImportFile(filePath, relativePath);
              } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                preparedResults[index] = {
                  status: 'skipped',
                  filePath,
                  relativePath,
                  slug: relativePath,
                  error: message,
                  prepareFailed: true,
                };
              }
            }
          }),
        );

        for (let index = 0; index < preparedResults.length; index++) {
          const prepared = preparedResults[index];
          const relativePath = relative(options.rootDir, batchFiles[index]);
          if (prepared.status !== 'ready') {
            if (prepared.prepareFailed) {
              finalizeImportError(relativePath, prepared.error ?? 'prepare failed');
            } else {
              finalizeImportResult(relativePath, {
                slug: prepared.slug,
                status: 'skipped',
                chunks: 0,
                error: prepared.error,
              });
            }
            continue;
          }
          try {
            const result = await deps.commitPreparedImport(engine, prepared);
            finalizeImportResult(relativePath, result);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            finalizeImportError(relativePath, message);
          }
        }
      }
    } else {
      for (const filePath of plan.files) {
        await processFile(engine, filePath);
      }
    }
  } else {
    for (const filePath of plan.files) {
      await processFile(engine, filePath);
    }
  }

  for (const [errorMessage, count] of Object.entries(errorCounts)) {
    if (count > 5) {
      logger.error(`  ${count} files failed: ${errorMessage.slice(0, 100)}`);
    }
  }

  if (errors === 0 && existsSync(checkpointPath)) {
    try {
      unlinkSync(checkpointPath);
    } catch {
      // Non-fatal.
    }
  } else if (errors > 0 && existsSync(checkpointPath)) {
    logger.log(`  Checkpoint preserved (${errors} errors). Run again to retry failed files.`);
  }

  await updateImportGitState(engine, options.rootDir);

  return {
    durationSeconds: Number(((Date.now() - startTime) / 1000).toFixed(1)),
    imported,
    skipped,
    errors,
    unchanged: skipped - errors,
    chunksCreated,
    totalFiles: allFiles.length,
    importedSlugs,
  };
}

async function updateImportGitState(engine: BrainEngine, rootDir: string) {
  try {
    if (!existsSync(join(rootDir, '.git'))) {
      return;
    }

    const head = execFileSync('git', ['-C', rootDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    await engine.setConfig('sync.last_commit', head);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await engine.setConfig('sync.repo_path', rootDir);
  } catch {
    // Not a git repo or git not available, skip sync metadata.
  }
}

export function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  const rootStat = lstatSync(dir);
  if (rootStat.isSymbolicLink()) {
    console.warn(`[mbrain import] Skipping symlinked import root: ${dir}`);
    return files;
  }

  const walk = (currentDir: string) => {
    for (const entry of readdirSync(currentDir)) {
      if (entry.startsWith('.')) continue;
      if (entry === 'node_modules') continue;

      const fullPath = join(currentDir, entry);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        console.warn(`[mbrain import] Skipping unreadable path: ${fullPath}`);
        continue;
      }

      if (stat.isSymbolicLink()) {
        console.warn(`[mbrain import] Skipping symlink: ${fullPath}`);
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith('.md') || entry.endsWith('.mdx')) {
        files.push(fullPath);
      }
    }
  };

  walk(dir);
  return files.sort();
}
