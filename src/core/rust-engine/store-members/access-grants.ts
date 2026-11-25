/**
 * The access-grant reads (engine-sql/access-grants.ts) and the request-id lookup of the receipt operations, on the
 * Rust store (rust/docs/store/persistence.md, "Access grants").
 *
 * The OAuth client and access token grant reads answer from the store's client and token rows (oauth-clients.md,
 * access-tokens.md): a receipt read returns the row deleted or revoked (the caller refuses it), a membership read none.
 * The local writer grant comes from the writer registration the store keeps; the store runs one write transaction at
 * a time, so the FOR SHARE the SQL engines take is skipped while explicit transactions hold the writer
 * (`serialized_transactions`); the members that take a `lock` option assert it. The store's shared-skill state keeps only the
 * catalog token secret (shared-skill-members.ts); its serving epoch is a UUID derived from the brain id, fixed for the
 * life of the brain (the store has no restore that would rotate it), and null when the brain has no id, so membership
 * denies. The trust generation read is trust-withdrawals.ts's readTrustGeneration.
 */
import { createHash } from 'node:crypto';
import type { MemberClientGrant, MemberLocalWriterGrant, MemberTokenGrant, ReceiptClientGrant, ReceiptTokenGrant } from '../../engine-sql/access-grants.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import { requestRow } from '../store-codec.ts';
import { TOKEN_GRANT_ROW_COLUMNS } from '../../grants/model.ts';
import { assertStoreSerializedTransactions, storeCall, type StoreMember } from './common.ts';
import { readOauthClient } from './jobs-oauth-clients.ts';
import { readAccessTokenWriteGrant, readLocalWriterRow } from './persistence.ts';
import { readPersistenceBrainId } from './persistence-identity.ts';

/** An OAuth client's receipt grant, deleted or not. `lock` skips the FOR SHARE while explicit transactions hold the writer (`serialized_transactions`); it asserts that. */
export const readOAuthClientReceiptGrant: StoreMember<[clientId: string, opts?: { lock?: boolean }], ReceiptClientGrant | undefined> = async (brain, clientId, opts) => {
  if (opts?.lock) assertStoreSerializedTransactions(brain, 'readOAuthClientReceiptGrant');
  const row = await readOauthClient(brain, clientId);
  return row ? { scope: row.scope as string, deleted_at: row.deleted_at, allowed_operations: row.allowed_operations, source_id: row.source_id, bound_slug_prefixes: row.bound_slug_prefixes } : undefined;
};

/** An access token's receipt grant, revoked or not; `lock` as in readOAuthClientReceiptGrant. A token id that is not a UUID is refused as Postgres refuses it. */
export const readAccessTokenReceiptGrant: StoreMember<[tokenId: string, opts?: { lock?: boolean }], ReceiptTokenGrant | undefined> = async (brain, tokenId, opts) => {
  if (opts?.lock) assertStoreSerializedTransactions(brain, 'readAccessTokenReceiptGrant');
  const row = await readAccessTokenWriteGrant(brain, tokenId);
  return row ? { scopes: row.scopes, revoked_at: row.revoked_at } : undefined;
};

/** A live OAuth client's membership grant; `lock` as in readOAuthClientReceiptGrant. Undefined for a missing or deleted client. */
export const readOAuthClientMemberGrant: StoreMember<[clientId: string, opts?: { lock?: boolean }], MemberClientGrant | undefined> = async (brain, clientId, opts) => {
  if (opts?.lock) assertStoreSerializedTransactions(brain, 'readOAuthClientMemberGrant');
  const row = await readOauthClient(brain, clientId);
  if (!row || row.deleted_at != null) return undefined;
  return { scope: row.scope as string, source_id: row.source_id as string, federated_read: row.federated_read, allowed_operations: row.allowed_operations, grant_revision: row.grant_revision };
};

/** A live access token's membership grant (the grant columns the store keeps: all of them); `lock` as in readOAuthClientReceiptGrant. Undefined for a missing or revoked token. */
export const readAccessTokenMemberGrant: StoreMember<[tokenId: string, opts?: { lock?: boolean }], MemberTokenGrant | undefined> = async (brain, tokenId, opts) => {
  if (opts?.lock) assertStoreSerializedTransactions(brain, 'readAccessTokenMemberGrant');
  const row = await readAccessTokenWriteGrant(brain, tokenId);
  if (!row || row.revoked_at != null) return undefined;
  return Object.fromEntries(TOKEN_GRANT_ROW_COLUMNS.map(c => [c, (row as Record<string, unknown>)[c]])) as MemberTokenGrant;
};

/** The local writer's grant ceiling and revoked_at, revoked or not (the caller refuses a revoked writer). */
export const readLocalWriterMemberGrant: StoreMember<[id: string], MemberLocalWriterGrant | undefined> = async (brain, id) => {
  // The SQL reads the row FOR SHARE; skipped while explicit transactions hold the writer (`serialized_transactions`).
  assertStoreSerializedTransactions(brain, 'readLocalWriterMemberGrant');
  const row = await readLocalWriterRow(brain, id);
  return row ? { grant_ceiling: row.grant_ceiling, revoked_at: row.revoked_at } : undefined;
};

/** A UUID derived from the brain id, or null when the brain has none. */
export const readSharedSkillServingEpoch: StoreMember<[], string | null> = async (brain) => {
  const brainId = await readPersistenceBrainId(brain);
  if (brainId === null) return null;
  const h = createHash('sha256').update(`gbrain-shared-skill-serving-epoch\0${brainId}`).digest('hex');
  // Version 4, RFC 4122 variant bits, so it reads as the gen_random_uuid() value Postgres and PGLite hold.
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** At most two request rows with this request id, from any principal. */
export const readWriteRequestsByRequestId: StoreMember<[requestId: string], WriteRequest[]> = async (brain, requestId) => {
  const rows = await storeCall({ member: 'readWriteRequestsByRequestId' }, () => brain.readWriteRequestsByRequestId(requestId)) as unknown[];
  return rows.map(row => requestRow<WriteRequest>(row)).filter((row): row is WriteRequest => row !== null);
};
