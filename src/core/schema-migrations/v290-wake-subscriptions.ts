import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Wakeshift PR 1 (plan D7): wake_subscriptions holds each watch an agent made
// through watch_job: the event and target, the subscribing principal (kind,
// id and its bound member, never sent anywhere), the hashed Wakeshift user
// and Wakeshift's subscription id, and the drainer's delivery state (marker,
// attempts, next attempt, a lease so two drainer hosts never emit the same
// row, the last error code). Operational state, not brain content: a
// repo-less brain gets it unchanged, and it stays empty unless the owner ran
// gbrain wakeshift enable. Nothing is rewritten on upgrade. No schema.sql
// mirror: like v282-v286, it exists only through migrations.
export const v290: Migration = {
  version: 290,
  name: 'wake_subscriptions',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS wake_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  event TEXT NOT NULL CHECK (event ~ '^gbrain\\.[a-z][a-z0-9._]{0,47}$'),
  target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 128),
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('oauth_client', 'legacy_token', 'local_stdio')),
  principal_id TEXT NOT NULL,
  member_id TEXT,
  wake_user TEXT NOT NULL CHECK (wake_user ~ '^[0-9a-f]{32}$'),
  ws_subscription_id TEXT NOT NULL CHECK (length(ws_subscription_id) BETWEEN 1 AND 200),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'delivered', 'dead', 'ended')),
  delivered_marker TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  last_error TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wake_subscriptions_open_idx ON wake_subscriptions (next_attempt_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS wake_subscriptions_principal_idx ON wake_subscriptions (principal_kind, principal_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS wake_subscriptions_open_unique ON wake_subscriptions (wake_user, ws_subscription_id) WHERE state = 'open';
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE wake_subscriptions ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
