/**
 * Entity and mention reads the CLI made through executeRaw (engine-sql/entity-reads.ts), answered from the store.
 *
 * The store keeps no mention-pass state: no pass time, and every live page is due, as on a PGLite brain where the pass
 * never ran. `readExtractionLagCounts` is served by the extraction members (extraction.ts). `excludePrivate` applies the page policy (private-provenance.ts `storePagePolicy`), and
 * refuses for a caller whose members, grants or lineage change it. `readRetirementHop` applies the hop's page policy
 * the same way (retirementHopPolicy).
 */
import type {
  EntityCardMatch, EntityCardRow, FuzzyEntityCandidateRow, IgnoredLabelPageRow, InboundLinkerCountRow, MentionDueQuery, NameVariantCandidateQuery,
  NameVariantCandidateRow, NameVariantCardCandidateRow, RetirementHopRow, RetirementPrivacy, SiblingCandidateQuery, SiblingCandidateRow, SlugPatternPageRow, VariantPageRow,
} from '../../engine-sql/entity-reads.ts';
import { ignoredPrivacyLabels, SCAN_CAP } from '../../search/ignored-privacy-labels.ts';
import { callerAccessAllowedSql, currentCallerAccess, privatePagesFilterForCaller, remoteReadFloorSql, withCallerAccess, withoutCallerAccess } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { ownerOnlyFormIn, storePagePolicy, storePageTextPolicy, type StorePrivacyPolicy } from './private-provenance.ts';

export const readMentionLastPass: StoreMember<[sourceId?: string | null], string | null> = (brain, sourceId) =>
  storeCall({ member: 'readMentionLastPass', sourceId: sourceId ?? undefined }, () => brain.readMentionLastPass(sourceId ?? null));

export const countPagesDueForMentions: StoreMember<[q: MentionDueQuery], number> = async (brain, q) => {
  const opts = takeOptions('countPagesDueForMentions', q, ['sourceId', 'mentionVersion', 'aliases']);
  return Number(await storeCall({ member: 'countPagesDueForMentions', sourceId: q.sourceId ?? undefined }, () =>
    brain.countPagesDueForMentions({ sourceId: opts.sourceId ?? null })));
};

export const readIdentitySiblingCandidates: StoreMember<[sourceId: string, q: SiblingCandidateQuery], SiblingCandidateRow[]> = (brain, sourceId, q) => {
  const opts = takeOptions('readIdentitySiblingCandidates', q, ['types', 'subject', 'limit', 'excludeQuarantined', 'excludePrivate']);
  const excludePrivate = storePagePolicy('readIdentitySiblingCandidates', opts.excludePrivate, { callerReaders: true });
  return storeCall({ member: 'readIdentitySiblingCandidates', sourceId }, () => brain.readIdentitySiblingCandidates(sourceId, {
    types: [...q.types], subject: q.subject, limit: Math.max(0, Math.floor(q.limit)), excludeQuarantined: opts.excludeQuarantined === true,
    excludePrivate: excludePrivate ?? null }));
};

export const findExactSlug: StoreMember<[sourceId: string, slugs: readonly string[], opts?: { retired?: boolean }], string | null> = (brain, sourceId, slugs, opts) =>
  storeCall({ member: 'findExactSlug', sourceId }, () => brain.findExactSlug(sourceId, [...slugs], opts?.retired ?? null));

/**
 * The store page policy a retirement hop applies: the caller's page policy and the remote read floor through
 * storePageTextPolicy; member access alone (privacy off) when the caller's `callerAccessAllowedSql` is the no-caller
 * text or the canonical one for its reader identities, as the page visibility guards serve it (page-visibility.ts).
 * Any other caller refuses before the read.
 */
