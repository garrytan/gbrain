/**
 * Shared source-table loader (v0.40 Federated Sync v2 — D7).
 *
 * Before v0.40, the only caller that enumerated `sources` was `runList` in
 * src/commands/sources.ts. v0.40 adds four more enumerators: `gbrain sync --all`
 * fan-out, autopilot per-source dispatch, `gbrain sources status`, and the
 * `federation_health` doctor check. Going from 1→5 inline SELECTs invites
 * silent drift the next time someone adds a column to `sources`.
 *
 * This module is the single source of truth for that read path. Adding a
 * column means updating exactly one projection.
 *
 * Engine-agnostic: works on both Postgres and PGLite (same SQL surface).
 *
 * Why no engine method: BrainEngine parity would force PGLite + Postgres
 * implementations even though both run identical SQL through `executeRaw`.
 * A shared helper hits the bar at lower cost.
 */
import type { BrainEngine } from './engine.ts';

export interface SourceRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | null;
  /** Postgres returns object; PGLite returns JSON string. Parse via `parseSourceConfig`. */
  config: Record<string, unknown> | string;
  created_at: Date;
  archived?: boolean;
  /**
   * v0.41.32.0: newest COMMIT timestamp observed at last sync (HEAD committer
   * time). The REMOTE staleness path reads this column so it never shells out
   * to git on a DB-supplied local_path. Optional because the forward-reference
   * fallback SELECT below omits it on pre-v109 brains; null/undefined → the
   * reader falls back to wall-clock.
   */
  newest_content_at?: Date | null;
}

export interface LoadAllSourcesOpts {
  /** Include soft-archived rows (default false). */
  includeArchived?: boolean;
  /** Only return sources with config.federated === true (default false). */
  federatedOnly?: boolean;
}

/**
 * #2829: max JSON.parse passes when unwrapping a possibly multiply-stringified
 * `sources.config`. A re-wrapping bug could store config as a JSON *string
 * scalar* ("{}", "\"{}\"", ...) that grows one layer per read→write cycle; the
 * bound keeps a pathological value from spinning forever.
 */
const MAX_CONFIG_UNWRAP_DEPTH = 10;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Unwrap a value that may be JSON-stringified 0..N times. Bounded; never throws. */
function unwrapConfigLayers(config: unknown): { value: unknown; layers: number } {
  let value = config;
  let layers = 0;
  while (typeof value === 'string' && layers < MAX_CONFIG_UNWRAP_DEPTH) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
    layers++;
  }
  return { value, layers };
}

/**
 * #2829: coerce a config value to the underlying plain object before it is
 * written back, fully unwrapping any accidental JSON-string nesting so a
 * re-wrapping bug can't keep growing a layer on every write. Returns {} (with a
 * warning) when the value never resolves to a plain object. Every `sources`
 * config writer runs its config through this before `JSON.stringify` + the
 * `$1::text::jsonb` cast, which converges the stored value back to a jsonb
 * object.
 */
export function normalizeSourceConfig(config: unknown): Record<string, unknown> {
  const { value } = unwrapConfigLayers(config);
  if (isPlainObject(value)) return value;
  console.warn(
    `[gbrain] source config was not a JSON object (got ${value === null ? 'null' : typeof value}); ` +
    `storing {} instead. Run 'gbrain doctor' to find affected sources.`,
  );
  return {};
}

/**
 * Parse `sources.config` to a plain object regardless of driver shape (Postgres
 * returns an object; PGLite returns a JSON string). #2829: also unwraps a config
 * that was accidentally stored as a nested JSON string scalar, and warns once
 * when more than one unwrap layer is needed (one layer is the normal PGLite
 * path; two or more means the value was re-wrapped and should be repaired).
 */
export function parseSourceConfig(config: unknown): Record<string, unknown> {
  const { value, layers } = unwrapConfigLayers(config);
  if (layers > 1) {
    console.warn(
      `[gbrain] source config was stored as a ${layers}-layer nested JSON string; ` +
      `it will be repaired on the next config write. Run 'gbrain doctor' to find affected sources.`,
    );
  }
  return isPlainObject(value) ? value : {};
}

/** True iff the source's config.federated field is the literal boolean true. */
export function isSourceFederated(config: unknown): boolean {
  const parsed = parseSourceConfig(config);
  return parsed.federated === true;
}

/**
 * Enumerate every source. Order: 'default' first, then alphabetical by id.
 *
 * Caller filters in-process when the predicate is cheap (federatedOnly,
 * includeArchived). For source-id targeted reads use `fetchSource` instead
 * (single-row SELECT).
 */
export async function loadAllSources(
  engine: BrainEngine,
  opts: LoadAllSourcesOpts = {},
): Promise<SourceRow[]> {
  // Defensive on legacy brains pre-v0.26.5 that lack the archived column.
  let rows: SourceRow[];
  try {
    rows = await engine.executeRaw<SourceRow>(
      `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, archived, newest_content_at
         FROM sources
       ORDER BY (id = 'default') DESC, id`,
    );
  } catch (err) {
    // Forward-reference safety: pre-v0.26.5 brains lack `archived`; pre-v109
    // brains lack `newest_content_at`. Re-issue with the historical minimal
    // set; archived defaults false, newest_content_at undefined → wall-clock.
    if (isUndefinedColumnError(err)) {
      rows = await engine.executeRaw<SourceRow>(
        `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at
           FROM sources
         ORDER BY (id = 'default') DESC, id`,
      );
    } else {
      throw err;
    }
  }

  let filtered = rows;
  if (!opts.includeArchived) {
    filtered = filtered.filter((r) => r.archived !== true);
  }
  if (opts.federatedOnly) {
    filtered = filtered.filter((r) => isSourceFederated(r.config));
  }
  return filtered;
}

/** Single-row fetch — kept here so callers don't grow yet-another SELECT. */
export async function fetchSource(
  engine: BrainEngine,
  id: string,
): Promise<SourceRow | null> {
  try {
    const rows = await engine.executeRaw<SourceRow>(
      `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, archived, newest_content_at
         FROM sources WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  } catch (err) {
    if (isUndefinedColumnError(err)) {
      const rows = await engine.executeRaw<SourceRow>(
        `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at
           FROM sources WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    }
    throw err;
  }
}

/** Driver-tolerant 42703 detector. Mirrors src/core/utils.ts pattern. */
function isUndefinedColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === '42703') return true;
  return typeof e.message === 'string' && /column .* does not exist/i.test(e.message);
}
