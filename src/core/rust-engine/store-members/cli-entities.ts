/**
 * Entity and mention reads the CLI made through executeRaw (engine-sql/entity-reads.ts), answered from the store.
 *
 * The store keeps no mention-pass state: no pass time, and every live page is due, as on a PGLite brain where the pass
 * never ran. `readExtractionLagCounts` is served by the extraction members (extraction.ts). `excludePrivate` applies the page policy (private-provenance.ts `storePagePolicy`), and
 * refuses for a caller whose members, grants or lineage change it. `readRetirementHop` applies the hop's page policy
 * the same way (retirementHopPolicy).
 */
import type { EntityAnchoredPages, TextMentionPageRow, EntityCardMatch, EntityCardRow, IgnoredLabelPageRow, InboundLinkerCountRow, LivePageTypeRow, MentionDueQuery, MentionIndexRecount, MentionIndexStatusRow, NameVariantCandidateQuery, NameVariantCandidateRow, PrefixCandidateQuery, PrefixCandidateRow, PrefixTitleRow, ResolverPrivacy, RetirementHopRow, RetirementPrivacy, SiblingCandidateQuery, SiblingCandidateRow, SlugPatternPageRow, TrigramCandidateQuery, TrigramCandidateRow, FuzzyEntityCandidateRow } from '../../engine-sql/entity-reads.ts';
import { ignoredPrivacyLabels, SCAN_CAP } from '../../search/ignored-privacy-labels.ts';
import { callerAccessAllowedSql, currentCallerAccess, privatePagesFilterForCaller, remoteReadFloorSql, withCallerAccess, withoutCallerAccess } from '../../search/private-visibility.ts';
import { selfChecked } from '../access-self-check.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { ownerOnlyFormIn, storePagePolicy, storePageTextPolicy, type StorePrivacyPolicy } from './private-provenance.ts';

export const readMentionLastPass: StoreMember<[sourceId?: string | null], string | null> = (brain, sourceId) =>
  storeCall({ member: 'readMentionLastPass', sourceId: sourceId ?? undefined }, () => brain.readMentionLastPass(sourceId ?? null));

/** The mention pass's status rows (the store's mention state); a source the pass never ran on has none, and coverage counts its live pages. */
export const readMentionIndexStatus: StoreMember<[sourceIds: readonly string[]], MentionIndexStatusRow[]> = (brain, sourceIds) =>
  storeCall({ member: 'readMentionIndexStatus' }, () => brain.readMentionIndexStatus({ sourceIds: [...sourceIds] }));

/** The source's live pages: the due count at a version no page state holds (-1), so every live page is due whatever the pass has scanned. */
export const countLivePagesInSource: StoreMember<[sourceId: string], number> = async (brain, sourceId) =>
  Number(await storeCall({ member: 'countLivePagesInSource', sourceId }, () => brain.countPagesDueForMentions({ sourceId, mentionVersion: -1 })));

/** The source's live pages written at or after `since` that have no mention state at their content and `mentionVersion`. */
export const countMentionDueSince: StoreMember<[sourceId: string, since: string, mentionVersion: number], number> = async (brain, sourceId, since, mentionVersion) =>
  Number(await storeCall({ member: 'countMentionDueSince', sourceId }, () => brain.countMentionDueSince({ sourceId, since, mentionVersion })));

/** The compare-and-set on the source's status row's fingerprint; a source with no row is untouched. */
export const recountMentionIndexStatus: StoreMember<[sourceId: string, recount: MentionIndexRecount], void> = async (brain, sourceId, recount) => {
  const r = takeOptions('recountMentionIndexStatus', recount, ['pending', 'fingerprint', 'expectedFingerprint']);
  await storeCall({ member: 'recountMentionIndexStatus', sourceId }, () =>
    brain.recountMentionIndexStatus({ sourceId, pending: r.pending, fingerprint: r.fingerprint, expectedFingerprint: r.expectedFingerprint ?? null }));
};

export const countPagesDueForMentions: StoreMember<[q: MentionDueQuery], number> = async (brain, q) => {
  const opts = takeOptions('countPagesDueForMentions', q, ['sourceId', 'mentionVersion', 'aliases']);
  return Number(await storeCall({ member: 'countPagesDueForMentions', sourceId: q.sourceId ?? undefined }, () =>
    brain.countPagesDueForMentions({ sourceId: opts.sourceId ?? null, mentionVersion: opts.mentionVersion, aliases: opts.aliases ?? null })));
};

