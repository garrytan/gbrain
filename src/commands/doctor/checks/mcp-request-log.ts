/**
 * mcp_request_log_retention (#6770 rewrite): request-log growth and the opt-in
 * retention prune (src/core/mcp-request-log-retention.ts).
 *
 * Retention off: information while the log is small; past about 1M rows or
 * 1 GiB, a warn whose fix turns 90-day retention on. That fix deletes request
 * detail that cannot be restored, so it is `ask_user` with consent
 * `destructive` and never a remediation step (`doctor --remediate` builds its
 * plan from the brain score and repair kinds, not from check fixes).
 * Retention on: the pruned-before date and the last run (time, rows, whether
 * it hit the 400,000-row per-run cap); a warn when no prune ran for 48 hours,
 * or when none ever ran and rows past the window are waiting (a PGLite brain
 * whose serve stopped, a cycle that never runs).
 *
 * Row count: pg_class.reltuples on Postgres, a bounded count on PGLite (no
 * autovacuum, so its estimate is not kept fresh). Size: pg_total_relation_size.
 * Read-only; behaves the same on a repo-less brain.
 */
import type { Action } from '../../../core/agent-output.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { AUDIT_LOG_OPERATIONS, readMcpUsageCoverage } from '../../../core/mcp-usage.ts';
import {
  MCP_LOG_PRUNE_BATCH, MCP_LOG_PRUNE_MAX_BATCHES, MCP_LOG_RETENTION_KEY, readLastMcpLogPrune, readMcpLogRetentionDays,
} from '../../../core/mcp-request-log-retention.ts';

export const MCP_LOG_WARN_ROWS = 1_000_000;
export const MCP_LOG_WARN_BYTES = 1024 ** 3;
const STALE_PRUNE_MS = 48 * 3_600_000;
const SUGGESTED_DAYS = 90;
const DOCS = 'docs/mcp/ADMIN.md#request-log-retention';

const mb = (bytes: number) => (bytes / 1024 ** 2).toFixed(1);

