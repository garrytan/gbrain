/**
 * The access setup and policy-store members outside access/policy.ts (listUnboundTokenNames through
 * countOpenPages; SQL in engine-sql/access-setup.ts). The member-key setup reads and writes come from the
 * store's `access_tokens` and `oauth_clients` (rust/docs/store/access-tokens.md, oauth-clients.md); no store member
 * binds a token to a member yet, so every live token reads as unbound and no key reads a source. The source, page and
 * access-state reads come from the store's sources, its live page slugs and its access state; the migration journal is
 * gbrain-store `access_migrations`. What each member answers: rust/docs/store/access_rules.md.
 */
import type { AccessMigrationRow, LiveAccessTokenRow, MemberKeyReadingRow, OpenPageCount, OpenPageExclusion, PeopleFolderCount } from '../../engine-sql/access-setup.ts';
import { accessAllowedSql, callerAccessRecord, privacyPartSql, withCallerAccess } from '../../search/private-visibility.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';
import { openPageFloorPolicy } from './access-policies.ts';
import { storePageTextPolicy, type StorePrivacyPolicy } from './private-provenance.ts';

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

/**
 * The open-page count (engine-sql/access-setup.ts countOpenPages). The SQL engines render the empty-identity floor
 * (`accessAllowedSql('p', [], [])`) and the privacy part in the current access context; the store judges a page by
 * the no-caller policies it implements (`page_hidden` in facts/privacy.rs). The member serves the read only when the
 * floor equals the no-caller member-access rendering and the floor with the privacy part equals the no-caller page
 * policy (storePageTextPolicy). Inside a caller record (a remote caller asking) the floor is the same test for a
 * fresh record with no identity and the caller's folder coverage; openPageSql still adds the live pending prefixes, so
 * the store judges the record's coverage and its own pending prefixes both (no `callerRecord`). The page policy is then
 * judged for that empty identity; it only decides `visible` for pages already open. Any other rendering (an owner
 * record, private-readable sources) refuses before any read, so the count is never wider.
 * A page is open when the member-access policy admits it, and visible when the page policy does too.
 */
export const countOpenPages: StoreMember<[sources: readonly string[], exclude: readonly OpenPageExclusion[]], OpenPageCount[]> = async (brain, sources, exclude) => {
  const pageText = `(${accessAllowedSql('p', [], [])} AND ${privacyPartSql('p')})`;
  const access = openPageFloorPolicy();
  // The page policy for the empty identity, judged against the text the caller's record renders.
  // pageText was rendered in the caller's own record, before the empty-identity record below (renderedIn).
  const renderedIn = { record: callerAccessRecord() };
  const page = withCallerAccess({ identity: [], privateReadableSources: [] },
    () => storePageTextPolicy('countOpenPages', () => pageText, { callerReaders: true, fragment: 'plain', renderedIn }));
  const groups = new Map<string, OpenPageCount>();
  for (const source of new Set(sources)) {
    const skip = exclude.filter(x => x.source === source).map(x => x.prefix);
    const slugs = (await liveSlugs(brain, 'countOpenPages', source, '')).filter(slug => !skip.some(x => slug.startsWith(x)));
    if (!slugs.length) continue;
    const open = await pageTypes(brain, source, slugs, access);
    if (!open.length) continue;
    const visible = new Set((await pageTypes(brain, source, open.map(r => r.slug), page)).map(r => r.slug));
    for (const row of open) {
      const cut = row.slug.indexOf('/');
      const folder = cut >= 0 ? row.slug.slice(0, cut) : '(root)';
      const shown = visible.has(row.slug);
      const key = JSON.stringify([source, folder, row.type, shown]);
      const group = groups.get(key) ?? { source, folder, type: row.type, visible: shown, pages: 0 };
      groups.set(key, group);
      group.pages++;
    }
  }
  return [...groups.values()];
};

async function pageTypes(brain: StoreBrain, sourceId: string, slugs: string[], policy: StorePrivacyPolicy): Promise<Array<{ slug: string; type: string }>> {
  return storeCall({ member: 'countOpenPages', sourceId }, () => brain.readLivePageTypes(sourceId, slugs, policy));
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
