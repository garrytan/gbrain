import { readdirSync, lstatSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join, relative, resolve, isAbsolute } from 'path';
import { cpus, totalmem } from 'os';
import type { BrainEngine } from '../core/engine.ts';
import { importFile, importImageFile, isImageFilePath } from '../core/import-file.ts';
import type { SyncFileRuntime, SyncFileOptions } from '../core/sync-file-runtime.ts';
import { importOfficeFile, isOfficeFilePath } from '../core/office-import.ts';
import { importSessionExport, isSessionExportPath } from '../core/conversation-parser/session-import.ts';
import { loadConfig, gbrainPath } from '../core/config.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import {
  isCodeFilePath,
  isMarkdownFilePath,
  isImageFilePath as isImageFilePathFromSync,
  isOfficeTransientFile,
  type SyncStrategy,
  matchesAnyGlob,
} from '../core/sync.ts';
import { sortNewestFirst } from '../core/sort-newest-first.ts';
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  resumeFilter,
} from '../core/import-checkpoint.ts';
import {
  loadOpCheckpoint,
  recordCompleted as recordOpCompleted,
  clearOpCheckpoint,
  type OpCheckpointKey,
} from '../core/op-checkpoint.ts';
import {
  GIN_REPAIR_FAILED_MESSAGE,
  GinIndexUnusableError,
  isGinCorruptionError,
  repairPgliteGinIndexes,
} from '../core/pglite-gin-repair.ts';

function defaultWorkers(): number {
  const cpuCount = cpus().length;
  const memGB = totalmem() / (1024 ** 3);
  // Network-bound, so we can go higher than CPU count.
  // Cap by: DB pool (leave 2 for other queries), CPU, memory.
  const byPool = 8;
  const byCpu = Math.max(2, cpuCount);
  const byMem = Math.floor(memGB * 2);
  return Math.min(byPool, byCpu, byMem);
}

/** Bug 9 — surface per-file failures so callers (performFullSync) can gate state advances. */
export interface RunImportResult {
  imported: number;
  skipped: number;
  errors: number;
  chunksCreated: number;
  failures: Array<{ path: string; error: string }>;
  /**
   * Slugs successfully imported this run (status imported/partial).
   * Downstream Quick/Full extract must keep processing these even when
   * other files failed and last_commit is not advanced.
   */
  importedSlugs: string[];
}

export interface ImportOptions {
    fileRuntime?: SyncFileRuntime;
    commit?: string;
    strategy?: SyncStrategy;
    sourceId?: string;
    checkpointKey?: OpCheckpointKey;
    /** Sync owns failure gating and bookmark advancement for this import. */
    managedBookmark?: boolean;
    /** Sync exclusion globs, matched against the import-root-relative path. */
    exclude?: string[];
    runtime?: {
      signal: AbortSignal;
      onFile: (result: Record<string, unknown>) => Promise<void>;
      beforeFile?: (path: string) => Promise<void>;
      completedPaths?: string[];
    };
}

export interface StructuredImportInput {
  path?: string;
  noEmbed?: boolean;
  fresh?: boolean;
  jsonOutput?: boolean;
  reportFiles?: boolean;
  includeOffice?: boolean;
  documentOcr?: boolean;
  includeImages?: boolean;
  structuredDocuments?: boolean;
  sourceId?: string;
  workers?: string;
}

export async function importSyncFile(engine: BrainEngine, path: string, relativePath: string, options: SyncFileOptions) {
  if (options.session && isSessionExportPath(relativePath)) return importSessionExport(engine, path, relativePath, options);
  if (options.includeImages && isImageFilePath(relativePath)) return importImageFile(engine, path, relativePath, { ...options, forceOcr: options.documentOcr });
  if (options.includeOffice && isOfficeFilePath(relativePath)) return importOfficeFile(engine, path, relativePath, options);
  return importFile(engine, path, relativePath, options);
}

