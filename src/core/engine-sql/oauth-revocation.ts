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
  delete_client: 'DELETE FROM oauth_clients WHERE client_id = $1',
  revision_revoke: 'UPDATE oauth_clients SET deleted_at = COALESCE(deleted_at, now()), grant_revision = $1 WHERE client_id = $2',
  revision_only: 'UPDATE oauth_clients SET grant_revision = $1 WHERE client_id = $2',
  read_shared: 'UPDATE oauth_clients SET read_shared_revision = $2 WHERE client_id = $1',
  grant_audit: `INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
      VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb)`,
} as const;

/** The audit row a lifecycle action appends: the grant documents are JSON text (the statement casts them `::text::jsonb`). */
export interface OauthGrantAuditInsert {
  client_id: string;
  actor: string;
  action: string;
  revision: number;
  before_grant: string;
  after_grant: string;
}

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

/** Delete the client row itself (the lifecycle `delete`); its tokens and codes are separate deletes. */
export async function deleteOauthClientRow(tx: Raw, clientId: string): Promise<void> {
  await tx.executeRaw(OAUTH_REVOCATION_SQL.delete_client, [clientId]);
}

/** Set the client's grant revision; `revoke` also stamps `deleted_at` when the client is not already revoked. */
export async function setOauthClientRevision(tx: Raw, clientId: string, revision: number, revoke: boolean): Promise<void> {
  await tx.executeRaw(revoke ? OAUTH_REVOCATION_SQL.revision_revoke : OAUTH_REVOCATION_SQL.revision_only, [revision, clientId]);
}

/**
 * GST-2898: stamp the client's read-shared switch at `revision` (the switch is on while it equals grant_revision), or
 * clear it with null. The grant writers (grants/service.ts stampReadShared) and invalidate-tokens (grants/lifecycle.ts) run it.
 */
export async function setOauthClientReadSharedRevision(tx: Raw, clientId: string, revision: number | null): Promise<void> {
  await tx.executeRaw(OAUTH_REVOCATION_SQL.read_shared, [clientId, revision]);
}

/** Append one row to the grant audit. */
export async function insertOauthGrantAudit(tx: Raw, row: OauthGrantAuditInsert): Promise<void> {
  await tx.executeRaw(OAUTH_REVOCATION_SQL.grant_audit, [row.client_id, row.actor, row.action, row.revision, row.before_grant, row.after_grant]);
}
