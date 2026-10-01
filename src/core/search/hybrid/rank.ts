/**
 * hybridSearch pipeline stages (refactor wave 1, W4 hybrid): fusion, structural expansion, rerank, identity tiers, return sizing and the main return.
 * Each stage reads the resolved request (HybridRequest, request.ts) and
 * writes its per-request accumulators only as `req.<field>`.
 */
import type { ModalityMode } from '../query-intent.ts';
import { type AdaptiveReturnDecision, adaptiveReturnFromConfig, applyAdaptiveReturn, resolveAdaptiveReturn } from '../return-policy.ts';
import { type AutocutDecision, applyAutocut } from '../autocut.ts';
import { type ExactLookupOpts, applyExactLookupTier } from '../exact-lookup.ts';
import { type FusionListEntry, type VectorArm, composeFusionLists } from '../fusion-lists.ts';
import { type HybridRequest, applyIdentityBoosts, emitHybridMeta } from './request.ts';
import type { KeywordArmConfidenceDecision } from '../arm-confidence.ts';
import { type MetadataBoostGateDecision, decideMetadataBoosts, lexicalArmsVoted } from '../metadata-boost-gate.ts';
import { type PostFusionOpts, RRF_K, cosineReScore, resolveWalkDedupCap, rrfFusionWeighted, runPostFusionStages, stampContentFlags, stampUnverifiedExtractions, textVectorArmNonEmpty } from '../hybrid.ts';
import { type RelationalEvidenceSlotDecision, ensureRelationalEvidenceSlot } from '../relational-recall.ts';
import { type RelationalRerankPinDecision, pinRelationalRows } from '../relational-rerank-pin.ts';
import { type RerankFailedReason, type RerankPassThroughReason, type RerankSkipReason, applyReranker } from '../rerank.ts';
import type { RerankMeta } from '../../ai/gateway.ts';
import { applyEvidenceGate, recordRerankReceipts, startRerankShadow } from '../decide-stage.ts';
import { rerankEgressDenied } from '../decide-retrieval.ts';
import type { SearchResult } from '../../types.ts';
import { applyAliasHop } from '../alias-hop.ts';
import { effectiveRrfK } from '../intent-weights.ts';
import { enforceTokenBudget } from '../token-budget.ts';
import { expandAnchors, hydrateChunks } from '../two-pass.ts';
import { parseRelationalQuery } from '../relational-intent.ts';
import { pushDegraded, stampBudgetStage } from './degraded.ts';
import { requiresSafeChunks } from '../safe-chunks.ts';
import { stampEvidence } from '../evidence.ts';

