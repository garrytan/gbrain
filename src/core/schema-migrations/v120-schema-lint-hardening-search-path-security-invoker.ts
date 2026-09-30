import type { Migration } from './types.ts';

export const v120: Migration = {
  version: 120,
  name: 'schema_lint_hardening_search_path_security_invoker',
  // v0.42 schema-lint hardening wave (#1647 / #171).
  //
  //   (b) security_invoker on the page_links view: pre-fix the view ran with
  //       the definer/owner's privileges, so the anon / PostgREST role could
  //       read `links` (which has RLS) THROUGH the view, bypassing RLS. This
  //       is the single ERROR-severity Supabase lint. Postgres-only — PGLite
  //       is embedded/single-user with no anon role and no PostgREST, so the
  //       view has no RLS-bypass surface there (and security_invoker carries
  //       no benefit). Guarded with IF EXISTS for very old brains.
  //
  //   (a)/(#171) search_path on every gbrain-owned trigger/event function:
  //       an unqualified reference (e.g. `FROM timeline_entries`) resolves
  //       through the caller's search_path, so a same-named object in a
  //       user-controlled schema could shadow it. Pinning search_path closes
  //       that. ALTER FUNCTION (NOT CREATE OR REPLACE) leaves each body
  //       untouched — lowest drift risk, and critically safe for the
  //       load-bearing `auto_enable_rls` event-trigger function (codex #3).
  //       The IF EXISTS loop is engine-agnostic and skips functions a given
  //       brain never created (e.g. auto_enable_rls + the NOTIFY/chunk
  //       trigger functions are Postgres-only — codex #4).
  //
  // Regression guard is a doctor probe (pg_proc.proconfig) + scripts/
  // check-search-path.sh, NOT a migration verify-hook — hooks don't run on
  // brains already stamped past this version (learning: migration-verify-hook-
  // never-runs-on-stamped-brains). Fresh installs are born correct: the
  // function defs in schema.sql / pglite-schema.ts carry SET search_path too.
  idempotent: true,
  sql: '', // engine-specific via sqlFor
  sqlFor: {
    postgres: `
        ALTER VIEW IF EXISTS page_links SET (security_invoker = on);

        DO $$
        DECLARE fn text;
        BEGIN
          FOREACH fn IN ARRAY ARRAY[
            'bump_page_generation_fn','bump_page_generation_clock_fn',
            'update_chunk_search_vector','update_page_search_vector',
            'notify_minion_job_change','auto_enable_rls'
          ] LOOP
            IF EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = fn
            ) THEN
              EXECUTE format('ALTER FUNCTION public.%I() SET search_path = pg_catalog, public', fn);
            END IF;
          END LOOP;
        END $$;
      `,
    pglite: `
        DO $$
        DECLARE fn text;
        BEGIN
          FOREACH fn IN ARRAY ARRAY[
            'bump_page_generation_fn','bump_page_generation_clock_fn',
            'update_chunk_search_vector','update_page_search_vector',
            'notify_minion_job_change'
          ] LOOP
            IF EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = fn
            ) THEN
              EXECUTE format('ALTER FUNCTION public.%I() SET search_path = pg_catalog, public', fn);
            END IF;
          END LOOP;
        END $$;
      `,
  },
};
