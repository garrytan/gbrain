const ACTION_HISTORY_EVENT_TYPES = [
  'created',
  'status_change',
  'reminded',
  'escalated',
  'resolved',
  'dropped',
  'draft_created',
  'draft_approved',
  'draft_edited',
  'draft_rejected',
  'draft_sent',
  'draft_send_failed',
  'draft_regenerate',
  'draft_skipped',
  'draft_superseded',
  'draft_generation_failed',
  'draft_injection_suspected',
] as const;

const ACTION_HISTORY_EVENT_TYPES_SQL = ACTION_HISTORY_EVENT_TYPES.map((eventType) => `'${eventType}'`).join(',\n      ');
const ACTION_DRAFT_STATUS_VALUES = ['pending', 'approved', 'sending', 'rejected', 'sent', 'send_failed', 'superseded'] as const;
const ACTION_DRAFT_STATUS_VALUES_SQL = ACTION_DRAFT_STATUS_VALUES.map((status) => `'${status}'`).join(', ');

const ACTION_HISTORY_EVENT_TYPE_MIGRATION_SQL = `
ALTER TABLE IF EXISTS action_history
DROP CONSTRAINT IF EXISTS action_history_event_type_check;

ALTER TABLE IF EXISTS action_history
ADD CONSTRAINT action_history_event_type_check
CHECK (
  event_type IN (
      ${ACTION_HISTORY_EVENT_TYPES_SQL}
  )
);
`;

const ACTION_DRAFT_STATUS_MIGRATION_SQL = `
ALTER TABLE IF EXISTS action_drafts
DROP CONSTRAINT IF EXISTS action_drafts_status_check;

ALTER TABLE IF EXISTS action_drafts
ADD CONSTRAINT action_drafts_status_check
CHECK (status IN (${ACTION_DRAFT_STATUS_VALUES_SQL}));
`;

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
  event_type  TEXT NOT NULL CHECK (
    event_type IN (
      ${ACTION_HISTORY_EVENT_TYPES_SQL}
    )
  ),
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_action_history_item_id_timestamp ON action_history(item_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS action_drafts (
  id               SERIAL PRIMARY KEY,
  action_item_id   INTEGER NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (${ACTION_DRAFT_STATUS_VALUES_SQL})),
  channel          TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'telegram')),
  recipient        TEXT NOT NULL,
  draft_text       TEXT NOT NULL,
  model            TEXT NOT NULL,
  context_hash     TEXT NOT NULL,
  context_snapshot JSONB NOT NULL,
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at      TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  send_error       TEXT,
  UNIQUE (action_item_id, version)
);

CREATE INDEX IF NOT EXISTS action_drafts_item_idx ON action_drafts(action_item_id);
CREATE INDEX IF NOT EXISTS action_drafts_status_idx ON action_drafts(status);

CREATE TABLE IF NOT EXISTS action_drops (
  id                SERIAL PRIMARY KEY,
  run_id            TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  source_excerpt    TEXT NOT NULL DEFAULT '',
  drop_reason       TEXT NOT NULL CHECK (drop_reason IN ('low_confidence', 'schema_reject', 'duplicate', 'other')),
  confidence        DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  extractor_version TEXT NOT NULL,
  model             TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_drops_reason_created ON action_drops(drop_reason, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_drops_source_id ON action_drops(source_id);
`;

export async function initActionSchema(db: { exec: (sql: string) => Promise<unknown> }): Promise<void> {
  await db.exec(ACTION_SCHEMA_SQL);
  await db.exec(ACTION_HISTORY_EVENT_TYPE_MIGRATION_SQL);
  await db.exec(ACTION_DRAFT_STATUS_MIGRATION_SQL);
}