/** RRF over every role-tagged arm, cosine rescore, then the post-fusion boosts. */
export async function fuseArms(
  req: HybridRequest,
  { vectorArms, keywordResults, titleResults, relationalList, effectiveModality, queryEmbedding, imageQueryEmbedding, unifiedDone, postFusionOpts }: {
    vectorArms: VectorArm[]; keywordResults: SearchResult[]; titleResults: SearchResult[]; relationalList: SearchResult[];
    effectiveModality: ModalityMode; queryEmbedding: Float32Array | null; imageQueryEmbedding: Float32Array | null;
    unifiedDone: boolean; postFusionOpts: PostFusionOpts;
  },
) {
  const { engine, query, opts, resolvedMode, resolvedCol, intentWeights, ctBoost, degraded } = req;
  // Merge all result lists via RRF (includes normalization + boost)
  // Skip boost for detail=high (temporal/event queries want natural ranking)
  //
  // v0.32.x search-lite: when intent weighting is on, run RRF with
  // per-list effective k values — entity/event intents nudge keyword
  // contributions up by lowering their k. The base rrfK still controls
  // the overall RRF shape; intent weights tilt within that shape.
  const baseRrfK = opts?.rrfK ?? RRF_K;
  const keywordK = effectiveRrfK(baseRrfK, intentWeights.keywordWeight);
  const vectorK = effectiveRrfK(baseRrfK, intentWeights.vectorWeight);

  // v0.36 cross-modal (D6): in 'both' mode, vectorArms carries text arms
  // plus an `image` arm. composeFusionLists applies per-modality RRF k
  // (textRrfK / imageRrfK) only when BOTH an image arm and a text arm are
  // present; in 'text' and 'image' modes — and in 'both' mode whose image
  // branch fell open — every arm fuses at the standard vectorK.
  const textRrfK = effectiveRrfK(baseRrfK, resolvedMode.cross_modal_both_text_weight);
  const imageRrfK = effectiveRrfK(baseRrfK, resolvedMode.cross_modal_both_image_weight);

  // 2026-09 fix wave (#3617 follow-up): OR-relaxed lexical rows only vote in
  // RRF when EVERY vector list came back empty — the fallback's designed
  // rescue case (keyword-only mode, keyless installs, embedding outages; the
  // noEmbed and vector-failure paths above keep them unconditionally). When
  // the vector arm is healthy, relaxed rows are dropped pre-fusion: they are
  // OR-of-common-terms matches whose rank evidence is noise-shaped, and at
  // full RRF weight they demonstrably outvote correct semantic results
  // (LongMemEval fresh-pin receipt: hybrid recall_all@5 51.3% vs vector-only
  // 93.8%; per-question probe shows gold at vector ranks 0-2 sinking to
  // fused ranks 14-17 under relaxed-arm votes, and recovering exactly on
  // kof-off). Strict-match keyword/title rows are unaffected.
  //
  // The gate judges TEXT vector arms only (red-team, 2026-09): in 'both'
  // mode the `image` arm must not veto the lexical rescue — a
  // text-intent query whose text embeds returned zero rows (mid-backfill,
  // image-heavy corpus) would otherwise lose its only text-side recall arm
  // to image votes. ANY nonempty text list counts as healthy, including a
  // surviving expansion-variant list: variant hits are real semantic
  // evidence, which still beats noise-shaped OR matches (adjudicated vs the
  // stricter original-list-only reading).
  const vectorArmNonEmpty = textVectorArmNonEmpty(vectorArms);
  const keywordFusionList = vectorArmNonEmpty
    ? keywordResults.filter((r) => !r.keyword_relaxed)
    : keywordResults;
  const titleFusionList = vectorArmNonEmpty
    ? titleResults.filter((r) => !r.keyword_relaxed)
    : titleResults;
  // Observability for both demotion outcomes (adversarial review, 2026-09):
  // muted relaxed rows get a meta COUNT (common, normal operation — never a
  // degraded stage, which would collapse the cache TTL for every query with
  // zero strict lexical matches); carried relaxed rows on a vector-ENABLED
  // run get a degraded stage so the cache write takes the short TTL instead
  // of pinning transitional noise for the full TTL.
  const relaxedDropped =
    (keywordResults.length - keywordFusionList.length) +
    (titleResults.length - titleFusionList.length);
  if (
    !vectorArmNonEmpty &&
    (keywordFusionList.some((r) => r.keyword_relaxed) || titleFusionList.some((r) => r.keyword_relaxed))
  ) {
    pushDegraded(degraded, 'keyword_relaxed_carried');
  }

  // ONE composition point (fusion-lists.ts): role-tagged vector arms → k +
  // weight, then keyword (keywordK), title (keywordK, only if non-empty — the
  // D1 title arm is the same lexical-evidence class, no new tunable; its
  // fetch was gated on earlyModality), then the v0.43 relational arm (neutral
  // baseRrfK, text/both only; built above so it also serves the keyword-only
  // fallback path). Expansion variant/clause arms share the resolved
  // `expansion_variant_budget` (per-call → config → bundle) as total RRF
  // weight (`weight / (k + rank)`); null = legacy weight 1 on every list.
  // Phase E2 (Cat 13): the keyword + title lists fuse at half weight when
  // the keyword arm is weak (arm-confidence.ts) — non-relational queries
  // with a voting text vector arm only; the decision is stamped on meta
  // (`keyword_arm_confidence`) even with the floor off, for calibration.
  let keywordArmConfidence: KeywordArmConfidenceDecision | undefined;
  const allLists: FusionListEntry[] = composeFusionLists({
    arms: vectorArms,
    keywordFusionList,
    titleFusionList,
    relationalList,
    includeRelational: effectiveModality !== 'image',
    relationalQuery: parseRelationalQuery(query) !== null,
    onKeywordArmConfidence: (d) => { keywordArmConfidence = d; },
    ks: { vectorK, textRrfK, imageRrfK, keywordK, baseRrfK },
    knobs: {
      expansionVariantBudget: resolvedMode.expansion_variant_budget,
      keywordArmConfidenceFloor: resolvedMode.keyword_arm_confidence_floor,
    },
  });

  // issue #160: stamp unverified auto-extracted stubs across ALL candidate
  // arms BEFORE fusion so the compiled-truth authority boost skips them.
  await stampUnverifiedExtractions(engine, allLists.flatMap((l) => l.list), opts);

  let fused = rrfFusionWeighted(allLists, ctBoost);

  // Cosine re-scoring before dedup so semantically better chunks survive.
  // v0.36 (D9): hydrate from the active embedding column so rescore happens
  // in the same vector space the HNSW just ranked in. Pre-v0.36 this
  // always pulled from `embedding` and silently corrupted alt-column ranks.
  if (queryEmbedding) {
    // Unified routing embedded the query with the multimodal model, so the
    // rescore must hydrate the multimodal column, not the text column.
    fused = await cosineReScore(
      engine, fused, queryEmbedding, unifiedDone ? 'embedding_multimodal' : resolvedCol.name,
      imageQueryEmbedding && !unifiedDone ? { queryEmbedding: imageQueryEmbedding, column: 'embedding_image' } : undefined,
    );
  }

  // Phase E3 (Cat 13): metadata boost gate — decided from the SAME lexical
  // lists composeFusionLists just fused (post relaxed-row demotion); image
  // modality never skips (no lexical arm ran); stamped on meta even under `always`.
  const metadataBoostGate = decideMetadataBoosts({
    gate: resolvedMode.metadata_boost_gate, modality: effectiveModality,
    lexicalVoted: lexicalArmsVoted({
      keywordFusionList, titleFusionList, relationalList, includeRelational: effectiveModality !== 'image',
    }),
  });

  // v0.29.1: post-fusion stages (backlink + salience + recency) run via
  // runPostFusionStages so all three early-return paths share the same
  // boost surface. Salience and recency are independent axes — either,
  // both, or neither fires depending on resolved modes.
  if (fused.length > 0) {
    await runPostFusionStages(engine, fused, {
      ...postFusionOpts, skipMetadataBoosts: !metadataBoostGate.boosts_applied,
    });
    // v0.32.x search-lite: intent exact-match boost (entity/event intents).
    // No-op when boost factor is 1.0 (general intent or weighting disabled).
    await applyIdentityBoosts(req, fused);
    fused.sort((a, b) => b.score - a.score);
  }
  return { fused, relaxedDropped, keywordArmConfidence, metadataBoostGate };
}

