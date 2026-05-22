import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { importFile } from '../core/import-file.ts';
import { createInterface } from 'readline';
import {
  buildSyncManifest,
  isSyncable,
  resolveSlugForPath,
  recordSyncFailures,
  unacknowledgedSyncFailures,
  acknowledgeSyncFailures,
  formatCodeBreakdown,
} from '../core/sync.ts';
import { estimateTokens, CHUNKER_VERSION } from '../core/chunkers/code.ts';
import { EMBEDDING_MODEL, estimateEmbeddingCostUsd } from '../core/embedding.ts';
import { errorFor, serializeError } from '../core/errors.ts';
import type { SyncManifest } from '../core/sync.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { loadConfig } from '../core/config.ts';
import {
  autoConcurrency,
  shouldRunParallel,
  parseWorkers,
} from '../core/sync-concurrency.ts';
import { tryAcquireDbLock, SYNC_LOCK_ID } from '../core/db-lock.ts';
import { loadStorageConfig } from '../core/storage-config.ts';
import { getDefaultSourcePath } from '../core/source-resolver.ts';

export interface SyncResult {
  status: 'up_to_date' | 'synced' | 'first_sync' | 'dry_run' | 'blocked_by_failures';
  fromCommit: string | null;
  toCommit: string;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  chunksCreated: number;
  /** Pages re-embedded during this sync's auto-embed step. 0 if --no-embed or skipped. */
  embedded: number;
  pagesAffected: string[];
  failedFiles?: number; // count of parse failures (Bug 9)
}

/**
 * v0.20.0 Cathedral II Layer 8 (D1) — walk each source's working tree and
 * sum tokens for every syncable file. This is a conservative overestimate
 * (full file content, not just the incremental diff) because `sync --all`
 * on a source that hasn't been synced yet WILL embed every file in the
 * working tree. For already-synced sources with only incremental changes,
 * the overestimate is the ceiling, not the floor — users never get
 * surprised by MORE cost than the preview claims. The false-high bias is
 * intentional: a lower estimate that undersells the real bill would be
 * worse than one that oversells.
 */
function estimateSyncAllCost(sources: Array<{ local_path: string | null; config: Record<string, unknown> }>): {
  totalTokens: number;
  totalFiles: number;
  activeSources: number;
  perSource: Array<{ path: string; tokens: number; files: number }>;
} {
  let totalTokens = 0;
  let totalFiles = 0;
  let activeSources = 0;
  const perSource: Array<{ path: string; tokens: number; files: number }> = [];

  for (const src of sources) {
    if (!src.local_path) continue;
    const cfg = (src.config || {}) as { syncEnabled?: boolean; strategy?: 'markdown' | 'code' | 'auto' };
    if (cfg.syncEnabled === false) continue;
    activeSources++;
    let sourceTokens = 0;
    let sourceFiles = 0;
    try {
      walkSyncableFiles(src.local_path, (filePath: string, content: string) => {
        sourceTokens += estimateTokens(content);
        sourceFiles++;
      }, cfg.strategy ?? 'markdown');
    } catch {
      // Best-effort: a source whose local_path is gone or unreadable just
      // contributes 0. The sync itself would have failed anyway; no point
      // blocking the preview on a pre-existing fault.
    }
    totalTokens += sourceTokens;
    totalFiles += sourceFiles;
    perSource.push({ path: src.local_path, tokens: sourceTokens, files: sourceFiles });
  }

  return { totalTokens, totalFiles, activeSources, perSource };
}

/**
 * Walk a repo's working tree and invoke `cb(path, content)` for each
 * syncable file. Honors the same strategy as `isSyncable` so the preview
 * and the real sync agree on what's in scope.
 */
function walkSyncableFiles(
  repoRoot: string,
  cb: (path: string, content: string) => void,
  strategy: 'markdown' | 'code' | 'auto',
): void {
  const stack: string[] = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as import('fs').Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
      // Skip hidden dirs, .git, node_modules (same rules isSyncable applies).
      if (name.startsWith('.') || name === 'node_modules' || name === 'ops') continue;
      const fullPath = `${dir}/${name}`;
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const relativePath = fullPath.slice(repoRoot.length + 1);
        if (!isSyncable(relativePath, { strategy })) continue;
        try {
          const stat = statSync(fullPath);
          if (stat.size > 5_000_000) continue; // skip large binaries
          const content = readFileSync(fullPath, 'utf-8');
          cb(fullPath, content);
        } catch {
          // Ignore files we can't read; consistent with sync's own tolerance.
        }
      }
    }
  }
}

/** Interactive [y/N] prompt. Resolves false on non-y answers or EOF. */
async function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
    rl.on('close', () => resolve(false));
  });
}

export interface SyncOpts {
  repoPath?: string;
  dryRun?: boolean;
  full?: boolean;
  noPull?: boolean;
  noEmbed?: boolean;
  noExtract?: boolean;
  /** Bug 9 — acknowledge + skip past current failure set (CLI --skip-failed). */
  skipFailed?: boolean;
  /** Bug 9 — re-attempt unacknowledged failures explicitly (CLI --retry-failed). */
  retryFailed?: boolean;
  /**
   * v0.18.0 Step 5 — sync a specific named source. When set, sync reads
   * local_path + last_commit from the sources table (not the global
   * config.sync.* keys) and writes last_commit + last_sync_at back to
   * the same row. Backward compat: when undefined, sync uses the
   * pre-v0.17 global-config path unchanged.
   */
  sourceId?: string;
  /** Multi-repo: sync strategy override (markdown, code, auto). */
  strategy?: 'markdown' | 'code' | 'auto';
  /**
   * Number of parallel workers for the import phase. When > 1, each worker
   * gets its own small Postgres connection pool and files are dispatched via
   * an atomic queue index (same pattern as `import --workers N`).
   *
   * Deletes and renames remain serial (order-dependent).
   * Default: undefined → auto-concurrency picks (`src/core/sync-concurrency.ts`).
   *
   * v0.22.13 (PR #490 Q1): when this is explicitly set, the >50-file floor
   * is bypassed — explicit user intent beats the auto-path safety net.
   */
  concurrency?: number;
  /**
   * Internal: skip acquiring the gbrain-sync DB lock. Set by the cycle
   * handler (cycle.ts) which already holds gbrain-cycle and therefore
   * already serializes against other cycle runs. CLI sync, jobs handler,
   * and any external caller leave this undefined so they take the lock.
   *
   * v0.22.13 (PR #490 CODEX-2). Not part of the public CLI surface.
   */
  skipLock?: boolean;
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
  }).trim();
}

