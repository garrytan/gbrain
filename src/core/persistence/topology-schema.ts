/** Source administration receipts survive deletion of their source and principal. */
export const PERSISTENCE_TOPOLOGY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS persistence_topology_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL,
  request_id uuid NOT NULL,
  digest text NOT NULL,
  operation text NOT NULL,
  source_id text NOT NULL,
  source_incarnation uuid,
  worktree_ids uuid[] NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK(state IN ('recovering','committed','failed')),
  recovery jsonb,
  recovery_bytes bigint NOT NULL DEFAULT 0 CHECK(recovery_bytes>=0),
  intent_bytes bigint NOT NULL DEFAULT 0 CHECK(intent_bytes>=0),
  terminal_bytes bigint NOT NULL DEFAULT 2048 CHECK(terminal_bytes>=0),
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(principal_id,request_id)
);
ALTER TABLE persistence_topology_changes ADD COLUMN IF NOT EXISTS intent_bytes bigint NOT NULL DEFAULT 0 CHECK(intent_bytes>=0);
CREATE INDEX IF NOT EXISTS persistence_topology_recovering ON persistence_topology_changes(created_at) WHERE state='recovering';
`;