function retirementHopPolicy(privacy: RetirementPrivacy): StorePrivacyPolicy | undefined {
  const member = 'readRetirementHop';
  if (privacy === 'none') return undefined;
  if (privacy === 'caller') return storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true });
  if (privacy === 'floor') return storePageTextPolicy(member, () => remoteReadFloorSql('p'), { callerReaders: true });
  const text = callerAccessAllowedSql('p');
  const off = { honorAliases: false, entityPrivacy: false, ownerOnly: ownerOnlyFormIn(text, 'pages', 'p') };
  if (text === withoutCallerAccess(() => callerAccessAllowedSql('p'))) return off;
  const access = currentCallerAccess();
  const readers = { identity: [...access.identity], privateReadableSources: [...access.privateReadableSources] };
  const canonical = withoutCallerAccess(() => withCallerAccess({ ...readers, hidePrivate: true }, () => callerAccessAllowedSql('p')));
  if (text === canonical) return { ...off, ...readers };
  refuseMember(member, 'a caller whose member pages, grants or lineage widen the member-access policy');
}

export const readRetirementHop: StoreMember<[sourceId: string, slug: string, privacy: RetirementPrivacy], RetirementHopRow | null> =
  (brain, sourceId, slug, privacy) => {
    const policy = retirementHopPolicy(privacy);
    return storeCall({ member: 'readRetirementHop', slug, sourceId }, () => brain.readRetirementHop(sourceId, slug, policy ?? null));
  };

/** The store reads the page policy as readIdentitySiblingCandidates does; a widening caller refuses typed. */
export const readEntityCardRows: StoreMember<[sourceId: string, match: EntityCardMatch, opts?: { excludePrivate?: boolean }], EntityCardRow[]> =
  (brain, sourceId, match, opts) => {
    const taken = takeOptions('readEntityCardRows', opts, ['excludePrivate']);
    const policy = storePagePolicy('readEntityCardRows', taken.excludePrivate, { callerReaders: true });
    const wire = 'titleLc' in match ? { titleLc: match.titleLc, slugs: [...match.slugs], slugLike: match.slugLike } : { slugs: [...match.slugs] };
    return storeCall({ member: 'readEntityCardRows', sourceId }, () => brain.readEntityCardRows(sourceId, wire, policy ?? null)) as Promise<EntityCardRow[]>;
  };

/** pg_trgm `similarity` and `%` as PGLite computes them (keyword/trgm.rs); the store always has the trigram functions. */
export const findFuzzyEntityCandidates: StoreMember<[sourceId: string, title: string, fragment: string], FuzzyEntityCandidateRow[]> = (brain, sourceId, title, fragment) =>
  storeCall({ member: 'findFuzzyEntityCandidates', sourceId }, () => brain.findFuzzyEntityCandidates(sourceId, title, fragment));

/** The store returns the matches in slug byte order; Postgres states no order (`LIMIT 2` with no `ORDER BY`). */
export const findExactBasenameCandidates: StoreMember<[sourceId: string, slugs: readonly string[]], string[]> = (brain, sourceId, slugs) =>
  storeCall({ member: 'findExactBasenameCandidates', sourceId }, () => brain.findExactBasenameCandidates(sourceId, [...slugs]));

/** The store returns every live labelled page with no visibility key; the label rule itself is the TypeScript twin of the SQL. */
export const readIgnoredPrivacyLabelPages: StoreMember<[sourceId: string, scope: { slugs: readonly string[] } | { since: string },
  opts?: { limit?: number; timeoutMs?: number }], IgnoredLabelPageRow[]> = async (brain, sourceId, scope, opts) => {
  const taken = takeOptions('readIgnoredPrivacyLabelPages', opts, ['limit'], ['timeoutMs']);
  const limit = Math.max(0, Math.floor(typeof taken.limit === 'number' ? taken.limit : SCAN_CAP));
  const rows = await storeCall({ member: 'readIgnoredPrivacyLabelPages', sourceId }, () => brain.readIgnoredPrivacyLabelPages(sourceId,
    'slugs' in scope ? { slugs: [...new Set(scope.slugs)] } : { since: scope.since })) as IgnoredLabelPageRow[];
  return rows.filter(row => ignoredPrivacyLabels(row).length > 0).slice(0, limit);
};

