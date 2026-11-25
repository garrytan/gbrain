/**
 * The client grant members of engine-sql/client-grants.ts, served by the store (rust/docs/store/oauth-clients.md): the
 * grant write with its legacy job rewrite and audit row, the audit reads, and the whole-table reads the grant checks make.
 * The store keeps no `oauth_tokens` and no `oauth_codes`, so no client holds an authorization. The row-level locks a SQL
 * engine takes (`readOauthClientForUpdate`, `lockOauthClientName`, `readSourceArchivedForShare`) are skipped while
 * explicit transactions hold the writer (`serialized_transactions`); each of those members asserts it.
 */
import type { OauthClientGrantPersist, OauthGrantAuditRow } from '../../engine-sql/client-grants.ts';
import { normalizeOauthClientRow, type OauthClientRow } from '../../engine-sql/oauth-clients.ts';
import { assertStoreSerializedTransactions, storeCall, type StoreMember } from './common.ts';
import { refusing } from './constraint-errors.ts';
import { readOauthClient } from './jobs-oauth-clients.ts';

export const readOauthClientForUpdate: StoreMember<[clientId: string], OauthClientRow | null> = async (brain, clientId) => {
  assertStoreSerializedTransactions(brain, 'readOauthClientForUpdate');
  return readOauthClient(brain, clientId);
};

export const readLiveOauthClients: StoreMember<[], OauthClientRow[]> = async brain => {
  const raw = await storeCall({ member: 'readLiveOauthClients' }, () => brain.readLiveOauthClients()) as Record<string, unknown>[];
  return raw.map(normalizeOauthClientRow);
};

/** Each row as `readActiveAccessTokenByHash` returns it (`created_at` a Date), the columns the store does not keep at their defaults. */
export const readLiveAccessTokenRows: StoreMember<[], Record<string, unknown>[]> = async brain => {
  const raw = await storeCall({ member: 'readLiveAccessTokenRows' }, () => brain.readLiveAccessTokenRows()) as Record<string, unknown>[];
  return raw.map(r => ({ ...r, created_at: new Date(String(r.created_at)) }));
};

const asDate = (v: unknown): Date | null => v == null ? null : new Date(String(v));

/** Every token, revoked ones too, newest first (a tie by id); the times are `Date`s, as `SELECT *` returns them. */
export const listAccessTokenRows: StoreMember<[], Record<string, unknown>[]> = async brain => {
  const raw = await storeCall({ member: 'listAccessTokenRows' }, () => brain.listAccessTokenRows()) as Record<string, unknown>[];
  return raw.map(r => ({ ...r, created_at: new Date(String(r.created_at)), last_used_at: asDate(r.last_used_at),
    revoked_at: asDate(r.revoked_at), reads_unscoped: asDate(r.reads_unscoped) }));
};

/** The same-name advisory lock is skipped while explicit transactions hold the writer (`serialized_transactions`); it asserts that. */
export const lockOauthClientName: StoreMember<[lockKey: string], void> = async brain => {
  assertStoreSerializedTransactions(brain, 'lockOauthClientName');
};

/** Whether the client holds an OAuth token or an authorization code (expired ones count), as the SQL engines' EXISTS pair. */
export const oauthClientHoldsAuthorization: StoreMember<[clientId: string], boolean> = async (brain, clientId) =>
  (await storeCall({ member: 'oauthClientHoldsAuthorization' }, () => brain.oauthClientHoldsAuthorization(clientId))) === true;

export const readSourceArchivedForShare: StoreMember<[id: string], boolean | null> = async (brain, id) => {
  assertStoreSerializedTransactions(brain, 'readSourceArchivedForShare');
  const state = await storeCall({ member: 'readSourceArchivedForShare', sourceId: id }, () => brain.readSourceGrantState(id)) as { archived: boolean } | null;
  return state ? state.archived === true : null;
};

export const readSourceAttestState: StoreMember<[id: string], { archived: boolean; config: unknown } | null> = (brain, id) =>
  storeCall({ member: 'readSourceAttestState', sourceId: id }, () => brain.readSourceGrantState(id)) as Promise<{ archived: boolean; config: unknown } | null>;

export const replaceSourceConfig: StoreMember<[id: string, config: Record<string, unknown>], void> = async (brain, id, config) => {
  await storeCall({ member: 'replaceSourceConfig', sourceId: id }, () => brain.replaceSourceConfig(id, config));
};

export const persistOauthClientGrant: StoreMember<[grant: OauthClientGrantPersist], boolean> = (brain, grant) => {
  const { budget_usd_per_day, ...rest } = grant;
  return refusing('persistOauthClientGrant', () => brain.persistOauthClientGrant({ ...rest, budget_usd_per_day: budget_usd_per_day === null ? null : Number(budget_usd_per_day) })) as Promise<boolean>;
};

export const readLatestCatalogProvenanceAudit: StoreMember<[clientId: string], unknown | null> = (brain, clientId) =>
  storeCall({ member: 'readLatestCatalogProvenanceAudit' }, () => brain.readLatestCatalogProvenanceAudit(clientId)) as Promise<unknown | null>;

export const listOauthGrantAudit: StoreMember<[clientId: string], OauthGrantAuditRow[]> = async (brain, clientId) => {
  const raw = await storeCall({ member: 'listOauthGrantAudit' }, () => brain.listOauthGrantAudit(clientId)) as (Omit<OauthGrantAuditRow, 'created_at'> & { created_at: string })[];
  return raw.map(r => ({ ...r, created_at: new Date(r.created_at) }));
};
