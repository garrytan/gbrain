/**
 * Incremental sync preflight (refactor wave 1, W4 sync): resolve the repo and
 * its git root, pull, read the bookmark, resolve the pinned checkpoint target
 * and compute the filtered delta. Every exit before the checkpoint opens is a
 * `done` result (connector source, pre-pull abort, pull timeout, full-sync
 * fallbacks, up_to_date, dry run); otherwise the immutable `SyncPlan` the
 * phases drain.
 */
import { existsSync, realpathSync } from 'fs';
import { resolve as pathResolve, join } from 'path';
import { CHUNKER_VERSION } from '../../core/chunkers/code.ts';
import { currentCompanyBrainSync } from '../../core/company-brain/profile.ts';
import { serr, slog } from '../../core/console-prefix.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadOpCheckpoint, clearOpCheckpoint } from '../../core/op-checkpoint.ts';
import {
  readSyncAnchor,
  resolveSlugRootMode,
  isAnchorOwnedSyncPath,
  readChunkerVersion,
} from '../../core/sync-anchor.ts';
import type { SlugRootMode } from '../../core/sync-anchor.ts';
import { buildDetachedWorkingTreeManifest, computeSyncDelta } from '../../core/sync-delta.ts';
import {
  git,
  isWithinRoot,
  gitRelativePath,
  discoverGitRoot,
  createSyncBaselineCommit,
  isDetachedHead,
  hasOriginRemote,
  unique,
} from '../../core/sync-git.ts';
import { buildPartialResult } from '../../core/sync-lock.ts';
import { massReconcileAllowed, MASS_RECONCILE_RATIO } from '../../core/sync-reconcile.ts';
import {
  DEFAULT_SOURCE_ID,
  resolveSlugForPath,
  isSyncable,
  matchesAnyGlob,
  unsyncableReason,
  isPoisonedPath,
  sanitizePathForDisplay,
} from '../../core/sync.ts';
import type { SyncManifest } from '../../core/sync.ts';
import type { SyncResult, SyncOpts } from '../sync.ts';
import { syncCheckpointKeys, resolveSyncCheckpointEvery } from './checkpoint.ts';
import { runConnectorSync } from './connector.ts';
import { performFullSync } from './full.ts';
import { sweepOrphanedRenameSentinels } from './rename-reconcile.ts';
import type { SyncPlan, SyncActivePack } from './sync-run.ts';

export type PreflightOutcome = { readonly done: SyncResult } | { readonly plan: SyncPlan };

export async function preflightIncrementalSync(engine: BrainEngine, opts: SyncOpts): Promise<PreflightOutcome> {
  const repo = await resolveSyncRepo(engine, opts);
  if ('done' in repo) return repo;
  const { company, repoPath, syncActivePack, gitContextRoot, syncScopeRoot, syncScopeRelPath, scoped, anchorPath, slugRootMode } = repo;
  const fullSyncRoots = { gitContextRoot, syncScopeRoot, anchorPath, slugRootMode };

  const head = await pullAndResolveHead(engine, opts, company, repoPath, gitContextRoot);
  if ('done' in head) return head;
  const { detachedHead, lastCommit, pullFailed, headCommit } = head;

  opts = await applyPersistedScopeConfig(engine, opts);

  // #1970: bookmark reachability. The ONLY thing that should force a full
  // reconcile is a truly-absent object; a present-but-non-ancestor bookmark
  // (history rewrite: force-push, master→main consolidation, squash) is still
  // diffable. `git diff A..B` is an endpoint-tree comparison and does NOT
  // require A to be an ancestor of B (unlike rev-walk commands or `A...B`,
  // which use merge-base). So we diff DIRECTLY against the orphaned-but-on-disk
  // bookmark for the exact delta instead of a blind full re-walk that never
  // finishes cross-region (#1958) and never advances the bookmark.
  //
  //   lastCommit (orphan)        HEAD
  //        o ─────── x ─────── x   (old line, dropped by the rewrite)
  //         \
  //          o ─────── o ─────── ●  HEAD (new line)
  //   git diff orphan..HEAD == net tree delta — ancestry irrelevant.
  if (lastCommit) {
    let objectPresent = true;
    try {
      git(gitContextRoot, ['cat-file', '-t', lastCommit]);
    } catch {
      objectPresent = false;
    }
    if (!objectPresent) {
      // Object gc'd after a history rewrite — nothing to diff against, so fall
      // back to the authoritative full reconcile (which now also purges stale
      // pages for deleted files; see performFullSync's delete-reconcile pass).
      serr(`Sync anchor ${lastCommit.slice(0, 8)} object missing (gc'd after history rewrite). Running full reimport.`);
      return { done: await performFullSync(engine, fullSyncRoots, headCommit, opts) };
    }

    // Observability only — NOT control flow. A non-ancestor bookmark is still
    // diffed directly below; we just announce the rewrite so the silent-staleness
    // failure mode (#1970) is visible in the logs.
    let isAncestor = true;
    try {
      git(gitContextRoot, ['merge-base', '--is-ancestor', lastCommit, headCommit]);
    } catch {
      isAncestor = false;
    }
    if (!isAncestor) {
      slog(
        `[sync] last_commit ${lastCommit.slice(0, 8)} not an ancestor of HEAD ` +
        `(history rewritten) — diffing tree-to-tree against the orphaned bookmark; ` +
        `advancing to HEAD on completion.`,
      );
    }
  }

  // First sync
  if (!lastCommit) {
    return { done: await performFullSync(engine, fullSyncRoots, headCommit, opts) };
  }

  if (opts.includeGitignored) {
    slog(
      `[sync] --include-gitignored: running full filesystem reconcile because ` +
      `git diff cannot report untracked ignored files.`,
    );
    return { done: await performFullSync(engine, fullSyncRoots, headCommit, opts) };
  }

  const { ckpt, checkpointEvery, pin, completedPaths } = await resolveCheckpointPin(engine, opts, company, gitContextRoot, lastCommit, headCommit);

  const {
    storedVersion, currentVersion, versionMismatch, versionNeverSet, importWorkingTree, workingTreeManifest,
    hasWorkingTreeChanges, uncommittedDrift, inScope, scopeRel, isSelectedForRun, excluded, syncOpts,
  } = await resolveWorkingTreeScope(engine, opts, { company, gitContextRoot, detachedHead, scoped, syncScopeRelPath });

  if (lastCommit === headCommit && !versionMismatch && !versionNeverSet && !(importWorkingTree && hasWorkingTreeChanges)) {
    // #3068: the pull failed and nothing local advanced — this run imported
    // NOTHING and the remote may hold commits we could not fetch. Reporting
    // `up_to_date` here (and bumping the heartbeat below) is exactly the
    // silent-wedge from the issue: every scheduled sync exits 0 forever while
    // the source is stale. Return `partial` instead (not a clean status, and
    // last_sync_at stays frozen so doctor/sources-status staleness fires).
    // The anchor is untouched; the next sync retries the pull from the same
    // bookmark.
    if (pullFailed) {
      serr(
        `[sync] git pull failed and no local changes imported — reporting partial ` +
        `(not up_to_date); sync anchor unchanged at ${lastCommit.slice(0, 8)}.`,
      );
      return { done: buildPartialResult({
        fromCommit: lastCommit,
        toCommit: lastCommit,
        filesImported: 0,
        pagesAffected: [],
        chunksCreated: 0,
        added: 0, modified: 0, deleted: 0, renamed: 0,
        reason: 'pull_failed',
      }) };
    }
    // v0.42.52.0 (PR #22xx): bump last_sync_at as a heartbeat on every successful
    // 0-changes sync. D4 invariant ("never advance last_commit on partial") is
    // preserved: last_sync_at is a monitoring signal (doctor sync_freshness
    // reads it), separate from the import-converged bookmark. Without this,
    // a cron-driven `*/15 sync` over a quiet vault leaves last_sync_at pinned
    // to the last real commit, so doctor falsely flags the source as stale.
    // #3583 review: NOT under --dry-run — a preview that bumps the freshness
    // heartbeat masks real staleness from doctor.
    if (opts.sourceId && !opts.dryRun) {
      await engine.executeRaw(
        `UPDATE sources SET last_sync_at = now() WHERE id = $1`,
        [opts.sourceId],
      );
    }
    // #3479 blocker 2: quiet runs bypass the failure gate below, and an
    // orphaned `<rename:…>` sentinel would otherwise sit open forever.
    // #3583 review: NOT under --dry-run — the sweep rewrites the failure
    // ledger, and this early return sits ABOVE the dry-run gate, so an
    // unguarded sweep here made a preview clear the operator's only wedge
    // signal. (The sibling site below already sits after the dry-run
    // return, and performFullSync's dry-run return precedes both of its
    // sweep sites.)
    if (!opts.dryRun) {
      await sweepOrphanedRenameSentinels(engine, opts.sourceId ?? DEFAULT_SOURCE_ID);
    }
    return { done: {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
      ...(uncommittedDrift ? { uncommitted: uncommittedDrift } : {}),
    } };
  }

  if ((versionMismatch || versionNeverSet) && lastCommit === headCommit) {
    slog(
      `[sync] chunker_version gate: stored=${storedVersion ?? 'unset'}, current=${currentVersion}. ` +
      `Forcing full re-chunk pass (git HEAD unchanged but pipeline version advanced).`,
    );
    // #3583 gate13: NO unconditional version write here. performFullSync's
    // own gated advance writes the version exactly when the re-chunk
    // actually completed — writing it here acknowledged the version on a
    // BLOCKED run (losing the retry signal: the next run said up_to_date
    // and the failed re-walk never re-ran) and on a --dry-run PREVIEW
    // (persistent brain-state write from a preview).
    return { done: await performFullSync(engine, fullSyncRoots, headCommit, opts) };
  }

  const delta = await computeFilteredDelta(engine, opts, {
    company, gitContextRoot, syncScopeRoot, lastCommit, headCommit, pin, fullSyncRoots, importWorkingTree,
    workingTreeManifest, detachedHead, scoped, slugRootMode, inScope, scopeRel, excluded, isSelectedForRun, syncOpts,
  });
  if ('done' in delta) return delta;
  const { manifest, filtered, malformedSkipped, syncImportRoot, modePath, totalChanges } = delta;

  // Dry run
  if (opts.dryRun) return { done: dryRunResult({ lastCommit, headCommit, filtered, malformedSkipped, totalChanges }) };

  return {
    plan: {
      opts, company, repoPath, gitContextRoot, anchorPath, syncImportRoot, syncActivePack, lastCommit, headCommit, pin,
      pullFailed, ckpt, completedPaths, checkpointEvery, manifest, filtered, malformedSkipped, totalChanges,
      uncommittedDrift, inScope, isSelectedForRun, syncOpts, modePath,
    },
  };
}