export async function mcpRequestLogRetentionResult(
  engine: BrainEngine,
  opts: { warnRows?: number; warnBytes?: number } = {},
): Promise<Omit<Check, 'name'>> {
  const warnRows = opts.warnRows ?? MCP_LOG_WARN_ROWS;
  const warnBytes = opts.warnBytes ?? MCP_LOG_WARN_BYTES;
  const [size] = await engine.executeRaw<{ bytes: string }>("SELECT pg_total_relation_size('mcp_request_log')::text AS bytes");
  const [count] = engine.kind === 'postgres'
    ? await engine.executeRaw<{ rows: string }>("SELECT GREATEST(reltuples, 0)::bigint::text AS rows FROM pg_class WHERE oid = to_regclass('mcp_request_log')")
    : await engine.executeRaw<{ rows: string }>('SELECT count(*)::text AS rows FROM (SELECT 1 FROM mcp_request_log LIMIT $1) t', [warnRows + 1]);
  const rows = Number(count?.rows ?? 0);
  const bytes = Number(size?.bytes ?? 0);
  const rowsText = `${engine.kind === 'postgres' ? '~' : ''}${rows}${engine.kind !== 'postgres' && rows > warnRows ? '+' : ''} row(s) (${mb(bytes)} MB)`;
  const days = await readMcpLogRetentionDays(engine);
  const details: Record<string, unknown> = { retention_days: days, rows, rows_exact: engine.kind !== 'postgres' && rows <= warnRows, bytes, docs: DOCS };

  if (days === null) {
    const enable: Action = {
      argv: ['gbrain', 'config', 'set', MCP_LOG_RETENTION_KEY, String(SUGGESTED_DAYS)], consent: ['destructive'], actor: 'agent', ask_user: true,
      requires_exclusive: false, docs: DOCS, verify: doctorVerify('mcp_request_log_retention'),
      why: `Turns on the request-log prune: the next cycle purge phase (or, on a PGLite brain, a live serve within the hour) deletes request rows older than ${SUGGESTED_DAYS} days. Per-client lifetime totals and the audit rows (surface, memory-setting and access changes) are kept.`,
      user_message: `Your MCP request log holds ${rowsText} and nothing prunes it. Turn on ${SUGGESTED_DAYS}-day retention? Request details older than ${SUGGESTED_DAYS} days (operation, status, parameters, errors) will be deleted and cannot be restored; per-client totals and audit rows are kept.`,
    };
    if (rows >= warnRows || bytes >= warnBytes) {
      return { status: 'warn', details, fix: enable,
        message: `The MCP request log holds ${rowsText} and grows with every HTTP MCP call; request-log retention is off, so nothing prunes it. Turning it on deletes old request detail for good, so ask the user first.` };
    }
    return { status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice', details, fix: enable,
      message: `The MCP request log holds ${rowsText}; request-log retention is off, so it keeps every request.` };
  }

  const last = await readLastMcpLogPrune(engine);
  const coverage = await readMcpUsageCoverage(engine, days);
  const [pending] = await engine.executeRaw<{ waiting: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM mcp_request_log WHERE created_at < now() - ($1::int * interval '1 day') AND operation <> ALL($2::text[])) AS waiting`,
    [days, [...AUDIT_LOG_OPERATIONS]]);
  Object.assign(details, { last_prune: last, pruned_before: coverage.pruned_before, rows_past_window: pending?.waiting === true });
  const stale = last ? Date.now() - Date.parse(last.at) > STALE_PRUNE_MS : pending?.waiting === true;
  if (stale) {
    return { status: 'warn', details,
      message: `Request-log retention is ${days} days, but no prune has run in the last 48 hours (last run: ${last?.at ?? 'never'}), so the log keeps growing. ` +
        'The prune runs in the cycle purge phase (autopilot or gbrain dream) and, on a PGLite brain, hourly inside a live gbrain serve.',
      fix: { argv: ['gbrain', 'dream', '--phase', 'purge'], consent: ['destructive'], actor: 'agent', ask_user: true, requires_exclusive: false, docs: DOCS,
        verify: doctorVerify('mcp_request_log_retention'),
        why: 'Runs the cycle purge phase now, which applies the retention the user already turned on.',
        user_message: `The MCP request log has not been pruned for over 48 hours. Run the maintenance purge now? It deletes request detail older than ${days} days and also removes pages deleted more than the restore window ago, as the nightly cycle does.` } };
  }
  const capNote = last?.capped ? ` It hit the per-run cap of ${(MCP_LOG_PRUNE_BATCH * MCP_LOG_PRUNE_MAX_BATCHES).toLocaleString('en-US')} rows, so older rows are still waiting; each later run continues.` : '';
  return { status: 'ok', details,
    message: `Request-log retention is ${days} days; the log holds ${rowsText}. ` +
      (last ? `The last prune (${last.at}) removed ${last.deleted} row(s).${capNote}` : 'No prune has run yet.') +
      (coverage.pruned_before ? ` Request detail before ${coverage.pruned_before} was pruned; per-client totals and audit rows are kept.` : '') };
}

async function runMcpRequestLogRetention(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  try {
    checks.push({ name: 'mcp_request_log_retention', ...await mcpRequestLogRetentionResult(engine) });
  } catch (error) {
    checks.push({ name: 'mcp_request_log_retention', status: 'warn', fix_unavailable_reason: 'check_errored', details: { health: 'unknown' },
      message: `Could not read the MCP request log size or retention state: ${error instanceof Error ? error.message : String(error)}` });
  }
  return checks;
}

export const mcpRequestLogRetentionEntry: DoctorEntry = { name: 'mcp_request_log_retention', emits: ['mcp_request_log_retention'], run: runMcpRequestLogRetention };