/** A2 two-pass structural expansion (default off); grows `fused` in place and returns the dedup options. */
export async function expandStructuralNeighbors(req: HybridRequest, fused: SearchResult[]) {
  const { engine, opts, limit } = req;
  // v0.20.0 Cathedral II Layer 7 (A2): two-pass structural expansion.
  // Default OFF. When opts.walkDepth > 0 OR opts.nearSymbol is set, we
  // walk code_edges_chunk + code_edges_symbol up to walkDepth hops from
  // the anchor set (top of `fused`). Expanded neighbors get score decayed
  // by 1/(1+hop) from their anchor's score and merge back into the pool.
  //
  // Dedup per-page cap lifts to min(10, walkDepth * 5) when walking —
  // structural neighbors from the same file/class are the whole point
  // of two-pass; clipping them at 2/page defeats A2 (codex F5).
  const walkDepth = Math.min(opts?.walkDepth ?? 0, 2);
  // The optional code walk's raw graph hydration has no row-level read policy.
  // Keep it suspended for untrusted retrieval until that boundary is supported.
  const needsExpansion = !requiresSafeChunks(opts) && (walkDepth > 0 || Boolean(opts?.nearSymbol));
  let dedupOpts = opts?.dedupOpts;

  if (needsExpansion) {
    const anchorSet = fused.slice(0, Math.max(10, limit));
    try {
      const expanded = await expandAnchors(engine, anchorSet, {
        walkDepth,
        nearSymbol: opts?.nearSymbol,
        sourceId: opts?.sourceId,
      });
      // Resolve new chunk IDs (not already in fused) into full rows.
      const existingIds = new Set(fused.map(r => r.chunk_id));
      const newIds = expanded
        .filter(e => !existingIds.has(e.chunk_id))
        .map(e => e.chunk_id);
      if (newIds.length > 0) {
        const hydrated = await hydrateChunks(engine, newIds);
        const scoreById = new Map(expanded.map(e => [e.chunk_id, e.score]));
        for (const r of hydrated) {
          r.score = scoreById.get(r.chunk_id) ?? 0.01;
          fused.push(r);
        }
        fused.sort((a, b) => b.score - a.score);
      }
      // Widen per-page dedup cap when walking — but an EXPLICIT per-call
      // maxPerPage is never LOOSENED (CEO review D8): tightest wins. A
      // caller asking for maxPerPage:1 (session diversity) keeps 1 even
      // under a walk; an explicit cap LOOSER than the walk cap is tightened
      // to it (min of the two); callers without an explicit cap get the
      // widened walk cap as before.
      const capFromWalk = Math.min(10, Math.max(walkDepth * 5, 5));
      dedupOpts = {
        ...(dedupOpts ?? {}),
        maxPerPage: resolveWalkDedupCap(dedupOpts?.maxPerPage, capFromWalk),
      };
    } catch {
      // Expansion is best-effort — missing edge tables or a transient
      // DB error must not break base hybrid retrieval.
    }
  }
  return dedupOpts;
}

