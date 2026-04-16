export const ACTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS action_items (
  id                  SERIAL PRIMARY KEY,
  title               TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('commitment', 'follow_up', 'decision', 'question', 'delegation')),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_on', 'in_progress', 'stale', 'resolved', 'dropped')),
  owner               TEXT NOT NULL DEFAULT '',
  waiting_on          TEXT,
  due_at              TIMESTAMPTZ,
  stale_after_hours   INTEGER NOT NULL DEFAULT 48 CHECK (stale_after_hours > 0),
  priority_score      DOUBLE PRECISION NOT NULL DEFAULT 0,
  confidence          DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  source_message_id   TEXT NOT NULL UNIQUE,
  source_thread       TEXT NOT NULL DEFAULT '',
  source_contact      TEXT NOT NULL DEFAULT '',
  linked_entity_slugs TEXT[] NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_action_items_status_due_at ON action_items(status, due_at);
CREATE INDEX IF NOT EXISTS idx_action_items_owner ON action_items(owner);
CREATE INDEX IF NOT EXISTS idx_action_items_waiting_on ON action_items(waiting_on);
CREATE INDEX IF NOT EXISTS idx_action_items_source_contact ON action_items(source_contact);
CREATE INDEX IF NOT EXISTS idx_action_items_linked_entity_slugs ON action_items USING GIN(linked_entity_slugs);

CREATE TABLE IF NOT EXISTS action_history (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK (event_type IN ('created', 'status_change', 'reminded', 'escalated', 'resolved', 'dropped')),
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_action_history_item_id_timestamp ON action_history(item_id, timestamp DESC);
`;

export async function initActionSchema(db: { exec: (sql: string) => Promise<unknown> }): Promise<void> {
  await db.exec(ACTION_SCHEMA_SQL);
}
