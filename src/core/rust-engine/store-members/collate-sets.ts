/**
 * The page-set reads of the core commands (src/core/engine-sql/collate-page-reads.ts), served from the store's page, link and
 * source records (rust/crates/gbrain-store/src/collate_sets.rs, rust/docs/store/collate_sets.md).
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 *
 * `listChatChannelCensus` with `hidePrivate` sends the caller's page policy and asks the store to read it as the SQL text does.
 * The text is `privatePagesFilterFragmentFast`: the folder-rule test, then a cheap first test, then the full page policy
 * (`privatePagesFilterFragment`, which a caller with no readers renders as the no-caller policy). The store mirrors that
 * order, so a page that passes the cheap test is counted even where the full policy hides it (a page in an owner-only
 * source), as the statement counts it. The member refuses when the text stops having that shape.
 */
import type { BrainEngine } from '../../engine.ts';
import type { PageReadScope } from '../../types.ts';
import { folderRulesAllowedSql, privatePagesFilterFragment, privatePagesFilterFragmentFast } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function text(member: string, name: string, value: string): string {
  if (value.includes('\0')) refuseMember(member, `${name} with a NUL byte`);
  return value;
}

export const readPageSizeRows: Member<'readPageSizeRows'> = async (brain, sourceId, maxBytes, slugs) => {
  const member = 'readPageSizeRows';
  return storeCall({ member }, () => brain.readPageSizeRows(text(member, 'source id', sourceId), maxBytes, slugs ? slugs.map(s => text(member, 'slug', s)) : null)) as never;
};

/**
 * The cheap first test of `privatePagesFilterFragmentFast`, as the store mirrors it (`cheap_page_visible`, `folder_rules_allow`): the
 * text must still lead with the folder-rule test and carry exactly these key and type tests, or the member refuses.
 */
function fastFilterMirrored(fast: string, honorAliases: boolean): boolean {
  const keys = ['visibility', 'derived_from', ...(honorAliases ? ['access', 'confidentiality'] : []), 'readable_by', 'pinned_question'];
  const ownKeys = (fast.match(/p\.frontmatter->'[a-z_]+' IS NULL/g) ?? []).sort();
  return fast.startsWith(`(${folderRulesAllowedSql('p', [])} AND ((`)
    && JSON.stringify(ownKeys) === JSON.stringify(keys.map(k => `p.frontmatter->'${k}' IS NULL`).sort())
    && fast.includes("p.type NOT IN ('atom', 'concept', 'event', 'question'))\n    OR ");
}

export const listChatChannelCensus: Member<'listChatChannelCensus'> = async (brain, sourceIds, chatTypes, dmTypes, hidePrivate) => {
  const member = 'listChatChannelCensus';
  const full = privatePagesFilterFragment('p');
  const fast = privatePagesFilterFragmentFast('p');
  if (hidePrivate && !fast.endsWith(`\n    OR ${full}))`)) refuseMember(member, 'a fast page filter that no longer wraps the full page policy');
  const policy = hidePrivate ? storePageTextPolicy(member, () => full, { noReaders: true }) : null;
  if (policy && !fastFilterMirrored(fast, policy.honorAliases)) refuseMember(member, 'a fast page filter whose cheap test the store does not mirror');
  return storeCall({ member }, () => brain.listChatChannelCensus(
    sourceIds.map(s => text(member, 'source id', s)), chatTypes.map(t => text(member, 'type', t)), dmTypes.map(t => text(member, 'type', t)), policy, policy !== null)) as never;
};

export const listLinkPageMetadataForSlugs: Member<'listLinkPageMetadataForSlugs'> = async (brain, sourceId, slugs) => {
  const member = 'listLinkPageMetadataForSlugs';
  return storeCall({ member }, () => brain.listLinkPageMetadataForSlugs(text(member, 'source id', sourceId), slugs.map(s => text(member, 'slug', s)))) as never;
};

