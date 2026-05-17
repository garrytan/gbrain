import { readdirSync, lstatSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import { cpus, totalmem } from 'os';
import type { BrainEngine } from '../core/engine.ts';
import { importFile, importImageFile, isImageFilePath } from '../core/import-file.ts';
import { loadConfig, gbrainPath } from '../core/config.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import {
  isCodeFilePath,
  isMarkdownFilePath,
  isImageFilePath as isImageFilePathFromSync,
  matchesPathFilters,
  type SyncStrategy,
} from '../core/sync.ts';
import { sortNewestFirst } from '../core/sort-newest-first.ts';
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  resumeFilter,
} from '../core/import-checkpoint.ts';
import { loadCodeIndexConfig } from '../core/code-index-config.ts';

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

export async function runImport(
  engine: BrainEngine,
  args: string[],
  opts: { commit?: string; strategy?: SyncStrategy; sourceId?: string } = {},
): Promise<RunImportResult> {
  const noEmbed = args.includes('--no-embed');
  const fresh = args.includes('--fresh');
  const jsonOutput = args.includes('--json');
  // v0.30.x follow-up to PR #707: programmatic sourceId support so internal
  // callers (performFullSync, future Step 6 paths) can route to a named
  // source. The CLI `gbrain import` deliberately has no --source flag per
  // PR #707's design intent — only programmatic callers thread sourceId.
  const sourceId = opts.sourceId;
  const workersIdx = args.indexOf('--workers');
  const workersArg = workersIdx !== -1 ? args[workersIdx + 1] : null;
  // v0.22.13 (PR #490 Q2): shared parseWorkers helper rejects bad input
  // (--workers 0, -3, "foo") with a loud error instead of silently falling
  // through to 1. Mirrors sync.ts's flag handling.
  const { parseWorkers } = await import('../core/sync-concurrency.ts');
  let workerCount: number;
  try {
    workerCount = parseWorkers(workersArg ?? undefined) ?? 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  // Find dir: first non-flag arg that isn't a value for --workers
  const flagValues = new Set<number>();
  if (workersIdx !== -1) flagValues.add(workersIdx + 1);
  const dirArg = args.find((a, i) => !a.startsWith('--') && !flagValues.has(i));

  if (!dirArg) {
    console.error('Usage: gbrain import <dir> [--no-embed] [--workers N] [--fresh] [--json]');
    process.exit(1);
  }
  const dir: string = dirArg;  // narrowed; survives closure capture

  // v0.31.2: collect under the right strategy. Pre-fix this called
  // collectMarkdownFiles unconditionally — code-strategy first sync
  // silently no-op'd because no code file ever made it through walker
  // enumeration (codex C11 confirms dispatch was correct; bug was here).
  const strategy: SyncStrategy = opts.strategy ?? 'markdown';
  const codeIndexConfig = strategy === 'code' ? loadCodeIndexConfig(dir) : null;
  const _walkT0 = Date.now();
  console.error(`[gbrain phase] import.collect_files start dir=${dir} strategy=${strategy}`);
  const allFiles = collectSyncableFiles(dir, {
    strategy,
    include: codeIndexConfig?.include,
    exclude: codeIndexConfig?.exclude,
  });
  console.error(
    `[gbrain phase] import.collect_files done ${Date.now() - _walkT0}ms files=${allFiles.length}`,
  );
  const fileTypeLabel = strategy === 'code' ? 'code'
    : strategy === 'auto' ? 'syncable' : 'markdown';
  if (strategy === 'code') {
    console.log(
      `Code import filters: ${codeIndexConfig?.include.length ?? 0} include globs, ` +
      `${codeIndexConfig?.exclude.length ?? 0} exclude globs`,
    );
    console.log(`Found ${allFiles.length} code files after filtering`);
  } else {
    console.log(`Found ${allFiles.length} ${fileTypeLabel} files`);
  }

  // Sort newest-first so date-prefixed brain paths get embedded before older ones.
  // See src/core/sort-newest-first.ts for the policy.
  sortNewestFirst(allFiles);

  // Resume from checkpoint if available. v0.33.2: path-based resume —
  // see src/core/import-checkpoint.ts for the bug-class this fixes
  // (parallel-import silent-skip and failed-file no-retry).
  const checkpointPath = gbrainPath('import-checkpoint.json');
  const completed = new Set<string>();
  if (!fresh) {
    const cp = loadCheckpoint(checkpointPath, dir);
    if (cp) {
      for (const p of cp.completedPaths) completed.add(p);
      console.log(`Resuming from checkpoint: skipping ${completed.size} already-processed files`);
    }
  }
  const files = resumeFilter(allFiles, dir, completed);

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
    // v0.31.2 (D5): per-file slow-path log. Fires only when a single
    // file takes >5s. The user's hang surfaces as one file taking
    // forever — without this, the agent can't see which file.
    const _fileT0 = Date.now();
    try {
      // v0.27.1 (F2): dispatch image extensions to importImageFile when
      // multimodal is enabled. The walker (collectMarkdownFiles) only picks
      // up images when GBRAIN_EMBEDDING_MULTIMODAL=true so this branch is
      // unreachable when the gate is off; defense-in-depth check anyway.
      const result = isImageFilePath(relativePath) && process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true'
        ? await importImageFile(eng, filePath, relativePath, { noEmbed, sourceId })
        : await importFile(eng, filePath, relativePath, { noEmbed, sourceId });
      const _fileMs = Date.now() - _fileT0;
      if (_fileMs > 5000) {
        console.error(`[gbrain phase] import.process_file slow ${_fileMs}ms ${relativePath}`);
      }
      if (result.status === 'imported') {
        imported++;
        chunksCreated += result.chunks;
        importedSlugs.push(result.slug);
        // v0.33.2: path-based checkpoint — record only on success.
        completed.add(relativePath);
      } else {
        skipped++;
        if (result.error && result.error !== 'unchanged') {
          console.error(`  Skipped ${relativePath}: ${result.error}`);
          // Bug 9 — non-"unchanged" skips carry a real error reason.
          failures.push({ path: relativePath, error: result.error });
        } else {
          // 'unchanged' or no-error skip: content_hash matched a prior
          // successful import, so this file IS done for checkpoint purposes.
          completed.add(relativePath);
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
    // Save checkpoint every 100 SUCCESSFUL adds (not every 100 processed).
    // Failed files never enter `completed`, so a flaky file can't push the
    // checkpoint past it — the next run will retry it.
    if (completed.size > 0 && completed.size % 100 === 0) {
      const cpDir = gbrainPath();
      if (!existsSync(cpDir)) {
        try { const { mkdirSync } = await import('fs'); mkdirSync(cpDir, { recursive: true }); }
        catch { /* non-fatal */ }
      }
      saveCheckpoint(checkpointPath, {
        dir,
        completedPaths: Array.from(completed),
        timestamp: new Date().toISOString(),
      });
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
  if (errors === 0) {
    clearCheckpoint(checkpointPath);
  } else if (existsSync(checkpointPath)) {
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
  include?: string[];
  exclude?: string[];
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
): boolean {
  switch (strategy) {
    case 'code':
      return isCodeFilePath(path);
    case 'markdown':
      return isMarkdownFilePath(path) || (multimodalOn && isImageFilePathFromSync(path));
    case 'auto':
      return (
        isMarkdownFilePath(path) ||
        isCodeFilePath(path) ||
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
  const multimodalOn = process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true';
  const maxDepth = resolveMaxWalkDepth();
  const visitedInodes = new Map<string, true>();
  const files: string[] = [];

  function walk(d: string, depth: number): void {
    if (depth >= maxDepth) {
      console.warn(`[gbrain] walker depth limit reached at ${d}; skipping`);
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
        console.warn(`[gbrain import] Skipping unreadable path: ${full}`);
        continue;
      }

      if (stat.isSymbolicLink()) {
        console.warn(`[gbrain import] Skipping symlink: ${full}`);
        continue;
      }

      if (stat.isDirectory()) {
        const inodeKey = `${stat.dev}:${stat.ino}`;
        if (visitedInodes.has(inodeKey)) {
          console.warn(`[gbrain] walker cycle detected at ${full}; skipping`);
          continue;
        }
        visitedInodes.set(inodeKey, true);
        walk(full, depth + 1);
      } else if (stat.isFile()) {
        if (!isCollectibleForWalker(entry, strategy, multimodalOn)) continue;
        const rel = relative(dir, full).replace(/\\/g, '/');
        if (!matchesPathFilters(rel, opts)) continue;
        files.push(full);
      }
    }
  }

  walk(dir, 0);
  return files.sort();
}

/**
 * @deprecated v0.31.2: kept as a thin wrapper so legacy callers keep
 * compiling. Prefer `collectSyncableFiles(dir, { strategy: 'markdown' })`.
 */
export function collectMarkdownFiles(dir: string): string[] {
  return collectSyncableFiles(dir, { strategy: 'markdown' });
}
