/**
 * The `access_tokens` members (engine-sql/access-tokens.ts), served by the store (rust/docs/store/access-tokens.md). A time crosses the
 * binding as ISO text. The store refuses a write that breaks a constraint of the table with `constraint_violation`;
 * `refusing` gives it the SQLSTATE and constraint name PGLite and Postgres raise, so a caller branches on one error shape.
 * The list, the revokes, the active-token grant read and the liveness check are the credential members of
 * engine-sql/access-credentials.ts, and so are the bearer check reads and the OAuth token insert (the store keeps the table:
 * rust/docs/store/oauth-tokens.md); no store call here returns a token hash (doctor's whole-row read does: doctor-acc.ts).
 */
import type { AccessTokenInsert, AccessTokenScopeRow, ActiveAccessTokenRow } from '../../engine-sql/access-tokens.ts';
import { normalizeOauthClientRow, type OauthClientRow } from '../../engine-sql/oauth-clients.ts';
import { normalizeAccessTokenListRow, type AccessTokenGrantWrite, type AccessTokenListRow, type AccessTokenPrivateAxis, type ActiveTokenGrantField, type LegacyTokenGrantColumns, type OauthTokenInsert, type OauthTokenRung, type TokenByHashCaller, type ActiveTokenTarget, normalizeOauthCodeRow, type OauthCodeInsert, type OauthCodeRow, normalizeOauthTokenRow, type OauthTokenRow } from '../../engine-sql/access-credentials.ts';
import { withDates, uuidText } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';
import { refusing } from './constraint-errors.ts';

export const insertAccessToken: StoreMember<[row: AccessTokenInsert], { id: string }> = (brain, row) =>
  refusing('insertAccessToken', () => brain.insertAccessToken({ ...row, revoked_at: row.revoked_at?.toISOString() ?? null, created_at: row.created_at?.toISOString() ?? null })) as Promise<{ id: string }>;

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

/** The bearer check's OAuth token read: the store's `[row]` (the bearer projection at this rung) or `[]`; an expired token is returned, the caller refuses it. */
export const readOauthAccessTokenRows: StoreMember<[hash: string, rung: OauthTokenRung], Record<string, unknown>[]> = (brain, hash, rung) =>
  storeCall({ member: 'readOauthAccessTokenRows' }, () => brain.readOauthAccessTokenRows(hash, rung)) as Promise<Record<string, unknown>[]>;

/**
 * The bearer check's `SELECT *` row: the stored columns, the table defaults for the ones the store does not keep, and
 * `created_at` and `last_used_at` as Dates as PGLite and Postgres return them. The store's row leaves out the hash; the caller passed it.
 */
export const readActiveAccessTokenByHash: StoreMember<[hash: string, caller: TokenByHashCaller], Record<string, unknown> | null> = async (brain, hash) => {
  const raw = await storeCall({ member: 'readActiveAccessTokenByHash' }, () => brain.readActiveAccessTokenByHash(hash)) as Record<string, unknown> | null;
  return raw ? { ...raw, token_hash: hash, created_at: new Date(String(raw.created_at)), last_used_at: raw.last_used_at == null ? null : new Date(String(raw.last_used_at)) } : null;
};

/**
 * `auth rescope`'s rows: the stored columns of the active tokens one id or an exact name names, oldest first, the
 * timestamps as Dates. The store runs one write at a time, so it takes no lock. An id that is not a UUID is refused
 * with Postgres's text; the rows leave out the hash, as every store token row does.
 */
export const lockActiveAccessTokens: StoreMember<[target: ActiveTokenTarget], Record<string, unknown>[]> = async (brain, target) => {
  const [id, name] = 'id' in target ? [uuidText(target.id), null] : [null, target.name];
  const rows = await storeCall({ member: 'lockActiveAccessTokens' }, () => brain.lockActiveAccessTokens(id, name)) as Record<string, unknown>[];
  return rows.map(row => withDates(row, ['created_at', 'last_used_at', 'revoked_at', 'reads_unscoped']));
};

