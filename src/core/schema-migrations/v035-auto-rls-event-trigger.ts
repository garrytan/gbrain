import type { Migration } from './types.ts';

export const v035: Migration = {
  version: 35,
  name: 'auto_rls_event_trigger',
  sql: '', // engine-specific via sqlFor
  // v0.26.7 — Postgres event trigger that auto-enables RLS on every new public.*
  // table, plus one-time backfill on every existing public.* table without it.
  //
  // Problem: tables created outside gbrain migrations (Baku's face_detections,
  // manual SQL, other apps sharing the Supabase project) shipped without RLS.
  // doctor caught them after the fact; the gap window between create and next
  // doctor run was the silent vector.
  //
  // Fix has two halves:
  //   1. Event trigger — fires on ddl_command_end for CREATE TABLE,
  //      CREATE TABLE AS, and SELECT INTO; runs ALTER TABLE ... ENABLE ROW
  //      LEVEL SECURITY for any new public.* table. Supabase-recommended
  //      approach (no dashboard toggle exists).
  //   2. One-time backfill — every existing public.* table whose RLS is off
  //      and whose comment does NOT match the GBRAIN:RLS_EXEMPT contract
  //      (same regex doctor.ts uses) gets RLS enabled.
  //
  // Posture choices (vs PR-as-shipped):
  //   - ENABLE only, no FORCE — matches v24/v29/schema.sql. FORCE would lock
  //     out non-BYPASSRLS apps from their own newly-created tables (the
  //     trigger function inherits the caller's role, and the new table is
  //     owned by that role). gbrain has BYPASSRLS so gbrain itself is unaffected.
  //   - public-only schema scope — Supabase manages auth/storage/realtime/etc.
  //     and runs its own RLS posture there; we must not disturb those schemas.
  //   - No EXCEPTION wrap inside the trigger — ddl_command_end fires inside
  //     the DDL transaction, so a failed ALTER aborts the offending CREATE
  //     TABLE. That's a loud signal, not a silent gap. Wrapping would CREATE
  //     the silent path this migration exists to close.
  //   - Create-if-absent, NOT DROP+CREATE (#3603). CREATE EVENT TRIGGER is
  //     superuser-reserved and on managed Postgres (RDS/Aurora) no reachable
  //     app role has rolsuper — rds_superuser is NOT enough — so the original
  //     ungated DROP+CREATE could never apply: config.version stalled at 34
  //     forever while the server kept serving, and every later migration
  //     silently never ran. Both the function and the trigger are gated on
  //     existence so an operator can pre-create them once as the master user
  //     and have this migration converge (CREATE OR REPLACE / DROP would fail
  //     on master-owned objects). When absent AND uncreatable, the
  //     insufficient_privilege handler raises ONE actionable message instead
  //     of the raw permission error; anything else still fails loud.
  //
  // BREAKING CHANGE: the backfill is a one-time override of intentionally
  // RLS-off public tables that don't carry the GBRAIN:RLS_EXEMPT comment.
  // Operators with such tables MUST add the exempt comment BEFORE upgrading.
  //
  // PGLite: no-op — no RLS engine, no event triggers, single-tenant by design.
  sqlFor: {
    postgres: `
        -- Trigger function: fires post-DDL inside the CREATE TABLE transaction.
        -- A failure here aborts the CREATE TABLE so no public.* table is ever
        -- created without RLS. object_identity is pre-quoted by Postgres
        -- (e.g. "public"."My Table"), so %s is correct — %I would double-quote.
        -- #3603: create-if-absent for BOTH objects (see the posture comment
        -- above) so a master-user pre-create converges on managed Postgres.
        DO $v35$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = 'auto_enable_rls' AND n.nspname = 'public'
          ) THEN
            EXECUTE $fn$
              CREATE FUNCTION auto_enable_rls()
              RETURNS event_trigger AS $body$
              DECLARE
                obj record;
              BEGIN
                FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
                  WHERE object_type = 'table'
                  AND schema_name = 'public'
                LOOP
                  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
                END LOOP;
              END;
              $body$ LANGUAGE plpgsql
            $fn$;
          END IF;

          -- WHEN TAG covers all three table-creation syntaxes Postgres reports.
          -- CREATE TABLE / CREATE TABLE AS / SELECT INTO produce distinct command
          -- tags; covering only 'CREATE TABLE' would leave a syntax-shaped hole.
          IF NOT EXISTS (
            SELECT 1 FROM pg_event_trigger WHERE evtname = 'auto_rls_on_create_table'
          ) THEN
            BEGIN
              EXECUTE $trg$
                CREATE EVENT TRIGGER auto_rls_on_create_table
                  ON ddl_command_end
                  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
                  EXECUTE FUNCTION auto_enable_rls()
              $trg$;
            EXCEPTION WHEN insufficient_privilege THEN
              RAISE EXCEPTION 'v35 auto_rls_event_trigger: role % may not CREATE EVENT TRIGGER (superuser-only; on managed Postgres only the master user can — rds_superuser is not enough). Pre-create the auto_enable_rls() function and the auto_rls_on_create_table event trigger as that user (SQL in src/core/migrate.ts v35), then re-run: this migration passes create-if-absent and retries automatically on the next initSchema call.', current_user;
            END;
          END IF;
        END $v35$;

        -- One-time backfill of every existing public.* base table without RLS.
        -- Honors the same GBRAIN:RLS_EXEMPT regex doctor.ts uses
        -- (^GBRAIN:RLS_EXEMPT\\s+reason=\\S.{3,}) so the two surfaces stay aligned.
        -- %I.%I quotes the schema and table names safely, including mixed-case.
        DO $$
        DECLARE
          has_bypass BOOLEAN;
          r record;
        BEGIN
          SELECT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) INTO has_bypass; -- #1385: superuser + inherited-role BYPASSRLS, not just the role's own rolbypassrls
          IF NOT has_bypass THEN
            -- Same posture as v24: raise to abort the migration so the runner
            -- leaves config.version unbumped and retries on the next call.
            RAISE EXCEPTION 'v35 auto_rls_event_trigger backfill: role % does not have BYPASSRLS — cannot enable RLS safely. Grant it (as postgres or a managed-Postgres master user): ALTER ROLE % BYPASSRLS; then re-run. The migration will retry automatically on the next initSchema call.', current_user, current_user;
          END IF;

          FOR r IN
            SELECT n.nspname AS schema_name, c.relname AS table_name
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
              AND c.relrowsecurity = false
              AND (d.description IS NULL OR d.description !~ '^GBRAIN:RLS_EXEMPT\\s+reason=\\S.{3,}')
          LOOP
            EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema_name, r.table_name);
            RAISE NOTICE 'v35: backfilled RLS on %.%', r.schema_name, r.table_name;
          END LOOP;
        END $$;
      `,
    pglite: '', // PGLite has no RLS and no event trigger support
  },
};
