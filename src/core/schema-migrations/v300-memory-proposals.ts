import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-1158 memory_propose (GBRA-284): QM's held writes. One row per proposed
// timeline entry or link, keyed like a write receipt (principal, request_id),
// waiting for the brain owner's yes. Nothing here is page content: an
// approved proposal is admitted into persistence_requests in the same
// transaction and published through the normal writer door, so git (where a
// repo exists) never sees unapproved text. Every closed row (approved,
// denied, expired, cancelled, failed, conflict) is purged after the retention
// window (proposals.retention_days). Database only, so a repo-less brain gets
// it unchanged. No schema.sql mirror: like v282, v283 and v286, it exists only
// through migrations. Numbered when its PR takes the merge slot.
export const v300: Migration = {
  version: 300,
  name: 'memory_proposals',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS memory_proposals (
  principal_kind TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  request_id UUID NOT NULL,
  system TEXT NOT NULL,
  external_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('timeline', 'link')),
  operation TEXT NOT NULL CHECK (operation IN ('add_timeline_entry', 'add_link')),
  slug TEXT NOT NULL,
  to_slug TEXT,
  payload JSONB,
  payload_digest TEXT NOT NULL,
  expected_revision TEXT,
  authority JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'awaiting_owner'
    CHECK (state IN ('awaiting_owner', 'approved', 'denied', 'expired', 'cancelled', 'failed', 'conflict')),
  reason TEXT,
  error_code TEXT,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (principal_kind, principal_id, request_id)
);
CREATE INDEX IF NOT EXISTS memory_proposals_request_idx ON memory_proposals (request_id);
CREATE INDEX IF NOT EXISTS memory_proposals_pending_actor_idx ON memory_proposals (principal_kind, principal_id, member_id, expires_at)
  WHERE state = 'awaiting_owner';
CREATE INDEX IF NOT EXISTS memory_proposals_pending_source_idx ON memory_proposals (source_id, created_at)
  WHERE state = 'awaiting_owner';
CREATE INDEX IF NOT EXISTS memory_proposals_closed_idx ON memory_proposals (decided_at)
  WHERE state <> 'awaiting_owner';
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE memory_proposals ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
