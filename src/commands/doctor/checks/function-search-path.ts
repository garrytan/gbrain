/**
 * function_search_path doctor check (#7632): every gbrain function (PINNED_FUNCTION_NAMES) ends its pinned search_path
 * with pg_temp.
 *
 * Without it, a session's temp table or view named like a ledger (fact_purges, page_purges, take_purges,
 * fact_withdrawals) hides that ledger from the guard that reads it, and a purged or withdrawn write goes through. A
 * function with no search_path at all (re-created by hand without its SET clause) is named too. Below migration v277
 * the fix is the migration; at or past it, the fix is one schema-qualified ALTER FUNCTION per function, run as the role
 * that owns it. ALTER FUNCTION ... SET changes neither the owner nor the body, so the next boot's CREATE OR REPLACE still
 * succeeds. Read-only.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError, doctorVerify } from '../check-fix.ts';
import { PINNED_FUNCTION_NAMES, PINNED_PATH_SQL } from '../../../core/function-search-path.ts';
import { v277 } from '../../../core/schema-migrations/v277-function-search-path-pg-temp.ts';

const NAME = 'function_search_path';
const DOCS = 'docs/guides/troubleshooting.md#function-search-path';

/** The gbrain functions whose search_path does not end in pg_temp, and the schema-qualified ALTER that fixes each. */
export async function functionSearchPathProblems(engine: BrainEngine): Promise<{ functions: string[]; fix: string[] }> {
  const rows = await engine.executeRaw<{ sig: string; qualified: string; path: string | null }>(
    `SELECT p.oid::regprocedure::text AS sig,
            quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS qualified,
            (SELECT ${PINNED_PATH_SQL} FROM unnest(p.proconfig) AS c(setting) WHERE c.setting LIKE 'search_path=%' LIMIT 1) AS path
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = ANY($1::text[]) ORDER BY 1`,
    [[...PINNED_FUNCTION_NAMES]]);
  const bad = rows.filter(r => r.path === null || !/(^|,)\s*pg_temp$/i.test(r.path));
  return {
    functions: bad.map(r => r.sig),
    fix: bad.map(r => `ALTER FUNCTION ${r.qualified} SET search_path = ${r.path ?? 'pg_catalog, public'}, pg_temp;`),
  };
}

async function runFunctionSearchPath(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  ctx.progress.heartbeat(NAME);
  try {
    const { functions, fix } = await functionSearchPathProblems(engine);
    if (functions.length === 0) {
      return [{ name: NAME, status: 'ok', message: 'Every gbrain function that pins a search_path ends it with pg_temp' }];
    }
    const risk = `${functions.length} function(s) do not end their search_path with pg_temp (${functions.join(', ')}), so a temp table or view named like a purge or withdrawal ledger hides it from the guard that reads it.`;
    const version = parseInt(await engine.getConfig('version') || '0', 10);
    if (version < v277.version) {
      return [{
        name: NAME, status: 'fail',
        message: `${risk} This brain is at schema v${version}, below migration v${v277.version}, which appends pg_temp to every one its role owns: run gbrain apply-migrations --yes first, then check again.`,
        fix: agentFix(['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'],
          `Runs the pending schema migrations, v${v277.version} among them, on the brain host; this check then names only the functions another role owns.`, NAME, { requires_exclusive: true, docs: DOCS }),
        details: { functions, schema_version: version },
      }];
    }
    return [{
      name: NAME, status: 'fail',
      message: `${risk} Fix, as the role that owns each function (migration v${v277.version} and every migration run already did the ones the migrating role owns): ${fix.join(' ')}`,
      fix: { argv: ['psql', '-c', fix.join(' ')], consent: [], actor: 'host_admin', requires_exclusive: false, docs: DOCS, verify: doctorVerify(NAME),
        why: 'ALTER FUNCTION needs the role that owns each function, so it runs on the database host as that role; it changes neither the owner nor the body.' },
      details: { functions, sql: fix },
    }];
  } catch (e) {
    return [checkError(NAME, 'check function search paths', e)];
  }
}

export const functionSearchPathEntry: DoctorEntry = { name: NAME, emits: [NAME], run: runFunctionSearchPath };
