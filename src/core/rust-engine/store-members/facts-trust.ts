/**
 * Group 5 facts members, search relevance and trust reads (src/core/engine-sql/facts-trust.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/trust.rs). A member not exported here refuses with `engine_capability_missing`.
 *
 * Served: `listFactsForRelevance` (the keyword and entity arms), `countUncomparableFacts` and `matchSavedFacts`. The pool's trust floor and
 * flagged-fact suppression go to the store, which reads each fact's stamped `trust_tier` and its write-gate receipts. The
 * store answers the rest of the pool's read policy exactly when the visibility rule is the plain `world` one, the privacy
 * policy is the no-caller one (private-provenance.ts), the keyword arm runs in the `english` FTS configuration, and the
 * facts embedding column is `halfvec` (the only column type the store keeps).
 *
 * `matchSavedFacts` (facts/saved_match.rs) is served under the same read policy: the `english` FTS configuration, the
 * plain `world` visibility rule (no private-fact grant widens `worldOnly`), the no-caller or reader-identity privacy
 * policy, and the correction cue `CORRECTION_CUE` (the store spells that one regex as its phrases). Anything else refuses.
 *
 * `listRestatedPrivateCopies` is served by facts-trust-reads.ts; `readFactForOwnerAction`, `listStandingPreferences`,
 * `listLexicalContestCandidates` and `countDerivedFactTaint` by facts-trust-owner.ts. The `entity_ended` arm reads the
 * withdrawal ledger through `gbrain_fact_fingerprint`, which no store read joins yet.
 */
import type { BrainEngine } from '../../engine.ts';
import { grantedPrivateFactSql } from '../../access/member-facts.ts';
import { getFtsLanguage } from '../../fts-language.ts';
import { privateFactFilterForReader } from '../../search/private-visibility.ts';
import { CORRECTION_CUE } from '../../search/saved-facts-match.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePrivacyPolicy } from './private-provenance.ts';
import { withDates } from '../store-codec.ts';
import { poolArgs } from './fact-codec.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type Row = Record<string, unknown>;

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
  if (q.supersede && q.cue !== CORRECTION_CUE) refuseMember(member, 'a correction cue other than CORRECTION_CUE');
  if (q.worldOnly && grantedPrivateFactSql('f') !== 'FALSE') refuseMember(member, 'visibility widened by private-fact grants');
  const rows: Row[] = await storeCall({ member }, () => brain.matchSavedFacts({
    sources: q.sources,
    terms: q.terms,
    pats: q.pats,
    supersede: q.supersede,
    worldOnly: q.worldOnly,
    // pglite-engine.ts matchSavedFacts: `privateFactFilterForReader('f', true)`; the per-candidate form differs only by a
    // planner fence (OFFSET 0), so the policy is judged on the plain form.
    excludePrivate: storePrivacyPolicy(member, q.excludePrivate, () => privateFactFilterForReader('facts'), { callerReaders: true }),
    minTrust: q.minTrust || null,
  }));
  return rows.map(row => withDates(row, ['at', 'created_at'])) as never;
};
