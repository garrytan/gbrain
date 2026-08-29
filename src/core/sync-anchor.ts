/**
 * Sync anchor + chunker-version state helpers (source-scoped vs legacy
 * global-config storage). Peeled out of src/commands/sync.ts (containment
 * sprint C13-C14) as a pure move.
 */
import { realpathSync } from 'fs';
import { resolve as pathResolve } from 'path';
import type { BrainEngine } from './engine.ts';
import type { SyncOpts } from '../commands/sync.ts';
import { ownsGlobalSyncAnchor, sameRepoDir } from './sync.ts';
import { isWithinRoot } from './sync-git.ts';
import { serr } from './console-prefix.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from './source-config-sql.ts';

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

export interface SourceAnchorOwnership {
  owns: boolean;
  /** The path ownership was judged against, or null when the source has no
   * directory identity yet (bootstrap allowed). */
  configured: string | null;
}

/**
 * #4369 — may a sync of `dir` move THIS source's directory anchor
 * (`sources.local_path`)? The per-source analog of `ownsGlobalSyncAnchor`,
 * one level down: `local_path` is the source's registered directory
 * identity, and `writeSyncAnchor`'s per-source branch used to UPDATE it
 * unconditionally — an explicit `--source <id>` paired with a foreign
 * directory (or a fallback that resolved the wrong dir) silently repointed
 * an explicitly-registered source, poisoning put_page write-through and
 * that source's incremental anchor. Ownership rules:
 *   - `'default'` delegates to `ownsGlobalSyncAnchor` (the default source
 *     IS the brain repo; its identity rules — global key first, then the
 *     row's local_path, bootstrap only when neither exists — already live
 *     there, so the two layers cannot drift).
 *   - any other id: the row's `local_path` when set (realpath-tolerant via
 *     `sameRepoDir`, so a symlinked/case-variant spelling can't
 *     false-refuse the source's own directory); a null `local_path`
 *     bootstraps (first sync of a freshly-registered source).
 * Best-effort: a failed row read fails OPEN (a guard bug must never block
 * anchor writes — the UPDATE itself surfaces real DB trouble).
 */
