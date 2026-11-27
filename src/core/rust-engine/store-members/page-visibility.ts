/**
 * The writer slug fence read (BrainEngine readWriterSlugFence): whether a stored writer carries a slug fence
 * (engine-sql/page-visibility.ts on the SQL engines). An OAuth client's fence is its stored bound (or delegated)
 * slug prefixes; a local writer's fence is its stored grant ceiling's `slugPrefixes`; any other principal has none.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served.
 */
import { storeCall, type StoreMember } from './common.ts';
import { readOauthClient } from './jobs-oauth-clients.ts';

export const readWriterSlugFence: StoreMember<[principal: { kind: string; id: string }, opts?: { delegated?: boolean }], unknown> =
  async (brain, principal, opts) => {
  if (principal.kind === 'oauth_client') {
    const client = await readOauthClient(brain, principal.id);
    return (opts?.delegated ? client?.delegated_slug_prefixes : client?.bound_slug_prefixes) ?? null;
  }
  if (principal.kind !== 'local_cli' && principal.kind !== 'local_stdio') return null;
  const row = await storeCall({ member: 'readWriterSlugFence' }, () => brain.readLocalWriter(principal.id)) as
    { grant_ceiling?: { slugPrefixes?: unknown } | null } | null;
  return row?.grant_ceiling?.slugPrefixes ?? null;
};
