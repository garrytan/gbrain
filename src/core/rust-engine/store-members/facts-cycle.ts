/**
 * Group 5 facts members, command, cycle and fence reads (src/core/engine-sql/facts-cycle.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/cycle.rs). A member not exported here refuses with `engine_capability_missing`.
 *
 * Each member makes one store call with the arguments of its statement. `countWorldFacts` sends its read eligibility
 * (the trust floor and flag suppression), which the store applies over each fact's stamped `trust_tier` and its
 * write-gate receipts. What the store cannot answer exactly refuses: `excludePrivate` for a caller whose rendering is
 * not the store's policy (private-provenance.ts); `findBulkFactDays` under a rule whose count thresholds are not
 * integers (`$2::int`).
 * `listFactsForPage` turns the times the store returns as text into `Date`s, as PGLite returns them.
 */
import { privateFactFilterForReader } from '../../search/private-visibility.ts';
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePrivacyPolicy } from './private-provenance.ts';
import { withDates } from '../store-codec.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listActiveFactsForEntity: Member<'listActiveFactsForEntity'> = (brain, sourceId, entitySlug, limit) =>
  storeCall({ member: 'listActiveFactsForEntity' }, () => brain.listActiveFactsForEntity({ sourceId, entitySlug, limit }));

export const listFreshExtractionOutcomes: Member<'listFreshExtractionOutcomes'> = (brain, sourceId, slugs, sources, preferredSource) =>
  storeCall({ member: 'listFreshExtractionOutcomes' }, () => brain.listFreshExtractionOutcomes({ sourceId, slugs, sources, preferredSource }));

export const listFenceRowGroups: Member<'listFenceRowGroups'> = (brain) =>
  storeCall({ member: 'listFenceRowGroups' }, () => brain.listFenceRowGroups());

export const readFactSubject: Member<'readFactSubject'> = (brain, id) =>
  storeCall({ member: 'readFactSubject' }, () => brain.readFactSubject(id));

export const factsOrAliasesMayMatch: Member<'factsOrAliasesMayMatch'> = (brain, sourceId, slugTokens, aliasNorms) =>
  storeCall({ member: 'factsOrAliasesMayMatch' }, () => brain.factsOrAliasesMayMatch({ sourceId, slugTokens: [...slugTokens], aliasNorms: [...aliasNorms] }));

/** `expired_at` comes back from PGLite as a `Date`. */
export const readFactForForget: Member<'readFactForForget'> = async (brain, id) => {
  const row: Record<string, unknown> | null = await storeCall({ member: 'readFactForForget' }, () => brain.readFactForForget(id));
  return row === null ? null : withDates(row, ['expired_at']) as unknown as Awaited<ReturnType<BrainEngine['readFactForForget']>>;
};

/** `valid_from`, `valid_until` and `expired_at` come back from PGLite as `Date`s. */
export const listFactsForPage: Member<'listFactsForPage'> = async (brain, sourceId, slug) => {
  const rows: Array<Record<string, unknown>> = await storeCall({ member: 'listFactsForPage' }, () => brain.listFactsForPage({ sourceId, slug }));
  return rows.map((row) => withDates(row, ['valid_from', 'valid_until', 'expired_at'])) as unknown as Awaited<ReturnType<BrainEngine['listFactsForPage']>>;
};

export const readPageFileOrigin: Member<'readPageFileOrigin'> = (brain, sourceId, slug, opts) =>
  storeCall({ member: 'readPageFileOrigin' }, () => brain.readPageFileOrigin({ sourceId, slug, includeDeleted: opts?.includeDeleted ?? false }));

export const countLegacyFactsPending: Member<'countLegacyFactsPending'> = (brain, sourceId) =>
  storeCall({ member: 'countLegacyFactsPending' }, () => brain.countLegacyFactsPending(sourceId));

export const countUnconsolidatedFactsBySource: Member<'countUnconsolidatedFactsBySource'> = (brain, opts) =>
  storeCall({ member: 'countUnconsolidatedFactsBySource' }, () => brain.countUnconsolidatedFactsBySource({
    sourceId: opts.sourceId ?? null, worldOnly: opts.worldOnly, minPerBucket: opts.minPerBucket,
  }));

export const findBulkFactDays: Member<'findBulkFactDays'> = async (brain, sourceIds, rule) => {
  const member = 'findBulkFactDays';
  if (!Number.isInteger(rule.min_facts) || !Number.isInteger(rule.min_entities)) refuseMember(member, 'a count threshold that is not an integer');
  if (!Number.isFinite(rule.min_share)) refuseMember(member, 'a share threshold that is not finite');
  return storeCall({ member }, () => brain.findBulkFactDays({
    sourceIds: sourceIds ?? null,
    rule: { minFacts: rule.min_facts, minShare: rule.min_share, minEntities: rule.min_entities },
  }));
};

export const maxFenceRowNum: Member<'maxFenceRowNum'> = (brain, sourceId, slug) =>
  storeCall({ member: 'maxFenceRowNum' }, () => brain.maxFenceRowNum({ sourceId, slug }));

export const readFenceRowOccupant: Member<'readFenceRowOccupant'> = async (brain, sourceId, slug, rowNum) => {
  if (!Number.isSafeInteger(rowNum)) refuseMember('readFenceRowOccupant', 'a row number that is not an integer');
  const id = await storeCall({ member: 'readFenceRowOccupant' }, () => brain.readFenceRowOccupant({ sourceId, slug, rowNum }));
  return id == null ? null : Number(id);
};

export const listStoredFenceFactRows: Member<'listStoredFenceFactRows'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listStoredFenceFactRows' }, () => brain.listStoredFenceFactRows({ sourceId, slug }));

export const countWorldFacts: Member<'countWorldFacts'> = async (brain, opts) => {
  const member = 'countWorldFacts';
  return storeCall({ member }, () => brain.countWorldFacts({
    sourceId: opts.sourceId, entitySlugs: opts.entitySlugs, worldOnly: opts.worldOnly,
    // entity-card.ts: `privateFactFilterForReader('facts')`. A caller with a reader identity and a private-readable
    // grant is served (`callerReaders`).
    excludePrivate: storePrivacyPolicy(member, opts.excludePrivate, () => privateFactFilterForReader('facts'), { callerReaders: true }),
    minTrust: opts.eligibility?.floor || null,
    suppressFlagged: opts.eligibility?.suppressFlagged === true,
  }));
};
