/**
 * hybridSearch pipeline stages (refactor wave 1, W4 hybrid): the two keyword-only return paths (no embedding provider; every vector arm empty).
 * Each stage reads the resolved request (HybridRequest, request.ts) and
 * writes its per-request accumulators only as `req.<field>`.
 */
import { type HybridRequest, applyIdentityBoosts, emitHybridMeta } from './request.ts';
import type { LexicalArms } from './arms.ts';
import { type PostFusionOpts, RRF_K, rrfFusionWeighted, runPostFusionStages, stampContentFlags, stampUnverifiedExtractions } from '../hybrid.ts';
import { type RelationalEvidenceSlotDecision, ensureRelationalEvidenceSlot } from '../relational-recall.ts';
import type { SearchResult } from '../../types.ts';
import { applyAliasHop } from '../alias-hop.ts';
import { applyExactLookupTier } from '../exact-lookup.ts';
import { dedupResults } from '../dedup.ts';
import { enforceTokenBudget } from '../token-budget.ts';
import { pushDegraded, stampBudgetStage } from './degraded.ts';
import { stampEvidence } from '../evidence.ts';
import { applyEvidenceGate } from '../decide-stage.ts';
import { warnOncePerProcess } from '../../utils.ts';

/** No embedding provider (and no multimodal route): keyword + title + relational only. */
export async function searchWithoutEmbeddings(
  req: HybridRequest,
  { earlyModality, keywordResults, titleResults, exactLookupOpts }: LexicalArms,
  relationalList: SearchResult[],
  postFusionOpts: PostFusionOpts,
  providerProbe: string | undefined,
): Promise<SearchResult[]> {
  const { engine, query, opts, resolvedMode, resolvedCol, limit, offset, suggestions, detailResolved, ctBoost, aliasHopOpts, degraded } = req;
  // v0.43 — fuse the relational arm with keyword so typed-edge answers
  // survive on the no-embedding-provider path (the relational win is most
  // valuable exactly when vector is unavailable). The title arm fuses here
  // too — an exact-title lookup on a keyless install is precisely where
  // chunk-grain keyword FTS alone fails (D1).
  // issue #160: stamp unverified stubs BEFORE fusion so the compiled-truth
  // boost skips them (flag survives fusion's result spread).
  await stampUnverifiedExtractions(engine, [...keywordResults, ...titleResults, ...relationalList], opts);
  let noEmbedResults = keywordResults;
  if (relationalList.length > 0 || titleResults.length > 0) {
    const fk = opts?.rrfK ?? RRF_K;
    const noEmbedLists = [{ list: keywordResults, k: fk }];
    if (titleResults.length > 0) noEmbedLists.push({ list: titleResults, k: fk });
    if (relationalList.length > 0) noEmbedLists.push({ list: relationalList, k: fk });
    noEmbedResults = rrfFusionWeighted(noEmbedLists, ctBoost);
  }
  if (noEmbedResults.length > 0) {
    await runPostFusionStages(engine, noEmbedResults, postFusionOpts);
    await applyIdentityBoosts(req, noEmbedResults);
    noEmbedResults.sort((a, b) => b.score - a.score);
  }
  // T3/T4 — alias hop + evidence stamp even without an embedding provider
  // (the named-thing fix is most valuable exactly when vector is unavailable).
  const noEmbedPreExact = await applyAliasHop(engine, dedupResults(noEmbedResults), query, aliasHopOpts);
  // #1663 — structural exact-lookup tier (slug / exact-title identity).
  const noEmbedHopped = await applyExactLookupTier(engine, noEmbedPreExact, query, exactLookupOpts);
  stampEvidence(noEmbedHopped, { cosineFloor: resolvedMode.evidence_cosine_floor });
  // System One S3 evidence gate (no-op when the slot is off), at the fused path's position.
  const noEmbedGated = await applyEvidenceGate(req.decide, query, noEmbedHopped);
  // #3995 — guaranteed page-1 relational evidence: a fired arm's answer is
  // often lexically unrecoverable, so its single-arm fused row can land
  // beyond the limit slice on keyword-heavy corpora. Promote/inject before
  // slicing (first page only; pure no-op when the arm didn't fire).
  let noEmbedPool = noEmbedGated;
  let noEmbedRelSlot: RelationalEvidenceSlotDecision | undefined;
  if (relationalList.length > 0) {
    const r = ensureRelationalEvidenceSlot(noEmbedGated, relationalList, limit, offset, {
      cosineFloor: resolvedMode.evidence_cosine_floor,
    });
    noEmbedPool = r.pool;
    noEmbedRelSlot = r.decision;
  }
  const noEmbedSliced = noEmbedPool.slice(offset, offset + limit);
  // v0.32.3 search-lite: budget enforcement on the no-embedding-provider path.
  const { results: noEmbedBudgeted, meta: noEmbedBudgetMeta } = enforceTokenBudget(noEmbedSliced, resolvedMode.tokenBudget);
  await stampContentFlags(engine, noEmbedBudgeted, opts);
  req.lastResultsCount = noEmbedBudgeted.length;
  req.lastRank1Score = noEmbedBudgeted[0] ? (noEmbedBudgeted[0].base_score ?? noEmbedBudgeted[0].score) : undefined;
  // WP2/T3 — no silent bypass: the keyword-only-config branch names why
  // vector didn't run, and whether the keyword arm itself came up empty
  // (skipped-by-modality is not a keyword miss, hence the image gate).
  // System One S6 fire retrieval asks for keyword-only on purpose: vector is not degraded.
  if (!opts?.decide?.keywordOnly) {
    pushDegraded(degraded, 'embed_unavailable', 'no_provider');
    // #3808: meta names the degradation for programmatic callers, but a CLI
    // human never saw it — mirror the embed-failure warn (once per process,
    // stderr) with the diagnose reason so a silently keyword-only brain is
    // visible the first time it ships results.
    try {
      const { diagnoseEmbedding } = await import('../../ai/gateway.ts');
      const diag = diagnoseEmbedding(providerProbe);
      const reason = diag.ok ? 'provider_unreachable' : (diag.reason ?? 'provider_unreachable');
      warnOncePerProcess(
        'search-vector-leg-unavailable',
        `[gbrain] vector search unavailable (${reason}) — results are keyword-only. Run \`gbrain doctor\` to diagnose.`,
      );
    } catch {
      // Fail-open like every sibling stage: the warning is best-effort and a
      // gateway import/diagnose throw must never fail the already-computed
      // keyword-only degraded results it exists to explain.
    }
  }
  if (keywordResults.length === 0 && earlyModality !== 'image') {
    pushDegraded(degraded, 'keyword_zero');
  }
  stampBudgetStage(degraded, noEmbedBudgetMeta);
  emitHybridMeta(req, {
    vector_enabled: false,
    detail_resolved: detailResolved,
    expansion_applied: false,
    intent: suggestions.intent,
    mode: resolvedMode.resolved_mode,
    embedding_column: resolvedCol.name,
    degraded: [...degraded],
    retrieved_count: noEmbedSliced.length,
    ...(resolvedMode.tokenBudget && resolvedMode.tokenBudget > 0
      ? { token_budget: noEmbedBudgetMeta }
      : {}),
    ...(noEmbedRelSlot ? { relational_evidence_slot: noEmbedRelSlot } : {}),
  });
  return noEmbedBudgeted;
}

