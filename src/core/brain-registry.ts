/**
 * BrainRegistry — connected gbrains (v0.19, PR 0).
 *
 * A registry of BrainEngine handles keyed by brainId. Supports:
 *   - 'host': the brain defined by ~/.gbrain/config.json (single-brain default).
 *   - <mount-id>: brains declared in ~/.gbrain/mounts.json.
 *
 * This is the dispatch-time lookup that makes `ctx.brainId` → `ctx.engine`
 * resolution routable per operation. Only direct-transport mounts are
 * supported in PR 0. HTTP MCP transport (team-published brains with OAuth)
 * lands in PR 2.
 *
 * Design notes:
 * - Engines are lazily created on first `getBrain(id)` and cached.
 * - `disconnectAll()` is idempotent and safe to call during shutdown.
 * - NO AsyncLocalStorage. Brain routing is explicit via OperationContext.
 * - mounts.json is validated strictly on load. Malformed entries throw with
 *   actionable messages so partial-state silent failures never happen.
 * - `DuplicateMountPathError` blocks two mounts pointing at the same local
 *   path (load-bearing identity: skills/handlers/git-sync/attestation all
 *   key off path). Same db_url is not blocked because a team can
 *   legitimately mount the same remote brain under two local clones.
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';
import { GBrainError } from './types.ts';
import { loadConfig, type GBrainConfig } from './config.ts';

/** Host brain id. Reserved — users cannot create a mount with this id. */
export const HOST_BRAIN_ID = 'host';

/** Brain id regex. Alphanumeric + dashes, 1-32 chars. No edge dashes. */
const BRAIN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Path to mounts.json. Lazy to avoid homedir() at module scope. */
function getMountsPath(): string {
  return join(homedir(), '.gbrain', 'mounts.json');
}

/**
 * A single entry in ~/.gbrain/mounts.json.
 *
 * PR 0: only direct-transport mounts are supported. PR 2 will add
 * `transport: "mcp"` with `mcp_url` + OAuth credential references.
 */
export interface MountEntry {
  /** Unique mount id. Becomes the namespace in `yc-media::skill` form. */
  id: string;
  /** Optional shorthand for CLI display. Must pass BRAIN_ID_RE if present. */
  alias?: string;
  /** Absolute local path to the mount's git clone (for skills + handlers). */
  path: string;
  /** Engine kind. Required for direct transport. */
  engine: 'postgres' | 'pglite';
  /** Postgres connection URL (if engine=postgres). */
  database_url?: string;
  /** PGLite data-directory path (if engine=pglite). */
  database_path?: string;
  /** Default true. Disabled mounts are not loaded. */
  enabled?: boolean;
  /** Managed by `gbrain mounts sync` (PR 1). */
  expected_sha?: string;
  /** Managed by `gbrain mounts sync` (PR 1). */
  last_synced_at?: string;
}

/** Top-level shape of ~/.gbrain/mounts.json. */
export interface MountsFile {
  version: 1;
  mounts: MountEntry[];
}

/** Handle returned by the registry for a given brain id. */
export interface BrainHandle {
  /** 'host' for the default brain, else the mount id. */
  id: string;
  /** Connected BrainEngine. Only valid for the lifetime of this registry. */
  engine: BrainEngine;
  /** GBrainConfig used to create the engine. */
  config: GBrainConfig;
  /** Absolute local path to the mount's clone. `null` for the host brain. */
  path: string | null;
}

/** Error thrown when two mounts resolve to the same local path. */
export class DuplicateMountPathError extends GBrainError {
  constructor(path: string, existingId: string, attemptedId: string) {
    super(
      `Duplicate mount path: "${path}"`,
      `Mount "${existingId}" already uses this path. Cannot register "${attemptedId}" at the same location.`,
      'Use a different local clone path, or remove the existing mount first: ' +
        `gbrain mounts remove ${existingId}`,
    );
  }
}

/** Error thrown when a caller requests an unknown or disabled brain id. */
export class UnknownBrainError extends GBrainError {
  constructor(id: string, available: string[]) {
    const list = available.length > 0 ? available.join(', ') : '(none registered)';
    super(
      `Unknown brain: "${id}"`,
      `No enabled mount with id "${id}" found. Available brain ids: ${list}`,
      `Run 'gbrain mounts list' to see registered mounts. Add a new mount with 'gbrain mounts add ${id} --path <path> --db-url <url>'.`,
    );
  }
}

/** Validate a mount id (and optionally the alias). Throws with actionable msg. */
export function validateMountId(id: unknown, fieldLabel = 'mount id'): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new GBrainError(
      `Invalid ${fieldLabel}`,
      `${fieldLabel} must be a non-empty string`,
      'Use a kebab-case id like "yc-media" or "garrys-list"',
    );
  }
  if (id === HOST_BRAIN_ID) {
    throw new GBrainError(
      `Reserved ${fieldLabel}: "${HOST_BRAIN_ID}"`,
      `"${HOST_BRAIN_ID}" is the host brain id and cannot be used for a mount`,
      'Choose a different id',
    );
  }
  if (!BRAIN_ID_RE.test(id)) {
    throw new GBrainError(
      `Invalid ${fieldLabel}: "${id}"`,
      `${fieldLabel} must match [a-z0-9-]{1,32}, start+end alphanumeric, interior dashes allowed`,
      'Use a kebab-case id like "yc-media"',
    );
  }
  return id;
}

