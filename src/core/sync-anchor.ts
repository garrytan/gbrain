/**
 * Sync anchor + chunker-version state helpers (source-scoped vs legacy
 * global-config storage). Peeled out of src/commands/sync.ts (containment
 * sprint C13-C14) as a pure move.
 */
import { realpathSync } from 'fs';
import type { BrainEngine } from './engine.ts';
import type { SyncOpts } from '../commands/sync.ts';
import { ownsGlobalSyncAnchor } from './sync.ts';
import { serr } from './console-prefix.ts';

// v0.18.0 Step 5: source-scoped sync state helpers. When opts.sourceId
// is set, read/write the per-source row instead of the global config
// keys. These wrappers centralize the branch so every read/write site
// picks the right storage — future Step 5 work (failure-tracking per
// source) hooks here too.
export async function readSyncAnchor(
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

/**
 * #2964: is `repoPath` gbrain's own default-brain anchor, as opposed to a
 * path some caller merely happened to pass through unchanged?
 *
 * `!opts.sourceId` alone is NOT sufficient — and neither is rejecting
 * `opts.sourceId` outright: migration `sources_table_additive` (v20)
 * seeds a `'default'` source row whose `local_path` is copied FROM
 * `config.sync.repo_path` on every brain that has ever run it (i.e.
 * effectively all of them by now), and `writeSyncAnchor` keeps that row's
 * `local_path` current on every sync thereafter. So on a real installed
 * brain, `resolveSourceForDir` (dream cycle) and the CLI's bare `gbrain
 * sync` both resolve `sourceId: 'default'`, NOT `undefined` — rejecting
 * all non-empty `sourceId` (an earlier, insufficiently-reviewed version
 * of this check) made self-heal never fire on that real path either,
 * masked in tests only because a freshly-`initSchema()`'d test brain's
 * `'default'` row has a null `local_path` (Codex review round 5).
 *
 * The actual boundary: `'default'` is gbrain's own bootstrap identity,
 * not something a caller names — a DIFFERENT, non-default `sourceId` is
 * what an explicit `sources add <id> --path <dir>` registration (a
 * user's own external directory) looks like, and that's what must keep
 * failing loudly. So: permit `sourceId` when it's exactly `undefined` or
 * `'default'`, reject any other id, and for BOTH permitted cases prove
 * ownership by VALUE — reread the live anchor for that same identity
 * (`sources.default.local_path` when sourceId='default', else
 * `config.sync.repo_path`) and require the resolved `repoPath` to
 * REALPATH-equal it (not raw string equality: `dream`'s `resolveBrainDir`
 * normalizes via `path.resolve`, so a trailing slash or `..` in the
 * stored anchor must not defeat the match — Codex review round 5, P2).
 * An arbitrary caller-supplied path (e.g. an admin-scope
 * `submit_job({name:'sync', data:{repoPath}})`) only passes this check
 * if it already equals gbrain's own anchor by realpath identity — at
 * which point self-healing it is exactly the legitimate case, not an
 * escalation.
 *
 * `opts.srcSubpath` disqualifies unconditionally: a subpath-scoped sync
 * only wants THAT subdirectory captured, but the self-heal baseline
 * commit runs `git add -A` at the git root (there's no file list yet to
 * scope it to — collection happens after this point) — see the P2 review
 * finding on `createSyncBaselineCommit`'s callers.
 */
export async function isAnchorOwnedSyncPath(
  engine: BrainEngine,
  opts: SyncOpts,
  repoPath: string,
): Promise<boolean> {
  if (opts.srcSubpath) return false;
  if (opts.sourceId && opts.sourceId !== 'default') return false;
  const anchor = await readSyncAnchor(engine, opts.sourceId, 'repo_path');
  if (anchor === null) return false;
  try {
    return realpathSync(anchor) === realpathSync(repoPath);
  } catch {
    // Anchor or repoPath doesn't realpath-resolve (dangling/nonexistent) —
    // can't prove identity, so don't self-heal.
    return false;
  }
}

export async function writeSyncAnchor(
  engine: BrainEngine,
  sourceId: string | undefined,
  which: 'repo_path' | 'last_commit',
  value: string,
  // v0.41.32.0 (supersedes #1623): on `last_commit` advances, also stamp the
  // durable newest-COMMIT timestamp (HEAD committer time, epoch ms) in the SAME
  // atomic UPDATE as last_sync_at — no separate write to leave partial state,
  // no clock-domain split (last_sync_at = DB now(); newest_content_at = the
  // git-intrinsic committer time of the HEAD we just synced). `undefined` keeps
  // the legacy 2-column write; `null` clears the column (git unavailable).
  newestContentEpochMs?: number | null,
  // #2114: the repo dir this anchor write is FOR. Required to guard the
  // legacy branch's `last_commit` writes (where `value` is a hash, not a
  // dir). `repo_path` writes self-describe via `value`. Callers that omit
  // it on a legacy-path last_commit write keep pre-#2114 behavior.
  repoDir?: string,
): Promise<void> {
  if (sourceId) {
    const col = which === 'repo_path' ? 'local_path' : 'last_commit';
    // last_sync_at bookmarked on every last_commit advance.
    if (which === 'last_commit') {
      if (newestContentEpochMs !== undefined) {
        const iso = newestContentEpochMs === null
          ? null
          : new Date(newestContentEpochMs).toISOString();
        await engine.executeRaw(
          `UPDATE sources SET last_commit = $1, last_sync_at = now(), newest_content_at = $3 WHERE id = $2`,
          [value, sourceId, iso],
        );
      } else {
        await engine.executeRaw(
          `UPDATE sources SET last_commit = $1, last_sync_at = now() WHERE id = $2`,
          [value, sourceId],
        );
      }
    } else {
      await engine.executeRaw(
        `UPDATE sources SET ${col} = $1 WHERE id = $2`,
        [value, sourceId],
      );
    }
    return;
  }
  // Legacy no-sourceId path (pre-v0.18 global config; also reached when a
  // caller could not resolve a source for the dir — dream --dir on an
  // unregistered directory, minion sync with an unmatched repoPath). #2114:
  // these globals describe THE brain repo, and this branch used to write
  // them unconditionally — a full-sync fallback against a foreign directory
  // silently repointed put_page write-through and poisoned the incremental
  // anchor. Refuse to move them for a directory that isn't the brain repo.
  const anchorDir = which === 'repo_path' ? value : repoDir;
  if (anchorDir !== undefined) {
    const { owns, configured } = await ownsGlobalSyncAnchor(engine, undefined, anchorDir);
    if (!owns) {
      serr(
        `[sync] sync.${which} stays at ${configured ?? '(unset)'} — not moving the ` +
        `global anchor for "${anchorDir}". To make that directory the brain repo: ` +
        `gbrain config set sync.repo_path "${anchorDir}"`,
      );
      return;
    }
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
export async function readChunkerVersion(
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

export async function writeChunkerVersion(
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
