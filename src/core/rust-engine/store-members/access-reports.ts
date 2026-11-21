/**
 * The access report reads (BrainEngine readAccessStateUnreadable, countOpenPages, listWhoCanReadPages,
 * readPageAdmitsCaller, readPageFolderRulesAdmit, countLineageClosingRules; SQL in engine-sql/access-setup.ts and
 * engine-sql/access-policy.ts): what gbrain access serves, doctor open_shared_pages and gbrain access who-can-read read.
 * Folder rules come from gbrain-store `access_rules`, and the store's access state always reads. What
 * each member answers and why: rust/docs/store/write_misc.md (listWhoCanReadPages: page-visibility.md).
 */
import type { OpenPageCount, OpenPageExclusion, WhoCanReadPageRow } from '../../engine-sql/access-setup.ts';
import type { OwnerOnlyForm } from '../../access/owner-only.ts';
import { accessAllowedSql, callerAccessAllowedSql, currentCallerAccess, privacyPartSql } from '../../search/private-visibility.ts';
import type { AccessRuleRow } from '../../engine-sql/access-policy.ts';
import { ruleCovers, validPrefix, validQualifiedRuleId } from '../../access/folder-rules.ts';
import { isValidSourceId } from '../../source-id.ts';
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
 * `fn` form for `mode` too: the store keeps no owner-only read mode, so the mode never widens the test.
 * `folder_rule_ids` lists the rules that cover the page (`source:rule_id`), null when none does.
 */
export const listWhoCanReadPages: StoreMember<[slug: string, sourceId: string | undefined, form: OwnerOnlyForm], WhoCanReadPageRow[]> =
  async (brain, slug, sourceId, form) => {
    const storeForm = form === 'closed' ? 'closed' : 'fn';
    return storeCall({ member: 'listWhoCanReadPages', slug, sourceId }, () =>
      brain.listWhoCanReadPages(slug, sourceId ?? null, storeForm)) as Promise<WhoCanReadPageRow[]>;
  };

/** The store does not judge one member's member-access floor yet (row 32), so it refuses rather than guess one. */
export const readPageAdmitsCaller: StoreMember<[sourceId: string, slug: string, identity: readonly string[]], boolean> = async () =>
  refuseMember('readPageAdmitsCaller', 'one member\'s member-access floor');

/**
 * `folderRulesAllowedSql('p', satisfied)` over the page row (live or soft-deleted): its stamped rules
 * (`folder_rule_ids`, listWhoCanReadPages) are none or all in `satisfied`, and no prefix of the caller record's folder
 * coverage covers it (`coverageSql`; an entry with an invalid source id or prefix covers every page). False when the
 * source has no such page row.
 */
export const readPageFolderRulesAdmit: StoreMember<[sourceId: string, slug: string, satisfied: readonly string[]], boolean> = async (brain, sourceId, slug, satisfied) => {
  const [row] = await storeCall({ member: 'readPageFolderRulesAdmit', sourceId, slug }, () => brain.listWhoCanReadPages(slug, sourceId, 'fn')) as WhoCanReadPageRow[];
  if (!row) return false;
  const ids = satisfied.length && satisfied.every(validQualifiedRuleId) ? satisfied : [];
  if (!(row.folder_rule_ids ?? []).every(id => ids.includes(id))) return false;
  return !currentCallerAccess().folderCoverage.some(c => !isValidSourceId(c.source_id) || (c.prefix !== '' && !validPrefix(c.prefix))
    || (c.source_id === sourceId && (c.prefix === '' || ruleCovers(slug, c.prefix))));
};

/** How many of `ruleIds` are not an applied raw-only rule (`covers_derived` false) of `sourceId` (gbrain-store `access_rules`). */
export const countLineageClosingRules: StoreMember<[ruleIds: readonly string[], sourceId: string], number> = async (brain, ruleIds, sourceId) => {
  const rules = await storeCall({ member: 'countLineageClosingRules', sourceId }, () => brain.listAccessRules(sourceId)) as AccessRuleRow[];
  const rawOnly = new Set(rules.filter(r => r.covers_derived === false).map(r => `${sourceId}:${r.rule_id}`));
  return ruleIds.filter(id => !rawOnly.has(id)).length;
};
