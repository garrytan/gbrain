/**
 * Entity and mention reads the CLI made through executeRaw (engine-sql/entity-reads.ts), answered from the store.
 *
 * The store keeps no mention-pass state: no pass time, and every live page is due, as on a PGLite brain where the pass
 * never ran. `readExtractionLagCounts` is served by the extraction members (extraction.ts). `excludePrivate` applies the page policy (private-provenance.ts `storePagePolicy`), and
 * refuses for a caller whose members, grants or lineage change it.
 */
import type { FuzzyEntityCandidateRow, IgnoredLabelPageRow, MentionDueQuery, SiblingCandidateQuery, SiblingCandidateRow } from '../../engine-sql/entity-reads.ts';
import { ignoredPrivacyLabels, SCAN_CAP } from '../../search/ignored-privacy-labels.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

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

/** pg_trgm `similarity` and `%` as PGLite computes them (keyword/trgm.rs); the store always has the trigram functions. */
export const findFuzzyEntityCandidates: StoreMember<[sourceId: string, title: string, fragment: string], FuzzyEntityCandidateRow[]> = (brain, sourceId, title, fragment) =>
  storeCall({ member: 'findFuzzyEntityCandidates', sourceId }, () => brain.findFuzzyEntityCandidates(sourceId, title, fragment));

/** The store returns every live labelled page with no visibility key; the label rule itself is the TypeScript twin of the SQL. */
export const readIgnoredPrivacyLabelPages: StoreMember<[sourceId: string, scope: { slugs: readonly string[] } | { since: string },
  opts?: { limit?: number; timeoutMs?: number }], IgnoredLabelPageRow[]> = async (brain, sourceId, scope, opts) => {
  const taken = takeOptions('readIgnoredPrivacyLabelPages', opts, ['limit'], ['timeoutMs']);
  const limit = Math.max(0, Math.floor(typeof taken.limit === 'number' ? taken.limit : SCAN_CAP));
  const rows = await storeCall({ member: 'readIgnoredPrivacyLabelPages', sourceId }, () => brain.readIgnoredPrivacyLabelPages(sourceId,
    'slugs' in scope ? { slugs: [...new Set(scope.slugs)] } : { since: scope.since })) as IgnoredLabelPageRow[];
  return rows.filter(row => ignoredPrivacyLabels(row).length > 0).slice(0, limit);
};
