import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Outbound notifications (notifications/outbox.ts): one row per (sink, event, subject) to deliver, so an event is
// queued once per sink however often it is emitted (the dream cycle re-running, a backfill), and delivery retries
// with backoff until it lands or gives up. `delivery` keeps what the sink returned for later events on the same
// subject (Slack: channel + message ts, so a decision edits the message it posted). Inbound Slack button clicks are
// queued here too (event `slack.interaction`), so the HTTP handler acknowledges within Slack's 3 s and the decision
// runs from the queue. Writes no data; nothing changes on upgrade. No schema.sql mirror, like v327.
export const v333: Migration = {
  version: 333,
  name: 'notification_outbox',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  sink TEXT NOT NULL,
  event TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  last_error TEXT,
  delivery JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_once_idx ON notification_outbox (sink, event, subject);
CREATE INDEX IF NOT EXISTS notification_outbox_due_idx ON notification_outbox (next_attempt_at) WHERE status = 'pending';
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