// v0.18.0 Step 5: source-scoped sync state helpers. When opts.sourceId
// is set, read/write the per-source row instead of the global config
// keys. These wrappers centralize the branch so every read/write site
// picks the right storage — future Step 5 work (failure-tracking per
// source) hooks here too.
async function readSyncAnchor(
  engine: BrainEngine,
  sourceId: string | undefined,
  which: 'repo_path' | 'last_commit',
): Promise<string | null> {
  if (sourceId) {
    const col = which === 'repo_path' ? 'local_path' : 'last_commit';
    const rows = await engine.executeRaw<Record<string, string | null>>(
      `SELECT ${col} AS value FROM sources WHERE id = $1`,
      [sourceId],
    );
    return rows[0]?.value ?? null;
  }
  return await engine.getConfig(`sync.${which}`);
}

async function writeSyncAnchor(
  engine: BrainEngine,
  sourceId: string | undefined,
  which: 'repo_path' | 'last_commit',
  value: string,
): Promise<void> {
  if (sourceId) {
    const col = which === 'repo_path' ? 'local_path' : 'last_commit';
    // last_sync_at bookmarked on every last_commit advance.
    if (which === 'last_commit') {
      await engine.executeRaw(
        `UPDATE sources SET last_commit = $1, last_sync_at = now() WHERE id = $2`,
        [value, sourceId],
      );
    } else {
      await engine.executeRaw(
        `UPDATE sources SET ${col} = $1 WHERE id = $2`,
        [value, sourceId],
      );
    }
    return;
  }
  await engine.setConfig(`sync.${which}`, value);
}

/**
 * v0.20.0 Cathedral II Layer 12 (SP-1 fix) — read/write the chunker version
 * last used to sync a given source. When it mismatches CURRENT_CHUNKER_VERSION,
 * `performSync` forces a full walk regardless of git HEAD equality. Without
 * this gate, bumping CHUNKER_VERSION does NOTHING on an unchanged repo
 * because sync short-circuits at `up_to_date` before reaching
 * `importCodeFile`'s content_hash check.
 *
 * Per-source storage matches writeSyncAnchor's shape — sources.chunker_version
 * TEXT column from the v27 migration. No global fallback: non-source syncs
 * (pre-v0.17 brains with no sources table) never had CHUNKER_VERSION
 * version-gating, so they keep the v0.19.0 behavior.
 */
async function readChunkerVersion(
  engine: BrainEngine,
  sourceId: string | undefined,
): Promise<string | null> {
  if (!sourceId) return null;
  const rows = await engine.executeRaw<{ chunker_version: string | null }>(
    `SELECT chunker_version FROM sources WHERE id = $1`,
    [sourceId],
  );
  return rows[0]?.chunker_version ?? null;
}

async function writeChunkerVersion(
  engine: BrainEngine,
  sourceId: string | undefined,
  version: string,
): Promise<void> {
  if (!sourceId) return;
  await engine.executeRaw(
    `UPDATE sources SET chunker_version = $1 WHERE id = $2`,
    [version, sourceId],
  );
}

export async function performSync(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  // CODEX-2 (v0.22.13): cross-process writer lock for performSync. Two
  // concurrent syncs can otherwise read the same last_commit anchor, both
  // write last_commit unconditionally, and the last writer wins — including
  // regressing the bookmark backwards. cycle.ts already takes gbrain-cycle
  // for its broader scope; performSync (called from cycle, jobs handler,
  // and CLI) takes gbrain-sync just for the writer window. The two ids
  // nest cleanly: cycle holds gbrain-cycle, calls performSync, performSync
  // takes gbrain-sync. Other callers serialize on gbrain-sync against
  // each other AND against the cycle's sync phase.
  //
  // skipLock is reserved for callers that already serialize via another
  // mechanism (none in v0.22.13; reserved for future).
  let lockHandle: { release: () => Promise<void> } | null = null;
  if (!opts.skipLock) {
    lockHandle = await tryAcquireDbLock(engine, SYNC_LOCK_ID);
    if (!lockHandle) {
      throw new Error(
        `Another sync is in progress (lock ${SYNC_LOCK_ID} held). ` +
        `Wait for it to finish, or run 'gbrain doctor' if it has been more than 30 minutes.`,
      );
    }
  }

  try {
    return await performSyncInner(engine, opts);
  } finally {
    if (lockHandle) {
      try { await lockHandle.release(); } catch { /* best-effort release */ }
    }
  }
}

