import type { Migration } from './types.ts';

export const v024: Migration = {
  version: 24,
  name: 'rls_backfill_missing_tables',
  // v0.18.1 RLS hardening: 10 gbrain-managed public tables shipped
  // without RLS enabled (access_tokens, mcp_request_log, minion_inbox,
  // minion_attachments, subagent_messages, subagent_tool_executions,
  // subagent_rate_leases, gbrain_cycle_locks, budget_ledger,
  // budget_reservations). Supabase exposes the public schema via
  // PostgREST, so tables without RLS are readable by anyone with the
  // anon key.
  //
  // Numbered v24 to slot after v0.18.0's v20-v23 sources-migration
  // wave. The 'sources' and 'file_migration_ledger' tables added in
  // v0.18.0 already get RLS from schema.sql's base DO block; v24
  // backfills the 10 older tables that never had it.
  //
  // Gated on BYPASSRLS matching the pattern in schema.sql: enabling RLS
  // on a table in a session that does NOT hold BYPASSRLS would lock
  // the session out of its own data. RAISE WARNING is visible to the
  // migration runner's log stream.
  sql: `
      DO $$
      DECLARE
        has_bypass BOOLEAN;
      BEGIN
        SELECT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) INTO has_bypass; -- #1385: superuser + inherited-role BYPASSRLS, not just the role's own rolbypassrls
        IF NOT has_bypass THEN
          -- Fail the migration loudly instead of WARNING + version-bump.
          -- The runner unconditionally records schema_version on success,
          -- so a silent WARNING here would permanently lock the backfill out
          -- on future runs even after switching to a bypass role. Raising
          -- aborts the transaction, leaves schema_version at the prior value,
          -- and lets the next invocation retry after the role is fixed.
          RAISE EXCEPTION 'v24 rls_backfill_missing_tables: role % does not have BYPASSRLS privilege — cannot enable RLS safely. Grant it (as postgres or a managed-Postgres master user): ALTER ROLE % BYPASSRLS; then re-run. The migration will retry automatically on the next initSchema call.', current_user, current_user;
        END IF;

        -- These 8 are guaranteed to exist: schema.sql creates them (idempotent
        -- via IF NOT EXISTS) on every initSchema call, and initSchema runs
        -- before this migration. Bare ALTER TABLE is safe.
        ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
        ALTER TABLE mcp_request_log ENABLE ROW LEVEL SECURITY;
        ALTER TABLE minion_inbox ENABLE ROW LEVEL SECURITY;
        ALTER TABLE minion_attachments ENABLE ROW LEVEL SECURITY;
        ALTER TABLE subagent_messages ENABLE ROW LEVEL SECURITY;
        ALTER TABLE subagent_tool_executions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE subagent_rate_leases ENABLE ROW LEVEL SECURITY;
        ALTER TABLE gbrain_cycle_locks ENABLE ROW LEVEL SECURITY;

        -- budget_ledger + budget_reservations are migration-only (v12). Not
        -- in schema.sql, not re-created on every initSchema. In normal flow
        -- v12 runs before v24 so they exist, but if an operator manually
        -- dropped them (unusual — budget data is regenerable from resolver
        -- logs) or was pinned to a pre-v12 gbrain version when the table
        -- went away, the bare ALTER would fail with 42P01 and abort v24.
        -- information_schema.tables lookup makes the statement self-healing.
        IF EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'budget_ledger') THEN
          ALTER TABLE budget_ledger ENABLE ROW LEVEL SECURITY;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'budget_reservations') THEN
          ALTER TABLE budget_reservations ENABLE ROW LEVEL SECURITY;
        END IF;

        RAISE NOTICE 'v24: RLS backfill complete (role % has BYPASSRLS)', current_user;
      END $$;
    `,
  // PGLite has no RLS engine and is intrinsically single-tenant (local file).
  // The 8 ALTER TABLE ... ENABLE ROW LEVEL SECURITY statements above also
  // target tables that may not exist on PGLite (subagent_*, minion_inbox),
  // since pglite-schema.ts is the canonical PGLite schema source. No-op
  // override keeps PGLite upgrades unwedged and the version bump intact.
  sqlFor: {
    pglite: '',
  },
};