type SyncRepo = {
  company: ReturnType<typeof currentCompanyBrainSync>;
  repoPath: string;
  syncActivePack: SyncActivePack | undefined;
  gitContextRoot: string;
  syncScopeRoot: string;
  syncScopeRelPath: string;
  scoped: boolean;
  anchorPath: string;
  slugRootMode: SlugRootMode;
};

/** Repo path, active pack, connector dispatch, repo-state recovery, git root and scope. */
async function resolveSyncRepo(engine: BrainEngine, opts: SyncOpts): Promise<{ done: SyncResult } | SyncRepo> {
  const company = currentCompanyBrainSync(opts.sourceId);
  // v0.41.8.0 (D9 / #1342): phase breadcrumbs. The #1342 reporter saw
  // ZERO stderr output before their sync hang, which made the bug
  // impossible to triage. Mirror the existing `[gbrain phase] sync.git_pull`
  // pattern at the major phase boundaries so the next #1342-shaped
  // report names WHICH phase spun. Doesn't fix #1342 but converts
  // "hung with no output" into actionable diagnostic data.
  serr(`[gbrain phase] sync.resolve_repo`);
  opts.onProgress?.({ phase: 'resolve_repo' });
  // Resolve repo path
  const rawRepoPath = opts.repoPath || await readSyncAnchor(engine, opts.sourceId, 'repo_path');
  if (!rawRepoPath) {
    const hint = opts.sourceId
      ? `Source "${opts.sourceId}" has no local_path. Run: gbrain sources add ${opts.sourceId} --path <path>`
      : `No repo path specified. Use --repo or run gbrain init with --repo first.`;
    throw new Error(hint);
  }
  // #3696: resolve to ABSOLUTE at entry. A relative path (legacy relative
  // sources.local_path row, or a caller-passed `--repo .`) breaks the moment
  // any consumer runs from a different cwd (launchd daemon at cwd=/). Since
  // writeSyncAnchor('repo_path', anchorPath) re-persists this value below,
  // one successful sync from the right cwd self-heals a legacy relative row
  // to absolute.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- rawRepoPath is the local operator's --repo CLI arg or the operator-written sync anchor (sync.repo_path / sources.local_path); the sync_brain op is localOnly:true so no remote caller reaches this path, and absolutizing it here IS the #3696 fix
  const repoPath = pathResolve(rawRepoPath);

  serr(`[gbrain phase] sync.load_active_pack`);
  // v0.39 T1.5: load active pack ONCE at sync entry; pass to every per-file
  // importFile call below. Codex perf finding #7: per-file loadActivePack adds
  // disk/YAML/hash overhead × thousands of files. Best-effort: pack load
  // failure falls through to legacy inferType (parity preserved).
  let syncActivePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string> }> } | undefined;
  try {
    // v0.41.37.0 #1569: --no-schema-pack escape hatch. Skip pack load entirely so
    // no user-supplied pack regex (markdown.ts subtype path_pattern) runs during
    // sync; pages fall back to legacy prefix typing.
    if (opts.noSchemaPack) {
      serr('[sync] --no-schema-pack: skipping schema pack; pages use legacy prefix typing');
      throw new Error('schema-pack-skipped');
    }
    const { loadActivePackForEngine } = await import('../../core/schema-pack/engine-resolution.ts');
    const resolved = await loadActivePackForEngine(engine, {
      remote: false, // sync is always a trusted CLI / autopilot caller
      sourceId: opts.sourceId,
    });
    syncActivePack = { page_types: resolved.manifest.page_types };
  } catch {
    syncActivePack = undefined;
  }

  const connector = await runConnectorSync(engine, opts, false);
  if (connector) return { done: connector };

  await validateSourceRepoState(engine, opts, repoPath);

  const gitContextRoot = await discoverSyncGitRoot(engine, opts, company, repoPath);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- srcSubpath is the local operator's --src-subpath flag (sync is localOnly); the realpath'd result is proven inside the realpath'd git root by the isWithinRoot guard below before any git op
  const rawScopeRoot = opts.srcSubpath ? join(repoPath, opts.srcSubpath) : repoPath;
  if (!existsSync(rawScopeRoot)) {
    throw new Error(`Sync scope does not exist: ${rawScopeRoot}`);
  }
  const syncScopeRoot = realpathSync(rawScopeRoot);
  // NAV-1/NAV-2 scope-entry guard: the realpath-resolved scope must live
  // inside the realpath-resolved git root. Catches `--src-subpath ../escape`
  // AND a symlinked subdir pointing outside the repo, before any git op runs.
  if (!isWithinRoot(syncScopeRoot, gitContextRoot)) {
    throw new Error(
      `Sync scope ${syncScopeRoot} resolves outside git repo ${gitContextRoot}. ` +
      `Refusing to sync: possible path traversal via --src-subpath.`,
    );
  }
  const syncScopeRelPath = gitRelativePath(gitContextRoot, syncScopeRoot);
  const scoped = syncScopeRelPath !== '';
  // Anchor written back to sync state (sources.local_path / sync.repo_path):
  // the SCOPE path, so a follow-up bare `gbrain sync` auto-discovers the same
  // scope. Unchanged (the caller's repoPath spelling) when no --src-subpath.
  const anchorPath = opts.srcSubpath ? rawScopeRoot : repoPath;
  // #4342 — explicit + STICKY slug namespace for scoped syncs. Pre-fix the
  // namespace was implicit: a local_path that happened to sit inside a bigger
  // git repo silently produced git-root-PREFIXED slugs (`notes/foo` instead
  // of `foo`), diverging from what `gbrain import <dir>` of the same tree
  // creates. The mode is decided once (resolveSlugRootMode: stored pin >
  // explicit --src-subpath > auto-pin when existing pages already carry the
  // prefix > local_path-relative) and persisted, so a live install never
  // re-slugs and every later sync agrees.
  let slugRootMode: SlugRootMode = 'git-root';
  if (scoped) {
    // Probe prefix in SLUG spelling (resolveSlugForPath), not raw path
    // spelling — the auto-pin LIKE must match how slugs were actually minted.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- syncScopeRelPath is relative() of the realpath'd scope already proven inside the realpath'd git root by the isWithinRoot guard above (so it carries no ..); the join output only mints an in-memory slug probe string, no fs operation
    const probeSlug = resolveSlugForPath(join(syncScopeRelPath, 'x.md'));
    const slugPrefix = probeSlug.slice(0, probeSlug.length - '/x'.length);
    slugRootMode = await resolveSlugRootMode(engine, {
      sourceId: opts.sourceId,
      explicitGitRoot: opts.srcSubpath !== undefined,
      slugPrefix,
      // #4342 review fix: a --dry-run must not persist the sticky pin —
      // resolve in-memory only; the first real sync writes it.
      dryRun: opts.dryRun === true,
    });
  }
  return { company, repoPath, syncActivePack, gitContextRoot, syncScopeRoot, syncScopeRelPath, scoped, anchorPath, slugRootMode };
}

