import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Wakeshift PR 2 (plan D2, D5, D6): the tables behind gbrain.write.settled,
// gbrain.cron.finished, the shared-brain agreement step and forget-on-remove.
//   - wake_subscriptions.target_ref: the persistence_requests row a
//     write.settled watch points at (request ids are unique per principal only);
//   - wake_crons: cron names the owner registered with gbrain wakeshift cron add;
//   - wake_cron_runs: (name, status, time) recorded by gbrain wakeshift emit,
//     which the drainer reconciles, so a cron script never waits on Wakeshift;
//   - wake_terms_acceptances: a principal's acceptance of the operator's terms
//     version (a hash of the two links) on a brain with access members;
//   - wake_forgets: queued Wakeshift forget-user calls for removed members,
//     revoked tokens and deleted OAuth clients, sent by the drainer.
// Operational state, never brain content: a repo-less brain gets it
// unchanged, and it stays empty unless the owner turned reporting back on.
// Nothing is rewritten on upgrade. No schema.sql mirror, like v290.
export const v297: Migration = {
  version: 297,
  name: 'wake_events',
  idempotent: true,
  sql: `
ALTER TABLE wake_subscriptions ADD COLUMN IF NOT EXISTS target_ref TEXT;
CREATE TABLE IF NOT EXISTS wake_crons (
  name TEXT PRIMARY KEY CHECK (name ~ '^[a-z0-9._-]{1,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wake_cron_runs (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (name ~ '^[a-z0-9._-]{1,64}$'),
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wake_cron_runs_name_idx ON wake_cron_runs (name, finished_at);
CREATE TABLE IF NOT EXISTS wake_terms_acceptances (
  principal_key TEXT NOT NULL CHECK (length(principal_key) BETWEEN 1 AND 300),
  terms_version TEXT NOT NULL CHECK (terms_version ~ '^[0-9a-f]{16}$'),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_key, terms_version)
);
CREATE TABLE IF NOT EXISTS wake_forgets (
  id BIGSERIAL PRIMARY KEY,
  wake_user TEXT NOT NULL CHECK (wake_user ~ '^[0-9a-f]{32}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wake_forgets_pending_unique ON wake_forgets (wake_user) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS wake_forgets_due_idx ON wake_forgets (next_attempt_at) WHERE state = 'pending';
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE wake_crons ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wake_cron_runs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wake_terms_acceptances ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wake_forgets ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
