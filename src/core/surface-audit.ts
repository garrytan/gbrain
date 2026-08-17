/**
 * WP4 (amendment 32 / ENG-8) — surface-change audit trail.
 *
 * EVERY surface mutation (rescope CLI, POST /admin/api/rescope-client,
 * request_tools persist) writes one typed `mcp_request_log` row —
 * `operation='surface_change'`, `token_name`/`agent_name` = the acting
 * identity, `params` = a RAW OBJECT carrying `{actor, client_id, old, new,
 * via}` via executeRawJsonb (NEVER `JSON.stringify` into a `::jsonb` cast —
 * the #2339 double-encode class). Zero new DDL: it rides the existing
 * request log + `idx_mcp_log_time_agent` and the retention TODO, and is
 * remote-queryable via the E4 usage machinery. "Why did client X see 20
 * tools yesterday and 100 today" must be answerable from logs alone.
 *
 * Doc exception (ENG-8): CLI-actor audit rows are written even though stdio
 * ops don't otherwise log to mcp_request_log — the audit trail outranks the
 * transport-logging convention.
 *
 * Best-effort by design: the mutation has already committed when this runs;
 * a failed audit write warns to stderr rather than turning a successful
 * mutation into a caller-visible error. Callers that need fail-closed audit
 * semantics should await + inspect the returned boolean.
 */

import type { BrainEngine } from './engine.ts';
import { executeRawJsonb } from './sql-query.ts';

export interface SurfaceChangeAudit {
  /** Acting identity: OAuth client id (self-persist), 'operator' (CLI), 'admin-api'. */
  actor: string;
  /** The client whose surface changed. */
  client_id: string;
  /** Previous row value (null = column was NULL / no per-client surface). */
  old: string | null;
  /** New row value (null = cleared). */
  new: string | null;
  via: 'rescope_cli' | 'admin_api' | 'request_tools' | 'register_cli';
}

/** Returns true when the audit row landed; false (after a stderr warn) otherwise. */
export async function writeSurfaceChangeAudit(
  engine: BrainEngine,
  audit: SurfaceChangeAudit,
): Promise<boolean> {
  try {
    await executeRawJsonb(
      engine,
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [audit.actor, audit.actor, 'surface_change', 0, 'success'],
      [{ actor: audit.actor, client_id: audit.client_id, old: audit.old, new: audit.new, via: audit.via }],
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[surface-audit] failed to write surface_change audit row for ${audit.client_id} (via ${audit.via}): ${msg}\n`);
    return false;
  }
}
