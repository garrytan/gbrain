/**
 * function_search_path doctor check (#7632): every gbrain function (PINNED_FUNCTION_NAMES) ends its pinned search_path
 * with pg_temp.
 *
 * Without it, a session's temp table or view named like a ledger (fact_purges, page_purges, take_purges,
 * fact_withdrawals) hides that ledger from the guard that reads it, and a purged or withdrawn write goes through. Below
 * migration v277 the fix is the migration; at or past it, the fix is one schema-qualified ALTER FUNCTION per function
 * (argument types only, so no caller-chosen argument name reaches the printed SQL), run on the database host as the
 * role that owns it, so the check carries the SQL in details and no runnable fix. ALTER FUNCTION ... SET changes neither the owner nor the body, so the next boot's CREATE OR REPLACE still
 * succeeds. Read-only.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { PINNED_FUNCTION_NAMES, PINNED_PATH_SQL } from '../../../core/function-search-path.ts';
import { v277 } from '../../../core/schema-migrations/v277-function-search-path-pg-temp.ts';

const DOCS = 'docs/guides/troubleshooting.md#function-search-path';

/** The gbrain functions whose pinned search_path does not end in pg_temp, and the schema-qualified ALTER that fixes each. */
export async function functionSearchPathProblems(engine: BrainEngine): Promise<{ functions: string[]; fix: string[] }> {
  const rows = await engine.executeRaw<{ sig: string; qualified: string; path: string }>(
    `SELECT p.oid::regprocedure::text AS sig,
            quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || oidvectortypes(p.proargtypes) || ')' AS qualified,
            ${PINNED_PATH_SQL} AS path
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL unnest(p.proconfig) AS c(setting)
      WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = ANY($1::text[]) AND c.setting LIKE 'search_path=%' ORDER BY 1`,
    [[...PINNED_FUNCTION_NAMES]]);
  const bad = rows.filter(r => !/(^|,)\s*pg_temp$/i.test(r.path));
  return {
    functions: bad.map(r => r.sig),
    fix: bad.map(r => `ALTER FUNCTION ${r.qualified} SET search_path = ${r.path}, pg_temp;`),
  };
}

async function runFunctionSearchPath(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('function_search_path');
  try {
    const { functions, fix } = await functionSearchPathProblems(engine);
    const risk = `${functions.length} function(s) do not end their search_path with pg_temp (${functions.join(', ')}), so a temp table or view named like a purge or withdrawal ledger hides it from the guard that reads it.`;
    const version = functions.length === 0 ? v277.version : parseInt(await engine.getConfig('version') || '0', 10);
    if (functions.length === 0) {
      checks.push({ name: 'function_search_path', status: 'ok', message: 'Every gbrain function that pins a search_path ends it with pg_temp' });
    } else if (version < v277.version) {
      checks.push({
        name: 'function_search_path', status: 'fail',
        message: `${risk} This brain is at schema v${version}, below migration v${v277.version}, which appends pg_temp to every one its role owns: run gbrain apply-migrations --yes first, then check again.`,
        fix: agentFix(['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'],
          `Runs the pending schema migrations, v${v277.version} among them, on the brain host; this check then names only the functions another role owns.`, 'function_search_path', { requires_exclusive: true, docs: DOCS }),
        details: { functions, schema_version: version },
      });
    } else {
      checks.push({
        name: 'function_search_path', status: 'fail',
        message: `${risk} Fix: run this SQL on the database host, connected to this brain's database as the role that owns each function (migration v${v277.version} and every migration run already did the ones the migrating role owns): ${fix.join(' ')} See ${DOCS}.`,
        fix_unavailable_reason: 'no_safe_automatic_fix',
        details: { functions, sql: fix, docs: DOCS },
      });
    }
  } catch (e) {
    checks.push(checkError('function_search_path', 'check function search paths', e));
  }
  return checks;
}

export const functionSearchPathEntry: DoctorEntry = { name: 'function_search_path', emits: ['function_search_path'], run: runFunctionSearchPath };
