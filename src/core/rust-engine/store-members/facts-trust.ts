/**
 * Group 5 facts members, search relevance and trust reads (src/core/engine-sql/facts-trust.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/trust.rs and facts/saved_match.rs). A member not exported here refuses with
 * `engine_capability_missing`.
 *
 * Served: `listFactsForRelevance` (the keyword and entity arms), `countUncomparableFacts` and `matchSavedFacts`. The pool's trust floor and
 * flagged-fact suppression go to the store, which reads each fact's stamped `trust_tier` and its write-gate receipts. The
 * store answers the rest of the pool's read policy exactly when the world-only rule is the plain `world` one or a
 * widening the store models (fact-visibility.ts), the privacy policy is one the store models (private-provenance.ts),
 * the keyword arm runs in the `english` FTS configuration, and the facts embedding column is `halfvec` (the only column
 * type the store keeps).
 *
 * Served: `matchSavedFacts`, for the one correction cue saved-facts-match.ts sends, under the same rules (a widened
 * `worldOnly` visibility, a private-facts grant, refuses).
 * `listLexicalContestCandidates`, the keyless conflict slot's read of a remember, is served from
 * rust/crates/gbrain-store/src/facts/contest.rs. `listFactsFromQuotedPages` and `listOwnerTierFacts`, the quote reads of
 * search/transcript-quote.ts, are served from rust/crates/gbrain-store/src/facts/quote.rs: the holding page, a backstop's
 * named page or a recorded input page (`derivation_inputs`) marks a fact quoted.
 *
 * `listRestatedPrivateCopies` is served by facts-trust-reads.ts; `readFactForOwnerAction`, `listStandingPreferences` and
 * `countDerivedFactTaint` by facts-trust-owner.ts. The `entity_ended` arm reads the withdrawal ledger through
 * `gbrain_fact_fingerprint`, which no store read joins yet.
 */
import type { BrainEngine } from '../../engine.ts';
import { escapeLikePattern } from '../../cjk.ts';
import { grantedPrivateFactSql } from '../../access/member-facts.ts';
import { getFtsLanguage } from '../../fts-language.ts';
import { privateFactFilterForReader, privateProvenanceFilterUnderPolicy } from '../../search/private-visibility.ts';
import type { FactPoolFilters, FactPoolScope } from '../../engine-sql/facts-trust.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePrivacyPolicy } from './private-provenance.ts';
import { storeVisibility } from './fact-visibility.ts';
import { withDates } from '../store-codec.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type Row = Record<string, unknown>;

/** The pool's scope and filters as the store reads them, or a refusal for a policy it cannot answer. */
function poolArgs(member: string, scope: FactPoolScope, filters: FactPoolFilters | undefined): Row {
  // A world-only pool is widened per row for the caller's member page and private-facts grant, as the fact lists are.
  const widen = scope.worldOnly ? storeVisibility(member, ['world']).widen : undefined;
  const grep = filters?.grep?.trim();
  return {
    sourceIds: [...new Set(scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? 'default'])],
    worldOnly: scope.worldOnly,
    ...(widen ? { widen } : {}),
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

/** The correction cue the store implements (facts/saved_match.rs `CUE_PHRASES`): saved-facts-match.ts CORRECTION_CUE. */
const STORE_CORRECTION_CUE = String.raw`\m(correction|retract(s|ed|ing|ion)?|disregard|scratch that|i misspoke|i was wrong|not what (i|we) (posted|said|wrote)|ignore (the|my|that|what))\M`;

export const matchSavedFacts: Member<'matchSavedFacts'> = async (brain, q) => {
  const member = 'matchSavedFacts';
  if (getFtsLanguage() !== 'english') refuseMember(member, `FTS language ${getFtsLanguage()}`);
  if (q.cue !== STORE_CORRECTION_CUE) refuseMember(member, 'a correction cue other than CORRECTION_CUE');
  if (q.worldOnly && grantedPrivateFactSql('f') !== 'FALSE') refuseMember(member, 'visibility widened by a private-facts grant');
  const rows: Row[] = await storeCall({ member }, () => brain.matchSavedFacts({
    sources: q.sources,
    terms: q.terms,
    pats: q.pats,
    supersede: q.supersede,
    // The SQL reads `privateFactFilterForReader('f', true)`; `true` only adds a plan hint (OFFSET 0).
    excludePrivate: storePrivacyPolicy(member, q.excludePrivate, () => privateFactFilterForReader('facts'), { callerReaders: true }),
    worldOnly: q.worldOnly,
    minTrust: q.minTrust || null,
  }));
  return rows.map(row => withDates(row, ['at', 'created_at']) as unknown as Awaited<ReturnType<BrainEngine['matchSavedFacts']>>[number]);
};

export const listLexicalContestCandidates: Member<'listLexicalContestCandidates'> = (brain, q) =>
  storeCall({ member: 'listLexicalContestCandidates', sourceId: q.sourceId }, () => brain.listLexicalContestCandidates({
    sourceId: q.sourceId, entitySlug: q.entitySlug, kind: q.kind, visibility: q.visibility, pageSlug: q.pageSlug ?? null, writer: q.writer }));

export const listFactsFromQuotedPages: Member<'listFactsFromQuotedPages'> = (brain, q) =>
  storeCall({ member: 'listFactsFromQuotedPages' }, () => brain.listFactsFromQuotedPages({
    ids: [...new Set(q.ids.map(Number))], pageTypes: [...q.pageTypes], backstop: q.backstop.map(([source, prefix]) => [source, prefix]) }));

export const listOwnerTierFacts: Member<'listOwnerTierFacts'> = (brain, q) =>
  storeCall({ member: 'listOwnerTierFacts' }, () => brain.listOwnerTierFacts({ ids: [...new Set(q.ids.map(Number))], floor: q.floor }));