export const listUnretiredPagesBySlugPattern: StoreMember<[sourceId: string, patterns: readonly string[], limit: number], SlugPatternPageRow[]> =
  (brain, sourceId, patterns, limit) => storeCall({ member: 'listUnretiredPagesBySlugPattern', sourceId }, () =>
    brain.listUnretiredPagesBySlugPattern(sourceId, [...patterns], Math.max(0, Math.floor(limit))));

export const listNameVariantCandidates: StoreMember<[sourceId: string, q: NameVariantCandidateQuery], NameVariantCandidateRow[]> = (brain, sourceId, q) => {
  takeOptions('listNameVariantCandidates', q, ['types', 'slugPatterns', 'probes', 'limit']);
  return storeCall({ member: 'listNameVariantCandidates', sourceId }, () => brain.listNameVariantCandidates(sourceId, {
    types: [...q.types], slugPatterns: [...q.slugPatterns], probes: [...q.probes], limit: Math.max(0, Math.floor(q.limit)) }));
};

/** listNameVariantCandidates under the page policy, read as readEntityCardRows reads it; a widening caller refuses typed. */
export const listVisibleNameVariantCandidates: StoreMember<[sourceId: string, q: NameVariantCandidateQuery, opts?: { excludePrivate?: boolean }],
  NameVariantCandidateRow[]> = (brain, sourceId, q, opts) => {
  takeOptions('listVisibleNameVariantCandidates', q, ['types', 'slugPatterns', 'probes', 'limit']);
  const taken = takeOptions('listVisibleNameVariantCandidates', opts, ['excludePrivate']);
  const policy = storePagePolicy('listVisibleNameVariantCandidates', taken.excludePrivate, { callerReaders: true });
  return storeCall({ member: 'listVisibleNameVariantCandidates', sourceId }, () => brain.listVisibleNameVariantCandidates(sourceId, {
    types: [...q.types], slugPatterns: [...q.slugPatterns], probes: [...q.probes], limit: Math.max(0, Math.floor(q.limit)) }, policy ?? null));
};

/** listVisibleNameVariantCandidates as entity-card rows (readEntityCardRows' columns) with their probe hits. */
export const listNameVariantCardCandidates: StoreMember<[sourceId: string, q: NameVariantCandidateQuery, opts?: { excludePrivate?: boolean }],
  NameVariantCardCandidateRow[]> = (brain, sourceId, q, opts) => {
  takeOptions('listNameVariantCardCandidates', q, ['types', 'slugPatterns', 'probes', 'limit']);
  const taken = takeOptions('listNameVariantCardCandidates', opts, ['excludePrivate']);
  const policy = storePagePolicy('listNameVariantCardCandidates', taken.excludePrivate, { callerReaders: true });
  return storeCall({ member: 'listNameVariantCardCandidates', sourceId }, () => brain.listNameVariantCardCandidates(sourceId, {
    types: [...q.types], slugPatterns: [...q.slugPatterns], probes: [...q.probes], limit: Math.max(0, Math.floor(q.limit)) }, policy ?? null)) as Promise<NameVariantCardCandidateRow[]>;
};

/** The live pages at `slugs` in list order under the page policy, read as readEntityCardRows reads it. */
export const readVisibleVariantPages: StoreMember<[sourceId: string, slugs: readonly string[], opts?: { excludePrivate?: boolean }], VariantPageRow[]> =
  (brain, sourceId, slugs, opts) => {
    const taken = takeOptions('readVisibleVariantPages', opts, ['excludePrivate']);
    const policy = storePagePolicy('readVisibleVariantPages', taken.excludePrivate, { callerReaders: true });
    return storeCall({ member: 'readVisibleVariantPages', sourceId }, () => brain.readVisibleVariantPages(sourceId, [...slugs], policy ?? null));
  };

export const countDistinctInboundLinkers: StoreMember<[sourceIds: readonly string[], slugs: readonly string[]], InboundLinkerCountRow[]> =
  (brain, sourceIds, slugs) => storeCall({ member: 'countDistinctInboundLinkers' }, () =>
    brain.countDistinctInboundLinkers([...sourceIds], [...slugs]));