async function validateSourceRepoState(engine: BrainEngine, opts: SyncOpts, repoPath: string): Promise<void> {

  // v0.28: source-aware re-clone branch. When the source has a remote_url
  // recorded (i.e. it was registered via `sources add --url`), the on-disk
  // clone is auto-managed. validateRepoState classifies the on-disk state;
  // we recover from missing/no-git/not-a-dir by re-cloning, refuse on
  // url-drift or corruption with structured hints.
  if (opts.sourceId) {
    serr(`[gbrain phase] sync.validate_repo_state`);
    const { validateRepoState } = await import('../../core/git-remote.ts');
    const { recloneIfMissing, isOwnedClone, unownedHint } = await import(
      '../../core/sources-ops.ts'
    );
    const cfgRows = await engine.executeRaw<{ local_path: string | null; config: unknown }>(
      `SELECT local_path, config FROM sources WHERE id = $1`,
      [opts.sourceId],
    );
    const cfg =
      typeof cfgRows[0]?.config === 'string'
        ? (JSON.parse(cfgRows[0].config as string) as Record<string, unknown>)
        : ((cfgRows[0]?.config ?? {}) as Record<string, unknown>);
    // #4899: EVERY caller that is not the `--all` fan-out passes no strategy —
    // the autopilot freshness lane (commands/autopilot.ts -> jobs.ts), the dream
    // cycle (core/cycle.ts), the MCP `sync` op (core/operations.ts) and the
    // single-source CLI path below. `isSyncable` then falls back to 'markdown'
    // (core/sync.ts), which drops every code file in the range. Two consequences:
    // the run imports nothing yet still advances the anchor (`Update sync state
    // even with no syncable changes`), freezing the index at HEAD forever; and
    // every MODIFIED code file reaches the un-syncable delete loop, whose only
    // exemptions are 'metafile' (#1433) and 'pruned-dir' (#2404), so its page is
    // soft-deleted.
    //
    // Resolve the source's own strategy when the caller states none. An explicit
    // --strategy still wins, so the `--all` fan-out and the CLI flag are unchanged.
    if (opts.strategy === undefined && typeof cfg.strategy === 'string') {
      const persisted = cfg.strategy;
      if (persisted === 'markdown' || persisted === 'code' || persisted === 'auto') {
        // Assign the PROPERTY, never `opts = {...opts}`: this block runs inside
        // `if (opts.sourceId)`, and replacing the object discards that narrowing,
        // so three downstream call sites stop compiling.
        opts.strategy = persisted;
      }
    }
    const remoteUrl = typeof cfg.remote_url === 'string' ? cfg.remote_url : null;
    if (remoteUrl) {
      const ownSrc = {
        id: opts.sourceId,
        local_path: cfgRows[0]?.local_path ?? repoPath,
        config: cfg,
      };
      const state = validateRepoState(repoPath, remoteUrl);
      switch (state) {
        case 'healthy':
          // No per-sync warning for an unowned-but-healthy source — it would
          // spam every sync. The misconfig is surfaced by the doctor check
          // (TODO1) instead. Healthy unowned paths sync read-only and are safe.
          break;
        case 'missing':
        case 'no-git':
        case 'not-a-dir':
          // #1881: only re-clone a clone gbrain owns. An unowned local_path
          // (the user's working tree) is refused loudly, never deleted.
          if (!isOwnedClone(ownSrc)) {
            throw new Error(unownedHint(ownSrc, state));
          }
          serr(
            `[gbrain] auto-recovery: re-cloning "${opts.sourceId}" (clone state: ${state}).`,
          );
          await recloneIfMissing(engine, opts.sourceId);
          break;
        case 'corrupted':
          throw new Error(
            `Source "${opts.sourceId}" clone at ${repoPath} is corrupted ` +
              `(\`git remote get-url origin\` failed). Run: ` +
              `gbrain sources remove ${opts.sourceId} --confirm-destructive && ` +
              `gbrain sources add ${opts.sourceId} --url ${remoteUrl}`,
          );
        case 'url-drift':
          throw new Error(
            `Source "${opts.sourceId}" clone at ${repoPath} has a remote ` +
              `that differs from config.remote_url=${remoteUrl}. ` +
              `Re-clone with: gbrain sources rebase-clone ${opts.sourceId} ` +
              `(if available, else: sources remove + sources add).`,
          );
      }
    }
  }
}