/** Cross-encoder rerank (fail-open), then the relational-row pin. */
export async function rerankAndPin(
  req: HybridRequest,
  deduped: SearchResult[],
  relationalList: SearchResult[],
  effectiveModality: ModalityMode,
) {
  const { query, opts, resolvedMode, degraded } = req;
  // v0.35.0.0+: cross-encoder reranker. Slots between dedup and slice so the
  // reranker sees the full candidate pool (its own topNIn caps how many
  // get sent upstream). Fail-open: any error returns deduped unchanged.
  //
  // Resolution: per-call SearchOpts.reranker overrides; otherwise pull
  // from the resolved mode bundle (tokenmax → enabled, others → disabled).
  // The resolved mode's fields already participate in knobsHash, so cache
  // rows naturally segregate by reranker config.
  const rerankerOpts = opts?.reranker ?? {
    enabled: resolvedMode.reranker_enabled,
    topNIn: resolvedMode.reranker_top_n_in,
    topNOut: resolvedMode.reranker_top_n_out,
    model: resolvedMode.reranker_model,
    timeoutMs: resolvedMode.reranker_timeout_ms,
  };

  // is stamped `reranker_skipped` (ranking-only — never shortens the cache TTL
  // or turns an empty result into a degraded miss), and a success-shaped
  // pass-through (#4648: provider answered 200 with an empty/malformed result
  // set) is stamped `rerank_passthrough`, so --explain, telemetry and eval rows
  // can tell "reranked" from "fell through in RRF order" — never stderr.
  // System One S1 (search/decide-stage.ts): Jev shadow scoring starts in
  // parallel; `on` mode writes receipts. Both are no-ops when the slot is off.
  const s1 = req.decide?.policies.rerank;
  req.decide?.budget.anchor();
  const s1Shadow = startRerankShadow(req.decide, query, deduped.slice(0, rerankerOpts.enabled ? rerankerOpts.topNIn : resolvedMode.reranker_top_n_in), rerankerOpts.timeoutMs ?? resolvedMode.reranker_timeout_ms);
  let s1Failure: string | undefined;
  let s1Meta: RerankMeta | undefined;
  // Owner decision: the Jev reranker never receives a candidate from a source in
  // decide.egress.deny_sources; such a query keeps fused order (egress_denied).
  const egressDenied = rerankerOpts.enabled && rerankEgressDenied(req.modeInput.decide, rerankerOpts.model ?? resolvedMode.reranker_model, deduped.slice(0, rerankerOpts.topNIn));
  if (egressDenied) { s1Failure = 'egress_denied'; pushDegraded(degraded, 'reranker_skipped', 'egress_denied'); }
  const reranked = rerankerOpts.enabled && !egressDenied
    ? await applyReranker(query, deduped, {
        ...(rerankerOpts as any),
        ...(s1?.effective === 'on' ? { timeoutMs: Math.max(1, Math.min(rerankerOpts.timeoutMs ?? resolvedMode.reranker_timeout_ms, req.decide!.budget.remaining())) } : {}),
        onSkip: (reason: RerankSkipReason) => { s1Failure = reason; pushDegraded(degraded, 'reranker_skipped', reason); },
        onFailure: (reason: RerankFailedReason) => { s1Failure = reason; pushDegraded(degraded, 'rerank_failed', reason); },
        onPassThrough: (reason: RerankPassThroughReason) => {
          pushDegraded(degraded, 'rerank_passthrough', reason);
          // Chain a per-call callback if the caller supplied one.
          (rerankerOpts as { onPassThrough?: (r: RerankPassThroughReason) => void }).onPassThrough?.(reason);
        },
        onMeta: (m: RerankMeta) => { s1Meta = m; req.rerankMeta = { model_resolved: m.model_resolved }; },
      })
    : deduped;
  if (s1 && rerankerOpts.enabled) recordRerankReceipts(req.decide, query, reranked.slice(0, rerankerOpts.topNIn).filter((r) => s1Failure !== undefined || r.rerank_score !== undefined), s1Meta, s1Failure);
  if (s1Shadow) await s1Shadow(reranked);

  // Ranker wave (R1 receipt) — relational-arm rows bypass reranker DEMOTION:
  // re-pinned above the reranked text rows in fused order, bounded by
  // `relational_rerank_pin` (0 = off). Only when the reranker actually
  // reordered (applyReranker returns its input on every fail-open path; fused
  // order already carries the arm) and never for image modality (the arm is
  // not fused there). Contract + tie policy: relational-rerank-pin.ts.
  let relationalRerankPin: RelationalRerankPinDecision | undefined;
  const rerankPinned = reranked !== deduped && effectiveModality !== 'image'
    ? pinRelationalRows(reranked, relationalList, { max: resolvedMode.relational_rerank_pin, fusedOrder: deduped, onPin: (d) => { relationalRerankPin = d; } })
    : reranked;
  return { rerankPinned, relationalRerankPin };
}

