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
import { join, dirname, resolve as resolvePath } from 'path';
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
  | 'symlink_escape';

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

const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export interface SourceRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | null;
  config: Record<string, unknown>;
  created_at: Date;
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

function validateSourceId(id: string): void {
  if (!SOURCE_ID_RE.test(id)) {
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

    const config: Record<string, unknown> = { remote_url: parsedUrl.url };
    if (opts.federated !== null && opts.federated !== undefined) {
      config.federated = opts.federated;
    }
    const displayName = opts.name ?? opts.id;

    try {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
             VALUES ($1, $2, $3, $4::jsonb)`,
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
           VALUES ($1, $2, $3, $4::jsonb)`,
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

  // Re-clone via temp + rename, mirroring addSource's atomicity contract.
  const tempDir = makeTempCloneDir(id);
  mkdirSync(dirname(tempDir), { recursive: true });
  try {
    cloneRepo(remoteUrl, tempDir);
  } catch (e) {
    rmSync(tempDir, { recursive: true, force: true });
    if (e instanceof GitOperationError) {
      throw new SourceOpError('clone_failed', e.message, e);
    }
    throw e;
  }

  // If the local_path partially exists (e.g., empty dir, file-not-dir), nuke
  // it before the rename so renameSync doesn't fail on a non-empty target.
  rmSync(src.local_path, { recursive: true, force: true });
  mkdirSync(dirname(src.local_path), { recursive: true });
  try {
    renameSync(tempDir, src.local_path);
  } catch (e) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new SourceOpError(
      'rename_failed',
      `Could not move re-cloned repo to ${src.local_path}: ${(e as Error).message}`,
      e,
    );
  }
  return true;
}
