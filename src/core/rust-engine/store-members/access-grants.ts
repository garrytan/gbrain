/**
 * The access-grant reads (engine-sql/access-grants.ts) and the request-id lookup of the receipt operations, on the
 * Rust store (rust/docs/store/persistence.md, "Access grants").
 *
 * The store keeps no OAuth clients and no access tokens, so their grant reads refuse with engine_capability_missing
 * rather than answer "no row": a caller never mistakes an engine that cannot read a grant for a grant that is gone.
 * The local writer grant comes from the writer registration the store keeps; the store runs one write transaction at
 * a time, so the FOR SHARE the SQL engines take changes nothing here. The store's shared-skill state keeps only the
 * catalog token secret (shared-skill-members.ts); its serving epoch is a UUID derived from the brain id, fixed for the life of the brain (the store has no restore
 * that would rotate it), and null when the brain has no id, so membership denies. The trust generation read lives in
 * trust-withdrawals.ts.
 */
import { createHash } from 'node:crypto';
import type { MemberClientGrant, MemberLocalWriterGrant, MemberTokenGrant, ReceiptClientGrant, ReceiptTokenGrant } from '../../engine-sql/access-grants.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import { requestRow } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { readLocalWriterRow } from './persistence.ts';
import { readPersistenceBrainId } from './persistence-identity.ts';

const NO_CLIENTS = 'the store keeps no OAuth clients';
const NO_TOKENS = 'the store keeps no access tokens';

export const readOAuthClientReceiptGrant: StoreMember<[clientId: string, opts?: { lock?: boolean }], ReceiptClientGrant | undefined> =
  async () => refuseMember('readOAuthClientReceiptGrant', NO_CLIENTS);

export const readAccessTokenReceiptGrant: StoreMember<[tokenId: string, opts?: { lock?: boolean }], ReceiptTokenGrant | undefined> =
  async () => refuseMember('readAccessTokenReceiptGrant', NO_TOKENS);

export const readOAuthClientMemberGrant: StoreMember<[clientId: string], MemberClientGrant | undefined> =
  async () => refuseMember('readOAuthClientMemberGrant', NO_CLIENTS);

export const readAccessTokenMemberGrant: StoreMember<[tokenId: string], MemberTokenGrant | undefined> =
  async () => refuseMember('readAccessTokenMemberGrant', NO_TOKENS);

/** The local writer's grant ceiling and revoked_at, revoked or not (the caller refuses a revoked writer). */
export const readLocalWriterMemberGrant: StoreMember<[id: string], MemberLocalWriterGrant | undefined> = async (brain, id) => {
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
  const rows = await storeCall({ member: 'readWriteRequestsByRequestId' }, () => brain.listWriteRequestsByRequestId(requestId)) as unknown[];
  return rows.map(row => requestRow<WriteRequest>(row)).filter((row): row is WriteRequest => row !== null);
};
