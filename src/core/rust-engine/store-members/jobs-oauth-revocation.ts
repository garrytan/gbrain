/**
 * The revoke members of engine-sql/oauth-revocation.ts, served by the store (rust/docs/store/oauth-tokens.md,
 * oauth-clients.md). Each runs on the caller's bound transaction handle, so a grant's revoke is one store write.
 */
import type { OauthGrantAuditInsert } from '../../engine-sql/oauth-revocation.ts';
import { storeCall, type StoreMember } from './common.ts';

export const deleteOauthTokenByHash: StoreMember<[hash: string, clientId: string], void> = async (brain, hash, clientId) => {
  await storeCall({ member: 'deleteOauthTokenByHash' }, () => brain.deleteOauthTokenByHash(hash, clientId));
};

export const softDeleteOauthClient: StoreMember<[clientId: string], void> = async (brain, clientId) => {
  await storeCall({ member: 'softDeleteOauthClient' }, () => brain.softDeleteOauthClient(clientId));
};

export const deleteOauthClientTokens: StoreMember<[clientId: string], void> = async (brain, clientId) => {
  await storeCall({ member: 'deleteOauthClientTokens' }, () => brain.deleteOauthClientTokens(clientId));
};

export const deleteOauthClientCodes: StoreMember<[clientId: string], void> = async (brain, clientId) => {
  await storeCall({ member: 'deleteOauthClientCodes' }, () => brain.deleteOauthClientCodes(clientId));
};

/** The store deletes the client's tokens with the row; the return of its delete (the row it removed) is not needed here. */
export const deleteOauthClientRow: StoreMember<[clientId: string], void> = async (brain, clientId) => {
  await storeCall({ member: 'deleteOauthClientRow' }, () => brain.deleteOauthClient(clientId));
};

export const setOauthClientRevision: StoreMember<[clientId: string, revision: number, revoke: boolean], void> = async (brain, clientId, revision, revoke) => {
  await storeCall({ member: 'setOauthClientRevision' }, () => brain.setOauthClientRevision(clientId, revision, revoke));
};

/** GST-2898: the client's read-shared stamp (engine-sql/oauth-revocation.ts); a null revision clears the switch. */
export const setOauthClientReadSharedRevision: StoreMember<[clientId: string, revision: number | null], void> = async (brain, clientId, revision) => {
  await storeCall({ member: 'setOauthClientReadSharedRevision' }, () => brain.setOauthClientReadSharedRevision(clientId, revision));
};

export const insertOauthGrantAudit: StoreMember<[row: OauthGrantAuditInsert], void> = async (brain, row) => {
  await storeCall({ member: 'insertOauthGrantAudit' }, () => brain.insertOauthGrantAudit(row));
};