async function performSyncInner(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  // Resolve repo path
  const repoPath = opts.repoPath || await readSyncAnchor(engine, opts.sourceId, 'repo_path');
  if (!repoPath) {
    const hint = opts.sourceId
      ? `Source "${opts.sourceId}" has no local_path. Run: gbrain sources add ${opts.sourceId} --path <path>`
      : `No repo path specified. Use --repo or run gbrain init with --repo first.`;
    throw new Error(hint);
  }

  // Validate git repo
  if (!existsSync(join(repoPath, '.git'))) {
    throw new Error(`Not a git repository: ${repoPath}. GBrain sync requires a git-initialized repo.`);
  }

  // Git pull (unless --no-pull)
  if (!opts.noPull) {
    try {
      git(repoPath, 'pull', '--ff-only');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('non-fast-forward') || msg.includes('diverged')) {
        console.error(`Warning: git pull failed (remote diverged). Syncing from local state.`);
      } else {
        console.error(`Warning: git pull failed: ${msg.slice(0, 100)}`);
      }
    }
  }

  // Get current HEAD
  let headCommit: string;
  try {
    headCommit = git(repoPath, 'rev-parse', 'HEAD');
  } catch {
    throw new Error(`No commits in repo ${repoPath}. Make at least one commit before syncing.`);
  }

  // Read sync state (source-scoped when sourceId is set, global otherwise)
  const lastCommit = opts.full ? null : await readSyncAnchor(engine, opts.sourceId, 'last_commit');

  // Ancestry validation: if lastCommit exists, verify it's still in history
  if (lastCommit) {
    try {
      git(repoPath, 'cat-file', '-t', lastCommit);
    } catch {
      console.error(`Sync anchor commit ${lastCommit.slice(0, 8)} missing (force push?). Running full reimport.`);
      return performFullSync(engine, repoPath, headCommit, opts);
    }

    // Verify ancestry
    try {
      git(repoPath, 'merge-base', '--is-ancestor', lastCommit, headCommit);
    } catch {
      console.error(`Sync anchor ${lastCommit.slice(0, 8)} is not an ancestor of HEAD. Running full reimport.`);
      return performFullSync(engine, repoPath, headCommit, opts);
    }
  }

  // First sync
  if (!lastCommit) {
    return performFullSync(engine, repoPath, headCommit, opts);
  }

  // v0.20.0 Cathedral II Layer 12 (codex SP-1 fix): before returning
  // 'up_to_date' on git-HEAD equality, check the chunker version gate.
  // If sources.chunker_version mismatches CURRENT_CHUNKER_VERSION, force
  // a full re-walk so existing chunks get re-chunked under the new
  // pipeline (qualified symbol names, parent scope, doc-comment column
  // population, etc.). Without this, upgraded brains silently stay on
  // the old chunks — the whole reason we bumped the version.
  const storedVersion = await readChunkerVersion(engine, opts.sourceId);
  const currentVersion = String(CHUNKER_VERSION);
  const versionMismatch = storedVersion !== null && storedVersion !== currentVersion;
  const versionNeverSet = storedVersion === null && opts.sourceId !== undefined;

  if (lastCommit === headCommit && !versionMismatch && !versionNeverSet) {
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
    };
  }

  if ((versionMismatch || versionNeverSet) && lastCommit === headCommit) {
    console.log(
      `[sync] chunker_version gate: stored=${storedVersion ?? 'unset'}, current=${currentVersion}. ` +
      `Forcing full re-chunk pass (git HEAD unchanged but pipeline version advanced).`,
    );
    const result = await performFullSync(engine, repoPath, headCommit, opts);
    await writeChunkerVersion(engine, opts.sourceId, currentVersion);
    return result;
  }

  // Diff using git diff (net result, not per-commit)
  const diffOutput = git(repoPath, 'diff', '--name-status', '-M', `${lastCommit}..${headCommit}`);
  const manifest = buildSyncManifest(diffOutput);

  // Filter to syncable files (strategy-aware)
  const syncOpts = opts.strategy ? { strategy: opts.strategy } : undefined;
  const filtered: SyncManifest = {
    added: manifest.added.filter(p => isSyncable(p, syncOpts)),
    modified: manifest.modified.filter(p => isSyncable(p, syncOpts)),
    deleted: manifest.deleted.filter(p => isSyncable(p, syncOpts)),
    renamed: manifest.renamed.filter(r => isSyncable(r.to, syncOpts)),
  };

  // Delete pages that became un-syncable (modified but filtered out).
  // v0.20.0 Cathedral II SP-5: resolveSlugForPath picks the right slug shape
  // (markdown vs code) based on the chunker's classifier, so a Rust file that
  // became un-syncable (e.g., moved under `.gitignore` or filtered by
  // strategy=markdown) deletes the actual code-slug page, not a ghost
  // markdown-slug that never existed.
  const unsyncableModified = manifest.modified.filter(p => !isSyncable(p, syncOpts));
  for (const path of unsyncableModified) {
    const slug = resolveSlugForPath(path);
    try {
      const existing = await engine.getPage(slug);
      if (existing) {
        await engine.deletePage(slug);
        console.log(`  Deleted un-syncable page: ${slug}`);
      }
    } catch { /* ignore */ }
  }

  const totalChanges = filtered.added.length + filtered.modified.length +
    filtered.deleted.length + filtered.renamed.length;

  // Dry run
  if (opts.dryRun) {
    console.log(`Sync dry run: ${lastCommit.slice(0, 8)}..${headCommit.slice(0, 8)}`);
    if (filtered.added.length) console.log(`  Added: ${filtered.added.join(', ')}`);
    if (filtered.modified.length) console.log(`  Modified: ${filtered.modified.join(', ')}`);
    if (filtered.deleted.length) console.log(`  Deleted: ${filtered.deleted.join(', ')}`);
    if (filtered.renamed.length) console.log(`  Renamed: ${filtered.renamed.map(r => `${r.from} -> ${r.to}`).join(', ')}`);
    if (totalChanges === 0) console.log(`  No syncable changes.`);
    return {
      status: 'dry_run',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: filtered.added.length,
      modified: filtered.modified.length,
      deleted: filtered.deleted.length,
      renamed: filtered.renamed.length,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
    };
  }

  if (totalChanges === 0) {
    // Update sync state even with no syncable changes (git advanced)
    await writeSyncAnchor(engine, opts.sourceId, 'last_commit', headCommit);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
    };
  }

  const noEmbed = opts.noEmbed || totalChanges > 100;
  if (totalChanges > 100) {
    console.log(`Large sync (${totalChanges} files). Importing text, deferring embeddings.`);
  }

  const pagesAffected: string[] = [];
  let chunksCreated = 0;
  const start = Date.now();

  // Per-file progress on stderr so agents see each step of a big sync.
  // Phases: sync.deletes, sync.renames, sync.imports.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  // Process deletes first (prevents slug conflicts). SP-5: resolveSlugForPath
  // dispatches to the right slug shape so code file deletes hit the real page.
  if (filtered.deleted.length > 0) {
    progress.start('sync.deletes', filtered.deleted.length);
    for (const path of filtered.deleted) {
      const slug = resolveSlugForPath(path);
      await engine.deletePage(slug);
      pagesAffected.push(slug);
      progress.tick(1, slug);
    }
    progress.finish();
  }

  // Process renames (updateSlug preserves page_id, chunks, embeddings).
  // SP-5: both old and new slugs use resolveSlugForPath so a .ts → .ts
  // rename (code→code), .md → .md (markdown→markdown), or cross-kind rename
  // all resolve to the right slug shape for each side.
  if (filtered.renamed.length > 0) {
    progress.start('sync.renames', filtered.renamed.length);
    for (const { from, to } of filtered.renamed) {
      const oldSlug = resolveSlugForPath(from);
      const newSlug = resolveSlugForPath(to);
      try {
        await engine.updateSlug(oldSlug, newSlug);
      } catch {
        // Slug doesn't exist or collision, treat as add
      }
      // Reimport at new path (picks up content changes)
      const filePath = join(repoPath, to);
      if (existsSync(filePath)) {
        const result = await importFile(engine, filePath, to, { noEmbed });
        if (result.status === 'imported') chunksCreated += result.chunks;
      }
      pagesAffected.push(newSlug);
      progress.tick(1, newSlug);
    }
    progress.finish();
  }

  // Process adds and modifies.
  //
  // NOTE: do NOT wrap this loop in engine.transaction(). importFromContent
  // already opens its own inner transaction per file, and PGLite transactions
  // are not reentrant — they acquire the same _runExclusiveTransaction mutex,
  // so a nested call from inside a user callback queues forever on the mutex
  // the outer transaction is still holding. Result: incremental sync hangs in
  // ep_poll whenever the diff crosses the old > 10 threshold that used to
  // trigger the outer wrap. Per-file atomicity is also the right granularity:
  // one file's failure should not roll back the others' successful imports.
  //
  // v0.15.2: per-file progress on stderr via the shared reporter.
  // Bug 9: per-file failures captured in `failedFiles` so the caller can
  // gate `sync.last_commit` advancement and record recoverable errors.
  const failedFiles: Array<{ path: string; error: string; line?: number }> = [];
  const addsAndMods = [...filtered.added, ...filtered.modified];

  // v0.22.13 (PR #490 Q5): one source of truth for the concurrency decision.
  // engine.kind === 'pglite' → forced 1; explicit opts.concurrency wins;
  // auto path returns DEFAULT_PARALLEL_WORKERS only when fileCount > 100.
  const explicitConcurrency = opts.concurrency !== undefined;
  const effectiveConcurrency = autoConcurrency(engine, addsAndMods.length, opts.concurrency);
  const runParallel = shouldRunParallel(effectiveConcurrency, addsAndMods.length, explicitConcurrency);

  if (addsAndMods.length > 0) {
    progress.start('sync.imports', addsAndMods.length);

    // Core import logic shared by serial and parallel paths.
    // repoPath is validated non-null at the top of performSyncInner; narrow for TS.
    const syncRepoPath = repoPath!;
    async function importOnePath(eng: BrainEngine, path: string): Promise<void> {
      const filePath = join(syncRepoPath, path);
      if (!existsSync(filePath)) {
        // CODEX-3 (v0.22.13): a file the diff said exists at headCommit but
        // is gone from disk means the working tree has drifted (someone ran
        // `git checkout` / `git reset` mid-sync, or the file was deleted
        // post-diff). Record as a failure so last_commit does NOT advance —
        // the silent-skip-then-advance pathology was the bug.
        failedFiles.push({
          path,
          error: 'file vanished mid-sync (working tree drifted from headCommit)',
        });
        progress.tick(1, `skip:${path}`);
        return;
      }
      try {
        const result = await importFile(eng, filePath, path, { noEmbed });
        if (result.status === 'imported') {
          chunksCreated += result.chunks;
          pagesAffected.push(result.slug);
        } else if (result.status === 'skipped' && (result as any).error) {
          failedFiles.push({ path, error: String((result as any).error) });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  Warning: skipped ${path}: ${msg}`);
        failedFiles.push({ path, error: msg });
      }
      progress.tick(1, path);
    }

    if (runParallel) {
      // A1 (v0.22.13): use engine.kind discriminator instead of config?.engine
      // string compare or constructor.name sniff. Q3: belt-and-suspenders fall
      // back to serial when database_url is unset, so we never crash on a null
      // assertion if config is missing.
      const config = loadConfig();
      if (engine.kind === 'pglite' || !config?.database_url) {
        for (const path of addsAndMods) {
          await importOnePath(engine, path);
        }
      } else {
        const { PostgresEngine } = await import('../core/postgres-engine.ts');
        const { resolvePoolSize } = await import('../core/db.ts');
        const workerPoolSize = Math.min(2, resolvePoolSize(2));
        const workerCount = Math.min(effectiveConcurrency, addsAndMods.length);
        const databaseUrl = config.database_url;

        // Q4 (v0.22.13): banner on stderr so stdout stays clean for --json.
        console.error(`  Parallel sync: ${workerCount} workers for ${addsAndMods.length} files`);

        const workerEngines: InstanceType<typeof PostgresEngine>[] = [];
        try {
          // Connect workers one-by-one rather than Promise.all so a partial
          // failure leaves us with the connected ones in workerEngines for
          // the finally-block cleanup. The original code lost track of
          // already-connected engines on any one failure.
          for (let i = 0; i < workerCount; i++) {
            const eng = new PostgresEngine();
            await eng.connect({ database_url: databaseUrl, poolSize: workerPoolSize });
            workerEngines.push(eng);
          }

          // Atomic queue index — JS is single-threaded; the read-then-increment
          // happens between awaits, so no lock is needed.
          let queueIndex = 0;
          await Promise.all(
            workerEngines.map(async (eng) => {
              while (true) {
                const idx = queueIndex++;
                if (idx >= addsAndMods.length) break;
                await importOnePath(eng, addsAndMods[idx]);
              }
            }),
          );
        } finally {
          // A2 (v0.22.13): try/finally guarantees connection cleanup even when
          // the worker loop throws (partial connect failure, OOM, mid-import
          // signal). Each disconnect is best-effort — one worker failing to
          // disconnect must not strand the others.
          await Promise.all(
            workerEngines.map((e) =>
              e.disconnect().catch((err: unknown) =>
                console.error(`  worker disconnect failed: ${err instanceof Error ? err.message : String(err)}`),
              ),
            ),
          );
        }
      }
    } else {
      // Serial path (small auto diffs or explicit --workers 1).
      for (const path of addsAndMods) {
        await importOnePath(engine, path);
      }
    }

    progress.finish();
  }

  // CODEX-3 (v0.22.13): head-drift gate. If git HEAD moved during the import
  // window (someone ran `git checkout` or `git pull` in another terminal /
  // sibling Conductor workspace), the chunks we just imported reflect a
  // different tree than `headCommit` claims. Refuse to advance last_commit
  // so the next sync re-walks against the new HEAD. The lock from CODEX-2
  // prevents *this* gbrain process from stepping on itself; this gate
  // catches drift caused by external `git` commands the lock cannot see.
  try {
    const currentHead = git(repoPath, 'rev-parse', 'HEAD');
    if (currentHead !== headCommit) {
      failedFiles.push({
        path: '<head>',
        error: `git HEAD drifted during sync: captured ${headCommit.slice(0, 8)}, now ${currentHead.slice(0, 8)}`,
      });
    }
  } catch (e) {
    // rev-parse failure is itself a drift signal (worktree disappeared).
    failedFiles.push({
      path: '<head>',
      error: `git HEAD verification failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const elapsed = Date.now() - start;

  // Bug 9 — gate the sync bookmark on success. If any per-file parse
  // failed, record it to ~/.gbrain/sync-failures.jsonl and DO NOT advance
  // sync.last_commit. The next sync re-walks the same diff and re-attempts
  // the failed files. Escape hatches: --skip-failed acknowledges the
  // current set, --retry-failed re-parses before running the normal sync.
  if (failedFiles.length > 0) {
    recordSyncFailures(failedFiles, headCommit);
    // Emit structured summary grouped by error code so the operator
    // can see *why* files failed, not just how many.
    const codeBreakdown = formatCodeBreakdown(failedFiles);
    if (!opts.skipFailed) {
      console.error(
        `\nSync blocked: ${failedFiles.length} file(s) failed to parse:\n` +
        `${codeBreakdown}\n\n` +
        `Fix the YAML frontmatter in the files above and re-run, or use ` +
        `'gbrain sync --skip-failed' to acknowledge and move on.`,
      );
      // Update last_run + repo_path (progress on infra) but NOT last_commit.
      await engine.setConfig('sync.last_run', new Date().toISOString());
      await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
      return {
        status: 'blocked_by_failures',
        fromCommit: lastCommit,
        toCommit: headCommit,
        added: filtered.added.length,
        modified: filtered.modified.length,
        deleted: filtered.deleted.length,
        renamed: filtered.renamed.length,
        chunksCreated,
        embedded: 0,
        pagesAffected,
        failedFiles: failedFiles.length,
      };
    }
    // --skip-failed: acknowledge the now-recorded set and proceed.
    const acked = acknowledgeSyncFailures();
    if (acked.count > 0) {
      console.error(
        `  Acknowledged ${acked.count} failure(s) and advancing past them:\n` +
        `${formatCodeBreakdown(acked.summary)}`,
      );
    }
  }

  // Update sync state AFTER all changes succeed (source-scoped when
  // opts.sourceId is set, global config otherwise).
  await writeSyncAnchor(engine, opts.sourceId, 'last_commit', headCommit);
  await engine.setConfig('sync.last_run', new Date().toISOString());
  await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
  // v0.20.0 Cathedral II Layer 12: persist the chunker version we just
  // finished with so the next sync's up_to_date gate respects it. Only
  // source-scoped syncs track this (see readChunkerVersion for rationale).
  await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));

  // Log ingest
  await engine.logIngest({
    source_type: 'git_sync',
    source_ref: `${repoPath} @ ${headCommit.slice(0, 8)}`,
    pages_updated: pagesAffected,
    summary: `Sync: +${filtered.added.length} ~${filtered.modified.length} -${filtered.deleted.length} R${filtered.renamed.length}, ${chunksCreated} chunks, ${elapsed}ms`,
  });

  // Auto-extract links + timeline (always, extraction is cheap CPU)
  if (!opts.noExtract && pagesAffected.length > 0) {
    try {
      const { extractLinksForSlugs, extractTimelineForSlugs } = await import('./extract.ts');
      const linksCreated = await extractLinksForSlugs(engine, repoPath, pagesAffected);
      const timelineCreated = await extractTimelineForSlugs(engine, repoPath, pagesAffected);
      if (linksCreated > 0 || timelineCreated > 0) {
        console.log(`  Extracted: ${linksCreated} links, ${timelineCreated} timeline entries`);
      }
    } catch { /* extraction is best-effort */ }
  }

  // Auto-embed (skip for large syncs — embedding calls OpenAI)
  let embedded = 0;
  if (!noEmbed && pagesAffected.length > 0 && pagesAffected.length <= 100) {
    try {
      const { runEmbed } = await import('./embed.ts');
      await runEmbed(engine, ['--slugs', ...pagesAffected]);
      // Before commit 2 lands: runEmbed is void. Best estimate is pagesAffected,
      // since runEmbed re-embeds every requested slug. Commit 2 sharpens this
      // with EmbedResult.embedded.
      embedded = pagesAffected.length;
    } catch { /* embedding is best-effort */ }
  } else if (noEmbed || totalChanges > 100) {
    console.log(`Text imported. Run 'gbrain embed --stale' to generate embeddings.`);
  }

  return {
    status: 'synced',
    fromCommit: lastCommit,
    toCommit: headCommit,
    added: filtered.added.length,
    modified: filtered.modified.length,
    deleted: filtered.deleted.length,
    renamed: filtered.renamed.length,
    chunksCreated,
    embedded,
    pagesAffected,
  };
}

async function performFullSync(
  engine: BrainEngine,
  repoPath: string,
  headCommit: string,
  opts: SyncOpts,
): Promise<SyncResult> {
  // Dry-run: walk the repo, count syncable files, return without writing.
  // Fixes the silent-write-on-dry-run bug where performFullSync called
  // runImport unconditionally regardless of opts.dryRun.
  if (opts.dryRun) {
    const { collectMarkdownFiles } = await import('./import.ts');
    const allFiles = collectMarkdownFiles(repoPath);
    const syncableRelPaths = allFiles
      .map(abs => relative(repoPath, abs))
      .filter(rel => isSyncable(rel));
    console.log(
      `Full-sync dry run: ${syncableRelPaths.length} file(s) would be imported ` +
      `from ${repoPath} @ ${headCommit.slice(0, 8)}.`,
    );
    return {
      status: 'dry_run',
      fromCommit: null,
      toCommit: headCommit,
      added: syncableRelPaths.length,
      modified: 0,
      deleted: 0,
      renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
    };
  }

  // v0.22.13 (PR #490 A1 + Q5): full sync is always "large" by definition
  // (entire working tree). Auto-concurrency fires unconditionally for Postgres;
  // PGLite stays serial because its engine is single-connection. Routes the
  // policy through autoConcurrency() so it stays consistent with incremental
  // sync and the jobs handler.
  const FULL_SYNC_LARGE_MARKER = Number.MAX_SAFE_INTEGER;
  const fullConcurrency = autoConcurrency(engine, FULL_SYNC_LARGE_MARKER, opts.concurrency);
  console.log(`Running full import of ${repoPath}${fullConcurrency > 1 ? ` (${fullConcurrency} workers)` : ''}...`);
  const { runImport } = await import('./import.ts');
  const importArgs = [repoPath];
  if (opts.noEmbed) importArgs.push('--no-embed');
  if (fullConcurrency > 1) importArgs.push('--workers', String(fullConcurrency));
  const result = await runImport(engine, importArgs, { commit: headCommit });

  // Bug 9 — gate the full-sync bookmark on success. runImport already
  // writes its own sync.last_commit conditionally (import.ts), but
  // performFullSync is called on first-sync + force-full paths where
  // the sync module owns the last_commit write. Respect the same gate.
  if (result.failures.length > 0) {
    recordSyncFailures(result.failures, headCommit);
    const codeBreakdown = formatCodeBreakdown(result.failures);
    if (!opts.skipFailed) {
      console.error(
        `\nFull sync blocked: ${result.failures.length} file(s) failed:\n` +
        `${codeBreakdown}\n\n` +
        `Fix the YAML in those files and re-run, or use '--skip-failed'.`,
      );
      await engine.setConfig('sync.last_run', new Date().toISOString());
      await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
      return {
        status: 'blocked_by_failures',
        fromCommit: null,
        toCommit: headCommit,
        added: 0, modified: 0, deleted: 0, renamed: 0,
        chunksCreated: result.chunksCreated,
        embedded: 0,
        pagesAffected: [],
        failedFiles: result.failures.length,
      };
    }
    const acked = acknowledgeSyncFailures();
    if (acked.count > 0) {
      console.error(
        `  Acknowledged ${acked.count} failure(s) and advancing past them:\n` +
        `${formatCodeBreakdown(acked.summary)}`,
      );
    }
  }

  // Persist sync state so next sync is incremental (C1 fix: was missing).
  // v0.18.0 Step 5: routed through writeSyncAnchor so --source pins it
  // to the right sources row rather than the global config.
  await writeSyncAnchor(engine, opts.sourceId, 'last_commit', headCommit);
  await engine.setConfig('sync.last_run', new Date().toISOString());
  await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
  // v0.20.0 Cathedral II Layer 12: persist chunker version for the gate.
  await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));

  // Full sync doesn't track pagesAffected, so fall back to embed --stale.
  // Before commit 2: runEmbed is void; use result.imported as best estimate of
  // pages touched. Commit 2 sharpens this with real EmbedResult counts.
  let embedded = 0;
  if (!opts.noEmbed) {
    try {
      const { runEmbed } = await import('./embed.ts');
      await runEmbed(engine, ['--stale']);
      embedded = result.imported;
    } catch { /* embedding is best-effort */ }
  }

  return {
    status: 'first_sync',
    fromCommit: null,
    toCommit: headCommit,
    added: result.imported,
    modified: 0,
    deleted: 0,
    renamed: 0,
    chunksCreated: result.chunksCreated,
    embedded,
    pagesAffected: [],
  };
}

