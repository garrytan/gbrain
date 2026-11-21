/**
 * The access report reads (BrainEngine readAccessStateUnreadable, countOpenPages, listWhoCanReadPages,
 * readPageAdmitsCaller, readPageFolderRulesAdmit, countLineageClosingRules; SQL in engine-sql/access-setup.ts and
 * engine-sql/access-policy.ts): what gbrain access serves, doctor open_shared_pages and gbrain access who-can-read read.
 * The store keeps no access members, no access rules and no folder rule ids, and its access state always reads. What
 * each member answers and why: rust/docs/store/write_misc.md (listWhoCanReadPages: page-visibility.md).
 */
import type { OpenPageCount, OpenPageExclusion, WhoCanReadPageRow } from '../../engine-sql/access-setup.ts';
import type { OwnerOnlyForm } from '../../access/owner-only.ts';
import { accessAllowedSql, callerAccessAllowedSql, privacyPartSql } from '../../search/private-visibility.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { ownerOnlyFormIn, renderForStoreCaller, storePageTextPolicy, type StorePrivacyPolicy } from './private-provenance.ts';

/** The store keeps its access state in its own records, which always read, so the state is never unreadable. */
export const readAccessStateUnreadable: StoreMember<[], boolean> = async () => false;

/**
 * The open-page count (engine-sql/access-setup.ts countOpenPages). The SQL engines render the empty-identity floor
 * (`accessAllowedSql('p', [], [])`) and the privacy part in the current access context; the store judges a page by
 * the no-caller policies it implements (`page_hidden` in facts/privacy.rs). The member serves the read only when the
 * floor equals the no-caller member-access rendering and the floor with the privacy part equals the no-caller page
 * policy (storePageTextPolicy); any other rendering refuses before any read, so the count is never wider.
 * A page is open when it is live and the member-access policy admits it, and visible when the page policy does too.
 */
export const countOpenPages: StoreMember<[sources: readonly string[], exclude: readonly OpenPageExclusion[]], OpenPageCount[]> = async (brain, sources, exclude) => {
  const floor = accessAllowedSql('p', [], []);
  if (floor !== renderForStoreCaller({}, () => callerAccessAllowedSql('p'))) {
    refuseMember('countOpenPages', 'an open-page floor rendered in a caller record');
  }
  const access: StorePrivacyPolicy = { honorAliases: false, entityPrivacy: false, ownerOnly: ownerOnlyFormIn(floor, 'pages', 'p') };
  const page = storePageTextPolicy('countOpenPages', () => `(${accessAllowedSql('p', [], [])} AND ${privacyPartSql('p')})`);
  const groups = new Map<string, OpenPageCount>();
  for (const source of new Set(sources)) {
    const skip = exclude.filter(x => x.source === source).map(x => x.prefix);
    const live = await storeCall({ member: 'countOpenPages', sourceId: source }, () =>
      brain.listLivePageSummaries({ sourceId: source, scoped: true })) as Array<{ slug: string; type: string }>;
    const kept = live.filter(r => !skip.some(x => r.slug.startsWith(x)));
    if (!kept.length) continue;
    const open = new Set(await readable(brain, source, kept.map(r => r.slug), access));
    if (!open.size) continue;
    const visible = new Set(await readable(brain, source, [...open], page));
    for (const row of kept) {
      if (!open.has(row.slug)) continue;
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

/** The slugs of `sourceId` whose row `policy` reads (gbrain-store readCallerPageAccess). */
async function readable(brain: StoreBrain, sourceId: string, slugs: string[], policy: StorePrivacyPolicy): Promise<string[]> {
  const rows = await storeCall({ member: 'countOpenPages', sourceId }, () =>
    brain.readCallerPageAccess(slugs.map(slug => ({ sourceId, slug })), policy)) as Array<{ slug: string; readable: boolean }>;
  return rows.filter(r => r.readable).map(r => r.slug);
}

/**
 * whoCanRead's page rows (engine-sql/access-setup.ts listWhoCanReadPages). The store reads the owner-only test in the
 * `fn` form for `mode` too: the store keeps no owner-only read mode, so the mode never widens the test. The store keeps
 * no folder rules, so `folder_rule_ids` is null.
 */
export const listWhoCanReadPages: StoreMember<[slug: string, sourceId: string | undefined, form: OwnerOnlyForm], WhoCanReadPageRow[]> =
  async (brain, slug, sourceId, form) => {
    const storeForm = form === 'closed' ? 'closed' : 'fn';
    return storeCall({ member: 'listWhoCanReadPages', slug, sourceId }, () =>
      brain.listWhoCanReadPages(slug, sourceId ?? null, storeForm)) as Promise<WhoCanReadPageRow[]>;
  };

/** The store keeps no access members, so no member identity reaches this read; it refuses rather than guess a floor. */
export const readPageAdmitsCaller: StoreMember<[sourceId: string, slug: string, identity: readonly string[]], boolean> = async () =>
  refuseMember('readPageAdmitsCaller', 'the store keeps no access members, so no member identity reaches it');

/** The store keeps no access members and no folder rules, so no member's satisfied rules reach this read. */
export const readPageFolderRulesAdmit: StoreMember<[sourceId: string, slug: string, satisfied: readonly string[]], boolean> = async () =>
  refuseMember('readPageFolderRulesAdmit', 'the store keeps no access members, so no member identity reaches it');

/** The store keeps no access rules, so no id names an applied raw-only rule and every id counts. */
export const countLineageClosingRules: StoreMember<[ruleIds: readonly string[], sourceId: string], number> = async (_brain, ruleIds) =>
  ruleIds.length;