/**
 * Parse + validate mounts.json. Returns an empty list if the file is absent.
 * Throws a structured error on any malformed entry (never a silent skip).
 */
export function loadMounts(mountsPath: string = getMountsPath()): MountEntry[] {
  if (!existsSync(mountsPath)) return [];

  let raw: string;
  try {
    raw = readFileSync(mountsPath, 'utf-8');
  } catch (e) {
    throw new GBrainError(
      `Cannot read ${mountsPath}`,
      e instanceof Error ? e.message : String(e),
      `Check file permissions (expected 0600) and re-run`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new GBrainError(
      `Malformed mounts.json`,
      e instanceof Error ? e.message : String(e),
      `Fix the JSON syntax at ${mountsPath} or remove it and re-add mounts via 'gbrain mounts add'`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GBrainError(
      `mounts.json must be a JSON object`,
      `Got: ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      `Expected { version: 1, mounts: [...] }`,
    );
  }

  const file = parsed as Partial<MountsFile>;
  if (file.version !== 1) {
    throw new GBrainError(
      `Unsupported mounts.json version: ${file.version}`,
      `This gbrain binary supports version 1`,
      `Upgrade gbrain or regenerate mounts.json`,
    );
  }

  if (!Array.isArray(file.mounts)) {
    throw new GBrainError(
      `mounts.json: "mounts" must be an array`,
      `Got: ${typeof file.mounts}`,
      `Expected { version: 1, mounts: [...] }`,
    );
  }

  const seenIds = new Set<string>();
  const seenPaths = new Map<string, string>(); // resolved path → id
  const out: MountEntry[] = [];

  for (let i = 0; i < file.mounts.length; i++) {
    const entry = file.mounts[i] as Partial<MountEntry> | undefined;
    if (!entry || typeof entry !== 'object') {
      throw new GBrainError(
        `mounts.json: entry ${i} must be an object`,
        `Got: ${typeof entry}`,
        `Each entry shape: { id, path, engine, db_url|database_path, enabled? }`,
      );
    }
    const id = validateMountId(entry.id, `mounts[${i}].id`);
    if (seenIds.has(id)) {
      throw new GBrainError(
        `mounts.json: duplicate id "${id}"`,
        `Two mounts share the id "${id}" (only one entry permitted per id)`,
        `Remove one of the entries or rename it`,
      );
    }
    seenIds.add(id);

    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new GBrainError(
        `mounts[${i}] "${id}": path is required`,
        `path must be a non-empty absolute filesystem path`,
        `Add "path": "/absolute/path/to/${id}" to this mount entry`,
      );
    }
    const resolvedPath = resolve(entry.path);
    const existingAtPath = seenPaths.get(resolvedPath);
    if (existingAtPath) {
      throw new DuplicateMountPathError(resolvedPath, existingAtPath, id);
    }
    seenPaths.set(resolvedPath, id);

    if (entry.engine !== 'postgres' && entry.engine !== 'pglite') {
      throw new GBrainError(
        `mounts[${i}] "${id}": engine must be "postgres" or "pglite"`,
        `Got: ${JSON.stringify(entry.engine)}`,
        `Set "engine": "pglite" for a local embedded DB or "postgres" for Supabase/self-hosted`,
      );
    }

    if (entry.engine === 'postgres' && !entry.database_url) {
      throw new GBrainError(
        `mounts[${i}] "${id}": postgres mount requires database_url`,
        `database_url is missing`,
        `Add "database_url": "postgresql://..." or use engine: "pglite"`,
      );
    }
    if (entry.engine === 'pglite' && !entry.database_path && !entry.database_url) {
      throw new GBrainError(
        `mounts[${i}] "${id}": pglite mount requires database_path (or database_url)`,
        `Both database_path and database_url are missing`,
        `Add "database_path": "/path/to/${id}/.pglite"`,
      );
    }
    if (entry.alias !== undefined) {
      validateMountId(entry.alias, `mounts[${i}].alias`);
    }

    out.push({
      id,
      alias: entry.alias,
      path: resolvedPath,
      engine: entry.engine,
      database_url: entry.database_url,
      database_path: entry.database_path,
      enabled: entry.enabled ?? true,
      expected_sha: entry.expected_sha,
      last_synced_at: entry.last_synced_at,
    });
  }

  return out;
}

/** Convert a MountEntry to an EngineConfig suitable for createEngine. */
function mountToEngineConfig(mount: MountEntry): EngineConfig {
  return {
    engine: mount.engine,
    database_url: mount.database_url,
    database_path: mount.database_path,
  };
}

/** Convert a MountEntry to a GBrainConfig (for OperationContext). */
function mountToGBrainConfig(mount: MountEntry): GBrainConfig {
  return {
    engine: mount.engine,
    database_url: mount.database_url,
    database_path: mount.database_path,
  };
}

/**
 * Keyed registry of BrainHandles. Lazy-initialized; engines are constructed
 * on first `getBrain(id)` call and cached.
 */
export class BrainRegistry {
  private readonly mounts: Map<string, MountEntry>;
  private readonly handles = new Map<string, BrainHandle>();
  private readonly pending = new Map<string, Promise<BrainHandle>>();
  private hostHandle: BrainHandle | null = null;
  private pendingHost: Promise<BrainHandle> | null = null;

  constructor(mounts: MountEntry[]) {
    this.mounts = new Map();
    for (const m of mounts) {
      if (m.enabled !== false) this.mounts.set(m.id, m);
    }
  }

  /**
   * Resolve a brain id to a connected handle. Returns the host brain for
   * `id === 'host'` (or undefined). Throws UnknownBrainError for unknown ids.
   */
  async getBrain(id: string | undefined | null): Promise<BrainHandle> {
    const resolved = id && id.length > 0 ? id : HOST_BRAIN_ID;
    if (resolved === HOST_BRAIN_ID) return this.getDefaultBrain();

    const cached = this.handles.get(resolved);
    if (cached) return cached;

    // Dedup concurrent init: if two callers race on the same id, only one
    // createEngine() fires.
    const inflight = this.pending.get(resolved);
    if (inflight) return inflight;

    const mount = this.mounts.get(resolved);
    if (!mount) throw new UnknownBrainError(resolved, this.listBrainIds());

    const promise = this.initMountBrain(mount);
    this.pending.set(resolved, promise);
    try {
      const handle = await promise;
      this.handles.set(resolved, handle);
      return handle;
    } finally {
      this.pending.delete(resolved);
    }
  }

  /**
   * Return the host brain handle (from ~/.gbrain/config.json). Lazy-
   * initialized so callers that only touch mounts don't require host config.
   */
  async getDefaultBrain(): Promise<BrainHandle> {
    if (this.hostHandle) return this.hostHandle;
    if (this.pendingHost) return this.pendingHost;

    this.pendingHost = this.initHostBrain();
    try {
      this.hostHandle = await this.pendingHost;
      return this.hostHandle;
    } finally {
      this.pendingHost = null;
    }
  }

  /** Return every known brain id (host + enabled mounts). */
  listBrainIds(): string[] {
    return [HOST_BRAIN_ID, ...Array.from(this.mounts.keys()).sort()];
  }

  /** Return the underlying mount entries (host excluded). */
  listMounts(): MountEntry[] {
    return Array.from(this.mounts.values());
  }

  /** Disconnect every initialized engine. Safe to call repeatedly. */
  async disconnectAll(): Promise<void> {
    const handles = [this.hostHandle, ...Array.from(this.handles.values())].filter(
      (h): h is BrainHandle => h != null,
    );
    this.hostHandle = null;
    this.handles.clear();
    await Promise.allSettled(handles.map(h => h.engine.disconnect()));
  }

  private async initHostBrain(): Promise<BrainHandle> {
    const config = loadConfig();
    if (!config) {
      throw new GBrainError(
        'No host brain configured',
        '~/.gbrain/config.json is missing and GBRAIN_DATABASE_URL is unset',
        "Run 'gbrain init' to configure the host brain",
      );
    }
    const { createEngine } = await import('./engine-factory.ts');
    const engineConfig: EngineConfig = {
      engine: config.engine,
      database_url: config.database_url,
      database_path: config.database_path,
    };
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    return { id: HOST_BRAIN_ID, engine, config, path: null };
  }

  private async initMountBrain(mount: MountEntry): Promise<BrainHandle> {
    const { createEngine } = await import('./engine-factory.ts');
    const engineConfig = mountToEngineConfig(mount);
    const engine = await createEngine(engineConfig);
    // Mounts MUST use per-instance connection pools, never the module
    // singleton in db.ts. Passing poolSize forces postgres-engine onto the
    // instance path (postgres-engine.ts:33-60). Without this, two mounts
    // with different Postgres URLs silently share whichever singleton was
    // connected first (Codex finding #1). PGLite ignores poolSize — it has
    // no pool. Hard-coded 5: conservative cap for mounts given N brains
    // can be mounted at once. Override per-mount is PR 1.
    await engine.connect({ ...engineConfig, poolSize: 5 } as EngineConfig & { poolSize: number });
    return {
      id: mount.id,
      engine,
      config: mountToGBrainConfig(mount),
      path: mount.path,
    };
  }
}

/** Convenience: build a registry from the default mounts.json location. */
export function loadRegistry(mountsPath: string = getMountsPath()): BrainRegistry {
  return new BrainRegistry(loadMounts(mountsPath));
}

/** Exposed for tests. */
export const __testing = {
  BRAIN_ID_RE,
  getMountsPath,
  mountToEngineConfig,
  mountToGBrainConfig,
};
