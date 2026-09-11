/** Both engines use these additive columns. NULL snapshots are legacy grants. */
export const GRANT_COLUMNS_SQL = `
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS allowed_operations TEXT[];
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS delegated_slug_prefixes TEXT[];
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS delegated_namespace TEXT NOT NULL DEFAULT 'prefixes';
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS grant_profile TEXT;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS grant_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS grant_repair_reasons TEXT[] NOT NULL DEFAULT '{}';
`;

export const GRANT_AUDIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oauth_grant_audit (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  revision INTEGER NOT NULL,
  before_grant JSONB,
  after_grant JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_grant_audit_client ON oauth_grant_audit(client_id, created_at);
`;

export const GRANT_CONSTRAINTS_SQL = `
ALTER TABLE oauth_clients DROP CONSTRAINT IF EXISTS oauth_clients_complete_agent_grant;
ALTER TABLE oauth_clients ADD CONSTRAINT oauth_clients_complete_agent_grant CHECK (
  NOT (COALESCE(scope, '') ~ '(^|[[:space:]])agent([[:space:]]|$)') OR (
    COALESCE(cardinality(bound_tools), 0) > 0
    AND source_id IS NOT NULL AND bound_source_id IS NOT NULL AND bound_source_id = source_id
    AND COALESCE(source_id = ANY(federated_read), false)
    AND ((delegated_namespace = 'job' AND delegated_slug_prefixes IS NULL) OR
         (delegated_namespace = 'prefixes' AND COALESCE(cardinality(delegated_slug_prefixes), 0) > 0))
    AND bound_max_concurrent > 0
  )
);
`;

export const GRANT_SPEND_COLUMNS_SQL = `
ALTER TABLE mcp_spend_reservations ADD COLUMN IF NOT EXISTS estimate_known BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE mcp_spend_reservations ADD COLUMN IF NOT EXISTS usage_unknown_reason TEXT;
`;