/** The debounced `last_used_at` stamp (once per token per 60 s by the store clock; `unified` leaves a row with no `source_grant` alone). */
export const touchAccessTokenLastUsed: StoreMember<[id: string, unified: boolean], void> = async (brain, id, unified) => {
  await storeCall({ member: 'touchAccessTokenLastUsed' }, () => brain.touchAccessTokenLastUsed(id, unified));
};

/** One OAuth token; a repeated hash and a client with no row are refused as 23505 and 23503, as the SQL engines refuse them. */
export const insertOauthToken: StoreMember<[row: OauthTokenInsert], void> = async (brain, row) => {
  await refusing('insertOauthToken', () => brain.insertOauthToken({ ...row, scopes: [...row.scopes] }));
};

/**
 * The expired-credential sweep: the store's OAuth tokens (any token type; a token with no expiry stays) and codes that
 * expired before `nowEpochSeconds`, in one write; the count of both, as the two DELETEs of the SQL engines count.
 */
export const deleteExpiredOauthCredentials: StoreMember<[nowEpochSeconds: number], number> = async (brain, now) =>
  Number(await storeCall({ member: 'deleteExpiredOauthCredentials' }, () => brain.deleteExpiredOauthCredentials(now)));

/** Every OAuth token and code expires (`expires_at = 0`), in one write. */
export const expireAllOauthCredentials: StoreMember<[], void> = async (brain) => {
  await storeCall({ member: 'expireAllOauthCredentials' }, () => brain.expireAllOauthCredentials());
};

/** One authorization code; a repeated hash and a client with no row are refused as 23505 and 23503, as the SQL engines refuse them. */
export const insertOauthCode: StoreMember<[row: OauthCodeInsert], void> = async (brain, row) => {
  await refusing('insertOauthCode', () => brain.insertOauthCode({ ...row, scopes: [...row.scopes] }));
};

/** The code of this hash and client, `created_at` a Date and `expires_at` a number as PGLite and Postgres return them; or null. */
export const readOauthCodeForUpdate: StoreMember<[codeHash: string, clientId: string], OauthCodeRow | null> = async (brain, codeHash, clientId) => {
  const raw = await storeCall({ member: 'readOauthCodeForUpdate' }, () => brain.readOauthCodeForUpdate(codeHash, clientId)) as Record<string, unknown> | null;
  return raw ? normalizeOauthCodeRow(raw) : null;
};

export const deleteOauthCode: StoreMember<[codeHash: string, clientId: string], void> = async (brain, codeHash, clientId) => {
  await storeCall({ member: 'deleteOauthCode' }, () => brain.deleteOauthCode(codeHash, clientId));
};

/** The refresh token of this hash and client, `created_at` a Date and `expires_at` a number as PGLite and Postgres return them; or null. */
export const readOauthRefreshTokenForUpdate: StoreMember<[tokenHash: string, clientId: string], OauthTokenRow | null> = async (brain, tokenHash, clientId) => {
  const raw = await storeCall({ member: 'readOauthRefreshTokenForUpdate' }, () => brain.readOauthRefreshTokenForUpdate(tokenHash, clientId)) as Record<string, unknown> | null;
  return raw ? normalizeOauthTokenRow(raw) : null;
};

export const deleteOauthRefreshToken: StoreMember<[tokenHash: string, clientId: string], void> = async (brain, tokenHash, clientId) => {
  await storeCall({ member: 'deleteOauthRefreshToken' }, () => brain.deleteOauthRefreshToken(tokenHash, clientId));
};

export const readOauthCodeChallenge: StoreMember<[codeHash: string, clientId: string, nowEpochSeconds: number], string | null> = async (brain, codeHash, clientId, now) =>
  (await storeCall({ member: 'readOauthCodeChallenge' }, () => brain.readOauthCodeChallenge(codeHash, clientId, now)) as string | null) ?? null;

