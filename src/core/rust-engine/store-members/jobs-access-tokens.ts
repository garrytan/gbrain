/**
 * The `access_tokens` members (engine-sql/access-tokens.ts), served by the store (rust/docs/store/access-tokens.md). A time crosses the
 * binding as ISO text. The store refuses a write that breaks a constraint of the table with `constraint_violation`;
 * `refusing` gives it the SQLSTATE and constraint name PGLite and Postgres raise, so a caller branches on one error shape.
 * The list, the revokes, the active-token grant read and the liveness check are the credential members of
 * engine-sql/access-credentials.ts, and so are the bearer check reads; no store call returns a token hash.
 */
import type { AccessTokenInsert, ActiveAccessTokenRow } from '../../engine-sql/access-tokens.ts';
import { normalizeAccessTokenListRow, type AccessTokenListRow, type ActiveTokenGrantField, type OauthTokenRung, type TokenByHashCaller } from '../../engine-sql/access-credentials.ts';
import { storeCall, type StoreMember } from './common.ts';
import { refusing } from './constraint-errors.ts';

export const insertAccessToken: StoreMember<[row: AccessTokenInsert], { id: string }> = (brain, row) =>
  refusing('insertAccessToken', () => brain.insertAccessToken({ ...row, revoked_at: row.revoked_at?.toISOString() ?? null })) as Promise<{ id: string }>;

export const findActiveAccessTokens: StoreMember<[target: string], ActiveAccessTokenRow[]> = (brain, target) =>
  storeCall({ member: 'findActiveAccessTokens' }, () => brain.findActiveAccessTokens(target)) as Promise<ActiveAccessTokenRow[]>;

export const setAccessTokenMinTrust: StoreMember<[id: string, tier: string | null], void> = async (brain, id, tier) => {
  await refusing('setAccessTokenMinTrust', () => brain.setAccessTokenMinTrust(id, tier));
};

export const listAccessTokens: StoreMember<[], AccessTokenListRow[]> = async (brain) => {
  const raw = await storeCall({ member: 'listAccessTokens' }, () => brain.listAccessTokens()) as Record<string, unknown>[];
  return raw.map(normalizeAccessTokenListRow);
};

/** The store keeps `private_pages` at its default (`none`) and the stored `permissions`; null when no active token has the id. */
export const readActiveAccessTokenGrant: StoreMember<[id: string, field: ActiveTokenGrantField], { value: unknown } | null> = async (brain, id, field) => {
  const raw = await storeCall({ member: 'readActiveAccessTokenGrant' }, () => brain.readActiveAccessTokenGrant(id)) as Record<string, unknown> | null;
  return raw ? { value: raw[field] } : null;
};

export const accessTokenLive: StoreMember<[id: string], boolean> = (brain, id) =>
  storeCall({ member: 'accessTokenLive' }, () => brain.accessTokenLive(id)) as Promise<boolean>;

export const revokeAccessTokensNamed: StoreMember<[name: string], string[]> = (brain, name) =>
  refusing('revokeAccessTokensNamed', () => brain.revokeAccessTokensNamed(name)) as Promise<string[]>;

export const revokeAccessToken: StoreMember<[id: string], string | null> = (brain, id) =>
  refusing('revokeAccessToken', () => brain.revokeAccessToken(id)) as Promise<string | null>;

/** The store keeps no OAuth tokens (rust/docs/store/access-tokens.md), so the OAuth rung of the bearer check finds none. */
export const readOauthAccessTokenRows: StoreMember<[hash: string, rung: OauthTokenRung], Record<string, unknown>[]> = async () => [];

/**
 * The bearer check's `SELECT *` row: the stored columns, the table defaults for the ones the store does not keep, and
 * `created_at` as a Date as PGLite and Postgres return it. The store's row leaves out the hash; the caller passed it.
 */
export const readActiveAccessTokenByHash: StoreMember<[hash: string, caller: TokenByHashCaller], Record<string, unknown> | null> = async (brain, hash) => {
  const raw = await storeCall({ member: 'readActiveAccessTokenByHash' }, () => brain.readActiveAccessTokenByHash(hash)) as Record<string, unknown> | null;
  return raw ? { ...raw, token_hash: hash, created_at: new Date(String(raw.created_at)) } : null;
};

/** The store keeps no `last_used_at`, so the stamp writes nothing. */
export const touchAccessTokenLastUsed: StoreMember<[id: string, unified: boolean], void> = async () => {};

/** The store keeps no OAuth tokens or codes (rust/docs/store/access-tokens.md), so the expired-credential sweep deletes none. */
export const deleteExpiredOauthCredentials: StoreMember<[nowEpochSeconds: number], number> = async () => 0;
