/**
 * function_search_path doctor check (#7632): every gbrain function that pins a search_path ends it with pg_temp.
 *
 * Without it, a session's temp table or view named like a ledger (fact_purges, page_purges, take_purges,
 * fact_withdrawals) hides that ledger from the guard that reads it, and a purged or withdrawn write goes through.
 * Migration v277 appends pg_temp to every function the migrating role owns and names the rest on stderr; this check
 * names each function still without it and the ALTER FUNCTION to run as its owner. ALTER FUNCTION ... SET changes
 * neither the owner nor the body, so the next boot's CREATE OR REPLACE still succeeds. Read-only.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError } from '../check-fix.ts';
import { PINNED_FUNCTION_NAMES, LEGACY_SEARCH_PATH_SETTINGS } from '../../../core/function-search-path.ts';

/** The gbrain functions whose pinned search_path lacks a trailing pg_temp, and the ALTER that fixes each. */
export async function functionSearchPathProblems(engine: BrainEngine): Promise<{ functions: string[]; fix: string[] }> {
  const rows = await engine.executeRaw<{ sig: string; path: string }>(
    `SELECT p.oid::regprocedure::text AS sig, substr(c.setting, 13) AS path
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL unnest(p.proconfig) AS c(setting)
      WHERE n.nspname = 'public' AND p.prokind = 'f' AND c.setting = ANY($1::text[]) AND p.proname = ANY($2::text[]) ORDER BY 1`,
    [[...LEGACY_SEARCH_PATH_SETTINGS], [...PINNED_FUNCTION_NAMES]]);
  return {
    functions: rows.map(r => r.sig),
    fix: rows.map(r => `ALTER FUNCTION ${r.sig} SET search_path = ${r.path}, pg_temp;`),
  };
}

async function runFunctionSearchPath(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('function_search_path');
  try {
    const { functions, fix } = await functionSearchPathProblems(engine);
    if (functions.length === 0) {
      checks.push({ name: 'function_search_path', status: 'ok', message: 'Every gbrain function that pins a search_path ends it with pg_temp' });
    } else {
      checks.push({
        name: 'function_search_path',
        status: 'fail',
        message: `${functions.length} function(s) pin search_path without pg_temp last (${functions.join(', ')}), so a temp table or view named like a purge or withdrawal ledger hides it from the guard that reads it. `
          + `Fix (as the role that owns each function; migration v277 did the ones the migrating role owned): ${fix.join(' ')}`,
      });
    }
  } catch (e) {
    checks.push(checkError('function_search_path', 'check function search paths', e));
  }
  return checks;
}

export const functionSearchPathEntry: DoctorEntry = { name: 'function_search_path', emits: ['function_search_path'], run: runFunctionSearchPath };
