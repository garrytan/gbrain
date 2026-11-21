/**
 * The bearer checks (oauth-provider.ts verifyAccessToken, mcp/http-transport.ts validateToken, grants/legacy-token.ts
 * touchTokenLastUsed): the OAuth token read, the legacy token read by hash and the debounced last-use stamp. SQL once for
 * both engines, under the names the old line gave them (row 32d-1). The Rust store keeps access tokens
 * (rust/docs/store/access-tokens.md) and no OAuth tokens yet (row 32d-2), so it finds no OAuth token row. The legacy
 * read's `SELECT *` row holds the hash the caller passed.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * The bearer checks (oauth-provider.ts verifyAccessToken, mcp/http-transport.ts validateToken, grants/legacy-token.ts
 * touchTokenLastUsed), byte for byte as the SqlQuery tag sent them at d51679a5fd. `oauth_rungs` is the OAuth token read
 * and its degrade ladder for brains missing newer `oauth_clients` columns, widest first; the caller walks it.
 */
export const BEARER_SQL = {
  oauth_rungs: [
    `
        SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes, to_jsonb(t)->>'grant_type' AS token_grant,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
               c.source_id, c.federated_read, c.bound_slug_prefixes,
               c.surface, c.surface_set_by
        FROM oauth_tokens t
        LEFT JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
      `,
    `
          SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
                 c.source_id, c.federated_read, c.bound_slug_prefixes
          FROM oauth_tokens t
          LEFT JOIN oauth_clients c ON c.client_id = t.client_id
          WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
        `,
    `
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
                   c.source_id, c.federated_read
            FROM oauth_tokens t
            LEFT JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
          `,
    `
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources, c.source_id
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
            `,
    `
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
            `
  ],
  token_by_hash_provider: `
      SELECT * FROM access_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL
    `,
  token_by_hash_transport: `
        SELECT * FROM access_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL
      `,
  touch_unified: `UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = $1::uuid AND source_grant IS NOT NULL
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`,
  touch_legacy: `UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = $1::uuid
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`,
} as const;

/** Which rung of the OAuth token read's degrade ladder (0 is the full projection). */
export type OauthTokenRung = 0 | 1 | 2 | 3 | 4;
/** Which bearer check reads the token by hash (the two texts differ only in whitespace). */
export type TokenByHashCaller = 'provider' | 'transport';

/** The OAuth access token with this hash joined to its live client, at one rung of the degrade ladder. */
export async function readOauthAccessTokenRows(tx: Raw, hash: string, rung: OauthTokenRung): Promise<Record<string, unknown>[]> {
  return tx.executeRaw<Record<string, unknown>>(BEARER_SQL.oauth_rungs[rung], [hash]);
}

/** The whole row (`SELECT *`, every schema generation) of the token not revoked with this hash, or null. */
export async function readActiveAccessTokenByHash(tx: Raw, hash: string, caller: TokenByHashCaller): Promise<Record<string, unknown> | null> {
  const [row] = await tx.executeRaw<Record<string, unknown>>(caller === 'transport' ? BEARER_SQL.token_by_hash_transport : BEARER_SQL.token_by_hash_provider, [hash]);
  return row ?? null;
}

/**
 * The debounced `last_used_at` stamp (once per token per 60 s, SKIP LOCKED). `unified` is whether the row the caller read
 * has the `source_grant` column: then a row still on the legacy shape is left to its first-read conversion.
 */
export async function touchAccessTokenLastUsed(tx: Raw, id: string, unified: boolean): Promise<void> {
  await tx.executeRaw(unified ? BEARER_SQL.touch_unified : BEARER_SQL.touch_legacy, [id]);
}
