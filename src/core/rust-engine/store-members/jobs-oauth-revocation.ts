/**
 * The revoke members of engine-sql/oauth-revocation.ts, served by the store (rust/docs/store/oauth-tokens.md,
 * oauth-clients.md). Each runs on the caller's bound transaction handle, so a grant's revoke is one store write.
 */
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

/** The store keeps no authorization codes yet, so a client has none to delete. */
export const deleteOauthClientCodes: StoreMember<[clientId: string], void> = async () => {};
