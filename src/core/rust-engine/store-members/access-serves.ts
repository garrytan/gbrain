/**
 * The member-key and owner setup of `gbrain access serves several` (commands/access-serves.ts) and the people folders
 * of access/serves.ts, over the store's tokens, OAuth clients, sources and live page slugs (SQL in
 * engine-sql/access-setup.ts; rust/docs/store/access-tokens.md). Also the token list `gbrain auth list` reads, with
 * every column `SELECT *` returns, and the unarchived source ids the member keys' read list starts from.
 */
import type { LiveAccessTokenRow, MemberKeyReadingRow, PeopleFolderCount } from '../../engine-sql/access-setup.ts';
import type { AccessTokenRow } from '../../engine-sql/write-misc.ts';
import type { StoreBrain } from '../store.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const listUnboundTokenNames: StoreMember<[], string[]> = (brain) =>
  storeCall({ member: 'listUnboundTokenNames' }, () => brain.listUnboundTokenNames()) as Promise<string[]>;

export const listUnboundClientIds: StoreMember<[], string[]> = (brain) =>
  storeCall({ member: 'listUnboundClientIds' }, () => brain.listUnboundClientIds()) as Promise<string[]>;

export const readLiveAccessToken: StoreMember<[name: string], LiveAccessTokenRow | null> = (brain, name) =>
  storeCall({ member: 'readLiveAccessToken' }, () => brain.readLiveAccessToken(name)) as Promise<LiveAccessTokenRow | null>;

export const recordTokenSetupReads: StoreMember<[name: string, reads: readonly string[]], void> = async (brain, name, reads) => {
  await storeCall({ member: 'recordTokenSetupReads' }, () => brain.recordTokenSetupReads(name, [...reads]));
};

export const listKeysReadingSource: StoreMember<[sourceId: string], MemberKeyReadingRow[]> = (brain, sourceId) =>
  storeCall({ member: 'listKeysReadingSource', sourceId }, () => brain.listKeysReadingSource(sourceId)) as Promise<MemberKeyReadingRow[]>;

/** The store's revoke of one live token by id (`revokeAccessToken`); the name it answers is not needed here. */
export const revokeAccessTokenById: StoreMember<[id: string], void> = async (brain, id) => {
  await storeCall({ member: 'revokeAccessTokenById' }, () => brain.revokeAccessToken(id));
};

async function sourceRows(brain: StoreBrain, member: string, includeArchived: boolean): Promise<Array<{ id: string }>> {
  return storeCall<Array<{ id: string }>>({ member }, () => brain.listAllSources(includeArchived ? { includeArchived: true } : {}));
}

async function liveSlugs(brain: StoreBrain, member: string, sourceId: string, prefix: string): Promise<string[]> {
  return storeCall({ member, sourceId }, () => brain.listAccessPrefixSlugs(sourceId, [prefix]));
}

/** Every source that is not archived, by id in byte order (the store lists `default` first, the SQL by id). */
export const listUnarchivedSourceIds: StoreMember<[], Array<{ id: string }>> = async (brain) =>
  (await sourceRows(brain, 'listUnarchivedSourceIds', false)).map(s => ({ id: s.id })).sort((a, b) => byCodeUnit(a.id, b.id));

/** `LIKE 'company/calls/%'` has no `_`, so it is a starts-with test. */
export const countCompanyPages: StoreMember<[sourceId: string], { pages: number; calls: number }> = async (brain, sourceId) => {
  const slugs = await liveSlugs(brain, 'countCompanyPages', sourceId, '');
  return { pages: slugs.length, calls: slugs.filter(s => s.startsWith('company/calls/')).length };
};

/**
 * `slug LIKE 'people/%/%'` is a slug under people/ with another `/` after it; `split_part(slug, '/', 2)` is the
 * segment between the first two. Every source counts, archived ones too.
 */
export const countPeopleFolderPages: StoreMember<[], PeopleFolderCount[]> = async (brain) => {
  const out: PeopleFolderCount[] = [];
  for (const s of await sourceRows(brain, 'countPeopleFolderPages', true)) {
    const counts = new Map<string, number>();
    for (const slug of await liveSlugs(brain, 'countPeopleFolderPages', s.id, 'people/')) {
      const rest = slug.slice('people/'.length);
      const cut = rest.indexOf('/');
      if (cut >= 0) counts.set(rest.slice(0, cut), (counts.get(rest.slice(0, cut)) ?? 0) + 1);
    }
    for (const [folder, pages] of counts) out.push({ source_id: s.id, folder, pages });
  }
  return out.sort((a, b) => byCodeUnit(a.source_id, b.source_id) || byCodeUnit(a.folder, b.folder));
};

/** The access_tokens columns PGLite returns as a Date (timestamptz). */
const TOKEN_DATES = ['created_at', 'last_used_at', 'revoked_at', 'reads_unscoped'];

/** `gbrain auth list` and the open-page count's member keys: every token row, newest first, with every column. */
export const listAccessTokens: StoreMember<[], AccessTokenRow[]> = async (brain) => {
  const rows = await storeCall({ member: 'listAccessTokens' }, () => brain.listAccessTokens()) as AccessTokenRow[];
  return rows.map(r => withDates(r, TOKEN_DATES));
};