/** Every vector arm came back empty or failed: keyword fallback. */
export async function searchVectorFallback(
  req: HybridRequest,
  { earlyModality, keywordResults, titleResults, exactLookupOpts }: LexicalArms,
  relationalList: SearchResult[],
  postFusionOpts: PostFusionOpts,
): Promise<SearchResult[]> {
  const { engine, query, opts, resolvedMode, resolvedCol, limit, offset, suggestions, detailResolved, ctBoost, aliasHopOpts, degraded } = req;
  // Embed/vector failed silently; record that vector did not run.
  // v0.29.1 codex pass-2 #4: this is the third return path. Apply
  // post-fusion stages here too — without it, salience='on' silently
  // does nothing on embed failures.
  // v0.43: fuse the relational arm with keyword via RRF so typed-edge
  // answers survive even when vector is unavailable. The title arm fuses
  // here too (same rationale as the no-embedding-provider path — D1).
  // issue #160: stamp unverified stubs BEFORE fusion (see the
  // no-embedding-provider path for rationale).
  await stampUnverifiedExtractions(engine, [...keywordResults, ...titleResults, ...relationalList], opts);
  let fallbackResults = keywordResults;
  if (relationalList.length > 0 || titleResults.length > 0) {
    const fk = opts?.rrfK ?? RRF_K;
    const fallbackLists = [{ list: keywordResults, k: fk }];
    if (titleResults.length > 0) fallbackLists.push({ list: titleResults, k: fk });
    if (relationalList.length > 0) fallbackLists.push({ list: relationalList, k: fk });
    fallbackResults = rrfFusionWeighted(fallbackLists, ctBoost);
  }
  if (fallbackResults.length > 0) {
    await runPostFusionStages(engine, fallbackResults, postFusionOpts);
    await applyIdentityBoosts(req, fallbackResults);
    fallbackResults.sort((a, b) => b.score - a.score);
  }
  const kwPreExact = await applyAliasHop(engine, dedupResults(fallbackResults), query, aliasHopOpts);
  // #1663 — structural exact-lookup tier (slug / exact-title identity).
  const kwHopped = await applyExactLookupTier(engine, kwPreExact, query, exactLookupOpts);
  stampEvidence(kwHopped, { cosineFloor: resolvedMode.evidence_cosine_floor });
  // System One S3 evidence gate (no-op when the slot is off), at the fused path's position.
  const kwGated = await applyEvidenceGate(req.decide, query, kwHopped);
  const kwSliced = kwGated.slice(offset, offset + limit);
  // v0.32.3 search-lite: budget enforcement on the keyword-fallback path too.
  const { results: kwBudgeted, meta: kwBudgetMeta } = enforceTokenBudget(kwSliced, resolvedMode.tokenBudget);
  await stampContentFlags(engine, kwBudgeted, opts);
  req.lastResultsCount = kwBudgeted.length;
  req.lastRank1Score = kwBudgeted[0] ? (kwBudgeted[0].base_score ?? kwBudgeted[0].score) : undefined;
  // WP2/T3 — the embed/vector failure that emptied vectorArms already
  // pushed its stage above; add the keyword-arm outcome (skipped-by-
  // modality is not a keyword miss, hence the image gate).
  if (keywordResults.length === 0 && earlyModality !== 'image') {
    pushDegraded(degraded, 'keyword_zero');
  }
  stampBudgetStage(degraded, kwBudgetMeta);
  emitHybridMeta(req, {
    vector_enabled: false,
    detail_resolved: detailResolved,
    expansion_applied: req.expansionApplied,
    intent: suggestions.intent,
    mode: resolvedMode.resolved_mode,
    embedding_column: resolvedCol.name,
    degraded: [...degraded],
    retrieved_count: kwSliced.length,
    ...(resolvedMode.tokenBudget && resolvedMode.tokenBudget > 0
      ? { token_budget: kwBudgetMeta }
      : {}),
  });
  return kwBudgeted;
}
