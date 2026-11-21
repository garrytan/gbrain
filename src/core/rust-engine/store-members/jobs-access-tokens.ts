/**
 * The `access_tokens` members (engine-sql/access-tokens.ts), served by the store (rust/docs/store/access-tokens.md). A time crosses the
 * binding as ISO text. The store refuses a write that breaks a constraint of the table with `constraint_violation`;
 * `refusing` gives it the SQLSTATE and constraint name PGLite and Postgres raise, so a caller branches on one error shape.
 */
import type { AccessTokenInsert, AccessTokenScopeRow, ActiveAccessTokenRow } from '../../engine-sql/access-tokens.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';
import { refusing } from './constraint-errors.ts';

export const insertAccessToken: StoreMember<[row: AccessTokenInsert], { id: string }> = (brain, row) =>
  refusing('insertAccessToken', () => brain.insertAccessToken({ ...row, revoked_at: row.revoked_at?.toISOString() ?? null })) as Promise<{ id: string }>;

export const findActiveAccessTokens: StoreMember<[target: string], ActiveAccessTokenRow[]> = (brain, target) =>
  storeCall({ member: 'findActiveAccessTokens' }, () => brain.findActiveAccessTokens(target)) as Promise<ActiveAccessTokenRow[]>;

export const setAccessTokenMinTrust: StoreMember<[id: string, tier: string | null], void> = async (brain, id, tier) => {
  await refusing('setAccessTokenMinTrust', () => brain.setAccessTokenMinTrust(id, tier));
};

/**
 * A live token's requester-scope fields. The store keeps no `reads_unscoped` column and mints no token that opts out, so
 * it answers null there (read as not opted out); `created_at` crosses as ISO text and is returned as a Date, as the SQL
 * engines return it.
 */
export const readLiveAccessTokenScope: StoreMember<[id: string], AccessTokenScopeRow | null> = async (brain, id) => {
  const row = await storeCall({ member: 'readLiveAccessTokenScope' }, () => brain.readLiveAccessTokenScope(id)) as AccessTokenScopeRow | null;
  return row ? withDates(row, ['created_at']) : null;
};

/** The member a token is bound to. The store keeps no member column, so it answers null for every token. */
export const readAccessTokenMemberId: StoreMember<[id: string], string | null> = (brain, id) =>
  storeCall({ member: 'readAccessTokenMemberId' }, () => brain.readAccessTokenMemberId(id)) as Promise<string | null>;
