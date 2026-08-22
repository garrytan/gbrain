import { readdirSync, lstatSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { cpus, totalmem } from 'os';
import type { BrainEngine } from '../core/engine.ts';
import { importFile, importImageFile, isImageFilePath } from '../core/import-file.ts';
import { loadConfig, gbrainPath } from '../core/config.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import {
  hasMalformedPathSegment,
  sanitizePathForDisplay,
  isCodeFilePath,
  isMarkdownFilePath,
  isImageFilePath as isImageFilePathFromSync,
  matchesAnyGlob,
  pruneDir,
  SYNC_SKIP_FILES,
  type SyncStrategy,
} from '../core/sync.ts';
import { sortNewestFirst } from '../core/sort-newest-first.ts';
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  resolveImportTargetDir,
  resumeFilter,
} from '../core/import-checkpoint.ts';
import { realpathOrResolve } from '../core/path-confine.ts';

/** Return a refusal when an import target lies outside every admitted root. */
export function configuredRootImportError(dir: string, configuredRoots: string[]): string | null {
  if (configuredRoots.length === 0) return null;
  const target = realpathOrResolve(dir);
  const admitted = configuredRoots.some((candidate) => {
    const root = realpathOrResolve(candidate);
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
  if (admitted) return null;
  return (
    `Import root ${target} is not under the configured root for the destination source ` +
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- error-message hint construction, no fs operation
        `(${configuredRoots.map((root) => resolve(root)).join(', ')}). ` +
    `Pass --allow-noncanonical-root to override deliberately.`
  );
}

/** Resolve only roots belonging to the selected import destination. */
export async function listConfiguredRoots(
  engine: BrainEngine,
  destinationSourceId: string,
): Promise<string[]> {
  const roots: string[] = [];
  try {
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = $1`,
      [destinationSourceId],
    );
    for (const row of rows) if (row.local_path) roots.push(resolve(row.local_path)); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- resolves REGISTERED roots to build the containment allowlist (#4388 guard)
    if (destinationSourceId === 'default') {
      const legacyRoot = await engine.getConfig('sync.repo_path');
      if (legacyRoot) roots.push(resolve(legacyRoot)); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- same: registered root canonicalization for the guard allowlist
    }
  } catch (error) {
    throw new Error(
      `Cannot determine configured source roots: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return [...new Set(roots)];
}

/**
 * Records one failed file against the run's error-grouping state and
 * returns the running count for its group plus an unredacted sample
 * message for display.
 *
 * `key` groups structurally-identical errors (e.g. the same failure
 * across many files) so a single noisy failure mode doesn't produce
 * thousands of near-duplicate warning lines — quoted substrings (typically
 * a per-file slug or path) are blanked for the GROUPING key only. The
 * printed `sample` is always a real, unredacted occurrence of the error
 * (the first one seen for that key), so identifying details that are
 * constant across the whole group — a Postgres table or constraint name,
 * for instance — survive into what actually gets shown to the user.
 * Pre-fix, the redacted key itself was printed, so e.g. a `pages_source_id_fkey`
 * foreign-key violation surfaced as `table "" violates foreign key constraint ""`.
 */
export function recordImportFailure(
  errorCounts: Record<string, number>,
  errorSamples: Record<string, string>,
  msg: string,
): { key: string; count: number; sample: string } {
  const key = msg.replace(/"[^"]*"/g, '""');
  const count = (errorCounts[key] ?? 0) + 1;
  errorCounts[key] = count;
  if (!(key in errorSamples)) errorSamples[key] = msg;
  return { key, count, sample: errorSamples[key] };
}

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

/**
 * W0 fix-wave (Tier-1 #5): typed abort for runImport's preflight/argv
 * failures. Pre-fix these five sites called process.exit(1) directly —
 * correct for the CLI, but runImport is ALSO invoked in-process by the
 * sync_brain MCP op (via performFullSync), the autopilot daemon, and the
 * minion sync handler, so a first sync with unconfigured embedding
 * credentials TERMINATED the MCP server / daemon / worker mid-call. The
 * user-facing messages are printed BEFORE the throw (byte-identical CLI
 * output); the CLI dispatch site maps this error back to exit(exitCode).
 */
export class ImportAbortError extends Error {
  readonly exitCode: number;
  /** True: the user-facing message was already printed at the throw site. */
  readonly alreadyReported = true;
  constructor(reason: string, exitCode = 1) {
    super(`import aborted: ${reason}`);
    this.name = 'ImportAbortError';
    this.exitCode = exitCode;
  }
}

/**
 * #3969 — a poll that changed nothing is not an ingest event. Cron-driven
 * `import`/`sync` against a mostly-static tree was writing an ingest_log row
 * every run ("Imported 0 pages, N skipped, 0 chunks" — 93% of rows on a
 * 15-minute cadence), burying real events past get_ingest_log's default
 * LIMIT 20. Shared by runImport (directory imports) and performSync (git
 * syncs). `logNoop` (CLI `--log-noop`) opts back into per-poll rows for
 * deployments using them as a liveness signal.
 */
export function shouldLogIngest(
  counts: { imported: number; errors: number; chunksCreated: number },
  logNoop: boolean,
): boolean {
  if (logNoop) return true;
  return counts.imported > 0 || counts.errors > 0 || counts.chunksCreated > 0;
}

/** Bug 9 — surface per-file failures so callers (performFullSync) can gate state advances. */
export interface RunImportResult {
  imported: number;
  skipped: number;
  errors: number;
  chunksCreated: number;
  failures: Array<{ path: string; error: string }>;
  /** Files dropped by the malformed-filename gate (walker + per-file defense). */
  malformedSkipped?: number;
  /** Aggregated alias/undeclared explicit-type warnings (schema.type_warnings). */
  type_warnings?: Array<{ kind: 'alias_of' | 'undeclared'; type: string; canonical?: string; directory?: string; count: number }>;
}

export async function runImport(
  engine: BrainEngine,
  args: string[],
  opts: {
    commit?: string;
    strategy?: SyncStrategy;
    sourceId?: string;
    managedBookmark?: boolean;
    /**
     * #753/#774: glob patterns to exclude from the import (same semantics as
     * `isSyncable`'s `exclude` — matched against the dir-relative path).
     * Threaded by performFullSync for `gbrain sync --exclude`.
     */
    exclude?: string[];
    /**
     * Opt out of the git-visible fast path and walk the filesystem directly,
     * so markdown/code files matched by .gitignore can still be imported.
     */
    includeGitignored?: boolean;
    /**
     * #753/#774 monorepo subdir-source support: when set, slugs and
     * `source_path` are computed relative to this root (the git repo root)
     * instead of `dir` (the sync scope), so `wiki/page1.md` lands as slug
     * `wiki/page1` consistently across full and incremental sync.
     */
    slugRoot?: string;
  } = {},
): Promise<RunImportResult> {
  const noEmbed = args.includes('--no-embed');
  const allowNoncanonicalRoot = args.includes('--allow-noncanonical-root');
  const fresh = args.includes('--fresh');
  const jsonOutput = args.includes('--json');
  // #3969: opt back into per-poll ingest_log rows (default: no-op runs skip the write).
  const logNoop = args.includes('--log-noop');
  const includeGitignored = args.includes('--include-gitignored') || opts.includeGitignored === true;

  // #3637: under --json, stdout belongs to the JSON document alone. The
  // informational lines below are useful — they just belong on the other
  // channel, the same rule progress already follows (CLAUDE.md: "Progress
  // always writes to stderr. Stdout stays clean for data output (--json
  // payloads)"). Pre-fix, `import --json` prefixed the payload with
  // "Found N markdown files", so JSON.parse of stdout failed outright.
  const info = (msg: string): void => {
    if (jsonOutput) console.error(msg);
    else console.log(msg);
  };

  // T7 (D9): refuse cleanly when init persisted the deferred-setup sentinel,
  // unless the user is explicitly skipping embedding via `--no-embed` (in
  // which case the chunks land without vectors and the user can backfill
  // later with `gbrain embed --stale` after configuring a provider).
  if (!noEmbed) {
    const { assertEmbeddingEnabled } = await import('../core/embedding-dim-check.ts');
    const { loadConfig } = await import('../core/config.ts');
    try {
      assertEmbeddingEnabled(loadConfig());
    } catch (e) {
      console.error(`\n${e instanceof Error ? e.message : e}`);
      console.error('Tip: run `gbrain import <dir> --no-embed` to import without embedding now.');
      throw new ImportAbortError('embedding disabled (deferred-setup sentinel)');
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
        throw new ImportAbortError('embedding credentials missing');
      }
      throw e;
    }
  }
  // v0.39 T1.5: load active pack ONCE at runImport entry; thread to every
  // per-file importFile call below. Codex perf finding #7 — never per-file.
  let importActivePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string> }> } | undefined;
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
  const sourceIdIdx = args.indexOf('--source-id');
  const flagSourceId = sourceIdIdx !== -1 ? args[sourceIdIdx + 1] : null;
  let sourceId: string | undefined = flagSourceId ?? opts.sourceId;

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
  if (!sourceId && process.env.GBRAIN_SOURCE) {
    const { resolveSourceId } = await import('../core/source-resolver.ts');
    sourceId = await resolveSourceId(engine, null);
  } else if (!sourceId) {
    const { resolveSourceWithTier, formatSoleNonDefaultNudge } = await import('../core/source-resolver.ts');
    const resolved = await resolveSourceWithTier(engine, null);
    // Only adopt the resolution when it improves on the seed_default
    // fallback — that preserves the v0.30.x "default-only when unset"
    // contract for the common case AND opens the sole_non_default
    // auto-route for the single-source-brain case.
    if (resolved.tier === 'sole_non_default') {
      sourceId = resolved.source_id;
      const nudge = formatSoleNonDefaultNudge(sourceId);
      if (nudge) process.stderr.write(nudge + '\n');
    }
  }
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
    throw new ImportAbortError('invalid --workers value');
  }
  // Find dir: first non-flag arg that isn't a value for --workers
  const flagValues = new Set<number>();
  if (workersIdx !== -1) flagValues.add(workersIdx + 1);
  if (sourceIdIdx !== -1) flagValues.add(sourceIdIdx + 1);
  const dirArg = args.find((a, i) => !a.startsWith('--') && !flagValues.has(i));

  if (!dirArg) {
    console.error('Usage: gbrain import <dir> [--no-embed] [--workers N] [--fresh] [--source-id <id>] [--include-gitignored] [--allow-noncanonical-root] [--json]');
    throw new ImportAbortError('no import directory given');
  }
  // #1728: capture the import target ONCE as an absolute real path. Every
  // downstream consumer of `dir` (collection, checkpoint load/save, resume
  // filtering) sees the same canonical identity — never the caller's `.`/
  // relative spelling, which would make the persisted checkpoint `dir`
  // resolve against whatever CWD a later process happens to run from.
  let dir: string;
  try {
    dir = resolveImportTargetDir(dirArg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Import target is not readable: ${dirArg} (${msg})`);
    throw new ImportAbortError(`import target not readable: ${dirArg}`);
  }

  if (!allowNoncanonicalRoot) {
    try {
      const strictRoot = (await engine.getConfig('import.require_configured_root')) === 'true';
      if (strictRoot) {
        const configuredRoots = await listConfiguredRoots(engine, sourceId ?? 'default');
        if (configuredRoots.length === 0) {
          console.error(
            'import.require_configured_root is enabled but the destination source has no configured root. ' +
            'Configure its local_path or pass --allow-noncanonical-root deliberately.',
          );
          throw new ImportAbortError('configured-root admission has no destination root');
        }
        const refusal = configuredRootImportError(dir, configuredRoots);
        if (refusal) {
          console.error(refusal);
          throw new ImportAbortError('import target is outside the configured destination root');
        }
      }
    } catch (error) {
      if (error instanceof ImportAbortError) throw error;
      console.error(
        `Cannot evaluate configured-root admission: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Pass --allow-noncanonical-root to bypass deliberately.`,
      );
      throw new ImportAbortError('configured-root admission failed closed');
    }
  }

  // v0.31.2: collect under the right strategy. Pre-fix this called
  // collectMarkdownFiles unconditionally — code-strategy first sync
  // silently no-op'd because no code file ever made it through walker
  // enumeration (codex C11 confirms dispatch was correct; bug was here).
  const strategy: SyncStrategy = opts.strategy ?? 'markdown';
  const _walkT0 = Date.now();
  console.error(`[gbrain phase] import.collect_files start dir=${dir} strategy=${strategy}`);
  const malformedExcluded: string[] = [];
  let allFiles = collectSyncableFiles(dir, {
    strategy, includeGitignored,
    onExcluded: (rel) => { malformedExcluded.push(rel); },
  });
  console.error(
    `[gbrain phase] import.collect_files done ${Date.now() - _walkT0}ms files=${allFiles.length}`,
  );
  if (malformedExcluded.length > 0) {
    console.error(
      `[gbrain import] ${malformedExcluded.length} file(s) skipped: malformed filename ` +
      `(brackets/control chars; rename to import): ` +
      malformedExcluded.slice(0, 20).map(sanitizePathForDisplay).join(', ') +
      (malformedExcluded.length > 20 ? `, … (+${malformedExcluded.length - 20} more)` : ''),
    );
  }
  const fileTypeLabel = strategy === 'code' ? 'code'
    : strategy === 'auto' ? 'syncable' : 'markdown';
  // #753/#774: apply --exclude glob patterns (threaded by performFullSync).
  if (opts.exclude && opts.exclude.length > 0) {
    const beforeExclude = allFiles.length;
    allFiles = allFiles.filter(abs => !matchesAnyGlob(relative(dir, abs), opts.exclude));
    info(
      `Found ${allFiles.length} ${fileTypeLabel} files ` +
      `(${beforeExclude - allFiles.length} excluded by --exclude patterns)`,
    );
    // NAV-4: everything excluded is almost always a mistyped pattern — warn.
    if (beforeExclude > 0 && allFiles.length === 0) {
      console.warn(
        `[gbrain sync] No files matched after applying ${opts.exclude.length} --exclude pattern(s). ` +
        `Check your --exclude flags. Patterns: ${JSON.stringify(opts.exclude)}`,
      );
    }
  } else {
    info(`Found ${allFiles.length} ${fileTypeLabel} files`);
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
      info(`Resuming from checkpoint: skipping ${completed.size} already-processed files`);
    }
  }
  const files = resumeFilter(allFiles, dir, completed);

  // Determine actual worker count
  const actualWorkers = workerCount > 1 ? workerCount : 1;
  if (actualWorkers > 1) {
    info(`Using ${actualWorkers} parallel workers`);
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  // Per-file malformed skips (defense-in-depth hits inside importFromFile);
  // the walker-level exclusions are counted separately via malformedExcluded.
  let malformedFileSkips = 0;
  let processed = 0;
  // Time-based checkpoint floor (see the save site below). Chunking cost scales
  // with paragraph count, not bytes, so a single reference-style file can take
  // many minutes; a count-only trigger leaves that work undurable.
  const CHECKPOINT_MAX_INTERVAL_MS = 120_000;
  let lastCheckpointMs = Date.now();
  let lastCheckpointSize = completed.size;
  let chunksCreated = 0;
  const importedSlugs: string[] = [];
  const errorCounts: Record<string, number> = {};
  const errorSamples: Record<string, string> = {};
  const failures: Array<{ path: string; error: string }> = []; // Bug 9
  // Alias-footgun visibility: aggregate per-file type_warning results once
  // per distinct type per run (same surface `gbrain sync` carries).
  const typeWarningCounts = new Map<string, import('../core/schema-pack/type-usage.ts').TypeWarningCount>();
  const noteTypeWarning = (w: { kind: 'alias_of' | 'undeclared'; type: string; canonical?: string; directory?: string } | undefined): void => {
    if (!w) return;
    const key = `${w.kind}\t${w.type}`;
    const cur = typeWarningCounts.get(key);
    if (cur) cur.count++;
    else typeWarningCounts.set(key, { ...w, count: 1 });
  };
  // #3839: paths that succeeded (imported OR unchanged) this run, keyed the
  // same way as `failures` above (importRelPath) so a path that failed on a
  // prior run and now succeeds clears its ledger row instead of staying
  // `open` forever.
  const succeededPaths: string[] = [];
  const startTime = Date.now();

  // Progress on stderr so stdout stays clean for the final summary / --json payload.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('import.files', files.length);

  function tickProgress() {
    progress.tick(1, `imported=${imported} skipped=${skipped} errors=${errors}`);
  }

  async function processFile(eng: BrainEngine, filePath: string) {
    const relativePath = relative(dir, filePath);
    // #753/#774: slug + source_path base. When performFullSync syncs a
    // monorepo subdir, slugRoot is the git root so slugs stay git-root-
    // relative (matching the incremental path's git-diff paths). The
    // checkpoint (`completed`) stays dir-relative — resumeFilter's contract.
    const importRelPath = opts.slugRoot ? relative(opts.slugRoot, filePath) : relativePath;
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
        ? await importImageFile(eng, filePath, importRelPath, { noEmbed, sourceId })
        : await importFile(eng, filePath, importRelPath, { noEmbed, sourceId, activePack: importActivePack });
      noteTypeWarning((result as { type_warning?: Parameters<typeof noteTypeWarning>[0] }).type_warning);
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
        succeededPaths.push(importRelPath); // #3839
      } else {
        skipped++;
        if (result.skip_reason === 'malformed_path') {
          // Informational skip (bracket/control-char filename): never a
          // failure-ledger row, and stable across runs — checkpoint as done.
          console.error(`  Skipped (malformed filename — rename to import): ${sanitizePathForDisplay(relativePath)}`);
          malformedFileSkips++;
          completed.add(relativePath);
        } else if (result.error && result.error !== 'unchanged') {
          console.error(`  Skipped ${relativePath}: ${result.error}`);
          // Bug 9 — non-"unchanged" skips carry a real error reason.
          // #774: ledger paths use the slug base so an incremental sync's
          // success at the same (git-root-relative) path clears the row.
          failures.push({ path: importRelPath, error: result.error });
        } else {
          // 'unchanged' or no-error skip: content_hash matched a prior
          // successful import, so this file IS done for checkpoint purposes.
          completed.add(relativePath);
          succeededPaths.push(importRelPath); // #3839
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const { count, sample } = recordImportFailure(errorCounts, errorSamples, msg);
      if (count <= 5) {
        console.error(`  Warning: skipped ${relativePath}: ${msg}`);
      } else if (count === 6) {
        console.error(`  (suppressing further "${sample.slice(0, 60)}..." errors)`);
      }
      errors++;
      skipped++;
      failures.push({ path: importRelPath, error: msg });
    }
    processed++;
    tickProgress();
    // Save checkpoint every 100 SUCCESSFUL adds (not every 100 processed).
    // Failed files never enter `completed`, so a flaky file can't push the
    // checkpoint past it — the next run will retry it.
    // ...and ALSO save on a time interval. On a corpus with an expensive tail
    // `completed` can advance ~1 file per several minutes, so the next
    // 100-boundary may be hours away; any kill before it discards every file
    // since the last boundary and the run can never converge.
    const nowMs = Date.now();
    const dueByCount = completed.size > 0 && completed.size % 100 === 0;
    const dueByTime = completed.size > lastCheckpointSize
      && nowMs - lastCheckpointMs >= CHECKPOINT_MAX_INTERVAL_MS;
    if (dueByCount || dueByTime) {
      lastCheckpointMs = nowMs;
      lastCheckpointSize = completed.size;
      const cpDir = gbrainPath();
      if (!existsSync(cpDir)) {
        try { const { mkdirSync } = await import('fs'); mkdirSync(cpDir, { recursive: true }); }
        catch { /* non-fatal */ }
      }
      saveCheckpoint(checkpointPath, {
        schema_version: 1,
        owner: 'gbrain',
        kind: 'import',
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
  for (const [key, count] of Object.entries(errorCounts)) {
    if (count > 5) {
      console.error(`  ${count} files failed: ${errorSamples[key].slice(0, 100)}`);
    }
  }

  // Final checkpoint save BEFORE the clear/preserve decision below. The
  // periodic triggers above are gated on a 100-file boundary or an interval,
  // so a run that ends between them would otherwise leave its tail unsaved.
  // This must run before clearCheckpoint() so a clean run still ends with no
  // checkpoint file — it only makes the ERROR path's preserved checkpoint
  // complete.
  if (errors > 0 && completed.size > lastCheckpointSize) {
    try {
      const cpDir = gbrainPath();
      if (!existsSync(cpDir)) {
        const { mkdirSync } = await import('fs');
        mkdirSync(cpDir, { recursive: true });
      }
      saveCheckpoint(checkpointPath, {
        schema_version: 1,
        owner: 'gbrain',
        kind: 'import',
        dir,
        completedPaths: Array.from(completed),
        timestamp: new Date().toISOString(),
      });
    } catch { /* non-fatal: the next run simply redoes the tail */ }
  }

  // Clear checkpoint on clean completion. On error, the path-based checkpoint
  // preserves only the successfully-completed paths, so the next run retries
  // failed files automatically (they never entered `completed`).
  if (errors === 0) {
    clearCheckpoint(checkpointPath);
  } else if (existsSync(checkpointPath)) {
    info(`  Checkpoint preserved (${errors} errors). Run again to retry failed files.`);
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

  // Alias/undeclared explicit-type warnings (schema.type_warnings, default on).
  let typeWarningsEnabled = true;
  if (typeWarningCounts.size > 0) {
    try {
      const v = await engine.getConfig('schema.type_warnings');
      typeWarningsEnabled = !(v === 'false' || v === '0' || v === 'off');
    } catch { /* config unavailable → default on */ }
    if (typeWarningsEnabled) {
      const { renderTypeWarningSummary } = await import('../core/schema-pack/type-usage.ts');
      for (const line of renderTypeWarningSummary([...typeWarningCounts.values()])) {
        console.error(`  ${line}`);
      }
      console.error(`  (silence with: gbrain config set schema.type_warnings false)`);
    }
  }

  // Log the ingest. #3969: skip the row when the run changed nothing
  // (imported=0, errors=0, chunks=0) unless --log-noop — see shouldLogIngest.
  if (shouldLogIngest({ imported, errors, chunksCreated }, logNoop)) {
    await engine.logIngest({
      source_type: 'directory',
      source_ref: dir,
      pages_updated: importedSlugs,
      summary: `Imported ${imported} pages, ${skipped} skipped, ${chunksCreated} chunks`,
    });
  }

  // Import → sync continuity: write sync checkpoint if this is a git repo.
  // Bug 9 — gate last_commit on "no failures" so import doesn't silently
  // stomp on the sync bookmark when parsing broke. last_run + repo_path are
  // written alongside it, but ONLY when this import owns the globals (#2114
  // guard below) — a foreign directory must not repoint the brain repo.
  let gitHead: string | null = null;
  try {
    if (existsSync(join(dir, '.git'))) {
      gitHead = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    }
  } catch {
    // Not a git repo or git not available
  }

  // issue #1939: when performFullSync drives runImport it owns the failure
  // ledger + bookmark via the shared gate (applySyncFailureGate). Skipping the
  // internal handling here prevents double-recording (which would double-count
  // the auto-skip `attempts` streak) and a competing bookmark write.
  if (gitHead && !opts.managedBookmark) {
    // Record failures into the central JSONL so doctor can surface them.
    // Use gitHead as the commit so a later sync can tell "same broken
    // state as last time" from "new broken state." Source-scoped (#1939 #2).
    if (failures.length > 0) {
      const { recordFailures } = await import('../core/sync.ts');
      recordFailures(opts.sourceId ?? 'default', failures, gitHead);
    }

    // #3839: a path that failed on a prior run and succeeded (imported or
    // unchanged) this run must clear its ledger row — pre-fix, clearFailures
    // existed but had no caller anywhere, so `open` rows never healed short
    // of a manual `gbrain sync --skip-failed`. Runs on every non-empty
    // success list regardless of whether this SAME run also had failures,
    // so a stale row from an earlier run gets cleared even if today's run
    // is only partially clean.
    if (succeededPaths.length > 0) {
      const { clearFailures } = await import('../core/sync.ts');
      clearFailures(opts.sourceId ?? 'default', succeededPaths);
    }

    // #2114 guard: the global sync.* keys describe THE brain repo (the
    // default source's working tree). Pre-fix this block rewrote them on
    // every git-repo import, silently repointing put_page write-through
    // and poisoning the incremental sync anchor. Ownership + the bootstrap
    // rule live in ownsGlobalSyncAnchor (shared with writeSyncAnchor's
    // legacy branch in sync.ts, so the two layers cannot drift).
    const { ownsGlobalSyncAnchor } = await import('../core/sync.ts');
    const { owns, configured } = await ownsGlobalSyncAnchor(engine, sourceId, dir);

    if (owns) {
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
    } else if ((sourceId ?? 'default') === 'default') {
      console.error(
        `\n[import] sync.repo_path stays at ${configured ?? '(unset)'} — NOT repointing to "${dir}". ` +
        `Sync bookmarks were not advanced. If this directory IS your brain repo, run: ` +
        `gbrain config set sync.repo_path "${dir}"`,
      );
    }
    // Non-default sources: deliberately silent no-op — the globals are not
    // this import's to move (its sync anchors live on the `sources` row).
  }

  const totalMalformed = malformedExcluded.length + malformedFileSkips;
  return {
    imported, skipped, errors, chunksCreated, failures,
    ...(totalMalformed > 0 ? { malformedSkipped: totalMalformed } : {}),
    ...(typeWarningCounts.size > 0 && typeWarningsEnabled
      ? { type_warnings: [...typeWarningCounts.values()] }
      : {}),
  };
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
  includeGitignored?: boolean;
  /**
   * Invoked (with the repo-relative path) for each file dropped by the
   * malformed-filename gate, on BOTH collection routes. Without this,
   * directory imports and full syncs silently succeed while omitting the
   * file — no rename guidance, no skipped count (structured-review finding).
   */
  onExcluded?: (relPath: string) => void;
}

/**
 * v0.27.1 + v0.31.2: walker-context image admission. `isSyncable` (the
 * incremental-diff filter at sync.ts:213) admits images only on `auto`.
 * The first-sync walker historically admitted them on markdown too when
 * `GBRAIN_EMBEDDING_MULTIMODAL=true`. Codex (C5) flagged the contradiction
 * — preserve the walker semantic explicitly.
 *
 * Closes #345: exclude `SYNC_SKIP_FILES` metafiles
 * (`README.md` / `index.md` / `log.md` / `schema.md` / `RESOLVER.md`).
 * Incremental `sync` skips these via `isSyncable`, but the bulk-import
 * walker only filtered by extension — so a directory import imported every
 * directory README as a page, titled by its folder ("People", "Companies",
 * …). Those index-titled pages then trigram-corrupt fuzzy entity resolution
 * (any `people/X` slug matches the "People" page) and inflate orphan count.
 * Funnel both admission paths through the same metafile exclusion so import
 * and sync agree on what is a page.
 */
function isCollectibleForWalker(
  path: string,
  strategy: SyncStrategy,
  multimodalOn: boolean,
): boolean {
  // #2607: apply the SAME segment-level prune gate as incremental sync's
  // `classifySync` (core/sync.ts). The FS walk below prunes at descent time,
  // but the git fast path enumerates via `git ls-files` and historically
  // filtered only by extension — so `sync --full` imported (and resurrected
  // previously-deleted) pages under dot-dirs / vendored trees that incremental
  // sync excludes. Full and incremental must agree on the exclusion set.
  // (In the FS-walk route `path` is a basename, so this is the same dot-file
  // check pruneDir already applied there — no behavior change on that route.)
  const segments = path.split('/');
  if (segments.some((seg) => !pruneDir(seg))) return false;

  // Malformed filenames (brackets / control chars — markdown-link syntax as a
  // literal filename) are rejected on BOTH collection routes, same as
  // incremental sync's classifySync. Full and incremental must agree.
  if (hasMalformedPathSegment(path)) return false;

  // Metafiles are directory scaffolding (READMEs / index / log / schema /
  // resolver), not typed brain pages — same exclusion `sync`'s `isSyncable`
  // applies. Guards both the FS-walk and the git-fast-path collection routes.
  const basename = segments[segments.length - 1] || '';
  if ((SYNC_SKIP_FILES as readonly string[]).includes(basename)) return false;

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
 * Git-aware fast path for `collectSyncableFiles`. Returns the strategy-filtered
 * list of syncable files when `dir` is inside a git work tree (paths absolute,
 * sorted), or `null` when `dir` is not a git repo / git is unavailable — in
 * which case the caller falls back to the recursive FS walk.
 *
 * Honors `.gitignore` (the whole point): `git ls-files --cached --others
 * --exclude-standard` lists tracked + untracked-not-ignored files, so vendored
 * / build / generated trees never reach the importer. `-z` (NUL-delimited)
 * survives paths with spaces/newlines. Each path is lstat-checked to preserve
 * the walker's no-symlink policy and to drop submodule gitlinks (which surface
 * as a single non-regular entry).
 */
function gitListSyncableFiles(
  dir: string,
  strategy: SyncStrategy,
  multimodalOn: boolean,
  onExcluded?: (relPath: string) => void,
): string[] | null {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null; // not a git work tree, or git not on PATH → FS-walk fallback
  }
  const files: string[] = [];
  for (const rel of stdout.split('\0')) {
    if (!rel) continue;
    // Malformed check FIRST (separately from the collectible gate) so the
    // exclusion is reportable — other filters (strategy, prune, metafile)
    // are silent by design; this one hides renameable content.
    if (hasMalformedPathSegment(rel)) { onExcluded?.(rel); continue; }
    if (!isCollectibleForWalker(rel, strategy, multimodalOn)) continue;
    const full = join(dir, rel);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue; // ls-files raced a deletion, or unreadable
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    files.push(full);
  }
  return files.sort();
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

  // v0.42.x (#1159 --respect-gitignore / #1483 .gbrainignore): when `dir` is a
  // git work tree, enumerate via `git ls-files` so the walk honors
  // `.gitignore`. Pre-fix the recursive FS walk below descended into every
  // git-ignored tree — `vendor/` (PHP Composer), `storage/`, `public/build/`,
  // etc. — so a Laravel/PHP repo's `--strategy code` sync tried to import ~50k
  // dependency/build files (and bloated DB + embedding cost on any repo with
  // vendored data/fixtures). `--cached --others --exclude-standard` = tracked
  // PLUS untracked-not-ignored, so uncommitted source is still indexed. Non-git
  // dirs (or git unavailable) fall through to the FS walk below.
  if (!opts.includeGitignored) {
    const gitFiles = gitListSyncableFiles(dir, strategy, multimodalOn, opts.onExcluded);
    if (gitFiles) return gitFiles;
  }

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
      // Descent-time prune through the canonical gate (single source of truth
      // in core/sync.ts) instead of a hand-maintained inline list that drifted
      // from it. Skips hidden dirs (`.git`, `.raw`, etc.), `node_modules`,
      // `vendor`, `dist`, `build`, `venv` (#2020), `ops`, and git submodules.
      if (!pruneDir(entry, d)) continue;
      // Control-char SEGMENT check at descent time (never legitimate). The
      // bracket check moved to the per-file RELATIVE-path test below: a
      // bracket-named DIRECTORY must still be descended for code strategies
      // (`app/[id]/page.tsx` is ubiquitous framework layout), while markdown
      // files under it are excluded per-file — mirroring classifySync so full
      // and incremental sync agree (cross-model adversarial finding).
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f]/.test(entry)) continue;

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
        // Malformed check on the RELATIVE path (this route's
        // isCollectibleForWalker only sees the basename, which can't catch a
        // bracket directory segment above a clean-named markdown file).
        const rel = relative(dir, full);
        if (hasMalformedPathSegment(rel)) { opts.onExcluded?.(rel); continue; }
        if (!isCollectibleForWalker(entry, strategy, multimodalOn)) continue;
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