export async function ownsSourceSyncAnchor(
  engine: BrainEngine,
  sourceId: string,
  dir: string,
): Promise<SourceAnchorOwnership> {
  if (sourceId === 'default') {
    return await ownsGlobalSyncAnchor(engine, sourceId, dir);
  }
  try {
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = $1`,
      [sourceId],
    );
    const configured = rows[0]?.local_path ?? null;
    if (configured === null) return { owns: true, configured: null };
    return { owns: sameRepoDir(configured, dir), configured };
  } catch {
    return { owns: true, configured: null };
  }
}

/** Realpath-normalize a directory (the same fallback ladder as
 * `sync.ts:sameRepoDir`'s inner norm — resolve, native realpath, realpath,
 * else the resolved spelling). */
function normRepoDir(p: string): string {
  const abs = pathResolve(p); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- this resolve IS the ownership guard (#4369): canonicalizes before same-repo containment comparison
  try {
    return realpathSync.native(abs);
  } catch {
    // fall through
  }
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Equal, or nested in EITHER direction after realpath normalization. The
 * commit-anchor guard's comparator: a subpath-scoped sync passes the git
 * ROOT while the registered `local_path` is the scope root inside it (and a
 * nested-repo registration is the mirror shape) — both are the same tree.
 * Only two disjoint trees (a foreign repo) fail. */
function sameOrNestedRepoDir(a: string, b: string): boolean {
  const na = normRepoDir(a);
  const nb = normRepoDir(b);
  return na === nb || isWithinRoot(na, nb) || isWithinRoot(nb, na);
}

/**
 * Wave-D review (#4369 follow-up) — may a sync running against git root
 * `repoDir` advance THIS source's commit-anchor trio (`last_commit` /
 * `last_sync_at` / `newest_content_at`)? Deliberately WEAKER than
 * `ownsSourceSyncAnchor` (which pins the directory identity itself with an
 * equality compare): a subpath-scoped sync legitimately advances the commit
 * anchor while the dir it passes (the git root) differs from the registered
 * scope root — so containment in either direction is allowed, and only a
 * FOREIGN repo (disjoint trees) is refused. Without this, a sync fallback
 * that resolved the wrong source (or an explicit `--source` paired with a
 * foreign directory) stamps another repo's HEAD into this source's
 * incremental anchor, silently skipping every future delta between the
 * poisoned hash and reality.
 *
 * Identity resolution mirrors `ownsGlobalSyncAnchor` for `'default'` (global
 * `sync.repo_path` key first, else the row's `local_path`); other ids use the
 * row's `local_path`. A null identity bootstraps (first sync of a
 * freshly-registered source). Best-effort: a failed read fails OPEN — a
 * guard bug must never block anchor writes.
 */
export async function sourceCommitAnchorAllowed(
  engine: BrainEngine,
  sourceId: string,
  repoDir: string,
): Promise<SourceAnchorOwnership> {
  try {
    let configured: string | null = null;
    if (sourceId === 'default') {
      configured = (await engine.getConfig('sync.repo_path')) || null;
    }
    if (configured === null) {
      const rows = await engine.executeRaw<{ local_path: string | null }>(
        `SELECT local_path FROM sources WHERE id = $1`,
        [sourceId],
      );
      configured = rows[0]?.local_path ?? null;
    }
    if (configured === null) return { owns: true, configured: null };
    return { owns: sameOrNestedRepoDir(configured, repoDir), configured };
  } catch {
    return { owns: true, configured: null };
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
      // Wave-D review (#4369 follow-up): guard the commit-anchor trio
      // (last_commit / last_sync_at / newest_content_at) too. A foreign
      // REPO's HEAD stamped here poisons the incremental anchor — every
      // future sync diffs from a hash that isn't in the registered repo's
      // history. Same-tree containment (git root vs registered scope root,
      // either direction) stays allowed so subpath-scoped syncs keep
      // advancing; callers that omit repoDir keep pre-guard behavior (the
      // dir is unknown, and a guard that can't see it must not refuse).
      if (repoDir !== undefined) {
        const { owns, configured } = await sourceCommitAnchorAllowed(engine, sourceId, repoDir);
        if (!owns) {
          serr(
            `[sync] sources.last_commit for "${sourceId}" not advanced — syncing repo ` +
            `"${repoDir}" is neither the registered directory ${configured ?? '(unset)'} nor ` +
            `within the same tree. Sync from the registered directory, or re-register the ` +
            `source to move it intentionally.`,
          );
          return;
        }
      }
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
      // #4369: repo_path repoints require directory-identity EQUALITY
      // (ownsSourceSyncAnchor); last_commit advances above use the weaker
      // same-tree containment guard (sourceCommitAnchorAllowed) so
      // subpath-scoped syncs — whose git root differs from the registered
      // scope root — keep advancing while foreign repos are refused.
      const { owns, configured } = await ownsSourceSyncAnchor(engine, sourceId, value);
      if (!owns) {
        serr(
          `[sync] sources.local_path for "${sourceId}" stays at ${configured ?? '(unset)'} — ` +
          `not repointing the source at "${value}". Sync from the registered directory, ` +
          `or re-register the source to move it intentionally.`,
        );
        return;
      }
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

// ─── #4342 — sticky per-source slug-root mode ─────────────────────────────
//
// When a source's local_path is a SUBDIRECTORY of a git repo, sync has two
// possible slug namespaces:
//   'git-root'    — slugs carry the subdir prefix (git-diff-path shaped; the
//                   historical #774 behavior, and the only sane shape when
//                   the user explicitly scoped with --src-subpath)
//   'source-root' — slugs are local_path-relative (matches what a plain
//                   `gbrain import <dir>` of the same tree produces)
//
// The choice used to be IMPLICIT (whatever the first sync inferred), and a
// later sync from a different spelling silently re-namespaced every slug.
// The mode is now decided ONCE, persisted (sources.config.slug_root_mode for
// scoped sources, `sync.slug_root_mode` config for the legacy no-source
// path), and every subsequent sync obeys the pin.

export type SlugRootMode = 'git-root' | 'source-root';

function asSlugRootMode(raw: unknown): SlugRootMode | null {
  return raw === 'git-root' || raw === 'source-root' ? raw : null;
}

export async function readSlugRootMode(
  engine: BrainEngine,
  sourceId: string | undefined,
): Promise<SlugRootMode | null> {
  if (sourceId) {
    const rows = await engine.executeRaw<{ mode: string | null }>(
      `SELECT config->>'slug_root_mode' AS mode FROM sources WHERE id = $1`,
      [sourceId],
    );
    return asSlugRootMode(rows[0]?.mode);
  }
  return asSlugRootMode(await engine.getConfig('sync.slug_root_mode'));
}

export async function writeSlugRootMode(
  engine: BrainEngine,
  sourceId: string | undefined,
  mode: SlugRootMode,
): Promise<void> {
  if (sourceId) {
    // jsonb_set on a bound ::text — never JSON.stringify into ::jsonb.
    //
    // #4521: a historical string-scalar (or array-shaped) sources.config made
    // the plain `jsonb_set(COALESCE(config, '{}'::jsonb), …)` throw
    // `cannot set path in scalar` and abort every subdir-scoped sync right
    // after sync.discover_git_root. Heal-on-write instead: coerce the column
    // through the canonical SOURCE_CONFIG_OBJECT_SQL recovery expression
    // (unwraps double-encoded object strings so their keys SURVIVE; anything
    // unrecoverable collapses to '{}') before setting the key.
    try {
      await engine.executeRaw(
        `UPDATE sources
            SET config = jsonb_set(${SOURCE_CONFIG_OBJECT_SQL}, '{slug_root_mode}', to_jsonb($2::text))
          WHERE id = $1`,
        [sourceId, mode],
      );
    } catch (e) {
      // Name the source — "cannot set path in scalar" alone gives the
      // operator nothing to act on.
      throw new Error(
        `failed to pin slug_root_mode on sources.config for source '${sourceId}': ` +
        `${e instanceof Error ? e.message : String(e)}`,
        e instanceof Error ? { cause: e } : undefined,
      );
    }
    return;
  }
  await engine.setConfig('sync.slug_root_mode', mode);
}

/** Escape LIKE metacharacters so a slug prefix can't wildcard-match. */
function escapeLike(s: string): string {
  return s.replace(/([\\%_])/g, '\\$1');
}

/**
 * Resolve (and PIN) the slug-root mode for a scoped sync. Precedence:
 *   1. the stored pin (sticky forever — a live install never re-slugs)
 *   2. explicit --src-subpath → 'git-root' (the #774 contract: the caller
 *      named the git root as the slug base)
 *   3. auto-pin 'git-root' when existing pages already carry the inferred
 *      git-root prefix (this install has lived with git-root slugs; flipping
 *      would strand every page + its links/takes under the old namespace)
 *   4. else 'source-root' (local_path-relative — what `gbrain import <dir>`
 *      of the same tree produces, and the least surprising default)
 * The decision is persisted before returning so every later sync agrees.
 *
 * `slugPrefix` is the SLUGIFIED git-root-relative scope prefix WITHOUT a
 * trailing slash (callers derive it via resolveSlugForPath so the probe
 * matches slug spelling, not raw path spelling).
 *
 * `dryRun: true` resolves the mode in-memory only and skips the persist —
 * a `sync --dry-run` must never mutate config (#4342 review fix). The pin
 * is written by the first REAL sync instead.
 */
export async function resolveSlugRootMode(
  engine: BrainEngine,
  opts: {
    sourceId: string | undefined;
    explicitGitRoot: boolean;
    slugPrefix: string;
    dryRun?: boolean;
  },
): Promise<SlugRootMode> {
  const stored = await readSlugRootMode(engine, opts.sourceId);
  if (stored) return stored;
  let mode: SlugRootMode;
  if (opts.explicitGitRoot) {
    mode = 'git-root';
  } else {
    const rows = await engine.executeRaw<{ one: number }>(
      `SELECT 1 AS one FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE $2 LIMIT 1`,
      [opts.sourceId ?? 'default', `${escapeLike(opts.slugPrefix)}/%`],
    );
    mode = rows.length > 0 ? 'git-root' : 'source-root';
  }
  if (opts.dryRun !== true) {
    await writeSlugRootMode(engine, opts.sourceId, mode);
  }
  return mode;
}
