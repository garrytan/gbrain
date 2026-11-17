import { FACT_FINGERPRINT_FUNCTION_STATEMENTS } from '../facts/withdrawal-schema.ts';
import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5190: every gbrain plpgsql function pins `search_path = pg_catalog, public`,
// so an unqualified reference in its body never resolves through a caller's
// search_path. Existing brains are ALTERed by regprocedure (functions with
// arguments included) wherever no setting is pinned yet; the definition
// sources carry the same SET for fresh installs and CREATE OR REPLACE
// re-applies. The fact fingerprint SQL functions stay inlinable for their
// index expression, so they are re-created with schema-qualified built-ins
// instead (byte-identical results). Re-running finds nothing left to change.
export const v211: Migration = {
  version: 211,
  name: 'function_search_path',
  idempotent: true,
  sql: FACT_FINGERPRINT_FUNCTION_STATEMENTS.join(';\n') + `;
DO $search_path$
DECLARE fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND l.lanname = 'plpgsql' AND p.proconfig IS NULL
      AND (p.proname LIKE 'gbrain\\_%' OR p.proname = 'auto_enable_rls')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', fn);
  END LOOP;
END
$search_path$;
`,
};
