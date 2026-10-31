import type { Migration } from './types.ts';
import type { BrainEngine } from '../engine.ts';
import { migrationStatementTimeoutMs } from '../migration-timeout.ts';
import { isLockTimeoutError } from '../retry-matcher.ts';
import { resolveSchemaLockTimeoutMs, schemaLockBlockedError } from '../postgres-engine/schema-lock-timeout.ts';
import { FUNCTION_SEARCH_PATH_HARDENING_SQL, PINNED_FUNCTION_NAMES, LEGACY_SEARCH_PATH_SETTINGS } from '../function-search-path.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7632: every gbrain function that pins a search_path gets pg_temp appended last (src/core/function-search-path.ts),
// so a temp table or view named like a ledger no longer hides it from a guard. ALTER only, no body changes. ALTER
// FUNCTION needs the owner: a function the migrating role does not own is left as it was and named on stderr, and
// doctor's function_search_path check keeps failing with the SQL to run as its owner. One short transaction with the
// migration's statement and lock timeouts.

/** Appends pg_temp where the role may, then names on stderr and returns every function still without it. */
export async function hardenFunctionSearchPaths(engine: BrainEngine, label: string): Promise<string[]> {
  const legacy = async () => (await engine.executeRaw<{ sig: string }>(
    `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proconfig && $1::text[] AND p.proname = ANY($2::text[]) ORDER BY 1`,
    [[...LEGACY_SEARCH_PATH_SETTINGS], [...PINNED_FUNCTION_NAMES]])).map(r => r.sig);
  if ((await legacy()).length === 0) return [];
  const lockTimeoutMs = resolveSchemaLockTimeoutMs();
  try {
    await engine.transaction(async tx => {
      if (engine.kind === 'postgres') {
        await tx.executeRaw(`SET LOCAL statement_timeout = '${migrationStatementTimeoutMs()}'`);
        await tx.executeRaw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      }
      await tx.runMigration(277, FUNCTION_SEARCH_PATH_HARDENING_SQL);
    });
  } catch (error) {
    if (isLockTimeoutError(error)) throw schemaLockBlockedError({ step: `${label} search_path`, timeoutMs: lockTimeoutMs, sessions: null, sampledDuringWait: false });
    throw error;
  }
  const left = await legacy();
  if (left.length > 0) {
    process.stderr.write(`  ${label}: ${left.length} function(s) left without pg_temp on their search_path (${left.join(', ')}): `
      + 'ALTER FUNCTION needs the owner. Run gbrain doctor for the SQL to run as that role.\n');
  }
  return left;
}

export const v277: Migration = {
  version: 277,
  name: 'function_search_path_pg_temp',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => { await hardenFunctionSearchPaths(engine, 'v277'); },
};