export function runImport(engine: BrainEngine, args: string[], opts: ImportOptions = {}): Promise<RunImportResult> {
  const sourceIdIdx = args.indexOf('--source-id');
  const workersIdx = args.indexOf('--workers');
  const flagValues = new Set<number>();
  if (workersIdx !== -1) flagValues.add(workersIdx + 1);
  if (sourceIdIdx !== -1) flagValues.add(sourceIdIdx + 1);
  return runStructuredImport(engine, {
    path: args.find((a, i) => !a.startsWith('--') && !flagValues.has(i)),
    noEmbed: args.includes('--no-embed'),
    fresh: args.includes('--fresh'),
    jsonOutput: args.includes('--json'),
    reportFiles: args.includes('--report-files'),
    includeOffice: args.includes('--include-office'),
    documentOcr: args.includes('--document-ocr'),
    includeImages: args.includes('--include-images'),
    structuredDocuments: !args.includes('--legacy-document-parser'),
    sourceId: sourceIdIdx !== -1 ? args[sourceIdIdx + 1] : undefined,
    workers: workersIdx !== -1 ? args[workersIdx + 1] : undefined,
  }, opts);
}

export async function runStructuredImport(
  engine: BrainEngine,
  input: StructuredImportInput,
  opts: ImportOptions = {},
): Promise<RunImportResult> {
  const noEmbed = input.noEmbed === true;
  const fresh = input.fresh === true;
  const jsonOutput = input.jsonOutput === true;
  const reportFiles = input.reportFiles === true;
  const includeOffice = input.includeOffice === true;
  const gateway = await import('../core/ai/gateway.ts');
  const documentOcr = input.documentOcr === true || gateway.isOcrEnabled();
  const includeImages = input.includeImages === true || documentOcr;
  const structuredDocuments = input.structuredDocuments !== false;

  // T7 (D9): refuse cleanly when init persisted the deferred-setup sentinel,
  // unless the user is explicitly skipping embedding via `--no-embed` (in
  // which case the chunks land without vectors and the user can backfill
  // later with `gbrain embed --stale` after configuring a provider).
  if (!noEmbed) {
    const { assertEmbeddingEnabled } = await import('../core/embedding-dim-check.ts');
    const {
      assertNoEmbeddingEnvConfigDrift,
      loadConfig,
    } = await import('../core/config.ts');
    try {
      assertEmbeddingEnabled(loadConfig());
      assertNoEmbeddingEnvConfigDrift();
    } catch (e) {
      console.error(`\n${e instanceof Error ? e.message : e}`);
      console.error('Tip: run `gbrain import <dir> --no-embed` to import without embedding now.');
      if (opts.runtime) throw e;
      process.exit(1);
    }

    // v0.41.6.0 D1: preflight embedding credentials. Closes the bug class
    // where `gbrain import` per-file embed writes N identical
    // "missing OPENAI_API_KEY" failures into sync-failures.jsonl.
    const { validateEmbeddingCreds, EmbeddingCredentialError } = await import('../core/embed-preflight.ts');
    try {
      validateEmbeddingCreds();
    } catch (e) {
      if (e instanceof EmbeddingCredentialError) {
        if (jsonOutput) {
          console.log(JSON.stringify({ status: 'embedding_credentials_missing', diagnosis: e.diagnosis }));
        } else {
          console.error('');
          console.error(e.userMessage);
          console.error('');
        }
        if (opts.runtime) throw e;
        process.exit(1);
      }
      throw e;
    }
  }
  // v0.39 T1.5: load active pack ONCE at runImport entry; thread to every
  // per-file importFile call below. Codex perf finding #7 — never per-file.
  let importActivePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined;
  try {
    const { loadActivePack } = await import('../core/schema-pack/load-active.ts');
    const { loadConfig } = await import('../core/config.ts');
    const resolved = await loadActivePack({
      cfg: loadConfig(),
      remote: false, // CLI import is trusted
      sourceId: opts.sourceId,
    });
    importActivePack = { page_types: resolved.manifest.page_types };
  } catch {
    importActivePack = undefined;
  }

  // v0.30.x follow-up to PR #707: programmatic sourceId support so internal
  // callers (performFullSync, future Step 6 paths) can route to a named
  // source.
  //
  // v0.37.7.0 #1167+#1222: the CLI surface now also accepts a
  // `--source-id <id>` flag (named to avoid colliding with `--source`
  // which other commands use for different axes). Pre-fix, users
  // passing `gbrain import --source dept-x ...` silently fell back to
  // default because the parser ignored the flag. Now an explicit
  // `--source-id <id>` opt-in routes the import to that source.
  // Programmatic callers continue passing `opts.sourceId` directly;
  // CLI callers' flag wins over opts when both are set.
  let sourceId: string | undefined = input.sourceId ?? opts.sourceId;

  // v0.41.13 (#1434): when no explicit source / env / opts.sourceId is set,
  // fall through to the resolver so the new sole_non_default tier (5.5) can
  // auto-route to the only registered non-default source. Pre-fix, import
  // followed the explicit-only design from PR #707 and silently routed
  // every import to 'default', mirroring the sync bug class.
  //
  // Resolution chain (full 7 tiers): flag → env → dotfile → local_path →
  // brain_default → sole_non_default → seed_default. The nudge fires only
  // when the resolver returns tier='sole_non_default', so explicit users
  // see no behavior change.
  if (!sourceId && process.env.PMBRAIN_SOURCE) {
    const { resolveSourceId } = await import('../core/source-resolver.ts');
    sourceId = await resolveSourceId(engine, null);
  } else if (!sourceId) {
    const { resolveMainSourceId } = await import('../core/source-resolver.ts');
    sourceId = await resolveMainSourceId(engine);
  }
  // v0.22.13 (PR #490 Q2): shared parseWorkers helper rejects bad input
  // (--workers 0, -3, "foo") with a loud error instead of silently falling
  // through to 1. Mirrors sync.ts's flag handling.
  const { parseWorkers } = await import('../core/sync-concurrency.ts');
  let workerCount: number;
  try {
    workerCount = parseWorkers(input.workers) ?? 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    if (opts.runtime) throw e;
    process.exit(1);
  }
  // Find dir: first non-flag arg that isn't a value for --workers
  const dirArg = input.path;

  if (!dirArg) {
    if (opts.runtime) throw new Error('Import path is required');
    console.error('Usage: gbrain import <dir> [--no-embed] [--workers N] [--fresh] [--source-id <id>] [--include-office] [--include-images] [--document-ocr] [--legacy-document-parser] [--json]');
    process.exit(1);
  }
  let dir: string = dirArg;  // narrowed; survives closure capture
  let sourceType: 'directory' | 'file' = 'directory';

  // v0.31.2: collect under the right strategy. Pre-fix this called
  // collectMarkdownFiles unconditionally — code-strategy first sync
  // silently no-op'd because no code file ever made it through walker
  // enumeration (codex C11 confirms dispatch was correct; bug was here).
  const strategy: SyncStrategy = opts.strategy ?? 'markdown';
  const _walkT0 = Date.now();
  console.error(`[pmbrain phase] import.collect_files start target=${dirArg} strategy=${strategy}`);
  let allFiles: string[];
  try {
    const stat = lstatSync(dirArg);
    if (stat.isFile()) {
      sourceType = 'file';
      dir = dirname(dirArg);
      allFiles = (strategy !== 'code' && isSessionExportPath(dirArg)) || isCollectibleForWalker(
        dirArg,
        strategy,
        includeImages || (process.env.PMBRAIN_EMBEDDING_MULTIMODAL ?? process.env.GBRAIN_EMBEDDING_MULTIMODAL) === 'true',
        includeOffice,
      )
        ? [dirArg]
        : [];
    } else {
      allFiles = collectSyncableFiles(dir, {
        strategy, includeOffice, includeImages, includeSessions: strategy !== 'code',
      });
    }
  } catch (error) {
    if (opts.runtime) throw error;
    allFiles = collectSyncableFiles(dir, {
      strategy, includeOffice, includeImages, includeSessions: strategy !== 'code',
    });
  }
  console.error(
    `[pmbrain phase] import.collect_files done ${Date.now() - _walkT0}ms files=${allFiles.length}`,
  );
  if (opts.exclude?.length) {
    const before = allFiles.length;
    allFiles = allFiles.filter(path => !matchesAnyGlob(relative(dir, path), opts.exclude));
    if (before > 0 && allFiles.length === 0) {
      console.warn(`[pmbrain sync] No files matched after applying ${opts.exclude.length} exclude pattern(s).`);
    }
  }
  const fileTypeLabel = strategy === 'code' ? 'code'
    : strategy === 'auto' ? 'syncable' : 'markdown';
  console.log(`Found ${allFiles.length} ${fileTypeLabel} files`);

  // Sort newest-first so date-prefixed brain paths get embedded before older ones.
  // See src/core/sort-newest-first.ts for the policy.
  sortNewestFirst(allFiles);
  const importRoot = await resolveImportRoot(engine, sourceId, dir, allFiles);

  // Resume from checkpoint if available. v0.33.2: path-based resume —
  // see src/core/import-checkpoint.ts for the bug-class this fixes
  // (parallel-import silent-skip and failed-file no-retry).
  const checkpointPath = gbrainPath('import-checkpoint.json');
  const completed = new Set<string>(opts.runtime?.completedPaths ?? []);
  if (!fresh) {
    if (opts.checkpointKey) {
      for (const path of await loadOpCheckpoint(engine, opts.checkpointKey)) completed.add(path);
    } else {
      const cp = loadCheckpoint(checkpointPath, importRoot);
      if (cp) for (const path of cp.completedPaths) completed.add(path);
    }
    if (completed.size > 0) {
      console.log(`Resuming from checkpoint: skipping ${completed.size} already-processed files`);
    }
  }
  const files = resumeFilter(allFiles, importRoot, completed);

  // Determine actual worker count
  const actualWorkers = workerCount > 1 ? workerCount : 1;
  if (actualWorkers > 1) {
    console.log(`Using ${actualWorkers} parallel workers`);
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;
  let chunksCreated = 0;
  const importedSlugs: string[] = [];
  const errorCounts: Record<string, number> = {};
  const failures: Array<{ path: string; error: string }> = []; // Bug 9
  const startTime = Date.now();
  let ginRepaired = false;

  // Progress on stderr so stdout stays clean for the final summary / --json payload.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('import.files', files.length);

  function tickProgress() {
    progress.tick(1, `imported=${imported} skipped=${skipped} errors=${errors}`);
  }

  function reportFile(result: {
    status: 'imported' | 'partial' | 'unchanged' | 'failed';
    path: string;
    chunks?: number;
    bytes?: number;
    reason?: string;
    vectorized?: boolean;
    document?: import('../core/document/types.ts').DocumentImportSummary;
    largeDocument?: import('../core/document/trusted-large-document.ts').LargeDocumentProgress;
  }) {
    if (reportFiles) console.error(`[pmbrain import-file] ${JSON.stringify(result)}`);
  }

  async function processFile(eng: BrainEngine, filePath: string) {
    opts.runtime?.signal.throwIfAborted();
    await opts.runtime?.beforeFile?.(filePath);
    const relativePath = relative(importRoot, filePath);
    if (isOfficeTransientFile(filePath) || isOfficeTransientFile(relativePath)) {
      processed++;
      tickProgress();
      return;
    }
    // v0.31.2 (D5): per-file slow-path log. Fires only when a single
    // file takes >5s. The user's hang surfaces as one file taking
    // forever — without this, the agent can't see which file.
    const _fileT0 = Date.now();
    try {
      // v0.27.1 (F2): dispatch image extensions to importImageFile when
      // multimodal is enabled. The walker (collectMarkdownFiles) only picks
      // up images when GBRAIN_EMBEDDING_MULTIMODAL=true so this branch is
      // unreachable when the gate is off; defense-in-depth check anyway.
      const imageImportEnabled = includeImages || (process.env.PMBRAIN_EMBEDDING_MULTIMODAL ?? process.env.GBRAIN_EMBEDDING_MULTIMODAL) === 'true';
      const result = opts.fileRuntime
        ? await opts.fileRuntime.importFile(filePath, relativePath, { noEmbed, sourceId, includeOffice, includeImages: imageImportEnabled, documentOcr, structured: structuredDocuments, session: sourceType === 'file' && strategy !== 'code', activePack: importActivePack })
        : sourceType === 'file' && strategy !== 'code' && isSessionExportPath(relativePath)
        ? await importSessionExport(eng, filePath, relativePath, { noEmbed, sourceId })
        : isImageFilePath(relativePath) && imageImportEnabled
        ? await importImageFile(eng, filePath, relativePath, { noEmbed, sourceId, forceOcr: documentOcr })
        : includeOffice && isOfficeFilePath(relativePath)
          ? await importOfficeFile(eng, filePath, relativePath, {
              noEmbed,
              sourceId,
              structured: structuredDocuments,
              documentOcr,
              activePack: importActivePack,
            })
        : await importFile(eng, filePath, relativePath, { noEmbed, sourceId, activePack: importActivePack });
      const _fileMs = Date.now() - _fileT0;
      if ('deferred' in result && result.deferred) { processed++; tickProgress(); return; }
      opts.runtime?.signal.throwIfAborted();
      if (_fileMs > 5000) {
        console.error(`[pmbrain phase] import.process_file slow ${_fileMs}ms ${relativePath}`);
      }
      if (result.status === 'imported') {
        imported++;
        chunksCreated += result.chunks;
        importedSlugs.push(result.slug);
        const embedSkip = result.parsedPage?.frontmatter?.embed_skip;
        const embedSkipBytes = embedSkip && typeof embedSkip === 'object' && typeof (embedSkip as { bytes?: unknown }).bytes === 'number'
          ? (embedSkip as { bytes: number }).bytes
          : undefined;
        reportFile(embedSkip
          ? { status: 'partial', path: relativePath, chunks: result.chunks, bytes: embedSkipBytes, reason: '正文超过切片与向量化上限' }
          : {
              status: 'imported',
              path: relativePath,
              chunks: result.chunks,
              vectorized: !noEmbed,
              document: result.documentSummary,
              largeDocument: result.largeDocument,
            });
        // v0.33.2: path-based checkpoint — record only on success.
        completed.add(relativePath);
      } else if (result.status === 'partial') {
        imported++;
        errors++;
        chunksCreated += result.chunks;
        importedSlugs.push(result.slug);
        const reason = result.error ?? 'Large document embedding is partially complete';
        reportFile({
          status: 'partial',
          path: relativePath,
          chunks: result.chunks,
          reason,
          vectorized: false,
          document: result.documentSummary,
          largeDocument: result.largeDocument,
        });
        failures.push({ path: relativePath, error: reason });
        console.error(
          `  Partial ${relativePath}: ${result.largeDocument?.embedded ?? 0}/${result.largeDocument?.chunksTotal ?? result.chunks} chunks embedded; retry will resume`,
        );
      } else {
        skipped++;
        if (result.error && result.error !== 'unchanged') {
          errors++;
          console.error(`  Skipped ${relativePath}: ${result.error}`);
          reportFile({ status: 'failed', path: relativePath, reason: result.error });
          // Bug 9 — non-"unchanged" skips carry a real error reason.
          failures.push({ path: relativePath, error: result.error });
        } else {
          reportFile({ status: 'unchanged', path: relativePath, reason: '内容未变化或知识库已有相同资料' });
          // 'unchanged' or no-error skip: content_hash matched a prior
          // successful import, so this file IS done for checkpoint purposes.
          completed.add(relativePath);
        }
      }
    } catch (e: unknown) {
      opts.runtime?.signal.throwIfAborted();
      if (eng.kind === 'pglite' && isGinCorruptionError(e)) {
        if (ginRepaired) {
          throw e instanceof GinIndexUnusableError
            ? e
            : new GinIndexUnusableError(GIN_REPAIR_FAILED_MESSAGE, { cause: e });
        }
        const result = await repairPgliteGinIndexes(eng);
        if (result.status !== 'repaired') {
          throw new GinIndexUnusableError(result.message, { status: result.status, cause: e });
        }
        ginRepaired = true;
        return processFile(eng, filePath);
      }
      const msg = e instanceof Error ? e.message : String(e);
      const errorKey = msg.replace(/"[^"]*"/g, '""');
      errorCounts[errorKey] = (errorCounts[errorKey] || 0) + 1;
      if (errorCounts[errorKey] <= 5) {
        console.error(`  Warning: skipped ${relativePath}: ${msg}`);
      } else if (errorCounts[errorKey] === 6) {
        console.error(`  (suppressing further "${errorKey.slice(0, 60)}..." errors)`);
      }
      errors++;
      skipped++;
      reportFile({ status: 'failed', path: relativePath, reason: msg });
      failures.push({ path: relativePath, error: msg });
    }
    processed++;
    await opts.runtime?.onFile({ path: relativePath, completed: completed.has(relativePath), processed, imported, skipped, errors, chunksCreated });
    tickProgress();
    // Save checkpoint every 100 SUCCESSFUL adds (not every 100 processed).
    // Failed files never enter `completed`, so a flaky file can't push the
    // checkpoint past it — the next run will retry it.
    if (!opts.runtime && completed.size > 0 && completed.size % 100 === 0) {
      if (opts.checkpointKey) {
        await recordOpCompleted(engine, opts.checkpointKey, Array.from(completed));
      } else {
        const cpDir = gbrainPath();
        if (!existsSync(cpDir)) {
          try { const { mkdirSync } = await import('fs'); mkdirSync(cpDir, { recursive: true }); }
          catch { /* non-fatal */ }
        }
        saveCheckpoint(checkpointPath, {
          dir: importRoot,
          completedPaths: Array.from(completed),
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  if (actualWorkers > 1) {
    // v0.22.13 (PR #490 A1 + Q3): use engine.kind discriminator (not config.engine
    // string sniff) and fall back to serial when database_url is unset. Both
    // checks belt-and-suspenders so we never crash on a null assertion.
    const config = loadConfig();
    if (engine.kind === 'pglite' || !config?.database_url) {
      for (const file of files) {
        await processFile(engine, file);
      }
    } else {
      const { PostgresEngine } = await import('../core/postgres-engine.ts');
      const { resolvePoolSize } = await import('../core/db.ts');
      // Default per-worker pool is 2 (small, parallel import case). Users on
      // constrained poolers (e.g. Supabase port 6543) can cap below this via
      // GBRAIN_POOL_SIZE=1.
      const workerPoolSize = Math.min(2, resolvePoolSize(2));
      const databaseUrl = config.database_url;

      // v0.22.13 (PR #490 A2): connect workers serially so a partial failure
      // leaves us with the connected ones already pushed onto workerEngines
      // for the finally-block cleanup. The prior Promise.all could leak any
      // engine that connected before another's connect() rejected.
      const workerEngines: InstanceType<typeof PostgresEngine>[] = [];
      try {
        for (let i = 0; i < actualWorkers; i++) {
          const eng = new PostgresEngine();
          await eng.connect({ database_url: databaseUrl, poolSize: workerPoolSize });
          workerEngines.push(eng);
        }

        // Thread-safe queue: atomic index counter (JS is single-threaded; the
        // read-then-increment happens between awaits so no lock is needed).
        let queueIndex = 0;
        await Promise.all(workerEngines.map(async (eng) => {
          while (true) {
            const idx = queueIndex++;
            if (idx >= files.length) break;
            await processFile(eng, files[idx]);
          }
        }));
      } finally {
        // v0.22.13 (PR #490 A2): try/finally guarantees cleanup even when the
        // worker loop throws. Each disconnect is best-effort — one failing
        // disconnect must not strand the others.
        await Promise.all(
          workerEngines.map(e =>
            e.disconnect().catch((err: unknown) =>
              console.error(`  worker disconnect failed: ${err instanceof Error ? err.message : String(err)}`),
            ),
          ),
        );
      }
    } // end else (postgres parallel)
  } else {
    // Sequential: use the provided engine
    for (const filePath of files) {
      await processFile(engine, filePath);
    }
  }

  await opts.fileRuntime?.finish();
  progress.finish();

  // Error summary
  for (const [err, count] of Object.entries(errorCounts)) {
    if (count > 5) {
      console.error(`  ${count} files failed: ${err.slice(0, 100)}`);
    }
  }

  // Clear checkpoint on clean completion. On error, the path-based checkpoint
  // preserves only the successfully-completed paths, so the next run retries
  // failed files automatically (they never entered `completed`).
  if (!opts.runtime && errors === 0) {
    if (opts.checkpointKey) await clearOpCheckpoint(engine, opts.checkpointKey);
    else clearCheckpoint(checkpointPath);
  } else if (!opts.runtime && (opts.checkpointKey || existsSync(checkpointPath))) {
    if (opts.checkpointKey && completed.size > 0) {
      await recordOpCompleted(engine, opts.checkpointKey, Array.from(completed));
    }
    console.log(`  Checkpoint preserved (${errors} errors). Run again to retry failed files.`);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  if (jsonOutput) {
    console.log(JSON.stringify({
      status: 'success', duration_s: parseFloat(totalTime),
      imported, skipped, errors, chunks: chunksCreated,
      total_files: allFiles.length,
    }));
  } else {
    console.log(`\nImport complete (${totalTime}s):`);
    console.log(`  ${imported} pages imported`);
    console.log(`  ${skipped} pages skipped (${skipped - errors} unchanged, ${errors} errors)`);
    console.log(`  ${chunksCreated} chunks created`);
  }

  // v0.39 T7 — end-of-run schema mismatch warn. Fires ONCE per import,
  // not per page. Counts untyped pages in the affected source AND
  // compares to import size; warns at >=10% untyped. The doctor
  // schema_pack_consistency check (also T7) gives the persistent surface.
  // Best-effort: query failure is non-fatal.
  if (imported > 0) {
    try {
      const sid = sourceId ?? 'default';
      const rows = await engine.executeRaw<{ total: string | number; untyped: string | number }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE type IS NULL OR type = '')::text AS untyped
         FROM pages
         WHERE source_id = $1 AND deleted_at IS NULL`,
        [sid],
      );
      const total = Number(rows[0]?.total ?? 0);
      const untyped = Number(rows[0]?.untyped ?? 0);
      if (total > 0 && untyped / total >= 0.1) {
        const pct = ((untyped / total) * 100).toFixed(1);
        console.error(
          `\n[schema] ${untyped} of ${total} pages (${pct}%) in source \`${sid}\` ` +
          `have no \`type\` matching the active schema pack. Run \`gbrain schema detect\` ` +
          `to propose a pack matching your content shape, or \`gbrain doctor --json\` ` +
          `for the persistent surface (schema_pack_consistency check).`,
        );
      }
    } catch {
      // best-effort
    }
  }

  // Log the ingest
  await engine.logIngest({
    source_type: sourceType,
    source_ref: sourceType === 'file' ? dirArg : dir,
    pages_updated: importedSlugs,
    summary: `Imported ${imported} pages, ${skipped} skipped, ${chunksCreated} chunks`,
  });

  // Import → sync continuity: write sync checkpoint if this is a git repo.
  // Bug 9 — gate last_commit on "no failures" so import doesn't silently
  // stomp on the sync bookmark when parsing broke. We still write
  // last_run + repo_path either way (those are progress indicators).
  let gitHead: string | null = null;
  try {
    if (existsSync(join(importRoot, '.git'))) {
      gitHead = execFileSync('git', ['-C', importRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    }
  } catch {
    // Not a git repo or git not available
  }

  if (gitHead && !opts.managedBookmark) {
    // Record failures into the central JSONL so doctor can surface them.
    // Use gitHead as the commit so a later sync can tell "same broken
    // state as last time" from "new broken state."
    if (failures.length > 0) {
      const { recordSyncFailures } = await import('../core/sync-failure-ledger.ts');
      recordSyncFailures(failures, gitHead);
    }
    if (failures.length === 0) {
      await engine.setConfig('sync.last_commit', gitHead);
    } else {
      console.error(
        `\nImport completed with ${failures.length} failure(s). ` +
        `sync.last_commit NOT advanced — re-run 'gbrain sync' to retry, or ` +
        `'gbrain sync --skip-failed' to acknowledge and move past them.`,
      );
    }
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await engine.setConfig('sync.repo_path', importRoot);
  }

  return { imported, skipped, errors, chunksCreated, failures, importedSlugs };
}

/**
 * v0.31.2: max walker depth before bailing out. 32 levels is more than
 * any real source tree on disk; reaching it is a structural cycle the
 * lstat+inode-set defenses missed (e.g., a Linux bind-mount or btrfs
 * subvolume that returns a fresh inode for the same content). Override
 * via `GBRAIN_MAX_WALK_DEPTH`.
 */
function resolveMaxWalkDepth(): number {
  const raw = process.env.GBRAIN_MAX_WALK_DEPTH;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 32;
}

interface CollectOpts {
  strategy?: SyncStrategy;
  includeOffice?: boolean;
  includeImages?: boolean;
  includeSessions?: boolean;
}

/**
 * v0.27.1 + v0.31.2: walker-context image admission. `isSyncable` (the
 * incremental-diff filter at sync.ts:213) admits images only on `auto`.
 * The first-sync walker historically admitted them on markdown too when
 * `GBRAIN_EMBEDDING_MULTIMODAL=true`. Codex (C5) flagged the contradiction
 * — preserve the walker semantic explicitly.
 */
function isCollectibleForWalker(
  path: string,
  strategy: SyncStrategy,
  multimodalOn: boolean,
  includeOffice: boolean,
  includeSessions = false,
): boolean {
  if (isOfficeTransientFile(path)) return false;
  if (includeSessions && strategy !== 'code' && isSessionExportPath(path)) return true;
  const officeAllowed = includeOffice && isOfficeFilePath(path);
  switch (strategy) {
    case 'code':
      return isCodeFilePath(path);
    case 'markdown':
      return isMarkdownFilePath(path) || officeAllowed || (multimodalOn && isImageFilePathFromSync(path));
    case 'auto':
      return (
        isMarkdownFilePath(path) ||
        isCodeFilePath(path) ||
        officeAllowed ||
        (multimodalOn && isImageFilePathFromSync(path))
      );
  }
}

/**
 * v0.31.2 (codex C4 + C5 + C8): unified walker with five hardenings:
 *
 * 1. `lstatSync` + explicit `isSymbolicLink()` skip — never follow symlinks.
 *    Replaces the old `collectMarkdownFiles` lstat path AND the old
 *    `walkSyncableFiles` `statSync` path (the latter was the cost-preview
 *    walker, weaker than the import walker for no good reason).
 * 2. Inode-set cycle detection keyed on `${st_dev}:${st_ino}` — defense in
 *    depth for non-symlink cycles (bind mounts, ZFS snapshots).
 * 3. `MAX_WALK_DEPTH` bailout — last-line backstop if both layers above miss.
 * 4. Strategy-aware filter via `isCollectibleForWalker` — single helper that
 *    surfaces the markdown+multimodal carve-out at one site instead of
 *    leaking it across two filter paths.
 * 5. `.sort()` output — `runImport`'s checkpoint-resume at line 68–74 is
 *    index-based against a sorted list. Unstable order skips the wrong
 *    files on resume.
 */
export function collectSyncableFiles(dir: string, opts: CollectOpts = {}): string[] {
  const strategy: SyncStrategy = opts.strategy ?? 'markdown';
  const includeOffice = opts.includeOffice === true;
  const includeSessions = opts.includeSessions === true;
  const multimodalOn = opts.includeImages === true
    || (process.env.PMBRAIN_EMBEDDING_MULTIMODAL ?? process.env.GBRAIN_EMBEDDING_MULTIMODAL) === 'true';
  const maxDepth = resolveMaxWalkDepth();
  const visitedInodes = new Map<string, true>();
  const files: string[] = [];

  function walk(d: string, depth: number): void {
    if (depth >= maxDepth) {
      console.warn(`[pmbrain] walker depth limit reached at ${d}; skipping`);
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip hidden dirs (.git, .claude, .raw, etc.) and `node_modules`/`ops`.
      // Same set the legacy walkers honored, surfaced once at the top of
      // every iteration.
      if (entry.startsWith('.')) continue;
      if (entry === 'node_modules' || entry === 'ops') continue;

      const full = join(d, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        console.warn(`[pmbrain import] Skipping unreadable path: ${full}`);
        continue;
      }

      if (stat.isSymbolicLink()) {
        console.warn(`[pmbrain import] Skipping symlink: ${full}`);
        continue;
      }

      if (stat.isDirectory()) {
        const inodeKey = `${stat.dev}:${stat.ino}`;
        if (visitedInodes.has(inodeKey)) {
          console.warn(`[pmbrain] walker cycle detected at ${full}; skipping`);
          continue;
        }
        visitedInodes.set(inodeKey, true);
        walk(full, depth + 1);
      } else if (stat.isFile()) {
        if (!isCollectibleForWalker(entry, strategy, multimodalOn, includeOffice, includeSessions)) continue;
        files.push(full);
      }
    }
  }

  walk(dir, 0);
  return files.sort();
}

function pathContains(basePath: string, candidatePath: string): boolean {
  const base = resolve(basePath);
  const candidate = resolve(candidatePath);
  const rel = relative(base, candidate);
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
}

async function resolveImportRoot(
  engine: BrainEngine,
  sourceId: string | undefined,
  collectedRoot: string,
  files: string[],
): Promise<string> {
  if (!sourceId) return collectedRoot;
  const rows = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1`,
    [sourceId],
  );
  const localPath = rows[0]?.local_path;
  if (!localPath) return collectedRoot;
  const candidates = files.length > 0 ? files : [collectedRoot];
  if (candidates.every(path => pathContains(localPath, path))) {
    return localPath;
  }
  return collectedRoot;
}

/**
 * @deprecated v0.31.2: kept as a thin wrapper so legacy callers keep
 * compiling. Prefer `collectSyncableFiles(dir, { strategy: 'markdown' })`.
 */
export function collectMarkdownFiles(dir: string): string[] {
  return collectSyncableFiles(dir, { strategy: 'markdown' });
}
