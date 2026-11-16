import type { Migration } from './types.ts';
import { failClosedLedgerGuards } from '../guard-ledger-checks.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7632/#7659: the purge and withdrawal guards read their ledgers (fact_purges,
// fact_withdrawals, take_purges, page_purges, the derivation purge tables) as
// the writing role. A role that neither owns them nor bypasses RLS, with write
// policies on a guarded table but none on its ledger, read the ledger empty, so
// a purged claim, take, page or derivation could be stored again and a
// withdrawn fact saved active. Each guard now refuses with
// writer_coordinator_required (unreadable_state, as v281 does) when RLS
// applies to the caller on a table it reads and no permissive policy of the
// caller covers it; the HINT names the table and the docs/ENGINES.md recipe.
// The owner, a role that bypasses RLS, a table without RLS and PGLite behave as
// before. Every guard stays SECURITY INVOKER with its timing: no SECURITY
// DEFINER (#7659), no privilege change, no row read or written. Replaces only
// the seven functions: their triggers already call them, and re-creating the
// triggers would take ACCESS EXCLUSIVE locks on facts, pages and takes. A
// function another role owns is left and named, never an abort; every later
// migration run re-creates it once a role that owns it runs (migrate.ts).
export const v318: Migration = {
  version: 318,
  name: 'guard_ledgers_fail_closed',
  idempotent: true,
  sql: '',
  handler: async engine => { await failClosedLedgerGuards(engine); },
};
