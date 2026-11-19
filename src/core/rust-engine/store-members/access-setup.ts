/**
 * The access setup and policy-store members outside access/policy.ts (listUnboundTokenNames through
 * countPeopleFolderPages; SQL in engine-sql/access-setup.ts). The member-key setup reads and writes come from the
 * store's `access_tokens` and `oauth_clients` (rust/docs/store/access-tokens.md, oauth-clients.md); no store member
 * binds a token to a member yet, so every live token reads as unbound and no key reads a source. The source, page and
 * access-state reads come from the store's sources, its live page slugs and its access state; the migration journal is
 * gbrain-store `access_migrations`. What each member answers: rust/docs/store/access_rules.md.
 */
import type { AccessMigrationRow, LiveAccessTokenRow, MemberKeyReadingRow, PeopleFolderCount } from '../../engine-sql/access-setup.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

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

export const listUnarchivedSourceIds: StoreMember<[ids: readonly string[]], string[]> = async (brain, ids) => {
  const wanted = new Set(ids);
  return (await sourceRows(brain, 'listUnarchivedSourceIds', false)).map(s => s.id).filter(id => wanted.has(id));
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