/** Alias hop + exact-lookup tier, evidence stamp, adaptive return, autocut and the relational evidence slot. */
export async function sizeReturnPool(
  req: HybridRequest,
  { rerankPinned, deduped, exactLookupOpts, relationalList, effectiveModality }: {
    rerankPinned: SearchResult[]; deduped: SearchResult[]; exactLookupOpts: ExactLookupOpts;
    relationalList: SearchResult[]; effectiveModality: ModalityMode;
  },
) {
  const { engine, query, opts, resolvedMode, cfgForColumn, limit, offset, suggestions, aliasHopOpts } = req;
  // T3 — free-text alias hop. Runs AFTER rerank so a query that is a page's
  // declared chosen name reliably surfaces that page regardless of how the
  // reranker scored body chunks. Fail-open on pre-v110 brains.
  const preExact = await applyAliasHop(engine, rerankPinned, query, aliasHopOpts);

  // #1663 — structural exact-lookup tier: a query that IS a page identity
  // (slug / exact normalized title) gets that page at rank-1 regardless of
  // how the scorers ranked body chunks. Supersession-filtered inside; reuses
  // the already-fetched title arm (no extra queries); pure no-op for
  // non-lookup-shaped queries. Runs after the alias hop so all three
  // identity surfaces (alias, slug, title) share the same injection shape.
  const aliasHopped = await applyExactLookupTier(engine, preExact, query, exactLookupOpts);

  // T4 — stamp evidence + create_safety so the agent's don't-duplicate
  // decision keys off WHY a page matched, not a raw blended score. Stamp on
  // the full alias-hopped set before any adaptive trim so the kept results
  // carry evidence regardless of where the cap lands.
  stampEvidence(aliasHopped, { cosineFloor: resolvedMode.evidence_cosine_floor });
  // System One S3 evidence gate (no-op when the slot is off): prunes, never reorders.
  const gated = await applyEvidenceGate(req.decide, query, aliasHopped);

  // v0.42 — intent-aware adaptive return-sizing (opt-in, default off). Trim
  // the ranked candidate set to an intent-driven cap BEFORE the limit slice,
  // and only on the first page (offset===0) — paginating a confidence-gated
  // set is incoherent, so paginated calls fall through to the fixed limit.
  // Runs on the alias-hopped set so an alias-injected page (top-of-organic)
  // survives the trim.
  const adaptiveCfg = resolveAdaptiveReturn(
    opts?.adaptiveReturn,
    adaptiveReturnFromConfig(cfgForColumn as Record<string, unknown> | null),
  );
  let returnPool = gated;
  let adaptiveDecision: AdaptiveReturnDecision | undefined;
  if (adaptiveCfg.enabled && offset === 0) {
    // 2026-08 fix wave (E5c): AdaptiveQueryIntent now equals the full
    // QueryIntent union, so the classifier's intent passes through unchanged
    // ('concept' → otherMax, the breadth cap). The cache key folds this SAME
    // intent class (ari= in knobsHash v=27) so cross-intent rows never serve.
    const r = applyAdaptiveReturn(gated, suggestions.intent, adaptiveCfg);
    returnPool = r.kept;
    adaptiveDecision = r.decision;
  }

  // v0.42.3.0 — autocut (score-discontinuity result-sizing). The floor:
  // default-ON in reranked modes (resolvedMode.autocut, resolved per-call >
  // config > bundle like every other knob). Cuts the ranked set at the largest
  // cross-encoder rerank-score cliff, BEFORE the limit slice, first page only.
  // Runs AFTER adaptive-return so an agent-forced intent cap composes (both are
  // trim-only with never-empty failsafes). The reranker scored the full
  // returned set (mode.ts D4: top_n_in = searchLimit), so there is no un-scored
  // tail to wrongly drop; applyAutocut additionally no-ops when <2 items carry
  // a finite rerank_score (covers the fail-open reranker path, where
  // applyReranker returns RRF order with no scores). jumpRatio + minKeep come
  // from the resolved mode (config `search.autocut_jump` /
  // `search.autocut_min_keep` > bundle); minKeep stays the never-empty
  // failsafe (default 1 — raising it floors the cut for operators whose
  // reranker score curves decay without a dramatic cliff).
  // Eval capture hook (plan D24): fires HERE, immediately before applyAutocut,
  // with the exact `returnPool` autocut is about to cut — post alias-hop /
  // exact-lookup / adaptive-return, including their unscored injected rows.
  // Firing right after the reranker (the original placement) captured a pool
  // that was NOT autocut's input, so the replay could not reproduce the live
  // decisions byte-for-byte.
  if (opts?.onRerankPool) {
    try { opts.onRerankPool(returnPool, deduped); } catch { /* eval hook must never break search */ }
  }

  let autocutDecision: AutocutDecision | undefined;
  if (resolvedMode.autocut && offset === 0) {
    const r = applyAutocut(
      returnPool,
      // Pinned relational rows are excluded from the cliff math (low scores by
      // construction) and preserved below — text-row autocut is unchanged.
      // System One rubric scores are level indices, not a calibrated cliff signal.
      (x) => (x.relational_pinned || x.rerank_score_kind === 'rubric' ? undefined : x.rerank_score),
      // v0.46.15 (#1863): minTopScore is the weak-top floor — below it the
      // cliff signal is untrustworthy and autocut no-ops. #3621: minKeep is
      // now the configured floor instead of the hardcoded 1.
      {
        enabled: true,
        jumpRatio: resolvedMode.autocut_jump,
        minKeep: resolvedMode.autocut_min_keep,
        minTopScore: resolvedMode.autocut_min_top,
      },
      // Preserve alias-hop exact matches: applyAliasHop injects the canonical
      // page AFTER reranking, so it has no rerank_score. Without this it would
      // be dropped whenever autocut cuts on the scored set (Codex P1).
      // #1663: same guarantee for structural exact-lookup tier hits (slug /
      // exact-title identity matches also arrive post-rerank, unscored).
      (x) => x.alias_hit === true || x.exact_lookup !== undefined || x.relational_pinned === true,
    );
    returnPool = r.kept;
    autocutDecision = r.decision;
  }

  // #3995 — guaranteed page-1 relational evidence. A fired arm's answer is
  // often lexically unrecoverable (unverified entity stub, single-arm RRF
  // score), so its fused row can land beyond the limit slice on multi-arm
  // corpora, and autocut's preserve predicate only covers alias hits — the
  // relational row (no rerank_score) is exactly what a cut drops. Promote the
  // fused row into the page-1 window, or re-inject the arm's top candidate
  // when it was dropped entirely. First page only; pure no-op otherwise.
  let relationalSlotDecision: RelationalEvidenceSlotDecision | undefined;
  if (relationalList.length > 0 && effectiveModality !== 'image') {
    const r = ensureRelationalEvidenceSlot(returnPool, relationalList, limit, offset, {
      cosineFloor: resolvedMode.evidence_cosine_floor,
    });
    returnPool = r.pool;
    relationalSlotDecision = r.decision;
  }
  return { returnPool, adaptiveDecision, autocutDecision, relationalSlotDecision };
}

