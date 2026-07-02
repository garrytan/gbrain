/**
 * gbrain sources-ops — pure async functions for source-management operations
 * (v0.28). Extracted from src/commands/sources.ts so the CLI handlers and the
 * MCP ops (sources_add / list / remove / status) share one implementation.
 *
 * Atomicity contract for addSource with --url (D3, eng-review):
 *
 *                    sources add --url <url>
 *                              │
 *                              ▼
 *                  parseRemoteUrl(url) → SSRF gate
 *                              │
 *                              ▼  (URL ok)
 *                  pre-flight SELECT id ─── id taken? ──► error (Q4)
 *                              │
 *                              ▼  (id free)
 *                  mkdir $GBRAIN_HOME/clones/.tmp/<id>-<rand>/
 *                              │
 *                              ▼
 *                  cloneRepo(url, tmp/) ─── fail ──► rm -rf tmp/, throw
 *                              │
 *                              ▼
 *                  INSERT INTO sources ─── fail ──► rm -rf tmp/, throw
 *                              │
 *                              ▼
 *                  fs.renameSync(tmp/, final) ─── fail ──► rm -rf tmp/, throw
 *                                                              + best-effort
 *                                                              DELETE row
 *                              │
 *                              ▼
 *                       return SourceRow
 *
 * Symlink-safe clone-cleanup for removeSource: realpath + lstat confinement
 * mirroring src/core/operations.ts:61 validateUploadPath. String startsWith
 * is symlink-unsafe and would let $GBRAIN_HOME/clones/<id> → /etc resolve
 * out of the confine.
 */

import { existsSync, mkdirSync, renameSync, rmSync, lstatSync } from 'fs';
import { realpathSync } from 'fs';
import { join, dirname, basename, resolve as resolvePath } from 'path';
import { randomBytes } from 'crypto';
import type { BrainEngine } from './engine.ts';
import {
  parseRemoteUrl,
  cloneRepo,
  validateRepoState,
  RemoteUrlError,
  GitOperationError,
  type RepoState,
} from './git-remote.ts';
import { gbrainPath } from './config.ts';
import { isValidSourceId } from './source-id.ts';
import { resolveSourceWithTier, type SourceTier } from './source-resolver.ts';

// ── Errors ──────────────────────────────────────────────────────────────────

export type SourceOpErrorCode =
  | 'invalid_id'
  | 'source_id_taken'
  | 'overlapping_path'
  | 'invalid_remote_url'
  | 'clone_failed'
  | 'insert_failed'
  | 'rename_failed'
  | 'not_found'
  | 'protected_id'
  | 'clone_dir_outside_gbrain'
  | 'symlink_escape'
  | 'unmanaged_path';

