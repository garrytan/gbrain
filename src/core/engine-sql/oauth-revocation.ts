/**
 * The revoke writes over `oauth_tokens`, `oauth_codes` and `oauth_clients` that `OAuthGrants.revokeToken` and
 * `revokeClient` make (src/core/oauth-grants.ts): one SQL implementation for PGLite and Postgres, served by the Rust store
 * as the same members (rust/docs/store/oauth-tokens.md, oauth-clients.md).
 *
 * Each text is the statement its caller sent through the `SqlQuery` tag before, byte for byte; a template `${}` is the
 * next `$n` (test/engine-sql-caller-raw-sql-pins.test.ts pins the text). Run them inside the caller's transaction
 * (`engine.transaction(tx => ...)`): the grant paths lock the client row first, and a write on another connection would
 * wait on the foreign key to that row.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

export const OAUTH_REVOCATION_SQL = {
  token_by_hash: 'DELETE FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2',
  soft_delete_client: 'UPDATE oauth_clients SET deleted_at = now() WHERE client_id = $1',
  client_codes: 'DELETE FROM oauth_codes WHERE client_id = $1',
  client_tokens: 'DELETE FROM oauth_tokens WHERE client_id = $1',
} as const;

/** Delete the token with this hash when this client owns it (a revoke naming the wrong client deletes nothing). */
export async function deleteOauthTokenByHash(tx: Raw, hash: string, clientId: string): Promise<void> {
  await tx.executeRaw(OAUTH_REVOCATION_SQL.token_by_hash, [hash, clientId]);
}

/** Stamp the client `deleted_at` now, whatever it held before; its tokens and codes are separate deletes. */
export async function softDeleteOauthClient(tx: Raw, clientId: string): Promise<void> {
  await tx.executeRaw(OAUTH_REVOCATION_SQL.soft_delete_client, [clientId]);
}

/** Delete every authorization code of the client. */
export async function deleteOauthClientCodes(tx: Raw, clientId: string): Promise<void> {
  await tx.executeRaw(OAUTH_REVOCATION_SQL.client_codes, [clientId]);
}

/** Delete every OAuth token (access and refresh) of the client. */
export async function deleteOauthClientTokens(tx: Raw, clientId: string): Promise<void> {
  await tx.executeRaw(OAUTH_REVOCATION_SQL.client_tokens, [clientId]);
}
