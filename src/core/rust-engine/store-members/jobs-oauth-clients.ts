/**
 * The OAuth client read (BrainEngine readOauthClient): one stored client by id, normalised as the SQL engines
 * return it (engine-sql/oauth-clients.ts `normalizeOauthClientRow`). The facts backstop effect reads a client's
 * slug fence through it.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served.
 */
import { normalizeOauthClientRow, type OauthClientRow } from '../../engine-sql/oauth-clients.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readOauthClient: StoreMember<[clientId: string], OauthClientRow | null> = async (brain, clientId) => {
  const raw = await storeCall({ member: 'readOauthClient' }, () => brain.readOauthClient(clientId)) as Record<string, unknown> | null;
  return raw ? normalizeOauthClientRow(raw) : null;
};