export const readIdentitySiblingCandidates: StoreMember<[sourceId: string, q: SiblingCandidateQuery], SiblingCandidateRow[]> = (brain, sourceId, q) => {
  const opts = takeOptions('readIdentitySiblingCandidates', q, ['types', 'subject', 'limit', 'excludeQuarantined', 'excludePrivate']);
  const excludePrivate = storePagePolicy('readIdentitySiblingCandidates', opts.excludePrivate, { callerReaders: true });
  return storeCall({ member: 'readIdentitySiblingCandidates', sourceId }, () => brain.readIdentitySiblingCandidates(sourceId, {
    types: [...q.types], subject: q.subject, limit: Math.max(0, Math.floor(q.limit)), excludeQuarantined: opts.excludeQuarantined === true,
    excludePrivate: excludePrivate ?? null }));
};

/** mentions/siblings.ts siblingCanonical: the live pages at the slugs; the store reads the page policy as readIdentitySiblingCandidates does. */
export const readSiblingGroupRows: StoreMember<[sourceId: string, slugs: readonly string[], opts?: { excludePrivate?: boolean }], SiblingCandidateRow[]> = (brain, sourceId, slugs, opts) => {
  const taken = takeOptions('readSiblingGroupRows', opts, ['excludePrivate']);
  const excludePrivate = storePagePolicy('readSiblingGroupRows', taken.excludePrivate, { callerReaders: true });
  return storeCall({ member: 'readSiblingGroupRows', sourceId }, () => brain.readSiblingGroupRows(sourceId, [...slugs], excludePrivate ?? null));
};

/** entities/resolve.ts: the live pages among the slugs; `limit` 2 caps them. */
export const readLiveSlugs: StoreMember<[sourceId: string, slugs: readonly string[], opts?: { limit?: 2 }], string[]> = (brain, sourceId, slugs, opts) => {
  const { limit } = takeOptions('readLiveSlugs', opts, ['limit']);
  if (limit !== undefined && limit !== 2) refuseMember('readLiveSlugs', `limit ${String(limit)}`);
  return storeCall({ member: 'readLiveSlugs', sourceId }, () => brain.readLiveSlugs(sourceId, [...slugs], limit === 2 ? 2 : null));
};

export const findExactSlug: StoreMember<[sourceId: string, slugs: readonly string[], opts?: { retired?: boolean }], string | null> = (brain, sourceId, slugs, opts) =>
  storeCall({ member: 'findExactSlug', sourceId }, () => brain.findExactSlug(sourceId, [...slugs], opts?.retired ?? null));

/**
 * The store page policy a retirement hop applies: the caller's page policy and the remote read floor through
 * storePageTextPolicy; member access alone (privacy off) when the caller's `callerAccessAllowedSql` is the no-caller
 * text or the canonical one for its reader identities, as the page visibility guards serve it (page-visibility.ts).
 * Any other caller refuses before the read.
 */
export function retirementHopPolicy(privacy: RetirementPrivacy, member = 'readRetirementHop'): StorePrivacyPolicy | undefined {
  if (privacy === 'none') return undefined;
  if (privacy === 'caller') return storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true, fragment: 'caller' });
  if (privacy === 'floor') return storePageTextPolicy(member, () => remoteReadFloorSql('p'), { callerReaders: true, fragment: 'floor' });
  return selfChecked(member, { mode: 'access_part_plain' }, () => accessPartPlainRendered(member));
}

