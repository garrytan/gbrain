/**
 * GBRA-133 `session_lane_budget`: how close this role is to the database's session-connection limit, counted across every
 * process (src/core/session-lane.ts). A pooler's per-role session limit (Supavisor `pool_size`) is shared by every gbrain
 * process on every host, so a serve, a cron sync, a jobs worker and an MCP stdio server together can exhaust it
 * (`EMAXCONNSESSION`) although each stays inside its own pool. Read-only: it counts backends by name, attributes gbrain's
 * to a process kind and host, and warns at 80% of the limit with the process kinds holding the most. On PGLite it is
 * not applicable; without a known limit (a pooler, and `GBRAIN_SESSION_LANE_LIMIT` unset) it reports the counts only.
 */
import type { Check } from '../../doctor.ts';
import { checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { loadConfig } from '../../../core/config.ts';
import { readSessionLane, SESSION_LANE_LIMIT_ENV, SESSION_LANE_WARN_RATIO } from '../../../core/session-lane.ts';

const DOCS = 'docs/ENGINES.md#pool-sizing';

async function runSessionLaneBudget(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const engine = connectedEngine(ctx);
  if (engine.kind !== 'postgres') {
    checks.push({ name: 'session_lane_budget', status: 'ok', severity: 'info', readiness_state: 'not_applicable', details: { docs: DOCS },
      message: 'Not applicable: PGLite has no connection pool to share.' });
    return checks;
  }
  try {
    const census = await readSessionLane(engine, [loadConfig()?.database_url ?? '', process.env.GBRAIN_DIRECT_DATABASE_URL ?? '']);
    const kinds = Object.entries(census.by_kind).sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${kind} ${n}`).join(', ') || 'none';
    const counts = `${census.gbrain} named by gbrain processes (${kinds})${census.pooler ? `, ${census.pooler} held by the pooler` : ''}${census.other ? `, ${census.other} by other clients` : ''}`;
    const details = { ...census, warn_ratio: SESSION_LANE_WARN_RATIO, docs: DOCS };
    if (census.limit === null) {
      checks.push({ name: 'session_lane_budget', status: 'ok', severity: 'info', details,
        message: `This role holds ${census.total} database connection(s): ${counts}. The pooler's session limit is not readable from Postgres; `
          + `set ${SESSION_LANE_LIMIT_ENV} to it (Supabase: the project's pool_size) to compare.` });
      return checks;
    }
    const share = census.used / census.limit;
    const where = census.limit_source === 'env' ? `${SESSION_LANE_LIMIT_ENV}=${census.limit}` : `max_connections less reserved slots, ${census.limit}`;
    if (share >= SESSION_LANE_WARN_RATIO) {
      checks.push({ name: 'session_lane_budget', status: 'warn', details,
        message: `${census.used} of ${census.limit} session connection(s) are in use (${Math.round(share * 100)}%, limit ${where}): ${counts}. `
          + 'One more process of the usual size exhausts the limit (EMAXCONNSESSION). Run fewer long-running processes on this database (share one gbrain serve --http), '
          + 'keep short-lived ones off the session lane (unset GBRAIN_DIRECT_DATABASE_URL and set GBRAIN_DISABLE_DIRECT_POOL=1 for a cron sync or an MCP stdio server), '
          + `lower GBRAIN_DIRECT_POOL_SIZE, or raise the limit (${DOCS}).` });
      return checks;
    }
    checks.push({ name: 'session_lane_budget', status: 'ok', details,
      message: `${census.used} of ${census.limit} session connection(s) are in use (${Math.round(share * 100)}%, limit ${where}): ${counts}.` });
  } catch (error) {
    checks.push(checkError('session_lane_budget', 'count the session connections in use', error, { details: { docs: DOCS } }));
  }
  return checks;
}

export const sessionLaneBudgetEntry: DoctorEntry = { name: 'session_lane_budget', emits: ['session_lane_budget'], run: runSessionLaneBudget };
