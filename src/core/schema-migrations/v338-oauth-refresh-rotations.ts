import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #9364: refresh-token families and a short reuse grace window. oauth_tokens.family_id ties every token a sign-in
// mints (the code exchange and each refresh after it) to one family. oauth_refresh_rotations keeps one row per
// rotated refresh token: who it belonged to, its family, the refresh token that replaced it, when, and for the grace
// window only the replacement pair sealed with a key derived from the rotated token itself (NULL afterwards). A replay
// of the immediate predecessor by the same client inside the window gets that pair back; any other replay revokes the
// whole family. Tokens minted before this migration carry no family: their first refresh starts one. Database only,
// so a repo-less brain gets it unchanged; nothing is rewritten on upgrade. Like v286, no schema.sql mirror:
// oauth-grants.ts checks for the table and keeps plain rotation on a schema without it.
export const v338: Migration = {
  version: 338,
  name: 'oauth_refresh_rotations',
  idempotent: true,
  sql: `
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS family_id TEXT;
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens (family_id) WHERE family_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS oauth_refresh_rotations (
  token_hash        TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  family_id         TEXT NOT NULL,
  replaced_by_hash  TEXT NOT NULL,
  rotated_at_ms     BIGINT NOT NULL,
  expires_at        BIGINT NOT NULL,
  sealed_pair       TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_rotations_family ON oauth_refresh_rotations (family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_rotations_client ON oauth_refresh_rotations (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_rotations_expiry ON oauth_refresh_rotations (expires_at);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE oauth_refresh_rotations ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
