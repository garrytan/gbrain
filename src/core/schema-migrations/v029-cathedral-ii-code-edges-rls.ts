import type { Migration } from './types.ts';

export const v029: Migration = {
  version: 29,
  name: 'cathedral_ii_code_edges_rls',
  // v0.21.0 Cathedral II — RLS hardening for the two new tables added by
  // v27 (code_edges_chunk, code_edges_symbol). The v24 RLS-backfill
  // pattern: gated on BYPASSRLS (so we don't lock the migrating session
  // out of its own data on a non-bypass role) + bare ALTER TABLE since
  // both tables are guaranteed to exist after v27.
  //
  // Postgres-only via sqlFor: PGLite doesn't enforce RLS the same way
  // and v24 already runs only against Postgres in practice. The E2E
  // test "RLS is enabled on every public table" runs against Docker
  // postgres exclusively and was failing because v27 created the new
  // tables without RLS enabled.
  sqlFor: {
    postgres: `
        DO $$
        DECLARE
          has_bypass BOOLEAN;
        BEGIN
          SELECT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) INTO has_bypass; -- #1385: superuser + inherited-role BYPASSRLS, not just the role's own rolbypassrls
          IF NOT has_bypass THEN
            RAISE EXCEPTION 'v29 cathedral_ii_code_edges_rls: role % does not have BYPASSRLS privilege — cannot enable RLS safely. Grant it (as postgres or a managed-Postgres master user): ALTER ROLE % BYPASSRLS; then re-run. The migration will retry automatically on the next initSchema call.', current_user, current_user;
          END IF;

          ALTER TABLE code_edges_chunk ENABLE ROW LEVEL SECURITY;
          ALTER TABLE code_edges_symbol ENABLE ROW LEVEL SECURITY;

          RAISE NOTICE 'v29: code_edges RLS enabled (role % has BYPASSRLS)', current_user;
        END $$;
      `,
    pglite: `-- PGLite: no-op. RLS check runs only against Postgres E2E.`,
  },
  sql: '',
};