export class SourceOpError extends Error {
  constructor(
    public code: SourceOpErrorCode,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'SourceOpError';
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface SourceRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | null;
  config: Record<string, unknown>;
  created_at: Date;
  /**
   * v0.40.3.0: per-source CR mode override. NULL falls through to global
   * mode bundle. Written only by `gbrain sources set-cr-mode <id> <mode>`
   * (CLI-write-only per D15 security gate); MCP / OAuth callers cannot
   * mutate this field.
   */
  contextual_retrieval_mode?: string | null;
  /**
   * v0.40.3.0: per-source mount-frontmatter trust gate (D15). FALSE for
   * mounted sources by default. Flipped via
   * `gbrain mounts trust-frontmatter <id>`. Host source (id='default') is
   * always trusted in the resolver regardless of this column value.
   */
  trust_frontmatter_overrides?: boolean;
}

export interface SourceListEntry {
  id: string;
  name: string;
  local_path: string | null;
  remote_url: string | null;
  federated: boolean;
  page_count: number;
  last_sync_at: string | null;
}

export interface SourceStatus {
  id: string;
  name: string;
  local_path: string | null;
  remote_url: string | null;
  federated: boolean;
  page_count: number;
  last_sync_at: string | null;
  last_commit: string | null;
  archived: boolean;
  /**
   * Discriminated union from validateRepoState. 'not-applicable' if the
   * source has no local_path (pure DB source). Lets a remote MCP caller
   * diagnose "is the clone OK?" without SSH access to the brain host.
   */
  clone_state: RepoState | 'not-applicable';
}

export interface AddSourceOpts {
  id: string;
  name?: string;
  localPath?: string | null;
  remoteUrl?: string;
  federated?: boolean | null;
  /**
   * Override clone destination. Defaults to $GBRAIN_HOME/clones/<id>/.
   * Only honored when remoteUrl is set.
   */
  cloneDir?: string;
}

export interface RemoveSourceOpts {
  id: string;
  confirmDestructive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  keepStorage?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate via the canonical regex from `source-id.ts` but rethrow as the
 * sources-ops-tagged error so `gbrain sources add` keeps its user-facing
 * SourceOpError shape. The regex itself is in one place; only the error
 * envelope differs per caller.
 */
function validateSourceId(id: string): void {
  if (!isValidSourceId(id)) {
    throw new SourceOpError(
      'invalid_id',
      `Invalid source id "${id}". Must be 1-32 lowercase alnum chars with optional interior hyphens.`,
    );
  }
}

function parseConfig(config: unknown): Record<string, unknown> {
  if (typeof config === 'string') {
    try {
      return JSON.parse(config) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof config === 'object' && config !== null) return config as Record<string, unknown>;
  return {};
}

function isFederated(config: unknown): boolean {
  return parseConfig(config).federated === true;
}

function getRemoteUrl(config: unknown): string | null {
  const v = parseConfig(config).remote_url;
  return typeof v === 'string' ? v : null;
}

async function fetchSourceRow(engine: BrainEngine, id: string): Promise<SourceRow | null> {
  const rows = await engine.executeRaw<{
    id: string;
    name: string;
    local_path: string | null;
    last_commit: string | null;
    last_sync_at: Date | null;
    config: unknown;
    created_at: Date;
  }>(
    `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at
       FROM sources WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return { ...r, config: parseConfig(r.config) };
}

async function countPages(engine: BrainEngine, id: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
    [id],
  );
  return rows[0]?.n ?? 0;
}

/** Default clone dir for a remote-URL source: $GBRAIN_HOME/clones/<id>/ */
export function defaultCloneDir(id: string): string {
  return gbrainPath('clones', id);
}

/** Temp clone dir under $GBRAIN_HOME/clones/.tmp/<id>-<rand>/ */
function makeTempCloneDir(id: string): string {
  const rand = randomBytes(6).toString('hex');
  return gbrainPath('clones', '.tmp', `${id}-${rand}`);
}

/**
 * Symlink-safe path confinement: realpath both sides, then lstat-walk to
 * confirm `child` is a real subtree of `parent`. Mirrors validateUploadPath
 * shape at src/core/operations.ts:61. String startsWith() would let
 * $GBRAIN_HOME/clones/<id> → /etc bypass the confine.
 *
 * Returns true if `child` exists and is contained under `parent`.
 * Returns false if the resolved path escapes, or either path is unresolvable.
 */
export function isPathContained(child: string, parent: string): boolean {
  let resolvedChild: string;
  let resolvedParent: string;
  try {
    resolvedChild = realpathSync(child);
    resolvedParent = realpathSync(parent);
  } catch {
    return false; // missing path → not contained
  }
  // Append a separator to parent so /foo doesn't match /foobar.
  const parentWithSep = resolvedParent.endsWith('/') ? resolvedParent : resolvedParent + '/';
  return resolvedChild === resolvedParent || resolvedChild.startsWith(parentWithSep);
}

/**
 * Did gbrain CREATE this clone (so re-clone/delete is safe)? Ownership, NOT
 * path-containment — a user-supplied working tree is NEVER owned, even if it
 * happens to sit under $GBRAIN_HOME. This is the #1881 guard: recloneIfMissing
 * deletes local_path, so it must only ever fire on a clone gbrain owns.
 *
 * Ownership is proven by either:
 *   1. config.managed_clone === true — written by addSource's --url path
 *      (covers both default-location and --clone-dir clones), OR
 *   2. local_path === defaultCloneDir(id) — back-compat for clones created
 *      before the marker existed (gbrain's default location), via exact
 *      normalized-path equality (symlink-free, so none of isPathContained's
 *      symlinked-parent / lexical-escape edge cases apply).
 *
 * Everything else is fail-closed (NOT owned → refuse to touch): the bug's
 * federated row (remote_url + a user tree), and pre-marker --clone-dir clones
 * (rare, local-only) which are byte-for-byte indistinguishable from it. Those
 * must be re-added to regain auto-reclone — the correct trade-off when ownership
 * is unprovable.
 */
export function isOwnedClone(src: {
  id: string;
  local_path: string | null;
  config: unknown;
}): boolean {
  if (!src.local_path) return false;
  const cfg =
    typeof src.config === 'string'
      ? (JSON.parse(src.config) as Record<string, unknown>)
      : ((src.config ?? {}) as Record<string, unknown>);
  if (cfg.managed_clone === true) return true;
  return resolvePath(src.local_path) === resolvePath(defaultCloneDir(src.id));
}

/**
 * Recovery hint for an unowned source with a remote_url. Splits guidance by
 * on-disk state: a healthy unowned path syncs read-only (just drop remote_url),
 * but a degraded one (missing/no-git/not-a-dir) cannot be recovered by dropping
 * remote_url — that would only defer the failure to the "Not a git repository"
 * check. Shared by the core SourceOpError and the sync.ts CLI error so they read
 * identically.
 */
export function unownedHint(
  src: { id: string; local_path: string | null },
  state: RepoState,
): string {
  const path = src.local_path ?? '(none)';
  if (state === 'healthy') {
    return (
      `Source "${src.id}" has config.remote_url set but local_path ${path} is not a ` +
      `clone gbrain created. gbrain syncs it read-only and will never re-clone or delete ` +
      `it. To silence this, drop config.remote_url, or re-register with --url so gbrain ` +
      `owns the clone.`
    );
  }
  return (
    `Source "${src.id}" has config.remote_url set but local_path ${path} is not a clone ` +
    `gbrain created and is not a usable git repo (state: ${state}). gbrain will NOT ` +
    `re-clone over it (it is your working tree, not a gbrain-managed mirror). Restore the ` +
    `directory yourself, or remove + re-add the source with --url to let gbrain manage the ` +
    `clone.`
  );
}

// ── addSource ───────────────────────────────────────────────────────────────

export async function addSource(
  engine: BrainEngine,
  opts: AddSourceOpts,
): Promise<SourceRow> {
  validateSourceId(opts.id);

  // Q4: pre-flight collision check before any clone work.
  const existing = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1`,
    [opts.id],
  );
  if (existing.length > 0) {
    throw new SourceOpError(
      'source_id_taken',
      `Source id "${opts.id}" is already registered. ` +
        `Use 'gbrain sources remove ${opts.id} --confirm-destructive' first, then re-add.`,
    );
  }

  // Validate URL before doing any filesystem work.
  let parsedUrl: { url: string; hostname: string } | null = null;
  if (opts.remoteUrl) {
    try {
      parsedUrl = parseRemoteUrl(opts.remoteUrl);
    } catch (e) {
      if (e instanceof RemoteUrlError) {
        throw new SourceOpError('invalid_remote_url', e.message, e);
      }
      throw e;
    }
  }

  // Overlap check for any local path (existing behavior).
  let finalPath = opts.localPath ?? null;
  if (parsedUrl) {
    finalPath = opts.cloneDir ?? defaultCloneDir(opts.id);
  }
  if (finalPath) {
    const others = await engine.executeRaw<{ id: string; local_path: string }>(
      `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND id != $1`,
      [opts.id],
    );
    for (const other of others) {
      const a = finalPath;
      const b = other.local_path;
      if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) {
        throw new SourceOpError(
          'overlapping_path',
          `path "${a}" overlaps with existing source "${other.id}" at "${b}". ` +
            `Overlapping sources are not allowed.`,
        );
      }
    }
  }

  // ── Path A: --url (clone + INSERT + rename) ────────────────────────────
  if (parsedUrl) {
    const tempDir = makeTempCloneDir(opts.id);
    mkdirSync(dirname(tempDir), { recursive: true });

    try {
      cloneRepo(parsedUrl.url, tempDir);
    } catch (e) {
      // Clone failed before we've touched the DB. tempDir may or may not
      // exist; nuke it just in case.
      rmSync(tempDir, { recursive: true, force: true });
      if (e instanceof GitOperationError) {
        throw new SourceOpError('clone_failed', e.message, e);
      }
      throw e;
    }

    // managed_clone:true is the ownership marker (#1881). It authorizes
    // recloneIfMissing to rm+replace this clone — gbrain created it, here or at
    // a --clone-dir path. A user-tree row (created by an external INSERT, no
    // --url) never carries this, so it can never be deleted by reclone.
    const config: Record<string, unknown> = {
      remote_url: parsedUrl.url,
      managed_clone: true,
    };
    if (opts.federated !== null && opts.federated !== undefined) {
      config.federated = opts.federated;
    }
    const displayName = opts.name ?? opts.id;

    try {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
             VALUES ($1, $2, $3, $4::text::jsonb)`,
        [opts.id, displayName, finalPath, JSON.stringify(config)],
      );
    } catch (e) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new SourceOpError(
        'insert_failed',
        `INSERT failed for source "${opts.id}": ${(e as Error).message}`,
        e,
      );
    }

    // Final step: rename temp dir to final clone path. EXDEV (cross-device
    // rename) is rare on a single-host brain but possible if $GBRAIN_HOME
    // and the temp dir are on different mounts. We don't fall back to
    // recursive copy because the temp dir is in $GBRAIN_HOME by design.
    try {
      mkdirSync(dirname(finalPath!), { recursive: true });
      // Refuse to rename over an existing path. If finalPath exists at this
      // point (race: another process created it between our pre-flight and
      // now), back out cleanly.
      if (existsSync(finalPath!)) {
        throw new Error(`destination ${finalPath} appeared mid-flight`);
      }
      renameSync(tempDir, finalPath!);
    } catch (e) {
      rmSync(tempDir, { recursive: true, force: true });
      // Best-effort DB rollback.
      await engine
        .executeRaw(`DELETE FROM sources WHERE id = $1`, [opts.id])
        .catch(() => {});
      throw new SourceOpError(
        'rename_failed',
        `Could not move clone to final path ${finalPath}: ${(e as Error).message}`,
        e,
      );
    }
  } else {
    // ── Path B: --path or no path (existing behavior, pre-v0.28) ─────────
    const config: Record<string, unknown> = {};
    if (opts.federated !== null && opts.federated !== undefined) {
      config.federated = opts.federated;
    }
    const displayName = opts.name ?? opts.id;
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
           VALUES ($1, $2, $3, $4::text::jsonb)`,
      [opts.id, displayName, finalPath, JSON.stringify(config)],
    );
  }

  const created = await fetchSourceRow(engine, opts.id);
  if (!created) {
    throw new SourceOpError(
      'insert_failed',
      `Source "${opts.id}" disappeared after INSERT (concurrent delete?).`,
    );
  }
  return created;
}

// ── resolveDefaultSource ────────────────────────────────────────────────────
//
// v0.34 W0b — canonical helper for CLI commands that take an optional
// --source flag. The contract per the eng review D7:
//   - exactly 1 registered source → return its id (single-source brains,
//     the 80% case; --source flag is unnecessary friction)
//   - 0 sources → throw (no source to scope to)
//   - 2+ sources → throw with the list, forcing the caller to be explicit
//
// Codex finding #7: src/commands/code-callers.ts:54 + code-callees.ts:43
// historically set `allSources: allSources || !sourceId` — which means
// the documented "source-scoped by default" behavior INVERTED to global
// whenever `--source` was omitted. Multi-source brains silently
// cross-contaminated structural retrieval despite the docstring claim.
//
// Helper consolidates the resolution rule so blast/flow/clusters/wiki
// (v0.34 new commands) and code-callers/callees (v0.20.0 retrofit)
// behave identically.

export class SourceResolutionError extends Error {
  constructor(
    message: string,
    public readonly code: 'no_sources' | 'multiple_sources_ambiguous',
    public readonly availableSources: string[],
  ) {
    super(message);
    this.name = 'SourceResolutionError';
  }
}

export async function resolveDefaultSource(engine: BrainEngine): Promise<string> {
  const sources = await listSources(engine);
  if (sources.length === 0) {
    throw new SourceResolutionError(
      'no sources registered; run `gbrain sources add` first',
      'no_sources',
      [],
    );
  }
  if (sources.length === 1) {
    return sources[0]!.id;
  }
  const ids = sources.map((s) => s.id);
  throw new SourceResolutionError(
    `multi-source brain — specify --source from: ${ids.join(', ')}`,
    'multiple_sources_ambiguous',
    ids,
  );
}

/** Result of `resolveScopedSourceOrThrow`: the resolved source id plus the
 * tier that won, so callers can nudge (sole_non_default) or surface the
 * source in their output envelope. */
export interface ScopedSourceResolution {
  source_id: string;
  tier: SourceTier;
}

/**
 * Source scope for the structural-retrieval commands (`code-callers` /
 * `code-callees`) when neither `--source` nor `--all-sources` is given.
 *
 * Runs the FULL 7-tier resolution chain via `resolveSourceWithTier`
 * (flag → env → dotfile → local_path → brain_default → sole_non_default →
 * seed_default), so a `.gbrain-source` pin (or any real signal) selects the
 * source. The multi-source ambiguity guard (`resolveDefaultSource`) is
 * applied ONLY when the chain matched nothing real (tier `seed_default`):
 * 1 source → returns it, 0 → `no_sources` throw, 2+ → `multiple_sources_ambiguous`.
 *
 * Contrast with `resolveSourceId` (silently returns `'default'` and never
 * throws on ambiguity) — this helper deliberately preserves the loud
 * multi-source error when there's genuinely no signal.
 *
 * @throws SourceResolutionError  on a no-signal 0/2+-source brain (seed_default tier).
 * @throws Error ("Source \"…\" not found." / "Invalid …")  on a bad pin / env value
 *         via `assertSourceExists` inside `resolveSourceWithTier` — callers should
 *         surface these as clean usage errors, not uncaught stacks.
 */
export async function resolveScopedSourceOrThrow(
  engine: BrainEngine,
  cwd: string = process.cwd(),
): Promise<ScopedSourceResolution> {
  const resolved = await resolveSourceWithTier(engine, null, cwd);
  if (resolved.tier !== 'seed_default') {
    return { source_id: resolved.source_id, tier: resolved.tier };
  }
  // Nothing in the chain matched → apply the ambiguity guard (may throw).
  const id = await resolveDefaultSource(engine);
  return { source_id: id, tier: 'seed_default' };
}

// ── listSources ─────────────────────────────────────────────────────────────

export async function listSources(
  engine: BrainEngine,
  opts: { includeArchived?: boolean } = {},
): Promise<SourceListEntry[]> {
  // v0.28.1 codex finding (MEDIUM): the prior version ignored the
  // includeArchived flag and returned every row. That leaked archived
  // sources' ids, local_paths, and remote_urls to read-scoped MCP callers
  // who shouldn't see soft-deleted state. Filter at the SQL level so the
  // archived rows never reach the wire by default.
  const archivedFilter = opts.includeArchived
    ? ''
    : 'WHERE archived IS NOT TRUE';
  const rows = await engine.executeRaw<{
    id: string;
    name: string;
    local_path: string | null;
    last_sync_at: Date | null;
    config: unknown;
  }>(
    `SELECT id, name, local_path, last_sync_at, config
       FROM sources ${archivedFilter} ORDER BY (id = 'default') DESC, id`,
  );
  const out: SourceListEntry[] = [];
  for (const r of rows) {
    const cfg = parseConfig(r.config);
    out.push({
      id: r.id,
      name: r.name,
      local_path: r.local_path,
      remote_url: typeof cfg.remote_url === 'string' ? cfg.remote_url : null,
      federated: cfg.federated === true,
      page_count: await countPages(engine, r.id),
      last_sync_at: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    });
  }
  return out;
}

// ── removeSource ────────────────────────────────────────────────────────────

export interface RemoveResult {
  id: string;
  pages_deleted: number;
  clone_removed: boolean;
  clone_path: string | null;
  dryRun: boolean;
}

/**
 * Hard-remove a source row + cascade. v0.28 additions:
 *  - protected-id guard for "default"
 *  - clone-cleanup: delete the on-disk clone IFF its resolved path is
 *    confined under $GBRAIN_HOME/clones/. realpath+lstat (not startsWith)
 *    to defeat symlink escape attacks.
 *
 * Soft-delete (archive / restore) lives in destructive-guard.ts and is the
 * preferred path for users; this hard-remove is for the admin operator
 * confirming via --confirm-destructive after the impact preview.
 */
export async function removeSource(
  engine: BrainEngine,
  opts: RemoveSourceOpts,
): Promise<RemoveResult> {
  validateSourceId(opts.id);

  if (opts.id === 'default') {
    throw new SourceOpError(
      'protected_id',
      'Cannot remove the "default" source (it backs the pre-v0.17 brain).',
    );
  }

  const src = await fetchSourceRow(engine, opts.id);
  if (!src) {
    throw new SourceOpError('not_found', `Source "${opts.id}" not found.`);
  }

  const pageCount = await countPages(engine, opts.id);

  if (opts.dryRun) {
    return {
      id: opts.id,
      pages_deleted: pageCount,
      clone_removed: false,
      clone_path: src.local_path,
      dryRun: true,
    };
  }

  // Confirmation gate (caller should usually have already shown the impact
  // preview from destructive-guard.ts).
  if (pageCount > 0 && !opts.confirmDestructive && !opts.yes) {
    throw new SourceOpError(
      'protected_id', // closest existing code; caller can frame as "needs confirm"
      `Refusing to remove source "${opts.id}" with ${pageCount} pages without --confirm-destructive or --yes.`,
    );
  }

  // Decide whether we own the clone dir before removing the row.
  const remoteUrl = getRemoteUrl(src.config);
  const cloneRoot = gbrainPath('clones');
  let cloneRemoved = false;
  if (
    !opts.keepStorage &&
    src.local_path &&
    remoteUrl && // only auto-clean when this was a --url-managed clone
    isPathContained(src.local_path, cloneRoot)
  ) {
    try {
      // Extra symlink-escape paranoia: lstat the resolved final path; if
      // it's a symlink itself (not just contained under the parent), bail
      // out rather than rm -rf following the link.
      const lst = lstatSync(src.local_path);
      if (lst.isSymbolicLink()) {
        throw new SourceOpError(
          'symlink_escape',
          `Refusing to delete clone at ${src.local_path}: path is a symlink.`,
        );
      }
      rmSync(src.local_path, { recursive: true, force: true });
      cloneRemoved = true;
    } catch (e) {
      if (e instanceof SourceOpError) throw e;
      // Don't fail the whole remove if rmSync had a permission hiccup — log
      // and continue. The DB row deletion is the user-facing operation.
      console.error(
        `[gbrain] WARN: clone cleanup at ${src.local_path} failed: ${(e as Error).message}`,
      );
    }
  }

  await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [opts.id]);

