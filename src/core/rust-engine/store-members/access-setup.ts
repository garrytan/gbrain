/**
 * The access setup and policy-store members outside access/policy.ts (listUnboundTokenNames through
 * countPeopleFolderPages; SQL in engine-sql/access-setup.ts). The store keeps no access tokens and no OAuth clients, so
 * the token reads answer what Postgres answers on a brain with none (no rows, no token) and the token writes match no
 * row. The source, page and access-state reads come from the store's sources, its live page slugs and its access
 * state; the migration journal is gbrain-store `access_migrations`. What each member answers:
 * rust/docs/store/access_rules.md.
 */
import type { AccessMigrationRow, LiveAccessTokenRow, MemberKeyReadingRow, PeopleFolderCount } from '../../engine-sql/access-setup.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The store keeps no access tokens, so no live token is unbound. */
export const listUnboundTokenNames: StoreMember<[], string[]> = async () => [];

/** The store keeps no OAuth clients, so none is unbound. */
export const listUnboundClientIds: StoreMember<[], string[]> = async () => [];

/** The store keeps no access tokens, so no live token has any name. */
export const readLiveAccessToken: StoreMember<[name: string], LiveAccessTokenRow | null> = async () => null;

/** The store keeps no access tokens: the write matches no live token, as on a brain with none. */
export const recordTokenSetupReads: StoreMember<[name: string, reads: readonly string[]], void> = async () => undefined;

/** The store keeps no access tokens, so no key still reads a source. */
export const listKeysReadingSource: StoreMember<[sourceId: string], MemberKeyReadingRow[]> = async () => [];

/** The store keeps no access tokens: the write matches no live token, as on a brain with none. */
export const revokeAccessTokenById: StoreMember<[id: string], void> = async () => undefined;

async function sourceRows(brain: StoreBrain, member: string, includeArchived: boolean): Promise<Array<{ id: string }>> {
  return storeCall<Array<{ id: string }>>({ member }, () => brain.listAllSources(includeArchived ? { includeArchived: true } : {}));
}

async function liveSlugs(brain: StoreBrain, member: string, sourceId: string, prefix: string): Promise<string[]> {
  return storeCall({ member, sourceId }, () => brain.listAccessPrefixSlugs(sourceId, [prefix]));
}

export const filterUnarchivedSourceIds: StoreMember<[ids: readonly string[]], string[]> = async (brain, ids) => {
  const wanted = new Set(ids);
  return (await sourceRows(brain, 'filterUnarchivedSourceIds', false)).map(s => s.id).filter(id => wanted.has(id));
};

/** `LIKE 'company/calls/%'` has no `_`, so it is a starts-with test. */
export const countCompanyPages: StoreMember<[sourceId: string], { pages: number; calls: number }> = async (brain, sourceId) => {
  const slugs = await liveSlugs(brain, 'countCompanyPages', sourceId, '');
  return { pages: slugs.length, calls: slugs.filter(s => s.startsWith('company/calls/')).length };
};

export const readUnfinishedAccessMigration: StoreMember<[sourceId: string], AccessMigrationRow | null> = (brain, sourceId) =>
  storeCall({ member: 'readUnfinishedAccessMigration', sourceId }, () => brain.readUnfinishedAccessMigration(sourceId));

export const insertAccessMigration: StoreMember<[id: string, sourceId: string, direction: string], void> = async (brain, id, sourceId, direction) => {
  await storeCall({ member: 'insertAccessMigration', sourceId }, () => brain.insertAccessMigration(id, sourceId, direction));
};

export const recordAccessMigrationPhase: StoreMember<[id: string, phase: string, receipts: Record<string, unknown>], void> = async (brain, id, phase, receipts) => {
  await storeCall({ member: 'recordAccessMigrationPhase' }, () => brain.recordAccessMigrationPhase(id, phase, receipts));
};

export const switchAccessMigration: StoreMember<[id: string, receipts: Record<string, unknown>], void> = async (brain, id, receipts) => {
  await storeCall({ member: 'switchAccessMigration' }, () => brain.recordAccessMigrationPhase(id, 'switched', receipts));
};

/** Every source, archived ones too, that holds access state, by id (code-unit order, as `COLLATE "C"`). */
export const listAccessPolicySources: StoreMember<[], string[]> = async (brain) => {
  const out: string[] = [];
  for (const s of await sourceRows(brain, 'listAccessPolicySources', true)) {
    if (await storeCall({ member: 'listAccessPolicySources', sourceId: s.id }, () => brain.hasAccessPolicyState(s.id))) out.push(s.id);
  }
  return out.sort(byCodeUnit);
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

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
