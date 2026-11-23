import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Swap eligibility (docs/designs/RUST_ENGINE.md "Swap and the way back", plan PR S5): engine_writer_observations, one row
// per writing process while a Rust shadow follows this brain: the host id the process claims (persistence/identity.ts),
// the application_name its pools give their connections, its command kind and gbrain version, and when it first and
// last wrote. Written only by src/shadow/writer-observations.ts, which exists only inside the shadow wrapper, so a brain
// with no shadow keeps this table empty and no write path gains a statement. No paths, arguments or query text.
// Operational state, not brain content: the shadow seed does not copy it and graduation discards it.
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
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE engine_writer_observations ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