export const listAttendedOriginSlugs: Member<'listAttendedOriginSlugs'> = async (brain, sourceId, slugs) => {
  const member = 'listAttendedOriginSlugs';
  return storeCall({ member }, () => brain.listAttendedOriginSlugs(text(member, 'source id', sourceId), slugs ? slugs.map(s => text(member, 'slug', s)) : null)) as never;
};

export const readCompanyBrainEvidenceRows: Member<'readCompanyBrainEvidenceRows'> = async (brain, sourceId) =>
  storeCall({ member: 'readCompanyBrainEvidenceRows' }, () => brain.readCompanyBrainEvidenceRows(text('readCompanyBrainEvidenceRows', 'source id', sourceId))) as never;

export const listShelfPageRows: Member<'listShelfPageRows'> = async (brain, sourceId) =>
  storeCall({ member: 'listShelfPageRows' }, () => brain.listShelfPageRows(text('listShelfPageRows', 'source id', sourceId))) as never;

export const listLiveSourceIncarnations: Member<'listLiveSourceIncarnations'> = async (brain, sourceIds) => {
  const member = 'listLiveSourceIncarnations';
  return storeCall({ member }, () => brain.listLiveSourceIncarnations(sourceIds.map(s => text(member, 'source id', s)))) as never;
};

export const listAttendanceScanWindow: Member<'listAttendanceScanWindow'> = async (brain, sourceId, afterSlug, limit) => {
  const member = 'listAttendanceScanWindow';
  return storeCall({ member }, () => brain.listAttendanceScanWindow(text(member, 'source id', sourceId), text(member, 'slug', afterSlug), limit)) as never;
};

/**
 * `listCardRows` serves the default shelf policy: none, or only a source scope that names the shelf's own source (a conjunct
 * every row of that source passes). A privacy, trust-floor or flagged-page policy, or a scope that leaves the shelf source out,
 * refuses with a typed refusal.
 */
/** The shelf policy `listCardRows` and `findCardRows` serve; any other policy or an unusable page size refuses (typed). */
function shelfRequest(member: string, sourceId: string, scope: PageReadScope | undefined): void {
  if (scope && (scope.excludePrivate || scope.minTrust || scope.suppressFlagged)) refuseMember(member, 'a page read policy beyond the shelf source');
  if (scope?.sourceIds?.length ? !scope.sourceIds.includes(sourceId) : scope?.sourceId && scope.sourceId !== sourceId) refuseMember(member, 'a source scope that leaves the shelf source out');
}

export const listCardRows: Member<'listCardRows'> = async (brain, sourceId, cardType, opts) => {
  const member = 'listCardRows';
  shelfRequest(member, sourceId, opts.policy);
  for (const n of [opts.limit, opts.offset]) if (!Number.isSafeInteger(n) || n < 0) refuseMember(member, 'a limit or offset that is not a non-negative integer');
  const { status, store, onSourceMachine } = opts.filters;
  return storeCall({ member }, () => brain.listCardRows(
    text(member, 'source id', sourceId), text(member, 'card type', cardType),
    status ? text(member, 'status', status) : null, store ? text(member, 'store', store) : null,
    onSourceMachine === undefined ? null : onSourceMachine, opts.limit, opts.offset)) as never;
};

/** `findCardRows` serves the same shelf policy as `listCardRows`; the store ranks the cards with the `simple` text search and pg_trgm. */
export const findCardRows: Member<'findCardRows'> = async (brain, sourceId, cardType, query, opts) => {
  const member = 'findCardRows';
  shelfRequest(member, sourceId, opts.policy);
  const { status, store, onSourceMachine } = opts.filters;
  return storeCall({ member }, () => brain.findCardRows(
    text(member, 'source id', sourceId), text(member, 'card type', cardType),
    text(member, 'query', query.lower), text(member, 'alias form', query.aliasNorm), query.terms.map(t => text(member, 'term', t)),
    status ? text(member, 'status', status) : null, store ? text(member, 'store', store) : null,
    onSourceMachine === undefined ? null : onSourceMachine)) as never;
};
