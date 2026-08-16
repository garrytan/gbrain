/**
 * mcp-usage.ts — the ONE shared reader over `mcp_request_log` (amendment 30).
 *
 * Consumed by three surfaces that must never disagree on what counts as an
 * "operation call":
 *   - `gbrain auth clients --usage` (E4, src/commands/auth.ts)
 *   - the advisor starter-fit collector (E3, src/core/advisor/collect-mcp-client-fit.ts)
 *   - `scripts/derive-starter-ops.ts` (amendment 23 / D12)
 *
 * Row hygiene (amendments 23 + 30) — encoded HERE, nowhere else:
 *   - JSON-RPC method rows are NOT op calls: 'tools/list', 'initialize',
 *     'notifications/initialized', 'ping' are dropped.
 *   - The legacy bearer transport (src/mcp/http-transport.ts) logs calls as
 *     'tools/call:<name>' — the prefix is stripped and the row counts as <name>.
 *   - 'surface_change' audit rows (ENG-8, src/core/surface-audit.ts) are
 *     bookkeeping, not usage — dropped.
 *   - Only successful calls count ('success' / 'success_with_warnings').
 *     Denied and errored rows are not usage: a client repeatedly bouncing off
 *     a gated op must not "use" its way into starter-set derivation or an
 *     advisor fit finding (that would let denial traffic curate the catalog).
 *
 * Windowed on `created_at` so the query rides `idx_mcp_log_time_agent`
 * (created_at, token_name). Plain SQL through `engine.executeRaw` — works on
 * BOTH engines; never writes, so no jsonb pathway is involved.
 *
 * Scope caveat (amendment 30): usage-derived features see HTTP clients ONLY.
 * The stdio transport (local pipe, including every bootstrap/hook-lane serve)
 * does not write `mcp_request_log`, so stdio usage is structurally invisible
 * here — treat absence of a client as "not an HTTP client", never "unused".
 *
 * D12 automation classification: bootstrap/hook-lane identities register no
 * distinguishing client name (the hook lane is stdio and never logs; thin
 * clients carry operator-chosen names), so automation is detected
 * BEHAVIORALLY — a client whose calls are >90% ambient-recall boundary ops
 * (`context_pack` / `delta`) is flagged `likely_automation` and excluded from
 * starter-set derivation + advisor fit findings. The threshold and op set are
 * exported so consumers cite one definition.
 */

import type { BrainEngine } from './engine.ts';

/** Default trailing window for every usage-derived surface. */
export const MCP_USAGE_DEFAULT_WINDOW_DAYS = 30;

/** JSON-RPC method / server-plane rows that are not operation calls. */
export const NON_OP_LOG_ROWS: ReadonlySet<string> = new Set([
  'tools/list',
  'initialize',
  'notifications/initialized',
  'ping',
  // ENG-8 surface-change audit rows (src/core/surface-audit.ts).
  'surface_change',
]);

/** Legacy bearer transport row prefix — 'tools/call:query' means op 'query'. */
export const LEGACY_CALL_PREFIX = 'tools/call:';

/**
 * D12: ambient-recall boundary verbs — the ops a hook-lane / turn-context
 * automation client calls almost exclusively.
 */
export const AUTOMATION_BOUNDARY_OPS: ReadonlySet<string> = new Set(['context_pack', 'delta']);

/** Fraction of a client's calls that must be boundary ops to classify as automation. */
export const AUTOMATION_FRACTION_THRESHOLD = 0.9;

/**
 * Normalize one logged `operation` value to an op name, or null when the row
 * is not an operation call. The single source for the hygiene rules above.
 */
export function normalizeLoggedOperation(operation: string): string | null {
  if (operation.startsWith(LEGACY_CALL_PREFIX)) {
    const name = operation.slice(LEGACY_CALL_PREFIX.length);
    if (name.length === 0) return null;
    // The stripped name re-runs the hygiene check: 'tools/call:tools/list'
    // or a prefixed 'surface_change' audit row is still not an op call.
    return NON_OP_LOG_ROWS.has(name) ? null : name;
  }
  if (NON_OP_LOG_ROWS.has(operation)) return null;
  return operation;
}

export interface ClientOpUsage {
  /** `mcp_request_log.token_name`: OAuth client_id, or a legacy bearer token name. */
  token_name: string;
  /** Op name → call count inside the window (post-hygiene). */
  ops: Record<string, number>;
  total_calls: number;
  /** Sorted distinct op names inside the window. */
  distinct_ops: string[];
  /** ISO timestamp of the client's most recent op call in the window. */
  last_seen: string;
  /** Fraction of calls that are AUTOMATION_BOUNDARY_OPS (0 when no calls). */
  automation_fraction: number;
  /** D12 behavioral classification: automation_fraction > threshold. */
  likely_automation: boolean;
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/**
 * Per-client op usage over the trailing window (default 30d). Returns one
 * entry per token_name, sorted by total_calls descending. Never throws for
 * an empty log; a missing table (very old brain) DOES throw — callers that
 * must be resilient wrap in try/catch (the advisor collector does).
 */
export async function readClientOpUsage(
  engine: BrainEngine,
  opts: { days?: number } = {},
): Promise<ClientOpUsage[]> {
  const days = opts.days ?? MCP_USAGE_DEFAULT_WINDOW_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error(`readClientOpUsage: days must be an integer in [1, 3650]; got ${String(opts.days)}`);
  }
  // Windowed on created_at (rides idx_mcp_log_time_agent). The day count is
  // bound as a parameter and multiplied into a unit interval — portable
  // across Postgres and PGLite, no string-splicing into the SQL.
  const rows = await engine.executeRaw<{
    token_name: string | null;
    operation: string;
    n: number | string;
    last_seen: unknown;
  }>(
    `SELECT token_name, operation, count(*)::int AS n, max(created_at) AS last_seen
       FROM mcp_request_log
      WHERE created_at > now() - ($1::int * interval '1 day')
        AND token_name IS NOT NULL
        AND status IN ('success', 'success_with_warnings')
      GROUP BY token_name, operation`,
    [days],
  );

  const byClient = new Map<string, { ops: Map<string, number>; total: number; lastSeen: string }>();
  for (const row of rows) {
    if (!row.token_name) continue;
    const op = normalizeLoggedOperation(row.operation);
    if (op === null) continue;
    const n = typeof row.n === 'number' ? row.n : parseInt(String(row.n), 10) || 0;
    const lastSeen = toIso(row.last_seen);
    let entry = byClient.get(row.token_name);
    if (!entry) {
      entry = { ops: new Map(), total: 0, lastSeen };
      byClient.set(row.token_name, entry);
    }
    entry.ops.set(op, (entry.ops.get(op) ?? 0) + n);
    entry.total += n;
    if (lastSeen > entry.lastSeen) entry.lastSeen = lastSeen;
  }

  const out: ClientOpUsage[] = [];
  for (const [token, entry] of byClient) {
    let automationCalls = 0;
    for (const [op, n] of entry.ops) {
      if (AUTOMATION_BOUNDARY_OPS.has(op)) automationCalls += n;
    }
    const fraction = entry.total > 0 ? automationCalls / entry.total : 0;
    out.push({
      token_name: token,
      ops: Object.fromEntries([...entry.ops.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))),
      total_calls: entry.total,
      distinct_ops: [...entry.ops.keys()].sort(),
      last_seen: entry.lastSeen,
      automation_fraction: fraction,
      likely_automation: fraction > AUTOMATION_FRACTION_THRESHOLD,
    });
  }
  out.sort((a, b) => b.total_calls - a.total_calls || (a.token_name < b.token_name ? -1 : 1));
  return out;
}