async function discoverSyncGitRoot(
  engine: BrainEngine,
  opts: SyncOpts,
  company: ReturnType<typeof currentCompanyBrainSync>,
  repoPath: string,
): Promise<string> {
  // #753/#774: discover the git root instead of requiring `.git` at repoPath
  // directly. Supports subdir-of-git-repo sources (monorepo pattern): either
  // an explicit `--src-subpath` under a git-root repoPath, or a repoPath that
  // IS a subdirectory (auto-discovery). Two axes fall out:
  //   - gitContextRoot: ALL git operations (pull, rev-parse, diff, cat-file)
  //   - syncScopeRoot:  file walking, imports, deletes, renames
  // In the common case (repoPath == git root, no subpath) they are identical.
  serr(`[gbrain phase] sync.discover_git_root`);
  // #2964: a legacy `sync.repo_path`-anchored default brain can reach here
  // having never been `git init`-ed — e.g. a brain-pages dir that predates
  // git-backed sync, or one rsync'd from another machine without its
  // `.git`. gbrain owns that directory outright, so self-heal by
  // initializing it in place instead of failing the sync phase every
  // single run. Mirrors the recloneIfMissing self-recovery above for
  // owned remote clones. Ownership is proven by VALUE (resolved repoPath
  // equals gbrain's persisted anchor) via `isAnchorOwnedSyncPath`, not by
  // the mere absence of `opts.sourceId`/`opts.repoPath` — see that
  // function's docstring. `!opts.dryRun`: a preview must never write.
  let gitContextRoot: string;
  try {
    gitContextRoot = realpathSync(discoverGitRoot(repoPath));
  } catch (err) {
    if (company) throw err;
    if (
      opts.dryRun ||
      opts.signal?.aborted ||
      !existsSync(repoPath) ||
      !(await isAnchorOwnedSyncPath(engine, opts, repoPath))
    ) {
      throw err;
    }
    // 2026-08-10 incident guard. `discoverGitRoot` is a 30s-bounded
    // `git rev-parse --show-toplevel` that walks UP; it can throw for reasons
    // OTHER than "no git repo" — a transient timeout on a large brain, or a
    // concurrent `gbrain-sync` holding a git lock — on a directory that IS a
    // git repo, whether the repo root is `repoPath` itself OR an ANCESTOR
    // (subdir-anchored brain, the #753/#774 monorepo pattern). Trusting a
    // single throw and running `git init` (a no-op reinit at repoPath, or a
    // NEW nested repo shadowing the ancestor) + baseline-commit stacks a
    // spurious auto-init commit and re-cases the tree on a case-insensitive
    // filesystem. So do NOT self-heal on one throw — re-probe once:
    //   - re-probe SUCCEEDS => the first throw was transient and the repo
    //     (own or ancestor) is real; use it, never init/commit.
    //   - re-probe THROWS but `.git` is present at repoPath => a real but
    //     unreadable repo (corrupt, broken gitlink, or a persistent transient)
    //     — NEVER init/commit over it; surface the original error.
    //   - re-probe THROWS and no `.git` at repoPath => genuinely not a git
    //     repo anywhere up the tree; self-heal.
    // The createSyncBaselineCommit chokepoint is the fail-closed backstop if
    // this ever reaches a baseline on a repo that turns out to have commits.
    let reprobedRoot: string | null = null;
    try {
      reprobedRoot = discoverGitRoot(repoPath);
    } catch {
      reprobedRoot = null;
    }
    if (reprobedRoot !== null) {
      gitContextRoot = realpathSync(reprobedRoot);
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- repoPath is the operator-configured local sync repo (sync is localOnly) and '.git' is a constant name
    } else if (existsSync(join(repoPath, '.git'))) {
      throw err;
    } else {
      serr(`[gbrain] auto-recovery: git-initializing brain dir ${repoPath} (no git repo found).`);
      git(repoPath, ['init', '--quiet']);
      createSyncBaselineCommit(repoPath);
      gitContextRoot = realpathSync(discoverGitRoot(repoPath));
    }
  }
  return gitContextRoot;
}