  return {
    id: opts.id,
    pages_deleted: pageCount,
    clone_removed: cloneRemoved,
    clone_path: src.local_path,
    dryRun: false,
  };
}

// ── getSourceStatus ─────────────────────────────────────────────────────────

export async function getSourceStatus(
  engine: BrainEngine,
  id: string,
): Promise<SourceStatus> {
  validateSourceId(id);
  const src = await fetchSourceRow(engine, id);
  if (!src) {
    throw new SourceOpError('not_found', `Source "${id}" not found.`);
  }

  // Archived check — sources.config.archived is a forward-compat slot;
  // schema.sql also has dedicated `archived` column post-v0.26.5. Read the
  // column directly via a separate query so we don't need to widen the
  // SourceRow shape just for status.
  const archivedRows = await engine.executeRaw<{ archived: boolean | null }>(
    `SELECT archived FROM sources WHERE id = $1`,
    [id],
  );
  const archived = archivedRows[0]?.archived === true;

  const remoteUrl = getRemoteUrl(src.config);
  let cloneState: SourceStatus['clone_state'] = 'not-applicable';
  if (src.local_path) {
    cloneState = validateRepoState(src.local_path, remoteUrl ?? undefined);
  }

  return {
    id: src.id,
    name: src.name,
    local_path: src.local_path,
    remote_url: remoteUrl,
    federated: isFederated(src.config),
    page_count: await countPages(engine, id),
    last_sync_at: src.last_sync_at ? new Date(src.last_sync_at).toISOString() : null,
    last_commit: src.last_commit,
    archived,
    clone_state: cloneState,
  };
}

// ── recloneIfNeeded (used by sources.ts restore path) ──────────────────────

/**
 * Re-clone a source's remote_url into its local_path if the clone is
 * missing on disk. Used by `gbrain sources restore` after an operator
 * autopurged $GBRAIN_HOME/clones/. Idempotent: returns false (didn't clone)
 * if the clone is already there.
 *
 * Throws SourceOpError on clone failure. Does NOT touch the DB row.
 */
export async function recloneIfMissing(
  engine: BrainEngine,
  id: string,
): Promise<boolean> {
  const src = await fetchSourceRow(engine, id);
  if (!src) {
    throw new SourceOpError('not_found', `Source "${id}" not found.`);
  }
  const remoteUrl = getRemoteUrl(src.config);
  if (!remoteUrl || !src.local_path) return false;

  const state = validateRepoState(src.local_path, remoteUrl);
  if (state === 'healthy') return false;

  // #1881 ownership guard — abort BEFORE any filesystem op. recloneIfMissing
  // deletes local_path; gbrain may only do that to a clone it created, never a
  // user working tree. A row with remote_url + an unowned local_path (the
  // gstack-orchestrator federated shape) is refused here, loudly, untouched.
  if (!isOwnedClone(src)) {
    throw new SourceOpError('unmanaged_path', unownedHint(src, state));
  }

  // EXDEV-safe atomic reclone. Clone into a SIBLING temp of local_path (not the
  // shared clones/.tmp, which can be on a different mount than a --clone-dir
  // target → EXDEV → "deleted but not recloned"). Then swap: move old aside →
  // move new in → drop old, so local_path is never left missing-and-unrecoverable.
  const parent = dirname(src.local_path);
  mkdirSync(parent, { recursive: true });
  const rand = randomBytes(6).toString('hex');
  const tempDir = join(parent, `.gbrain-reclone-${basename(src.local_path)}-${rand}`);
  try {
    cloneRepo(remoteUrl, tempDir);
  } catch (e) {
    rmSync(tempDir, { recursive: true, force: true });
    if (e instanceof GitOperationError) {
      throw new SourceOpError('clone_failed', e.message, e);
    }
    throw e;
  }

  // TOCTOU re-check immediately before the destructive move: re-confirm
  // ownership AND reject a symlink leaf swapped in after the entry check (never
  // rm-rf / rename through a symlink).
  if (!isOwnedClone(src)) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new SourceOpError('unmanaged_path', unownedHint(src, state));
  }
  let aside: string | null = null;
  try {
    if (existsSync(src.local_path)) {
      // Symlink leaf guard: never rename/rm *through* a symlinked leaf — that's
      // the TOCTOU swap-in vector (an attacker plants a symlink at local_path
      // between the entry ownership check and this rename). An owned clone's leaf
      // is a real dir gbrain created; a symlink here means tamper, so fail closed.
      // (Symlinked ANCESTORS are intentionally NOT rejected here: for an owned
      // clone gbrain created the dir at this path — cloneRepo refuses a non-empty
      // dest, so a pre-existing user tree can never become an owned clone — and a
      // realpath-chain check false-positives on ubiquitous system symlinks like
      // macOS /var -> /private/var. The residual DB-trust risk, a forged
      // managed_clone marker on an arbitrary path, is tracked as a TODO and is
      // not closable by a path check.)
      if (lstatSync(src.local_path).isSymbolicLink()) {
        rmSync(tempDir, { recursive: true, force: true });
        throw new SourceOpError(
          'symlink_escape',
          `Refusing to re-clone "${id}": local_path ${src.local_path} is a symlink.`,
        );
      }
      aside = `${src.local_path}.old-${rand}`;
      renameSync(src.local_path, aside); // same fs (sibling) — no EXDEV
    }
    renameSync(tempDir, src.local_path); // same fs — no EXDEV
  } catch (e) {
    // Best-effort restore of the original if the swap left local_path missing.
    if (aside && !existsSync(src.local_path)) {
      try {
        renameSync(aside, src.local_path);
      } catch {
        /* original kept at `aside`; surfaced via the thrown error below */
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
    if (e instanceof SourceOpError) throw e;
    // If the original is still parked at `aside` (restore failed), tell the user
    // exactly where it is — otherwise a "cleanup the failed reclone" reflex would
    // delete their only copy.
    const asideNote =
      aside && existsSync(aside)
        ? ` Your original clone is preserved at ${aside} — restore it manually; do not delete it.`
        : '';
    throw new SourceOpError(
      'rename_failed',
      `Could not move re-cloned repo to ${src.local_path}: ${(e as Error).message}.${asideNote}`,
      e,
    );
  }
  if (aside) rmSync(aside, { recursive: true, force: true });
  return true;
}
