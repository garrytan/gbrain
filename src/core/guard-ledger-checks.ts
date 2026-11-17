/**
 * #7632/#7659: the purge and withdrawal guards refuse a writing role that row-level security keeps from their ledgers
 * (derived-state-maintainers.ts requireLedgerPoliciesSql). Migration v318 installs those bodies and every migration run
 * re-checks them, so a guard the migrating role could not re-create (another role owns it: CREATE OR REPLACE needs the
 * owner, #7659 question 8) never aborts the upgrade, is named, and is re-created by the first migration run of a role
 * that owns it (hardenFunctionSearchPaths, which every run calls). An older gbrain that replays its schema blob over the
 * derivation guards is put right the same way. Each guard stays
 * SECURITY INVOKER; nothing but the seven function bodies changes.
 */

import type { BrainEngine } from './engine.ts';
import { FACT_INSERT_GUARD_FUNCTION_SQL } from './facts/insert-guard-schema.ts';
import { REFUSE_PURGED_FACT_FUNCTION_SQL, REFUSE_PURGED_PAGE_FUNCTION_SQL, REFUSE_PURGED_TAKE_FUNCTION_SQL } from './facts/purge-schema.ts';
import { FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL } from './facts/withdrawal-schema.ts';
import { DERIVATION_SCOPE_ENTRY_FUNCTION_SQL, REFUSE_PURGING_DERIVATION_FUNCTION_SQL } from './page-body/schema.ts';

/**
 * Each guard, the ledger whose check marks its current body, that body, and for a guard a later migration changed again
 * a text only its current body holds (GBRA-574 v321: the facts guards' name-key branch), so the migration run of a role
 * that owns it re-creates it too.
 */
const LEDGER_GUARDS: ReadonlyArray<{ name: string; ledger: string; sql: string; marker?: string }> = [
  { name: 'gbrain_refuse_purged_fact', ledger: 'fact_purges', sql: REFUSE_PURGED_FACT_FUNCTION_SQL, marker: 'unbacked_page' },
  { name: 'gbrain_refuse_purged_take', ledger: 'take_purges', sql: REFUSE_PURGED_TAKE_FUNCTION_SQL },
  { name: 'gbrain_refuse_purged_page', ledger: 'page_purges', sql: REFUSE_PURGED_PAGE_FUNCTION_SQL },
  { name: 'gbrain_preserve_fact_withdrawal', ledger: 'fact_withdrawals', sql: FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL, marker: 'memory/scope' },
  { name: 'gbrain_guard_inserted_facts', ledger: 'fact_withdrawals', sql: FACT_INSERT_GUARD_FUNCTION_SQL, marker: 'memory/scope' },
  { name: 'gbrain_mark_derivation_scope_entry', ledger: 'page_segment_derivation_purges', sql: DERIVATION_SCOPE_ENTRY_FUNCTION_SQL },
  { name: 'gbrain_refuse_purging_derivation', ledger: 'page_segment_derivation_purges', sql: REFUSE_PURGING_DERIVATION_FUNCTION_SQL },
];

/** A guard body without its ledger check, or without its marker. */
const STALE_GUARD_SQL = `(strpos(p.prosrc, 'row_security_active(''' || g.ledger || ''')') = 0 OR (g.marker <> '' AND strpos(p.prosrc, g.marker) = 0))`;

function guardParams(): [string[], string[], string[]] {
  return [LEDGER_GUARDS.map(g => g.name), LEDGER_GUARDS.map(g => g.ledger), LEDGER_GUARDS.map(g => g.marker ?? '')];
}

/**
 * Every installed guard whose body lacks its ledger check or its marker (regprocedure text and schema-qualified signature), the role
 * that owns it, whether the current role may re-create it, and the current role. Read-only (doctor guard_ledger_checks).
 */
export async function ledgerGuardsWithoutCheck(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Array<{ sig: string; qualified: string; owner: string; owned: boolean; role: string }>> {
  return engine.executeRaw(
    `SELECT p.oid::regprocedure::text AS sig, quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || oidvectortypes(p.proargtypes) || ')' AS qualified,
            pg_get_userbyid(p.proowner)::text AS owner, pg_has_role(current_user, p.proowner, 'USAGE') AS owned, quote_ident(current_user) AS role
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN unnest($1::text[], $2::text[], $3::text[]) AS g(name, ledger, marker) ON g.name = p.proname
      WHERE n.nspname = 'public' AND p.prokind = 'f' AND ${STALE_GUARD_SQL} ORDER BY 1`,
    guardParams());
}

/**
 * Re-creates every installed guard whose body lacks its ledger check or its marker and that the current role may replace,
 * and returns the ones another role owns (regprocedure text) with the current role, for the message naming them.
 */
export async function failClosedLedgerGuards(engine: Pick<BrainEngine, 'executeRaw'>): Promise<{ left: string[]; role: string }> {
  const rows = await engine.executeRaw<{ name: string; sig: string; owned: boolean; role: string }>(
    `SELECT p.proname AS name, p.oid::regprocedure::text AS sig, pg_has_role(current_user, p.proowner, 'USAGE') AS owned, current_user::text AS role
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN unnest($1::text[], $2::text[], $3::text[]) AS g(name, ledger, marker) ON g.name = p.proname
      WHERE n.nspname = 'public' AND p.prokind = 'f' AND ${STALE_GUARD_SQL} ORDER BY 1`,
    guardParams());
  const left: string[] = [];
  for (const row of rows) {
    if (!row.owned) { left.push(row.sig); continue; }
    await engine.executeRaw(LEDGER_GUARDS.find(g => g.name === row.name)!.sql);
  }
  return { left, role: rows[0]?.role ?? '' };
}