/** Detached-HEAD / origin detection, the bookmark read, the git pull and HEAD (with the unborn-HEAD self-heal). */
async function pullAndResolveHead(
  engine: BrainEngine,
  opts: SyncOpts,
  company: ReturnType<typeof currentCompanyBrainSync>,
  repoPath: string,
  gitContextRoot: string,
): Promise<{ done: SyncResult } | { detachedHead: boolean; lastCommit: string | null; pullFailed: boolean; headCommit: string }> {

  serr(`[gbrain phase] sync.detect_head`);
  // Detect detached HEAD up front so the working-tree fallback fires for both
  // the default sync and `--no-pull` callers. Only the actual git pull is
  // gated on opts.noPull or opts.dryRun.
  const detachedHead = !company && isDetachedHead(gitContextRoot);
  if (detachedHead && !opts.noPull) {
    // Print the caller's repoPath spelling (not the realpathed git root) —
    // it's what the operator recognizes, and tests pin it.
    serr(`Detached HEAD on ${repoPath}; skipping git pull. Syncing from local working tree.`);
  }

  // Git pull (unless --no-pull or --dry-run). v0.28.1 codex finding (HIGH): the legacy
  // git() helper at sync.ts:192 spawns git without GIT_SSRF_FLAGS, so
  // every steady-state pull was bypassing the redirect/submodule/protocol
  // hardening that cloneRepo applies. Route through pullRepo from
  // git-remote.ts so the flag set is consistent across initial clone and
  // ongoing pulls — single source of truth for the defensive flags.
  const originRemotePresent = !opts.noPull && !detachedHead ? hasOriginRemote(gitContextRoot) : false;
  if (!opts.noPull && !detachedHead && !originRemotePresent) {
    serr(`No origin remote on ${repoPath}; skipping git pull. Syncing from local working tree.`);
  }

  // v0.41.13.0 (T2 + T3): read the bookmark BEFORE pull so the pull-phase
  // abort/partial path has a real `fromCommit` value to report. lastCommit
  // is a pure DB read — pull doesn't change the bookmark — so the read
  // order doesn't matter for correctness. Ancestry validation below still
  // happens AFTER pull (so a `git pull` that brings in missing commits
  // can restore a valid ancestor chain).
  const lastCommit = opts.full ? null : await readSyncAnchor(engine, opts.sourceId, 'last_commit');

  // v0.41.13.0 (T2): pre-pull abort check. If --timeout already fired
  // (e.g. cron invoked sync after the previous run took the full budget),
  // return partial without invoking the pull subprocess. fromCommit and
  // toCommit both report the prior bookmark since we never advanced past it.
  if (opts.signal?.aborted) {
    return { done: buildPartialResult({
      fromCommit: lastCommit,
      toCommit: lastCommit ?? '',
      filesImported: 0,
      pagesAffected: [],
      chunksCreated: 0,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      reason: 'timeout',
    }) };
  }

  // #3068: remember a warn-and-continue pull failure. The fall-through-to-
  // working-tree design stays (local commits still import when the remote is
  // unreachable), but a ZERO-import sync after a failed pull must not report
  // `up_to_date` / bump the freshness heartbeat — that is what made a
  // permanently-failing pull (e.g. a local-path origin rejected by
  // protocol.file.allow=never, #1315) invisible forever: every nightly run
  // exited 0 with "Already up to date" and doctor's sync_freshness never
  // fired because last_sync_at kept advancing.
  let pullFailed = false;
  if (!opts.dryRun && !opts.noPull && !detachedHead && originRemotePresent) {
    const _t0 = Date.now();
    serr(`[gbrain phase] sync.git_pull start`);
    opts.onProgress?.({ phase: 'git_pull' });
    try {
      const { pullRepo } = await import('../../core/git-remote.ts');
      // v0.41.13.0 (T3 / D-V4-mech-7): if the operator set --timeout,
      // bound the pull subprocess to a fraction of the remaining budget.
      // We pass a safe default (the operator's full --timeout if set, else
      // pullRepo's own 300s default). The catch below distinguishes
      // timeout (ETIMEDOUT / SIGTERM on err.cause) from ordinary pull
      // failure. Pull applies to the whole git repo (gitContextRoot), not
      // just the sync scope — git has no per-subdir pull.
      pullRepo(gitContextRoot);
      serr(`[gbrain phase] sync.git_pull done ${Date.now() - _t0}ms`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      serr(`[gbrain phase] sync.git_pull error ${Date.now() - _t0}ms (${msg.slice(0, 200)})`);
      // v0.41.13.0 (T3 / D-V4-mech-7): pullRepo wraps execFileSync errors
      // in GitOperationError, so `error.code === 'ETIMEDOUT'` and
      // `error.signal === 'SIGTERM'` live on `.cause`, NOT on the top-
      // level error. Inspect `.cause` to distinguish a real timeout
      // (return partial reason='pull_timeout') from ordinary failure
      // (keep the existing warn-and-continue R2 invariant).
      const cause: unknown = e instanceof Error && 'cause' in e ? (e as { cause?: unknown }).cause : undefined;
      const causeCode = (cause && typeof cause === 'object' && 'code' in cause)
        ? (cause as { code?: unknown }).code
        : undefined;
      const causeSignal = (cause && typeof cause === 'object' && 'signal' in cause)
        ? (cause as { signal?: unknown }).signal
        : undefined;
      const isTimeout = causeCode === 'ETIMEDOUT' || causeSignal === 'SIGTERM';
      if (isTimeout) {
        return { done: buildPartialResult({
          fromCommit: lastCommit,
          toCommit: lastCommit ?? '',
          filesImported: 0,
          pagesAffected: [],
          chunksCreated: 0,
          added: 0, modified: 0, deleted: 0, renamed: 0,
          reason: 'pull_timeout',
        }) };
      }
      pullFailed = true;
      if (msg.includes('non-fast-forward') || msg.includes('diverged')) {
        serr(`Warning: git pull failed (remote diverged). Syncing from local state.`);
      } else {
        serr(`Warning: git pull failed: ${msg.slice(0, 200)}`); // #1315 stderr-first
      }
    }
  }

  // Get current HEAD
  let headCommit: string;
  try {
    headCommit = company?.plan.revision?.commit ?? git(gitContextRoot, ['rev-parse', 'HEAD']);
  } catch {
    // #2964: unborn-HEAD recovery. `.git` exists (discoverGitRoot succeeded
    // above) but there are zero commits — e.g. a prior self-heal `git init`
    // ran but the process died before the baseline commit landed, leaving
    // this brain permanently wedged on "No commits in repo" every night
    // thereafter. Finish the same baseline-commit self-heal the
    // discoverGitRoot catch above would have done, gated the same way
    // (ownership proven by value, never on a dry-run preview) PLUS a scope
    // check: `discoverGitRoot` walks UP from `repoPath`, so it can resolve
    // to an ANCESTOR repo, not `repoPath` itself (most plausible for a
    // `--src-subpath` sync, but `isAnchorOwnedSyncPath` already refuses
    // that case — kept here too as defense in depth against any other path
    // where gitContextRoot could diverge from repoPath). Committing at an
    // ancestor (`git add -A` at gitContextRoot) would capture sibling
    // files well outside the sync scope — refuse instead of guessing.
    if (
      opts.dryRun ||
      opts.signal?.aborted ||
      gitContextRoot !== realpathSync(repoPath) ||
      !(await isAnchorOwnedSyncPath(engine, opts, repoPath))
    ) {
      throw new Error(`No commits in repo ${repoPath}. Make at least one commit before syncing.`);
    }
    serr(`[gbrain] auto-recovery: repo has no commits yet, creating baseline commit ${gitContextRoot}.`);
    createSyncBaselineCommit(gitContextRoot);
    headCommit = git(gitContextRoot, ['rev-parse', 'HEAD']);
  }

  // #2964: self-heal deliberately does NOT special-case db_only/.gitignore
  // interaction beyond the COMMIT itself (createSyncBaselineCommit's
  // pathspec exclusion, which stands on its own regardless of what
  // .gitignore says). db_only content is documented as DB-sourced ("bulk
  // machine-generated content... written to disk as a local cache", see
  // docs/storage-tiering.md) — it reaches the database via ingest-specific
  // paths, never via gbrain sync's git-diff-based file collection, and
  // `.gitignore` management there is entirely about keeping db_only out of
  // git history, not about what sync imports. An earlier version of this
  // fix (Codex review rounds 6-7) tried to also guarantee db_only markdown
  // gets imported on this first sync and that .gitignore gets written
  // post-success even when called outside runSync — solving a problem
  // that, per the docs above, isn't actually in scope for what sync is
  // for. Reverted in round 8 review discussion in favor of this simpler
  // design: after self-heal, the import + any subsequent .gitignore
  // management behave EXACTLY the same as for any other brain, self-healed
  // or not (runSync's existing post-success manageGitignoreAtGitRoot call
  // covers the CLI path identically either way; the dream cycle not
  // calling it is a separate, pre-existing characteristic of the dream
  // cycle in general, not something this fix introduces or worsens).
  return { detachedHead, lastCommit, pullFailed, headCommit };
}

/** Union the persisted `sync.exclude` / `sync.include_hidden` scope into the options. */
async function applyPersistedScopeConfig(engine: BrainEngine, opts: SyncOpts): Promise<SyncOpts> {
  // Same reasoning as the `sync.include_working_tree` config fallback further
  // down, applied to the indexing scope: `--exclude` is a per-invocation flag,
  // so only callers that go through the CLI can narrow what gets indexed.
  // autopilot, minion sync jobs and the dream cycle call sync internally with
  // no place to put exclusions — a repo whose indexing scope is narrower than
  // its git tree is honored on one path and silently ignored on the others.
  //
  // Silently is the operative word: not excluding something is not an error
  // for an indexer, so the gap surfaces as content quietly reappearing in the
  // index, never as a failure. Resolving the config HERE gives every caller
  // the same scope. The read is best-effort, exactly like that one.
  //
  // UNION rather than flag-wins, which is where this departs from that
  // boolean: a persisted scope is a property of the repo ("this is not
  // indexable material"), and an ad-hoc `--exclude tmp/` must not silently
  // re-open it — that would reintroduce the very failure this closes. A
  // boolean has no union; a pattern list does. Narrowing further always
  // works; widening is deliberate, by editing the config.
  //
  // Directory prefixes are normalized to subtree globs (`raw/` → `raw/**`):
  // without the `**` the pattern matches the directory entry and none of the
  // files inside it, which is the same gap wearing a different shape.
  //
  // POSITION IS LOAD-BEARING: this union must run ABOVE the three
  // performFullSync early returns below (gc'd anchor, first sync,
  // --include-gitignored). The first sync is exactly where exclusion
  // pollution is permanent — a full walk that ignores the persisted scope
  // imports every excluded derivative file, and no later incremental sync
  // ever revisits them.
  try {
    const stored = await engine.getConfig('sync.exclude');
    const storedPatterns = (stored ?? '')
      .split(/[\n,]/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => (p.endsWith('/') ? `${p}**` : p));
    if (storedPatterns.length > 0) {
      opts = { ...opts, exclude: [...new Set([...(opts.exclude ?? []), ...storedPatterns])] };
    }
  } catch { /* config unreadable — never break a sync over the scope read */ }

  // #4901: the WAIVER's persisted twin, read exactly like `sync.exclude` above
  // (same dialect, trailing-slash normalization, union, best-effort, position).
  // `--include-hidden` is refused under `--all` and unavailable to autopilot /
  // the dream cycle, so this key is the only way the unattended paths get it.
  // An unset key admits nothing — the dot-directory default does not move.
  try {
    const storedHidden = await engine.getConfig('sync.include_hidden');
    const hiddenPatterns = (storedHidden ?? '')
      .split(/[\n,]/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => (p.endsWith('/') ? `${p}**` : p));
    if (hiddenPatterns.length > 0) {
      opts = { ...opts, includeHidden: [...new Set([...(opts.includeHidden ?? []), ...hiddenPatterns])] };
    }
  } catch { /* config unreadable — never break a sync over the scope read */ }
  return opts;
}

async function resolveCheckpointPin(
  engine: BrainEngine,
  opts: SyncOpts,
  company: ReturnType<typeof currentCompanyBrainSync>,
  gitContextRoot: string,
  lastCommit: string,
  headCommit: string,
): Promise<{ ckpt: SyncPlan['ckpt']; checkpointEvery: number; pin: string; completedPaths: string[] }> {
  // v0.42.x (#1794): resumable incremental sync — resolve the PINNED target.
  // last_commit advances only at FULL import completion, so a killed run keeps
  // lastCommit fixed and the checkpoint key stable across every resume even as
  // the enrich process races HEAD forward underneath us. We drain
  // `lastCommit..pin`; commits past the pin are a clean next-sync diff (this is
  // what kills the staleness window — see plan).
  //   - valid in-flight checkpoint (pin still reachable from HEAD) → resume it.
  //   - rewrite / force-push (pin no longer an ancestor) → discard, re-pin to HEAD.
  //   - no checkpoint → pin = HEAD (the normal single-shot case).
  const ckpt = syncCheckpointKeys(opts.sourceId, company ? company.receiptId : lastCommit);
  if (company && !opts.dryRun) await company.protect([{ ...ckpt.paths, kind: 'content' }, { ...ckpt.target, kind: 'manifest' }]);
  const checkpointEvery = resolveSyncCheckpointEvery();
  let pin = headCommit;
  let completedPaths: string[] = [];
  {
    const storedTargetArr = await loadOpCheckpoint(engine, ckpt.target);
    const storedTarget = storedTargetArr[0] ?? null;
    if (storedTarget) {
      let pinReachable = false;
      try {
        if (company && storedTarget !== company.plan.revision!.commit) throw new Error('Approved revision mismatch');
        if (!company) git(gitContextRoot, ['merge-base', '--is-ancestor', storedTarget, headCommit]);
        pinReachable = true;
      } catch {
        pinReachable = false;
      }
      if (pinReachable) {
        pin = storedTarget;
        completedPaths = await loadOpCheckpoint(engine, ckpt.paths);
        slog(
          `[sync] resuming checkpoint: ${completedPaths.length} file(s) already done; ` +
          `draining ${lastCommit.slice(0, 8)}..${pin.slice(0, 8)} (pinned target).`,
        );
      } else {
        slog(
          `[sync] checkpoint target ${storedTarget.slice(0, 8)} no longer reachable ` +
          `(history rewritten); restarting against HEAD.`,
        );
        // #3583 review: NOT under --dry-run — this hygiene clear is a
        // persistent write, and the real run re-detects the unreachable
        // pin and clears it itself; a preview only reports.
        if (!opts.dryRun) {
          await clearOpCheckpoint(engine, ckpt.paths);
          await clearOpCheckpoint(engine, ckpt.target);
        }
      }
    }
  }
  return { ckpt, checkpointEvery, pin, completedPaths };
}

/** Chunker-version gate inputs, the working-tree manifest, the shared scope filters and uncommitted drift. */
async function resolveWorkingTreeScope(
  engine: BrainEngine,
  opts: SyncOpts,
  input: {
    company: ReturnType<typeof currentCompanyBrainSync>;
    gitContextRoot: string;
    detachedHead: boolean;
    scoped: boolean;
    syncScopeRelPath: string;
  },
) {
  const { company, gitContextRoot, detachedHead, scoped, syncScopeRelPath } = input;
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
  // Untracked-gap fix: the working-tree manifest is now built for attached
  // HEADs too, not just detached ones. Detached HEAD (pre-existing semantics)
  // or a resolved workingTree opt-in → the manifest merges into the delta
  // below and uncommitted state IMPORTS. Attached without the opt-in → NOT
  // imported, but counted through the same scope/exclude/isSyncable filters
  // imports use and reported as `uncommitted` drift + a stderr warning.
  // Before this, "Already up to date." printed while untracked files sat
  // invisible — sync reported convergence it had not achieved.
  //
  // The config fallback resolves HERE (not the CLI layer) so EVERY caller —
  // dream cycle, minion sync jobs, sync_brain — honors the persisted
  // `sync.include_working_tree` the warnings recommend. Per-call flag wins;
  // the config read is best-effort (a config error never breaks a sync).
  let workingTreeResolved = opts.workingTree;
  if (workingTreeResolved === undefined) {
    try {
      workingTreeResolved = (await engine.getConfig('sync.include_working_tree')) === 'true';
    } catch { workingTreeResolved = false; }
  }
  const importWorkingTree = !company && (detachedHead || workingTreeResolved === true);
  // Fail-open guard: the manifest builder shells out under a 30s/100MiB git
  // budget and THROWS on breach; a monster untracked dir must not convert
  // every previously-working up-to-date sync into a hard error. Drift
  // counting degrades to empty with a stderr note; an EXPLICIT working-tree
  // import request fails closed with the reason (importing without the
  // manifest would silently skip the very files the caller asked for).
  let workingTreeManifest: SyncManifest;
  try {
    workingTreeManifest = company ? { added: [], modified: [], deleted: [], renamed: [] } : buildDetachedWorkingTreeManifest(gitContextRoot);
  } catch (e) {
    if (importWorkingTree) {
      throw new Error(
        `working-tree manifest unavailable (${e instanceof Error ? e.message.slice(0, 160) : String(e)}) — ` +
        `cannot import uncommitted state; re-run without --working-tree or fix the repo state`,
      );
    }
    serr('[sync] working-tree drift probe failed — drift counting skipped this run.');
    workingTreeManifest = { added: [], modified: [], deleted: [], renamed: [] };
  }

  // #753/#774 scope filter (hoisted above the up_to_date gate so the drift
  // counter here and the delta filter below apply IDENTICAL predicates):
  // git-diff paths are git-root-relative; when a subpath scope is active, only
  // paths under it participate. Back-compat: syncScopeRelPath is '' when
  // scope == root, so inScope is always true and the filters reduce to the
  // pre-#774 behavior exactly.
  const inScope = (p: string): boolean =>
    !scoped || p === syncScopeRelPath || p.startsWith(syncScopeRelPath + '/');
  // --exclude patterns match the SCOPE-relative path (what the user of a
  // scoped source thinks in), same form runImport matches on full sync.
  const scopeRel = (p: string): string =>
    scoped && p.startsWith(syncScopeRelPath + '/') ? p.slice(syncScopeRelPath.length + 1) : p;
  const includedPaths = company ? new Set(company.plan.manifest.filter(entry => entry.disposition === 'included').map(entry => entry.path)) : null;
  const storedPaths = company ? new Set((await engine.executeRaw<{ source_path: string }>('SELECT source_path FROM pages WHERE source_id=$1 AND source_path IS NOT NULL', [opts.sourceId!])).map(page => page.source_path)) : null;
  const isSelectedForRun = (path: string, options?: Parameters<typeof isSyncable>[1]): boolean => company
    ? includedPaths!.has(scopeRel(path)) || storedPaths!.has(scopeRel(path))
    : isSyncable(path, options);
  const excluded = (p: string): boolean => company ? !includedPaths!.has(scopeRel(p)) :
    opts.exclude !== undefined && opts.exclude.length > 0 && matchesAnyGlob(scopeRel(p), opts.exclude);
  // #4027: includeHidden must ride along wherever isSyncable() consults these
  // opts — dropping it here silently disables --include-hidden on the whole
  // delta path (and the #3974 drift counter) while the flag still parses.
  const syncOpts = { strategy: opts.strategy, includeHidden: opts.includeHidden };

  // Filtered working-tree counts. Renames decompose as add(to) + delete(from)
  // — the same decomposition the import path applies — so a rename-only dirty
  // tree still reports drift instead of reproducing the silent gap this
  // counter exists to close (a staged `git mv` populates only `renamed`).
  const wtCounts = {
    added: workingTreeManifest.added.filter(p => inScope(p) && !excluded(p) && isSelectedForRun(p, syncOpts)).length +
      workingTreeManifest.renamed.filter(r => inScope(r.to) && !excluded(r.to) && isSelectedForRun(r.to, syncOpts)).length,
    modified: workingTreeManifest.modified.filter(p => inScope(p) && !excluded(p) && isSelectedForRun(p, syncOpts)).length,
    deleted: workingTreeManifest.deleted.filter(p => inScope(p) && isSelectedForRun(p, syncOpts)).length +
      workingTreeManifest.renamed.filter(r => inScope(r.from) && isSelectedForRun(r.from, syncOpts)).length,
  };
  const wtSyncableTotal = wtCounts.added + wtCounts.modified + wtCounts.deleted;
  // Fast-path gate: detached HEADs keep the pre-existing RAW-manifest gate;
  // attached repos gate on SYNCABLE changes so a stray unsyncable scratch
  // file can't defeat the up_to_date fast path on every scheduled run.
  const hasWorkingTreeChanges = detachedHead
    ? (workingTreeManifest.added.length > 0 ||
        workingTreeManifest.modified.length > 0 ||
        workingTreeManifest.deleted.length > 0 ||
        workingTreeManifest.renamed.length > 0)
    : wtSyncableTotal > 0;

  let uncommittedDrift: { added: number; modified: number; deleted: number } | undefined;
  if (!importWorkingTree && wtSyncableTotal > 0) {
    uncommittedDrift = wtCounts;
    serr(
      `[sync] ${wtSyncableTotal} uncommitted file(s) are invisible to ` +
      `commit-driven sync (${wtCounts.added} untracked/added, ${wtCounts.modified} modified, ${wtCounts.deleted} deleted). ` +
      `Commit them, or run 'gbrain sync --working-tree' to import uncommitted state.`,
    );
  }
  return {
    storedVersion, currentVersion, versionMismatch, versionNeverSet, importWorkingTree, workingTreeManifest,
    hasWorkingTreeChanges, uncommittedDrift, inScope, scopeRel, isSelectedForRun, excluded, syncOpts,
  };
}

/** The pinned delta, filtered to what this source syncs (or a full-sync fallback when it is unavailable). */
async function computeFilteredDelta(
  engine: BrainEngine,
  opts: SyncOpts,
  input: {
    company: ReturnType<typeof currentCompanyBrainSync>;
    gitContextRoot: string;
    syncScopeRoot: string;
    lastCommit: string;
    headCommit: string;
    pin: string;
    fullSyncRoots: { gitContextRoot: string; syncScopeRoot: string; anchorPath: string; slugRootMode: SlugRootMode };
    importWorkingTree: boolean;
    workingTreeManifest: SyncManifest;
    detachedHead: boolean;
    scoped: boolean;
    slugRootMode: SlugRootMode;
    inScope: (p: string) => boolean;
    scopeRel: (p: string) => string;
    excluded: (p: string) => boolean;
    isSelectedForRun: SyncPlan['isSelectedForRun'];
    syncOpts: SyncPlan['syncOpts'];
  },
): Promise<
  | { done: SyncResult }
  | { manifest: SyncManifest; filtered: SyncManifest; malformedSkipped: string[]; syncImportRoot: string; modePath: (p: string) => string; totalChanges: number }
> {
  const {
    company, gitContextRoot, syncScopeRoot, lastCommit, headCommit, pin, fullSyncRoots, importWorkingTree,
    workingTreeManifest, detachedHead, scoped, slugRootMode, inScope, scopeRel, excluded, isSelectedForRun, syncOpts,
  } = input;
  // Diff using git diff (net result, not per-commit). v0.42.x (#1794): diff
  // against the PINNED target, not live HEAD. With a fixed (lastCommit, pin)
  // both endpoints are stable across every resume, so the manifest is
  // deterministic and resumeFilter maps cleanly onto completed paths.
  //
  // v0.42.42.0 (#2139): the diff + detached-working-tree merge now route
  // through `computeSyncDelta` (src/core/sync-delta.ts) — the SAME helper the
  // inline cost estimator uses, so the gate's dollar figure can't drift from
  // what this sync actually imports. `detachedWorkingTreeManifest` (computed
  // above for the `up_to_date` gate) is passed through to avoid recomputing it.
  //
  // #1970 (F-B): a non-ancestor diff against a wildly divergent tree (e.g. a
  // force-push to unrelated history) can exceed git()'s 30s timeout / 100 MiB
  // buffer, and a gc'd anchor object can't be diffed at all. On either
  // `unavailable`, fall back to the authoritative full reconcile instead of
  // throwing — a slow correct reconcile beats a hard error or a silent walk.
  const delta = computeSyncDelta(gitContextRoot, lastCommit, pin, {
    detachedManifest: importWorkingTree ? workingTreeManifest : null,
  });
  if (delta.status === 'unavailable') {
    serr(
      `[sync] delta ${lastCommit.slice(0, 8)}..${pin.slice(0, 8)} unavailable ` +
      `(${delta.reason}) — falling back to full reconcile.`,
    );
    return { done: await performFullSync(engine, fullSyncRoots, headCommit, opts) };
  }
  const manifest = delta.manifest;
  if (company) {
    manifest.added.push(...manifest.renamed.map(rename => rename.to));
    manifest.deleted.push(...manifest.renamed.map(rename => rename.from));
    manifest.renamed = [];
  }

  // Scope/exclude/isSyncable filter lambdas (`inScope`/`scopeRel`/`excluded`/
  // `syncOpts`) are hoisted above the up_to_date gate — the untracked-gap
  // drift counter shares them so both apply identical predicates.
  // #1970 (F-C): a rename whose DESTINATION is unsyncable drops out of BOTH
  // `renamed` (only `r.to` is kept below) AND `deleted` (git emits it as `R`,
  // not `D`), leaving the OLD page stale. Fold the source side into the delete
  // set. isSelectedForRun(r.from) excludes metafiles automatically, so a rename of a
  // metafile is left untouched (matching the #1433 metafile-skip invariant).
  // #774: a rename whose destination LEFT the scope is the same class — the
  // old page's backing file is gone from this source's slice of the repo.
  const renamedToUnsyncable = manifest.renamed
    .filter(r => inScope(r.from) && isSelectedForRun(r.from, syncOpts) &&
      !(inScope(r.to) && isSelectedForRun(r.to, syncOpts)) &&
      // A rename onto a NON-poison malformed destination (`foo.md` →
      // `notes [draft].md`) keeps the old row: the content still exists on
      // disk under the new name, it just can't re-import until renamed —
      // deleting the row here would be the rename-lane variant of the
      // reconcile data-loss class (codex re-review P1). Poisoned
      // destinations (`](`/control chars) still sweep.
      !(unsyncableReason(r.to, syncOpts) === 'malformed-path' && !isPoisonedPath(r.to)))
    .map(r => r.from);
  const filtered: SyncManifest = {
    added: manifest.added.filter(p => inScope(p) && !excluded(p) && isSelectedForRun(p, syncOpts)),
    modified: manifest.modified.filter(p => inScope(p) && !excluded(p) && isSelectedForRun(p, syncOpts)),
    deleted: unique([
      // 'malformed-path' deletions MUST still process: the classifier makes
      // junk filenames unsyncable, but their previously-ingested DB rows are
      // exactly what a delete event is supposed to remove — filtering them
      // out here would orphan those rows (searchable forever). Mirror of the
      // metafile carve-out, in the opposite direction.
      ...manifest.deleted.filter(p => inScope(p) &&
        (isSelectedForRun(p, syncOpts) || unsyncableReason(p, syncOpts) === 'malformed-path')),
      ...renamedToUnsyncable,
    ]),
    renamed: manifest.renamed.filter(r => inScope(r.to) && !excluded(r.to) && isSelectedForRun(r.to, syncOpts)),
  };

  // Surface malformed-filename skips: they were silently dropped from the
  // `filtered` manifest above, and a skip nobody can see reads as "synced".
  // Rename DESTINATIONS count too (the rename lane keeps the old row for
  // non-poison destinations, but the new name still can't import).
  const malformedSkipped = unique([
    ...[...manifest.added, ...manifest.modified]
      .filter(p => inScope(p) && unsyncableReason(p, syncOpts) === 'malformed-path'),
    ...manifest.renamed
      .filter(r => inScope(r.to) && unsyncableReason(r.to, syncOpts) === 'malformed-path')
      .map(r => r.to),
  ]);

  // #4342 'source-root' mode: translate the (git-root-relative) manifest to
  // SOURCE-relative paths so every downstream consumer — slugs, source_path,
  // deletes, renames, checkpoints — names pages the way `gbrain import
  // <local_path>` would. Under 'git-root' (or an unscoped sync) this is a
  // no-op and the pre-#4342 behavior is byte-for-byte. The file-join base
  // below (`syncImportRoot`) moves with it so `join(base, path)` still lands
  // on the same file.
  const sourceRootMode = scoped && slugRootMode === 'source-root';
  const syncImportRoot = sourceRootMode ? syncScopeRoot : gitContextRoot;
  /** Manifest path → the mode's canonical page path (slug/source_path base). */
  const modePath = (p: string): string => (sourceRootMode ? scopeRel(p) : p);
  if (sourceRootMode) {
    filtered.added = filtered.added.map(scopeRel);
    filtered.modified = filtered.modified.map(scopeRel);
    filtered.deleted = filtered.deleted.map(scopeRel);
    filtered.renamed = filtered.renamed.map(r => ({ from: scopeRel(r.from), to: scopeRel(r.to) }));
  }

  // Working-tree mass-delete valve: merged working-tree deletes bypass the
  // full-reconcile valve (#2828), but the hazard is the same — a transient
  // uncommitted tree state (mid-rebase checkout, accidental rm -rf) hit by a
  // scheduled --working-tree/config sync must not sweep the source. Same
  // ratio + same env escape hatch. Deletes are skipped loudly; adds and
  // modifies still import, and committing the deletions (or
  // GBRAIN_ALLOW_MASS_RECONCILE=1) re-enables them.
  if (importWorkingTree && !detachedHead && filtered.deleted.length >= 10 && !massReconcileAllowed()) {
    try {
      const rows = await engine.executeRaw<{ count: number }>(
        opts.sourceId
          ? `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL AND source_id = $1`
          : `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL`,
        opts.sourceId ? [opts.sourceId] : [],
      );
      const pageCount = Number(rows[0]?.count ?? 0);
      if (pageCount > 0 && filtered.deleted.length > pageCount * MASS_RECONCILE_RATIO) {
        serr(
          `\n  WARNING: refusing to delete ${filtered.deleted.length} page(s) from a working-tree ` +
          `sync (> ${Math.round(MASS_RECONCILE_RATIO * 100)}% of ${pageCount} page(s)). An uncommitted ` +
          `tree deleting this much is almost always transient (mid-rebase, accidental rm) — commit the ` +
          `deletions to apply them, or re-run with GBRAIN_ALLOW_MASS_RECONCILE=1. Adds/modifies still import.\n`,
        );
        filtered.deleted = [];
      }
    } catch { /* valve is best-effort — a count failure must not block the sync */ }
  }

  // NAV-4: warn when --exclude filtered out every candidate change — almost
  // always a mistyped pattern, and otherwise indistinguishable from
  // "up to date" in the output.
  if (opts.exclude && opts.exclude.length > 0) {
    const excludeCandidates = [...manifest.added, ...manifest.modified]
      .filter(p => inScope(p) && isSelectedForRun(p, syncOpts));
    if (excludeCandidates.length > 0 && excludeCandidates.every(excluded)) {
      console.warn(
        `[gbrain sync] No files matched after applying ${opts.exclude.length} --exclude pattern(s). ` +
        `Check your --exclude flags. Patterns: ${JSON.stringify(opts.exclude)}`,
      );
    }
  }

  const totalChanges = filtered.added.length + filtered.modified.length +
    filtered.deleted.length + filtered.renamed.length;
  return { manifest, filtered, malformedSkipped, syncImportRoot, modePath, totalChanges };
}

function dryRunResult(input: {
  lastCommit: string;
  headCommit: string;
  filtered: SyncManifest;
  malformedSkipped: string[];
  totalChanges: number;
}): SyncResult {
  const { lastCommit, headCommit, filtered, malformedSkipped, totalChanges } = input;
  slog(`Sync dry run: ${lastCommit.slice(0, 8)}..${headCommit.slice(0, 8)}`);
  if (filtered.added.length) slog(`  Added: ${filtered.added.join(', ')}`);
  if (filtered.modified.length) slog(`  Modified: ${filtered.modified.join(', ')}`);
  if (filtered.deleted.length) slog(`  Deleted: ${filtered.deleted.join(', ')}`);
  if (filtered.renamed.length) slog(`  Renamed: ${filtered.renamed.map(r => `${r.from} -> ${r.to}`).join(', ')}`);
  if (malformedSkipped.length) {
    slog(`  Skipped (malformed filename — brackets/control chars; rename to import): ${malformedSkipped.map(sanitizePathForDisplay).join(', ')}`);
  }
  if (totalChanges === 0) slog(`  No syncable changes.`);
  return {
    status: 'dry_run',
    malformedSkipped: malformedSkipped.length,
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