/** retirementHopPolicy's `access` branch: member access alone, as the TypeScript renderers decide it. */
function accessPartPlainRendered(member: string): StorePrivacyPolicy {
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

/** entities/resolve.ts: the live pages among the slugs with their types, under the resolver privacy (retirementHopPolicy). */
export const readLivePageTypes: StoreMember<[sourceId: string, slugs: readonly string[], privacy: ResolverPrivacy], LivePageTypeRow[]> =
  (brain, sourceId, slugs, privacy) => {
    const policy = retirementHopPolicy(privacy, 'readLivePageTypes');
    return storeCall({ member: 'readLivePageTypes', sourceId }, () => brain.readLivePageTypes(sourceId, [...slugs], policy ?? null)) as Promise<LivePageTypeRow[]>;
  };

/** entities/resolve.ts: the prefix pages titled the bare name, ignoring case, at most three. */
export const readPrefixTitleMatches: StoreMember<[sourceId: string, patterns: readonly string[], title: string], PrefixTitleRow[]> = (brain, sourceId, patterns, title) =>
  storeCall({ member: 'readPrefixTitleMatches', sourceId }, () => brain.readPrefixTitleMatches(sourceId, [...patterns], title)) as Promise<PrefixTitleRow[]>;

/** entities/resolve.ts: the named live, non-retired pages entityReferenceCandidates offers, by slug, at most five. */
export const readNamedEntitySlugs: StoreMember<[sourceId: string, slugs: readonly string[], privacy: ResolverPrivacy], string[]> =
  (brain, sourceId, slugs, privacy) => {
    const policy = retirementHopPolicy(privacy, 'readNamedEntitySlugs');
    return storeCall({ member: 'readNamedEntitySlugs', sourceId }, () => brain.readNamedEntitySlugs(sourceId, [...slugs], policy ?? null)) as Promise<string[]>;
  };

/** entities/resolve.ts: the distinct entity directories of the prefix pages, at most two. */
export const readPrefixDirs: StoreMember<[sourceId: string, patterns: readonly string[]], string[]> = (brain, sourceId, patterns) =>
  storeCall({ member: 'readPrefixDirs', sourceId }, () => brain.readPrefixDirs(sourceId, [...patterns])) as Promise<string[]>;

/** entities/resolve.ts: the prefix candidates with their connection counts; one pattern caps at five, a list at ten. */
export const readPrefixCandidates: StoreMember<[sourceId: string, q: PrefixCandidateQuery], PrefixCandidateRow[]> = (brain, sourceId, q) => {
  const taken = takeOptions('readPrefixCandidates', q, ['patterns', 'pattern']);
  const patterns = 'patterns' in taken ? [...(taken.patterns as readonly string[])] : [taken.pattern as string];
  const limit = 'patterns' in taken ? 10 : 5;
  if (('patterns' in taken) === ('pattern' in taken)) refuseMember('readPrefixCandidates', 'one of pattern or patterns');
  return storeCall({ member: 'readPrefixCandidates', sourceId }, () =>
    brain.readPrefixCandidates(sourceId, patterns, limit)) as Promise<PrefixCandidateRow[]>;
};

/** entities/resolve.ts: the title-similarity candidates of one resolver arm, under its privacy (retirementHopPolicy). */
export const readTrigramCandidates: StoreMember<[sourceId: string, q: TrigramCandidateQuery], TrigramCandidateRow[]> = (brain, sourceId, q) => {
  const taken = takeOptions('readTrigramCandidates', q, ['arm', 'titleLc', 'slugFragment', 'privacy']);
  if (taken.arm !== 'same_name' && taken.arm !== 'near' && taken.arm !== 'fuzzy') refuseMember('readTrigramCandidates', `arm ${String(taken.arm)}`);
  if (taken.arm === 'fuzzy' && taken.privacy !== undefined) refuseMember('readTrigramCandidates', 'privacy on the fuzzy arm');
  const policy = q.arm === 'fuzzy' ? undefined : retirementHopPolicy(q.privacy, 'readTrigramCandidates');
  return storeCall({ member: 'readTrigramCandidates', sourceId }, () =>
    brain.readTrigramCandidates(sourceId, q.arm, q.titleLc, q.slugFragment, policy ?? null)) as Promise<TrigramCandidateRow[]>;
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

/** The live page's type and frontmatter, or null; the store has no statement deadline, so `timeoutMs` is not read. */
export const readLivePageFrontmatter: StoreMember<[sourceId: string, slug: string, opts?: { timeoutMs?: number }], IgnoredLabelPageRow | null> =
  async (brain, sourceId, slug, opts) => {
    takeOptions('readLivePageFrontmatter', opts, [], ['timeoutMs']);
    return (await storeCall({ member: 'readLivePageFrontmatter', sourceId }, () => brain.readLivePageFrontmatter(sourceId, slug)) as IgnoredLabelPageRow | null) ?? null;
  };

/** The live entity page and the pages that name or link to it; the store matches the word pattern itself. */
export const readEntityAnchoredPages: StoreMember<[sourceId: string, entitySlug: string], EntityAnchoredPages> =
  (brain, sourceId, entitySlug) =>
    storeCall({ member: 'readEntityAnchoredPages', sourceId }, () => brain.readEntityAnchoredPages(sourceId, entitySlug)) as Promise<EntityAnchoredPages>;

/** The title of each page id, deleted or not. */
export const readPageTitlesById: StoreMember<[ids: readonly number[]], Array<{ id: number; title: string }>> =
  (brain, ids) =>
    storeCall({ member: 'readPageTitlesById' }, () => brain.readPageTitlesById([...ids])) as Promise<Array<{ id: number; title: string }>>;

/** The live pages at the slugs in the sources; the store's ISO date string becomes the Date both SQL engines return. */
export const readTextMentionPages: StoreMember<[sourceIds: readonly string[], slugs: readonly string[]], TextMentionPageRow[]> =
  async (brain, sourceIds, slugs) => {
    const rows = await storeCall({ member: 'readTextMentionPages' }, () => brain.readTextMentionPages([...sourceIds], [...slugs])) as TextMentionPageRow[];
    return rows.map(r => ({ ...r, date: r.date === null ? null : new Date(r.date) }));
  };

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

export const countDistinctInboundLinkers: StoreMember<[sourceIds: readonly string[], slugs: readonly string[]], InboundLinkerCountRow[]> =
  (brain, sourceIds, slugs) => storeCall({ member: 'countDistinctInboundLinkers' }, () =>
    brain.countDistinctInboundLinkers([...sourceIds], [...slugs]));
