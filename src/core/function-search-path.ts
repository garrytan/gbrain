/**
 * Every gbrain function that pins a search_path ends it with pg_temp (#7632).
 *
 * A pinned `pg_catalog, public` (or `pg_catalog`) does not name pg_temp, and PostgreSQL then searches the calling
 * session's temporary schema first for tables and views. Any role that may create temporary tables (PUBLIC may, by
 * default) could shadow a ledger a guard reads, such as fact_purges, page_purges, take_purges or fact_withdrawals, with an
 * empty temp table or view of the same name, and the guard let a purged claim, page or take, or a withdrawn fact,
 * through: for the owner as much as for any other writer. Named last, pg_temp comes after every other schema for
 * relations, and PostgreSQL never searches it for functions or operators.
 *
 * ALTER FUNCTION only: no body is rewritten, so every guard keeps master's body, SECURITY INVOKER and BEFORE ROW timing.
 * A write role with no policy on a ledger still reads it empty under its own RLS; that fail-open stays open (#7659).
 */

/** The search_path settings gbrain functions pinned before #7632, which the hardening completes with pg_temp. */
export const LEGACY_SEARCH_PATH_SETTINGS = ['search_path=pg_catalog, public', 'search_path=pg_catalog'] as const;

/**
 * Every function gbrain installs in public with a pinned search_path, on either engine. The hardening and the doctor
 * check touch only these, so another application's function in a shared database keeps its own search_path. A new
 * pinned function joins this list; the fresh-install tests (test/function-search-path-pglite.test.ts, and case 3 of
 * test/e2e/function-search-path-postgres.test.ts) fail until it does.
 */
export const PINNED_FUNCTION_NAMES = [
  'auto_enable_rls', 'bump_page_generation_clock_fn', 'bump_page_generation_fn', 'enforce_minion_queue_protocol',
  'gbrain_advance_page_revision', 'gbrain_advance_tag_revision', 'gbrain_bump_trust_generation',
  'gbrain_clear_atom_page_state', 'gbrain_count_git_canonical_sources', 'gbrain_count_modifications', 'gbrain_forget_page_retrievals',
  'gbrain_fts_input', 'gbrain_graduation_fence', 'gbrain_guard_effect_protocol', 'gbrain_guard_inserted_facts',
  'gbrain_guard_protocol_activation', 'gbrain_guard_request_protocol', 'gbrain_guard_skill_publication',
  'gbrain_lease_shared_skill_delivery', 'gbrain_mark_derivation_scope_entry', 'gbrain_preserve_fact_withdrawal',
  'gbrain_queue_page_projection', 'gbrain_refuse_purged_fact', 'gbrain_refuse_purged_page',
  'gbrain_refuse_purged_take', 'gbrain_refuse_purging_derivation', 'gbrain_require_managed_writer',
  'gbrain_require_persistence_protocol', 'gbrain_snapshot_version_trust', 'gbrain_stamp_revision_attribution',
  'gbrain_stamp_trust_tier', 'gbrain_stamp_version_attribution', 'gbrain_stamp_write_attribution', 'gbrain_try_jsonb',
  'notify_minion_job_change', 'update_chunk_search_vector', 'update_page_search_vector',
] as const;

/**
 * Appends pg_temp to the pinned search_path of every gbrain function (PINNED_FUNCTION_NAMES) in public the current
 * role may alter that still pins `pg_catalog, public` or `pg_catalog`. A function the role does not own is
 * left as it was, and so is a procedure (ALTER FUNCTION refuses one, and gbrain installs none). Shared by the schema blob (its last statement, so a replay's CREATE OR REPLACE never leaves a function
 * without it), the migration, the end of every migration run (src/core/migrate.ts: a migration that re-creates a
 * function resets its path, and the run may stop before v277) and `gbrain reindex-search-vector`, which rewrites the
 * search_vector trigger functions.
 */
export const FUNCTION_SEARCH_PATH_HARDENING_SQL = `DO $harden$
DECLARE f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, substr(c.setting, 13) AS path
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL unnest(p.proconfig) AS c(setting)
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND c.setting IN (${LEGACY_SEARCH_PATH_SETTINGS.map(v => `'${v}'`).join(', ')})
      AND p.proname IN (${PINNED_FUNCTION_NAMES.map(name => `'${name}'`).join(', ')})
      AND pg_has_role(current_user, p.proowner, 'USAGE')
    ORDER BY 1
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %s, pg_temp', f.sig, f.path);
  END LOOP;
END $harden$;`;

