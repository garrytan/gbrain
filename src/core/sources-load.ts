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
}

export interface LoadAllSourcesOpts {
  /** Include soft-archived rows (default false). */
  includeArchived?: boolean;
  /** Only return sources with config.federated === true (default false). */
  federatedOnly?: boolean;
}

/** Parse `sources.config` to a plain object regardless of driver shape. */
export function parseSourceConfig(config: unknown): Record<string, unknown> {
  if (typeof config === 'string') {
    try { return JSON.parse(config) as Record<string, unknown>; } catch { return {}; }
  }
  if (typeof config === 'object' && config !== null) return config as Record<string, unknown>;
  return {};
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
      `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, archived
         FROM sources
       ORDER BY (id = 'default') DESC, id`,
    );
  } catch (err) {
    // Forward-reference safety: pre-v0.26.5 brains have no `archived` column.
    // Re-issue without it; archived defaults to false.
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
      `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, archived
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