/** Main return path: slice, token budget, content flags, meta. */
export async function finalizeHybridResults(
  req: HybridRequest,
  returnPool: SearchResult[],
  { relaxedDropped, adaptiveDecision, autocutDecision, relationalSlotDecision, relationalRerankPin, keywordArmConfidence, metadataBoostGate }: {
    relaxedDropped: number;
    adaptiveDecision: AdaptiveReturnDecision | undefined;
    autocutDecision: AutocutDecision | undefined;
    relationalSlotDecision: RelationalEvidenceSlotDecision | undefined;
    relationalRerankPin: RelationalRerankPinDecision | undefined;
    keywordArmConfidence: KeywordArmConfidenceDecision | undefined;
    metadataBoostGate: MetadataBoostGateDecision;
  },
): Promise<SearchResult[]> {
  const { engine, opts, resolvedMode, resolvedCol, limit, offset, suggestions, detailResolved, degraded } = req;
  const sliced = returnPool.slice(offset, offset + limit);
  // v0.32.3 search-lite: budget enforcement at the main return path.
  // hybridSearchCached used to be the only place this fired; now bare
  // hybridSearch enforces it too so eval-replay + eval-longmemeval see
  // the same budget behavior as the production query op.
  const { results: budgeted, meta: budgetMeta } = enforceTokenBudget(sliced, resolvedMode.tokenBudget);
  await stampContentFlags(engine, budgeted, opts);
  req.lastResultsCount = budgeted.length;
  req.lastRank1Score = budgeted[0] ? (budgeted[0].base_score ?? budgeted[0].score) : undefined;
  stampBudgetStage(degraded, budgetMeta);
  emitHybridMeta(req, {
    vector_enabled: true,
    detail_resolved: detailResolved,
    expansion_applied: req.expansionApplied,
    intent: suggestions.intent,
    mode: resolvedMode.resolved_mode,
    embedding_column: resolvedCol.name,
    degraded: [...degraded],
    retrieved_count: sliced.length,
    ...(resolvedMode.tokenBudget && resolvedMode.tokenBudget > 0
      ? { token_budget: budgetMeta }
      : {}),
    ...(req.vectorPoolUnderfill ? { vector_pool_underfilled: req.vectorPoolUnderfill } : {}),
    ...(relaxedDropped > 0 ? { relaxed_dropped: relaxedDropped } : {}),
    ...(adaptiveDecision ? { adaptive_return: adaptiveDecision } : {}),
    ...(autocutDecision ? { autocut: autocutDecision } : {}),
    ...(relationalSlotDecision ? { relational_evidence_slot: relationalSlotDecision } : {}),
    ...(relationalRerankPin ? { relational_rerank_pin: relationalRerankPin } : {}),
    ...(keywordArmConfidence ? { keyword_arm_confidence: keywordArmConfidence } : {}),
    metadata_boost_gate: metadataBoostGate,
  });
  return budgeted;
}
