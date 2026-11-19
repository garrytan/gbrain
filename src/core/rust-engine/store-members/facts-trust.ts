/**
 * Group 5 facts members, search relevance and trust reads (src/core/engine-sql/facts-trust.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/trust.rs and facts/saved_match.rs). A member not exported here refuses with
 * `engine_capability_missing`.
 *
 * Served: `listFactsForRelevance` (the keyword and entity arms), `countUncomparableFacts` and `matchSavedFacts`. The pool's
 * trust floor and flagged-fact suppression go to the store, which reads each fact's stamped `trust_tier` and its write-gate
 * receipts. The store answers the rest of the pool's read policy exactly when the visibility rule is the plain `world` one,
 * the privacy policy is the no-caller one (private-provenance.ts), the keyword arm runs in the `english` FTS configuration,
 * and the facts embedding column is `halfvec` (the only column type the store keeps). `matchSavedFacts` is served under the
 * same conditions, for the correction cue of saved-facts-match.ts only (the store spells its phrases, not a regex).
 *
 * Refused (not exported): `readFactForOwnerAction`, `listStandingPreferences`, `listLexicalContestCandidates`,
 * `listRestatedPrivateCopies` and `countDerivedFactTaint`. The store keeps the columns they read (`trust_tier`,
 * `write_origin`, the write-gate receipts), but no store read for them is built yet. The `entity_ended` arm reads the
 * withdrawal ledger through `gbrain_fact_fingerprint`, which no store read joins yet.
 */
import type { BrainEngine } from '../../engine.ts';
import { escapeLikePattern } from '../../cjk.ts';
import { factVisibilitySql, grantedPrivateFactSql } from '../../access/member-facts.ts';
import { getFtsLanguage } from '../../fts-language.ts';
import { privateFactFilterForReader, privateProvenanceFilterUnderPolicy } from '../../search/private-visibility.ts';
import { CORRECTION_CUE } from '../../search/saved-facts-match.ts';
import type { FactPoolFilters, FactPoolScope } from '../../engine-sql/facts-trust.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePrivacyPolicy } from './private-provenance.ts';
import { withDates } from '../store-codec.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type Row = Record<string, unknown>;

/** The pool's scope and filters as the store reads them, or a refusal for a policy it cannot answer. */
function poolArgs(member: string, scope: FactPoolScope, filters: FactPoolFilters | undefined): Row {
  if (scope.worldOnly && factVisibilitySql('facts', ['world']) !== "facts.visibility IN ('world')") {
    refuseMember(member, 'visibility widened by member pages or grants');
  }
  const grep = filters?.grep?.trim();
  return {
    sourceIds: [...new Set(scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? 'default'])],
    worldOnly: scope.worldOnly,
    // A caller with a reader identity and a private-readable grant is served (`callerReaders`).
    excludePrivate: storePrivacyPolicy(member, scope.excludePrivate, () => privateProvenanceFilterUnderPolicy('facts'), { callerReaders: true }),
    minTrust: scope.minTrust || null,
    suppressFlagged: scope.suppressFlagged === true,
    ...(filters?.entities ? { entities: filters.entities.map(e => ({ sourceId: e.sourceId, slug: e.slug })) } : {}),
    ...(filters?.sessionId ? { sessionId: filters.sessionId } : {}),
    ...(filters?.since ? { since: filters.since.toISOString() } : {}),
    ...(grep ? { grep: `%${escapeLikePattern(grep)}%` } : {}),
    includeExpired: filters?.includeExpired === true,
  };
}

export const listFactsForRelevance: Member<'listFactsForRelevance'> = async (brain, q) => {
  const member = 'listFactsForRelevance';
  if (q.arm === 'entity_ended') refuseMember(member, 'the history arm reads the withdrawal ledger');
  if (q.arm === 'keyword' && getFtsLanguage() !== 'english') refuseMember(member, `the keyword arm in FTS language ${getFtsLanguage()}`);
  if (q.vector && q.vector.type !== 'halfvec') refuseMember(member, 'a vector-typed facts embedding column');
  const pool = poolArgs(member, q.scope, q.filters);
  const rows: Row[] = await storeCall({ member }, () => brain.listFactsForRelevance({
    arm: q.arm,
    pool,
    ...(q.vector ? { vector: { literal: q.vector.literal, model: q.vector.model, dims: q.vector.dims } } : {}),
    terms: q.terms ?? '',
    ...(q.entity ? { entity: { sourceId: q.entity.sourceId, slug: q.entity.slug } } : {}),
    limit: q.limit,
  }));
  return rows.map(row => withDates(row, ['valid_from', 'valid_until', 'created_at']) as unknown as Awaited<ReturnType<BrainEngine['listFactsForRelevance']>>[number]);
};

export const countUncomparableFacts: Member<'countUncomparableFacts'> = async (brain, q) => {
  const member = 'countUncomparableFacts';
  return storeCall({ member }, () => brain.countUncomparableFacts({
    pool: poolArgs(member, q.scope, q.filters),
    dims: q.dims,
    model: q.model,
    declared: q.declared,
  }));
};

export const matchSavedFacts: Member<'matchSavedFacts'> = async (brain, q) => {
  const member = 'matchSavedFacts';
  if (getFtsLanguage() !== 'english') refuseMember(member, `the keyword scan in FTS language ${getFtsLanguage()}`);
  if (q.cue !== CORRECTION_CUE) refuseMember(member, 'a correction cue other than saved-facts-match.ts CORRECTION_CUE');
  if (q.pats.length > q.terms.length) refuseMember(member, 'more CJK patterns than terms');
  if (q.worldOnly && grantedPrivateFactSql('f') !== 'FALSE') refuseMember(member, 'visibility widened by a private-facts grant');
  const rows: Row[] = await storeCall({ member }, () => brain.matchSavedFacts({
    sources: [...q.sources],
    terms: [...q.terms],
    pats: q.terms.map((_, i) => q.pats[i] ?? null),
    supersede: q.supersede,
    excludePrivate: storePrivacyPolicy(member, q.excludePrivate, () => privateFactFilterForReader('facts'), { callerReaders: true }),
    worldOnly: q.worldOnly,
    minTrust: q.minTrust || null,
  }));
  return rows.map(row => withDates(row, ['at', 'created_at']) as unknown as Awaited<ReturnType<BrainEngine['matchSavedFacts']>>[number]);
};
