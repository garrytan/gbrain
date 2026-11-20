/**
 * Access-grant reads: one SQL implementation for both engines (rust/docs/store/access-grants.md).
 *
 * The receipt operations (ops/persistence.ts) and shared-skill membership (shared-skills/membership-authority.ts)
 * re-read the caller's current grant before they answer: the OAuth client row, the access token row or the local
 * writer row, then the shared-skill serving epoch. (The trust policy generation the proactive caches read is in
 * trust-withdrawals.ts.) The statements are the text the callers sent through `executeRaw` before. Each read applies its
 * revocation filter in SQL where the caller did, and the callers keep every check on the row they get back.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { TOKEN_GRANT_COLUMNS_SQL, tokenGrantColumnList, type TokenGrantRow } from '../grants/model.ts';
import type { LocalGrant } from './persistence-state.ts';

/** The OAuth client columns a receipt operation re-checks (ops/persistence.ts receiptAccess). */
export interface ReceiptClientGrant { scope: string; deleted_at: unknown; allowed_operations: string[] | null; source_id: string | null; bound_slug_prefixes: string[] | null }
/** The access token columns a receipt operation re-checks. */
export interface ReceiptTokenGrant { scopes: unknown; revoked_at: unknown }
/** The live OAuth client columns membership authority reads (a deleted client has no row). */
export interface MemberClientGrant { scope: string; source_id: string; federated_read: string[] | null; allowed_operations: string[] | null; grant_revision: number }
/** The access token grant columns membership authority reads (those this brain's access_tokens has). */
export type MemberTokenGrant = TokenGrantRow;
/** The local writer columns membership authority reads. */
export interface MemberLocalWriterGrant { grant_ceiling: LocalGrant; revoked_at: unknown }

const lockSuffix = (lock: boolean | undefined) => lock ? trustedSql(' FOR SHARE') : sqlFragment``;

/** An OAuth client's receipt grant, deleted or not (the caller refuses a deleted one); `lock` reads it `FOR SHARE`. */
export async function readOAuthClientReceiptGrant(exec: LegacyUnscopedRead, clientId: string, opts: { lock?: boolean } = {}): Promise<ReceiptClientGrant | undefined> {
  const { rows: [row] } = await exec.run<ReceiptClientGrant>(
    sqlFragment`SELECT scope,deleted_at,allowed_operations,source_id,bound_slug_prefixes FROM oauth_clients WHERE client_id=${clientId}${lockSuffix(opts.lock)}`);
  return row;
}

/** An access token's receipt grant, revoked or not (the caller refuses a revoked one); `lock` reads it `FOR SHARE`. */
export async function readAccessTokenReceiptGrant(exec: LegacyUnscopedRead, tokenId: string, opts: { lock?: boolean } = {}): Promise<ReceiptTokenGrant | undefined> {
  const { rows: [row] } = await exec.run<ReceiptTokenGrant>(
    sqlFragment`SELECT scopes,revoked_at FROM access_tokens WHERE id=${tokenId}${lockSuffix(opts.lock)}`);
  return row;
}

/**
 * A live OAuth client's membership grant, `FOR SHARE` unless `lock` is false (a read-only catalog transaction, where
 * Postgres refuses a row lock); undefined for a missing or deleted client.
 */
export async function readOAuthClientMemberGrant(exec: LegacyUnscopedRead, clientId: string, opts: { lock?: boolean } = {}): Promise<MemberClientGrant | undefined> {
  const sql = opts.lock === false
    ? 'SELECT scope,source_id,federated_read,allowed_operations,grant_revision FROM oauth_clients WHERE client_id=$1 AND deleted_at IS NULL'
    : 'SELECT scope,source_id,federated_read,allowed_operations,grant_revision FROM oauth_clients WHERE client_id=$1 AND deleted_at IS NULL FOR SHARE';
  const [row] = await exec.executeRaw<MemberClientGrant>(sql, [clientId]);
  return row;
}

/**
 * A live access token's membership grant, `FOR SHARE` unless `lock` is false; undefined for a missing or revoked
 * token. The select list is the grant columns this brain's access_tokens has (grants/model.ts tokenGrantRowSelect),
 * read first.
 */
export async function readAccessTokenMemberGrant(exec: LegacyUnscopedRead, tokenId: string, opts: { lock?: boolean } = {}): Promise<MemberTokenGrant | undefined> {
  const present = new Set((await exec.executeRaw<{ attname: string }>(TOKEN_GRANT_COLUMNS_SQL)).map(c => c.attname));
  const { rows: [row] } = await exec.run<MemberTokenGrant>(
    sqlFragment`SELECT ${trustedSql(tokenGrantColumnList(present))} FROM access_tokens WHERE id=${tokenId} AND revoked_at IS NULL${lockSuffix(opts.lock !== false)}`);
  return row;
}

/** A local writer's membership grant, `FOR SHARE`, revoked or not (the caller refuses a revoked one). */
export async function readLocalWriterMemberGrant(exec: LegacyUnscopedRead, id: string): Promise<MemberLocalWriterGrant | undefined> {
  const [row] = await exec.executeRaw<MemberLocalWriterGrant>('SELECT grant_ceiling,revoked_at FROM persistence_local_writers WHERE id=$1::uuid FOR SHARE', [id]);
  return row;
}

/** The shared-skill serving epoch, or null when the brain has no `shared_skill_state` row (membership then denies). */
export async function readSharedSkillServingEpoch(exec: LegacyUnscopedRead): Promise<string | null> {
  const [state] = await exec.executeRaw<{ serving_epoch: string }>('SELECT serving_epoch FROM shared_skill_state WHERE singleton=1');
  return state ? state.serving_epoch : null;
}
