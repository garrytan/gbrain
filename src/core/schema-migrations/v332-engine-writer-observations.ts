import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Swap eligibility (docs/designs/RUST_ENGINE.md "Swap and the way back", plan PR S5): engine_writer_observations, one row
// per writing process while a Rust shadow follows this brain: the host id the process claims (persistence/identity.ts),
// the application_name its pools give their connections, its command kind and gbrain version, and when it first and
// last wrote. Written only by src/shadow/writer-observations.ts, which exists only inside the shadow wrapper, so a brain
// with no shadow keeps this table empty and no write path gains a statement. No paths, arguments or query text.
// On a Postgres primary, `gbrain engine shadow start` also hooks every brain table with a statement-level trigger that
// calls gbrain_note_writer(): it records the writing connection (application_name, client address, backend pid) in
// engine_writer_sessions, so a writer that is not a wrapped gbrain process (another machine, psql, an old binary)
// still leaves a row the swap can count. The function never fails the writer and never waits on the evidence tables:
// it takes each evidence table's lock with NOWAIT, so a lock someone else holds is 55P03 at once, which it catches like any error, and a function-scoped lock_timeout of 50 ms bounds any other wait (a conflicting uncommitted row). The sessions table has no unique key, so the trigger's INSERT has no uniqueness check that could wait on another transaction's uncommitted row; a repeated row is harmless because every reader counts a session as the set (application_name, client_addr, backend_pid) and the refresh updates every matching row. It does not catch query_canceled, so a user's own cancel still cancels. It skips a
// row another transaction holds (and records that skip as a gap, because the write went unrecorded), refreshes at most every 10 minutes per connection, and turns any error into a row in
// engine_writer_coverage_gaps (which has no sequence, so an INSERT alone records a gap). It stamps with
// clock_timestamp(), not now(): now() is the start of the writer's transaction, which can lie before the shadow
// window for a transaction that wrote only after the hooks existed. It runs with the writer's own rights (no
// SECURITY DEFINER, #7659); the eligibility read counts any role without a complete recording route as a coverage
// gap. This migration creates the function only; triggers exist only while a shadow runs.
// Operational state, not brain content: the shadow seed does not copy these tables and graduation discards them.
// RLS is enabled here (v275's list is frozen). No schema.sql mirror: like v331, it exists only through migrations.
export const v332: Migration = {
  version: 332,
  name: 'engine_writer_observations',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS engine_writer_observations (
  host_id TEXT NOT NULL,
  application_name TEXT NOT NULL,
  process_kind TEXT NOT NULL,
  gbrain_version TEXT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, application_name)
);
CREATE INDEX IF NOT EXISTS idx_engine_writer_observations_last_seen ON engine_writer_observations (last_seen);
CREATE TABLE IF NOT EXISTS engine_writer_sessions (
  application_name TEXT NOT NULL,
  client_addr TEXT NOT NULL,
  backend_pid INTEGER NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_engine_writer_sessions_last_seen ON engine_writer_sessions (last_seen);
CREATE INDEX IF NOT EXISTS idx_engine_writer_sessions_key ON engine_writer_sessions (application_name, client_addr, backend_pid);
CREATE TABLE IF NOT EXISTS engine_writer_coverage_gaps (
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  code TEXT NOT NULL,
  backend_pid INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_engine_writer_coverage_gaps_time ON engine_writer_coverage_gaps (created_at);
CREATE OR REPLACE FUNCTION gbrain_note_writer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET lock_timeout = '50ms' AS $fn$
DECLARE
  schema_name text := TG_TABLE_SCHEMA;
  app text := coalesce(current_setting('application_name', true), '');
  addr text := coalesce(host(inet_client_addr()), 'local');
  seen timestamptz;
  touched bigint;
BEGIN
  BEGIN
    -- Never wait for an evidence table: take its lock without waiting first, so a lock held by someone else (55P03) becomes a gap
    -- at once, before any statement could queue behind it and run into a caller's own statement timeout.
    EXECUTE format('LOCK TABLE %I.engine_writer_sessions IN ROW EXCLUSIVE MODE NOWAIT', schema_name);
    EXECUTE format('SELECT max(last_seen) FROM %I.engine_writer_sessions WHERE application_name = $1 AND client_addr = $2 AND backend_pid = $3', schema_name)
      INTO seen USING app, addr, pg_backend_pid();
    IF seen IS NOT NULL AND seen > clock_timestamp() - interval '600 seconds' THEN RETURN NULL; END IF;
    IF seen IS NULL THEN
      EXECUTE format('INSERT INTO %I.engine_writer_sessions (application_name, client_addr, backend_pid, first_seen, last_seen) VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp())', schema_name)
        USING app, addr, pg_backend_pid();
    ELSE
      EXECUTE format('UPDATE %I.engine_writer_sessions SET last_seen = clock_timestamp() WHERE ctid IN (SELECT ctid FROM %I.engine_writer_sessions WHERE application_name = $1 AND client_addr = $2 AND backend_pid = $3 FOR UPDATE SKIP LOCKED)', schema_name, schema_name)
        USING app, addr, pg_backend_pid();
      GET DIAGNOSTICS touched = ROW_COUNT;
      -- A row another transaction holds is skipped, never waited on; skipped means this write was not recorded, so it is a gap.
      IF touched = 0 THEN RAISE EXCEPTION 'writer session refresh skipped' USING ERRCODE = '55P03'; END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      EXECUTE format('LOCK TABLE %I.engine_writer_coverage_gaps IN ROW EXCLUSIVE MODE NOWAIT', schema_name);
      EXECUTE format('INSERT INTO %I.engine_writer_coverage_gaps (created_at, code, backend_pid) VALUES (clock_timestamp(), $1, $2)', schema_name) USING SQLSTATE, pg_backend_pid();
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'gbrain_note_writer: could not record a writer or a gap (%)', SQLSTATE;
    END;
  END;
  RETURN NULL;
END
$fn$;
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE engine_writer_observations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE engine_writer_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE engine_writer_coverage_gaps ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
