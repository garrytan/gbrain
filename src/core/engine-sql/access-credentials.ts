/**
 * Credential revokes: the access-token revoke and the OAuth client delete that `gbrain auth revoke`, `auth revoke --id`,
 * `auth revoke-client` and token-mint.ts revokeLegacyTokenById ran over the scalar-only SqlQuery. SQL once for both
 * engines. Each text is the caller's statement byte for byte (auth.ts at 2156121155); the id revoke is the one
 * `auth revoke --id` sent, which token-mint.ts now shares. The Rust store keeps no credentials (no `access_tokens`,
 * no `oauth_clients`), so a Rust brain revokes and deletes nothing and its callers report the credential as not found.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

export const CREDENTIAL_REVOKE_SQL = {
  tokens_by_name: `
      UPDATE access_tokens SET revoked_at = now()
      WHERE name = $1 AND revoked_at IS NULL
      RETURNING id
    `,
  token_by_id: `
      UPDATE access_tokens SET revoked_at = now()
      WHERE id = $1::uuid AND revoked_at IS NULL
      RETURNING name
    `,
  client: `
        DELETE FROM oauth_clients WHERE client_id = $1
        RETURNING client_id, client_name
      `,
} as const;

/** Revoke every active access token named `name` (names are not unique); the ids of the tokens it revoked. */
export async function revokeAccessTokensNamed(tx: Raw, name: string): Promise<string[]> {
  const rows = await tx.executeRaw<{ id: string }>(CREDENTIAL_REVOKE_SQL.tokens_by_name, [name]);
  return rows.map(r => String(r.id));
}

/** Revoke the active access token with this id (a UUID); its name, or null when no active token has that id. */
export async function revokeAccessToken(tx: Raw, id: string): Promise<string | null> {
  const [row] = await tx.executeRaw<{ name: string }>(CREDENTIAL_REVOKE_SQL.token_by_id, [id]);
  return row ? String(row.name) : null;
}

/** A deleted OAuth client. */
export interface DeletedOAuthClient { client_id: string; client_name: string }

/**
 * Delete the OAuth client with this id; its tokens and codes go with it (ON DELETE CASCADE). The deleted client, or
 * null when no client has that id.
 */
export async function deleteOAuthClient(tx: Raw, clientId: string): Promise<DeletedOAuthClient | null> {
  const [row] = await tx.executeRaw<DeletedOAuthClient>(CREDENTIAL_REVOKE_SQL.client, [clientId]);
  return row ? { client_id: String(row.client_id), client_name: String(row.client_name) } : null;
}
