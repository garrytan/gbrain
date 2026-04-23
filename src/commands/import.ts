import { readdirSync, lstatSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import { cpus, totalmem, homedir } from 'os';
import type { BrainEngine } from '../core/engine.ts';
import { importFile } from '../core/import-file.ts';
import { loadConfig } from '../core/config.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

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
}

export async function runImport(engine: BrainEngine, args: string[], opts: { commit?: string } = {}): Promise<RunImportResult> {
  const noEmbed = args.includes('--no-embed');
  const fresh = args.includes('--fresh');
  const jsonOutput = args.includes('--json');
  const workersIdx = args.indexOf('--workers');
  const workersArg = workersIdx !== -1 ? args[workersIdx + 1] : null;
  const workerCount = workersArg ? parseInt(workersArg, 10) : 1;
  // Find dir: first non-flag arg that isn't a value for --workers
  const flagValues = new Set<number>();
  if (workersIdx !== -1) flagValues.add(workersIdx + 1);
  const dirArg = args.find((a, i) => !a.startsWith('--') && !flagValues.has(i));

  if (!dirArg) {
    console.error('Usage: gbrain import <dir> [--no-embed] [--workers N] [--fresh] [--json]');
    process.exit(1);
  }
  const dir: string = dirArg;  // narrowed; survives closure capture

  // Collect all .md files
  const allFiles = collectMarkdownFiles(dir);
  console.log(`Found ${allFiles.length} markdown files`);

  // Resume from checkpoint if available
  const checkpointPath = join(homedir(), '.gbrain', 'import-checkpoint.json');
  let files = allFiles;
  let resumeIndex = 0;

  if (!fresh && existsSync(checkpointPath)) {
    try {
      const cp = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
      if (cp.dir === dir && cp.totalFiles === allFiles.length) {
        resumeIndex = cp.processedIndex;
        files = allFiles.slice(resumeIndex);
        console.log(`Resuming from checkpoint: skipping ${resumeIndex} already-processed files`);
      }
    } catch {
      // Invalid checkpoint, start fresh
    }
  }

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

  // Progress on stderr so stdout stays clean for the final summary / --json payload.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('import.files', files.length);

  function tickProgress() {
    progress.tick(1, `imported=${imported} skipped=${skipped} errors=${errors}`);
  }

  async function processFile(eng: BrainEngine, filePath: string) {
    const relativePath = relative(dir, filePath);
    try {
      const result = await importFile(eng, filePath, relativePath, { noEmbed });
      if (result.status === 'imported') {
        imported++;
        chunksCreated += result.chunks;
        importedSlugs.push(result.slug);
      } else {
        skipped++;
        if (result.error && result.error !== 'unchanged') {
          console.error(`  Skipped ${relativePath}: ${result.error}`);
          // Bug 9 — non-"unchanged" skips carry a real error reason.
          failures.push({ path: relativePath, error: result.error });
        }
      }
    } catch (e: unknown) {
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
      failures.push({ path: relativePath, error: msg });
    }
    processed++;
    tickProgress();
    if (processed % 100 === 0 || processed === files.length) {
      // Save checkpoint every 100 files — track completed file set, not just a counter
      if (processed % 100 === 0) {
        try {
          const cpDir = join(homedir(), '.gbrain');
          if (!existsSync(cpDir)) { const { mkdirSync } = await import('fs'); mkdirSync(cpDir, { recursive: true }); }
          writeFileSync(checkpointPath, JSON.stringify({
            dir, totalFiles: allFiles.length,
            processedIndex: resumeIndex + processed,
            completedFiles: importedSlugs.length + skipped,
            timestamp: new Date().toISOString(),
          }));
        } catch { /* non-fatal */ }
      }
    }
  }

  if (actualWorkers > 1) {
    // Parallel: create per-worker engine instances with small pool
    // PGLite is single-connection, so parallel workers are only for Postgres
    const config = loadConfig();
    if (config?.engine === 'pglite') {
      // PGLite: sequential import through single engine
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
    const workerEngines = await Promise.all(
      Array.from({ length: actualWorkers }, async () => {
        const eng = new PostgresEngine();
        await eng.connect({ database_url: config!.database_url!, poolSize: workerPoolSize });
        return eng;
      })
    );

    // Thread-safe queue: use an atomic index counter instead of array.shift()
    let queueIndex = 0;
    await Promise.all(workerEngines.map(async (eng) => {
      while (true) {
        const idx = queueIndex++;
        if (idx >= files.length) break;
        await processFile(eng, files[idx]);
      }
    }));

    await Promise.all(workerEngines.map(e => e.disconnect()));
    } // end else (postgres parallel)
  } else {
    // Sequential: use the provided engine
    for (const filePath of files) {
      await processFile(engine, filePath);
    }
  }

  progress.finish();

  // Error summary
  for (const [err, count] of Object.entries(errorCounts)) {
    if (count > 5) {
      console.error(`  ${count} files failed: ${err.slice(0, 100)}`);
    }
  }

  // Clear checkpoint only on successful completion (no errors)
  if (errors === 0 && existsSync(checkpointPath)) {
    try { unlinkSync(checkpointPath); } catch { /* non-fatal */ }
  } else if (errors > 0 && existsSync(checkpointPath)) {
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

  // Log the ingest
  await engine.logIngest({
    source_type: 'directory',
    source_ref: dir,
    pages_updated: importedSlugs,
    summary: `Imported ${imported} pages, ${skipped} skipped, ${chunksCreated} chunks`,
  });

  // Import → sync continuity: write sync checkpoint if this is a git repo.
  // Bug 9 — gate last_commit on "no failures" so import doesn't silently
  // stomp on the sync bookmark when parsing broke. We still write
  // last_run + repo_path either way (those are progress indicators).
  let gitHead: string | null = null;
  try {
    if (existsSync(join(dir, '.git'))) {
      gitHead = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    }
  } catch {
    // Not a git repo or git not available
  }

  if (gitHead) {
    // Record failures into the central JSONL so doctor can surface them.
    // Use gitHead as the commit so a later sync can tell "same broken
    // state as last time" from "new broken state."
    if (failures.length > 0) {
      const { recordSyncFailures } = await import('../core/sync.ts');
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
    await engine.setConfig('sync.repo_path', dir);
  }

  return { imported, skipped, errors, chunksCreated, failures };
}

export function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      // Skip hidden dirs and .raw dirs
      if (entry.startsWith('.')) continue;
      // Skip node_modules
      if (entry === 'node_modules') continue;

      const full = join(d, entry);
      let stat;
      try {
        // lstatSync, not statSync: we must NOT follow symlinks. A symlink
        // inside the brain directory can point to any file the importing
        // user can read, so a contributor to a shared brain could plant
        // notes/innocent.md as a symlink to ~/.gbrain/config.json, /etc/passwd,
        // or another sensitive file outside the brain root — and on the
        // next `gbrain import` it would be read, chunked, embedded, and
        // indexed, at which point a bearer-token holder could exfiltrate
        // it via search/get_page. See L002 in report/findings.md.
        stat = lstatSync(full);
      } catch {
        // Broken symlink or permission error — skip
        console.warn(`[gbrain import] Skipping unreadable path: ${full}`);
        continue;
      }

      // Skip symlinks (both file and directory targets). This also blocks
      // circular symlink DoS since we refuse to descend into linked dirs.
      if (stat.isSymbolicLink()) {
        console.warn(`[gbrain import] Skipping symlink: ${full}`);
        continue;
      }

      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md') || entry.endsWith('.mdx')) {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files.sort();
}