/** The tokens of one grant in one store write (the client row is read in that write): all land or none, refused as 23505 / 23503. */
export const issueOauthTokens: StoreMember<[rows: readonly OauthTokenInsert[]], void> = async (brain, rows) => {
  await refusing('issueOauthTokens', () => brain.issueOauthTokens(rows.map(row => ({ ...row, scopes: [...row.scopes] }))));
};

/** OAuth access tokens expiring from `from` to `to` (epoch seconds, inclusive), or after `from` (exclusive) when `to` is null. */
export const countOauthAccessTokens: StoreMember<[from: number, to: number | null], number> = async (brain, from, to) =>
  Number(await storeCall({ member: 'countOauthAccessTokens' }, () => brain.countOauthAccessTokens(from, to)));

/**
 * The first-read conversion of a token still on the legacy shape: its grant columns, one more grant revision and its
 * first use, or null when no token has the id or it already has a grant. The row leaves out `token_hash`, as every
 * store token row does.
 */
export const convertLegacyAccessTokenGrant: StoreMember<[id: string, columns: LegacyTokenGrantColumns], Record<string, unknown> | null> =
  async (brain, id, columns) => {
    const raw = await storeCall({ member: 'convertLegacyAccessTokenGrant' }, () => brain.convertLegacyAccessTokenGrant(id, columns)) as Record<string, unknown> | null;
    return raw ? { ...raw, created_at: new Date(String(raw.created_at)) } : null;
  };

/**
 * `auth rescope`'s grant write: the five grant columns, the scopes when given, the `permissions` mirror and one more
 * grant revision; the new revision, or null when no token has the id. A `source_grant` outside the list is refused as
 * 23514 with the constraint name, and an id that is not a UUID with Postgres's text.
 */
export const writeAccessTokenGrant: StoreMember<[id: string, write: AccessTokenGrantWrite], number | null> = async (brain, id, write) => {
  const uuid = uuidText(id);
  const revision = await refusing('writeAccessTokenGrant', () => brain.writeAccessTokenGrant(uuid, write.columns, write.scopes, write.permissions)) as number | null;
  return revision === null ? null : Number(revision);
};

/** One private grant column of a token; a value other than `none` and `granted_sources` is refused as 23514 with the constraint name. */
export const writeAccessTokenPrivateGrant: StoreMember<[id: string, axis: AccessTokenPrivateAxis, value: string], void> = async (brain, id, axis, value) => {
  const uuid = uuidText(id);
  await refusing('writeAccessTokenPrivateGrant', () => brain.writeAccessTokenPrivateGrant(uuid, axis, value));
};

/** GST-2898: token `id`'s read-shared stamp (engine-sql/access-credentials.ts); a null revision clears the switch. */
export const setAccessTokenReadSharedRevision: StoreMember<[id: string, revision: number | null], void> = async (brain, id, revision) => {
  const uuid = uuidText(id);
  await refusing('setAccessTokenReadSharedRevision', () => brain.setAccessTokenReadSharedRevision(uuid, revision));
};

/** The whole rows of the active tokens with no `source_grant`, oldest first, the times as Dates; the store takes no lock (one write at a time). */
export const lockLegacyAccessTokens: StoreMember<[], Record<string, unknown>[]> = async (brain) => {
  const rows = await storeCall({ member: 'lockLegacyAccessTokens' }, () => brain.lockLegacyAccessTokens()) as Record<string, unknown>[];
  return rows.map(row => withDates(row, ['created_at', 'last_used_at', 'revoked_at', 'reads_unscoped']));
};

/**
 * A live token's requester-scope fields: its `--reads-unscoped` opt-out and its creation time, both crossing as ISO text
 * and returned as Dates (or null), as the SQL engines return the two timestamp columns; null for a revoked or missing token.
 */
export const readLiveAccessTokenScope: StoreMember<[id: string], AccessTokenScopeRow | null> = async (brain, id) => {
  const row = await storeCall({ member: 'readLiveAccessTokenScope' }, () => brain.readLiveAccessTokenScope(id)) as AccessTokenScopeRow | null;
  return row ? withDates(row, ['created_at', 'reads_unscoped']) : null;
};