export async function runSync(engine: BrainEngine, args: string[]) {
  const repoPath = args.find((a, i) => args[i - 1] === '--repo') || undefined;
  const watch = args.includes('--watch');
  const intervalStr = args.find((a, i) => args[i - 1] === '--interval');
  const interval = intervalStr ? parseInt(intervalStr, 10) : 60;
  const dryRun = args.includes('--dry-run');
  const full = args.includes('--full');
  const noPull = args.includes('--no-pull');
  const noEmbed = args.includes('--no-embed');
  const skipFailed = args.includes('--skip-failed');
  const retryFailed = args.includes('--retry-failed');
  const syncAll = args.includes('--all');
  const jsonOut = args.includes('--json');
  const yesFlag = args.includes('--yes');
  const strategyArg = args.find((a, i) => args[i - 1] === '--strategy') as SyncOpts['strategy'] | undefined;
  const concurrencyStr = args.find((a, i) => args[i - 1] === '--concurrency' || args[i - 1] === '--workers');
  // v0.22.13 (PR #490 Q2): parseWorkers throws on '0', '-3', 'foo', '1.5' instead
  // of silently falling through to auto-concurrency or NaN. Loud failure beats
  // a 4-worker spawn from a typo.
  let concurrency: number | undefined;
  try {
    concurrency = parseWorkers(concurrencyStr);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // v0.18.0 Step 5: --source resolves to a sources(id) row. Falls back
  // to pre-v0.17 global config (sync.repo_path + sync.last_commit) when
  // no flag, no env, no dotfile is present.
  const explicitSource = args.find((a, i) => args[i - 1] === '--source') || null;
  let sourceId: string | undefined = undefined;
  if (explicitSource || process.env.GBRAIN_SOURCE) {
    const { resolveSourceId } = await import('../core/source-resolver.ts');
    sourceId = await resolveSourceId(engine, explicitSource);
  }

  // v0.19.0 — `sync --all` iterates all registered sources with a
  // local_path. Sources are the canonical v0.18.0 abstraction: per-source
  // last_commit, last_sync_at, config.federated flags. Per-source
  // bookmarks live in the sources table (not ~/.gbrain/config.json),
  // which is why this path replaced Garry's OpenClaw `multi-repo.ts` shim.
  //
  // Only sources with a non-null local_path participate. A GitHub-only
  // source (no checkout) has nothing for `sync` to pull. Sources with
  // syncEnabled=false in config.jsonb are skipped too.
  if (syncAll) {
    const sources = await engine.executeRaw<{ id: string; name: string; local_path: string | null; config: Record<string, unknown> }>(
      `SELECT id, name, local_path, config FROM sources WHERE local_path IS NOT NULL`,
    );
    if (!sources || sources.length === 0) {
      console.log('No sources with local_path configured. Use `gbrain sources add <id> --path <path>` first.');
      return;
    }

    // v0.20.0 Cathedral II Layer 8 D1 — cost preview + ConfirmationRequired
    // gate. Before kicking off a multi-source sync that may embed tens of
    // thousands of chunks (real money), walk the sync-diff set(s), sum
    // tokens, compute USD estimate, and gate:
    //   - TTY + !json + !yes → interactive [y/N] prompt
    //   - non-TTY OR --json OR piped → emit ConfirmationRequired envelope,
    //     exit 2 (reserve 1 for runtime errors)
    //   - --yes → skip prompt entirely
    //   - --dry-run → preview + exit 0
    // Skipped entirely when --no-embed is set (user already opted out of
    // the cost and will run `embed --stale` later).
    if (!noEmbed) {
      const preview = estimateSyncAllCost(sources);
      const costUsd = estimateEmbeddingCostUsd(preview.totalTokens);
      const previewMsg =
        `sync --all preview: ${preview.totalFiles} files across ${preview.activeSources} source(s), ` +
        `~${preview.totalTokens.toLocaleString()} tokens, est. $${costUsd.toFixed(2)} on ${EMBEDDING_MODEL}.`;

      if (dryRun) {
        if (jsonOut) {
          console.log(JSON.stringify({ status: 'dry_run', preview, costUsd, model: EMBEDDING_MODEL }));
        } else {
          console.log(previewMsg);
          console.log('--dry-run: exit without syncing.');
        }
        return;
      }

      if (!yesFlag) {
        const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
        if (!isTTY || jsonOut) {
          // Agent-facing path: emit structured envelope, exit 2.
          const envelope = serializeError(errorFor({
            class: 'ConfirmationRequired',
            code: 'cost_preview_requires_yes',
            message: previewMsg,
            hint: 'Pass --yes to proceed, or --dry-run to see the preview and exit 0.',
          }));
          console.log(JSON.stringify({ error: envelope, preview, costUsd, model: EMBEDDING_MODEL }));
          process.exit(2);
        }
        // Interactive TTY path: prompt [y/N].
        console.log(previewMsg);
        const answer = await promptYesNo('Proceed? [y/N] ');
        if (!answer) {
          console.log('Cancelled.');
          return;
        }
      }
    }

    for (const src of sources) {
      const cfg = (src.config || {}) as { syncEnabled?: boolean; strategy?: 'markdown' | 'code' | 'auto' };
      if (cfg.syncEnabled === false) {
        console.log(`Skipping disabled source: ${src.name}`);
        continue;
      }
      console.log(`\n--- Syncing source: ${src.name} ---`);
      const repoOpts: SyncOpts = {
        repoPath: src.local_path!,
        dryRun, full, noPull, noEmbed, skipFailed, retryFailed,
        sourceId: src.id,
        strategy: cfg.strategy,
        concurrency,
      };
      try {
        const result = await performSync(engine, repoOpts);
        printSyncResult(result);
        // Codex P2: --all loop must also manage .gitignore per-source. Without
        // this, multi-source users who rely on `gbrain sync --all` never get
        // the advertised db_only ignore rules unless they sync each repo
        // individually.
        if (result.status !== 'dry_run' && result.status !== 'blocked_by_failures') {
          manageGitignore(src.local_path!, engine.kind);
        }
      } catch (e: unknown) {
        console.error(`Error syncing ${src.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return;
  }

  const opts: SyncOpts = { repoPath, dryRun, full, noPull, noEmbed, skipFailed, retryFailed, sourceId, strategy: strategyArg, concurrency };

  // Bug 9 — --retry-failed: before running normal sync, clear acknowledgment
  // flags so the sync picks them up as fresh work. The actual re-attempt
  // happens inside the regular incremental/full loop because once the commit
  // pointer is behind the failures, the diff naturally revisits them.
  if (retryFailed) {
    const failures = unacknowledgedSyncFailures();
    if (failures.length === 0) {
      console.log('No unacknowledged sync failures to retry.');
    } else {
      console.log(`Retrying ${failures.length} previously-failed file(s)...`);
      // Don't acknowledge them yet — they must succeed to clear.
    }
  }

  if (!watch) {
    const result = await performSync(engine, opts);
    printSyncResult(result);
    // Issue #2 + eng-review pass-2 finding #1 + Codex P1: manage .gitignore ONLY
    // on successful sync. Skip on dry-run (don't mutate disk in preview mode)
    // and blocked_by_failures (sync state is inconsistent — defer .gitignore
    // until next clean run). Resolve the effective repo path so the wire-up
    // fires in the common case where the user runs `gbrain sync` without
    // passing --repo every time.
    if (result.status !== 'dry_run' && result.status !== 'blocked_by_failures') {
      const effectiveRepoPath = opts.repoPath ?? (await getDefaultSourcePath(engine));
      if (effectiveRepoPath) {
        manageGitignore(effectiveRepoPath, engine.kind);
      }
    }
    return;
  }

  // Watch mode
  let consecutiveErrors = 0;
  console.log(`Watching for changes every ${interval}s... (Ctrl+C to stop)`);

  while (true) {
    try {
      const result = await performSync(engine, { ...opts, full: false });
      consecutiveErrors = 0;
      if (result.status === 'synced') {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[${ts}] Synced: +${result.added} ~${result.modified} -${result.deleted} R${result.renamed}`);
      }
      // Same gate as non-watch: only manage .gitignore on successful sync.
      // Same repo-resolution path so watch mode catches the implicit-resolved case.
      if (result.status !== 'dry_run' && result.status !== 'blocked_by_failures') {
        const effectiveRepoPath = opts.repoPath ?? (await getDefaultSourcePath(engine));
        if (effectiveRepoPath) {
          manageGitignore(effectiveRepoPath, engine.kind);
        }
      }
    } catch (e: unknown) {
      consecutiveErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${new Date().toISOString().slice(11, 19)}] Sync error (${consecutiveErrors}/5): ${msg}`);
      if (consecutiveErrors >= 5) {
        console.error(`5 consecutive sync failures. Stopping watch.`);
        process.exit(1);
      }
    }
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

/**
 * Auto-manage .gitignore entries for db_only directories.
 *
 * Caller invokes ONLY on successful sync — this function trusts that the
 * sync's data state is consistent. See `runSync` for the gating logic.
 *
 * Idempotent: re-running adds no duplicate entries. The managed block has
 * a stable comment header so it's grep-able and editable.
 *
 * Skipped (with actionable warning) when:
 *   - GBRAIN_NO_GITIGNORE=1 — D23 escape hatch for shared-repo setups
 *   - The repo is a git submodule (`.git` is a file not a directory) —
 *     D49 lock; submodule .gitignore changes don't survive parent updates
 *
 * On PGLite (D4): emits a once-per-process soft-warn explaining that
 * tiering has limited effect — but still manages the .gitignore so the
 * config-present user gets the gitignore housekeeping.
 *
 * Failures (write permission denied, EROFS, etc.) are caught, warned, and
 * swallowed (D9 lock). Sync's primary job is moving data; .gitignore
 * management is a side effect — don't kill the main job for the side effect.
 */
let _pgliteTierWarned = false;
export function __resetPGLiteTierWarn(): void {
  _pgliteTierWarned = false;
}

export function manageGitignore(
  repoPath: string,
  engineKind?: 'pglite' | 'postgres',
): void {
  if (process.env.GBRAIN_NO_GITIGNORE === '1') {
    return;
  }

  // D49: submodule detection. In a submodule, `.git` is a regular file
  // (containing `gitdir: ../path/to/parent.git/modules/x`), not a directory.
  const dotGit = join(repoPath, '.git');
  if (existsSync(dotGit)) {
    try {
      if (statSync(dotGit).isFile()) {
        console.warn(
          `Note: skipping .gitignore management — ${repoPath} is a git submodule. ` +
            `Add db_only directories to your parent repo's .gitignore manually.`,
        );
        return;
      }
    } catch {
      // proceed; can't tell, default to managing
    }
  }

  let storageConfig;
  try {
    storageConfig = loadStorageConfig(repoPath);
  } catch (error) {
    // StorageConfigError (overlap) or read error — surface, don't manage.
    console.warn(
      `Skipped .gitignore update: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!storageConfig || storageConfig.db_only.length === 0) {
    return;
  }

  // D4 soft-warn: storage tiering has limited effect on PGLite, but the
  // .gitignore housekeeping still helps. Warn once per process; proceed.
  if (engineKind === 'pglite' && !_pgliteTierWarned) {
    _pgliteTierWarned = true;
    console.warn(
      `Note: storage tiering has limited effect on PGLite — pages live in your ` +
        `local database file regardless of tier. Managing .gitignore anyway.`,
    );
  }

  const gitignorePath = join(repoPath, '.gitignore');
  let gitignoreContent = '';

  if (existsSync(gitignorePath)) {
    try {
      gitignoreContent = readFileSync(gitignorePath, 'utf-8');
    } catch (error) {
      console.warn(
        `Could not read ${gitignorePath} (${error instanceof Error ? error.message : String(error)}) — ` +
          `skipping .gitignore update. Add db_only directories manually.`,
      );
      return;
    }
  }

  const existingLines = new Set(gitignoreContent.split('\n').map((line) => line.trim()));
  const linesToAdd: string[] = [];

  for (const dir of storageConfig.db_only) {
    if (!existingLines.has(dir) && !existingLines.has(`/${dir}`)) {
      linesToAdd.push(dir);
    }
  }

  if (linesToAdd.length === 0) return;

  if (gitignoreContent && !gitignoreContent.endsWith('\n')) {
    gitignoreContent += '\n';
  }
  gitignoreContent += '\n# Auto-managed by gbrain (db_only directories)\n';
  gitignoreContent += linesToAdd.join('\n') + '\n';

  try {
    writeFileSync(gitignorePath, gitignoreContent);
  } catch (error) {
    console.warn(
      `Could not update ${gitignorePath} (${error instanceof Error ? error.message : String(error)}) — ` +
        `please add db_only directories manually:\n  ${linesToAdd.join('\n  ')}`,
    );
  }
}

function printSyncResult(result: SyncResult) {
  switch (result.status) {
    case 'up_to_date':
      console.log('Already up to date.');
      break;
    case 'synced':
      console.log(`Synced ${result.fromCommit?.slice(0, 8)}..${result.toCommit.slice(0, 8)}:`);
      console.log(`  +${result.added} added, ~${result.modified} modified, -${result.deleted} deleted, R${result.renamed} renamed`);
      console.log(`  ${result.chunksCreated} chunks created${result.embedded > 0 ? `, ${result.embedded} pages embedded` : ''}`);
      break;
    case 'first_sync':
      console.log(`First sync complete. Checkpoint: ${result.toCommit.slice(0, 8)}`);
      console.log(`  ${result.added} file(s) imported, ${result.chunksCreated} chunks${result.embedded > 0 ? `, ${result.embedded} pages embedded` : ''}`);
      break;
    case 'dry_run':
      break; // already printed in performSync
    case 'blocked_by_failures':
      console.log(`Sync BLOCKED at ${result.toCommit.slice(0, 8)}: ${result.failedFiles ?? 0} file(s) failed to parse.`);
      console.log(`  See ~/.gbrain/sync-failures.jsonl for details, or run 'gbrain doctor'.`);
      console.log(`  Fix the files then re-run 'gbrain sync', or 'gbrain sync --skip-failed' to move on.`);
      break;
  }
}
