import type { Migration } from './types.ts';

export const v032: Migration = {
  version: 32,
  name: 'oauth_infrastructure',
  // v0.26 OAuth 2.1 tables for `gbrain serve --http`. Supports client credentials,
  // authorization code + PKCE, and refresh token rotation. Renumbered from v30
  // → v32 on merge with master's v0.23 (dream_verdicts at v30) + v0.25
  // (eval_capture_tables at v31). OAuth is independent of those chains so
  // ordering doesn't matter beyond version ledger correctness. CREATE TABLE
  // statements are idempotent so brains that previously applied this at v30
  // see version 32 as new and run IF NOT EXISTS DDL cleanly.
  sql: `
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id               TEXT PRIMARY KEY,
        client_secret_hash      TEXT,
        client_name             TEXT NOT NULL,
        redirect_uris           TEXT[],
        grant_types             TEXT[] DEFAULT '{"client_credentials"}',
        scope                   TEXT,
        token_endpoint_auth_method TEXT,
        client_id_issued_at     BIGINT,
        client_secret_expires_at BIGINT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash   TEXT PRIMARY KEY,
        token_type   TEXT NOT NULL,
        client_id    TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        scopes       TEXT[],
        expires_at   BIGINT,
        resource     TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash              TEXT PRIMARY KEY,
        client_id              TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        scopes                 TEXT[],
        code_challenge         TEXT NOT NULL,
        code_challenge_method  TEXT NOT NULL DEFAULT 'S256',
        redirect_uri           TEXT NOT NULL,
        state                  TEXT,
        resource               TEXT,
        expires_at             BIGINT NOT NULL,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_log_time_agent ON mcp_request_log(created_at, token_name);
      DO $$
      DECLARE
        has_bypass BOOLEAN;
      BEGIN
        SELECT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) INTO has_bypass; -- #1385: superuser + inherited-role BYPASSRLS, not just the role's own rolbypassrls
        IF has_bypass THEN
          ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
          ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
          ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
        ELSE
          RAISE WARNING 'v32: role % lacks BYPASSRLS — skipping RLS on OAuth tables. Grant it (as postgres or a managed-Postgres master user): ALTER ROLE % BYPASSRLS; then re-run to harden.', current_user, current_user;
        END IF;
      END $$;
    `,
};
