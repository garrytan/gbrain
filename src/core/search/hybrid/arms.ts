/**
 * hybridSearch pipeline stages (refactor wave 1, W4 hybrid): lexical, relational and vector candidate arms.
 * Each stage reads the resolved request (HybridRequest, request.ts) and
 * writes its per-request accumulators only as `req.<field>`.
 */
import type { ModalityMode } from '../query-intent.ts';
import type { ExactLookupOpts } from '../exact-lookup.ts';
import type { HybridRequest } from './request.ts';
import { type PostFusionOpts, embedQueryBounded, makeQueryEmbedDeadline } from '../hybrid.ts';
import type { SearchOpts, SearchResult } from '../../types.ts';
import { type VectorArm, pushVectorList } from '../fusion-lists.ts';
import { buildRelationalArm } from '../relational-recall.ts';
import { isAmbiguousModalityQuery } from '../query-intent.ts';
import { isDbAccessFailure } from '../../pg-access-classify.ts';
import { isTimeoutError, pushDegraded } from './degraded.ts';
import { markKeywordHits } from '../evidence.ts';
import { resolveEffectiveRecency, resolveEffectiveSalience } from './effective-modes.ts';
import { searchSalvageEnabled } from '../token-budget.ts';
import { warnOncePerProcess } from '../../utils.ts';

export interface LexicalArms {
  earlyModality: ModalityMode;
  keywordResults: SearchResult[];
  titleResults: SearchResult[];
  exactLookupOpts: ExactLookupOpts;
}

/**
 * SQLSTATE 22007 / 22008: a date bound the database could not cast. That is
 * the caller's input, never a degraded arm, so it surfaces instead of
 * becoming an empty result.
 */
function isDatetimeInputError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '22007' || code === '22008';
}

/** Keyword + title FTS arms, fetched concurrently (fail-open per arm, rethrow when both hit a dead database). */
export async function runLexicalArms(req: HybridRequest): Promise<LexicalArms> {
  const { engine, query, opts, suggestions, searchOpts, identityTierOpts, degraded } = req;
  // Run keyword search (always available, no API key needed).
  //
  // v0.36 cross-modal (D9): skip keyword for 'image'-only modality. Image
  // chunks may have OCR text in chunk_text, but a text-only keyword scan
  // would also surface every text chunk containing the query phrase —
  // not what an image-intent query asked for. Image vector search is the
  // canonical channel for image-modality queries.
  //
  // We classify modality early (it's also computed after for the modality
  // branch). The classification is pure regex via classifyQuery; running it
  // here is cheap.
  const earlyModality = (opts?.crossModal && opts.crossModal !== 'auto')
    ? opts.crossModal
    : (suggestions.suggestedModality ?? 'text');
  // D1 fix (fix/title-retrieval-arm): page-grain title candidate arm,
  // fetched CONCURRENTLY with the keyword arm (Reviewer F7 — independent
  // engine queries). The chunk FTS vector never includes the page title, so
  // an exact-title query can be unretrievable by keyword — this arm queries
  // pages.search_vector (title weight 'A') directly. Runs regardless of
  // query token count: the alias hop (≤6-token guard) and the title-phrase
  // boost are re-rank-only, so LONG exact-title queries — where strict-AND
  // chunk FTS is weakest — need a candidate GENERATOR. Fail-open WITH
  // SIGNAL (Reviewer F2): a SQL error (e.g. a pre-search_vector brain)
  // degrades to no title candidates, but warns once per process so a
  // broken engine arm cannot ship dark.
  // db-availability loop: per-arm fail-open is for DEGRADED arms (schema
  // gaps, pre-migration brains) — it must never convert a DEAD DATABASE into
  // an empty success. Capture access-class errors PER ARM; rethrow only when
  // BOTH lexical arms FAILED with one (an arm that succeeded — even with
  // zero rows — proves the DB is alive, and the vector arms may still
  // serve). The classified database_error envelope (GBRAIN_DB_ACCESS
  // marker) then reaches the caller instead of a silent [].
  let keywordAccessError: unknown = null;
  let titleAccessError: unknown = null;
  const [keywordResults, titleResults]: [SearchResult[], SearchResult[]] =
    earlyModality === 'image'
      ? [[], []]
      : await Promise.all([
          engine.searchKeyword(query, searchOpts).catch((err: unknown) => {
            if (isDatetimeInputError(err)) throw err;
            if (isDbAccessFailure(err)) keywordAccessError = err;
            pushDegraded(degraded, 'keyword_arm_failed', isTimeoutError(err) ? 'timeout' : 'provider_error');
            warnOncePerProcess(
              'search-keyword-arm-failed',
              `[gbrain] searchKeyword arm failed (fail-open, keyword candidates skipped): ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            return [] as SearchResult[];
          }),
          engine.searchTitles(query, searchOpts).catch((err: unknown) => {
            if (isDatetimeInputError(err)) throw err;
            if (isDbAccessFailure(err)) titleAccessError = err;
            pushDegraded(degraded, 'title_arm_failed', isTimeoutError(err) ? 'timeout' : 'provider_error');
            warnOncePerProcess(
              'search-titles-arm-failed',
              `[gbrain] searchTitles arm failed (fail-open, title candidates skipped): ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            return [] as SearchResult[];
          }),
        ]);
  if (keywordAccessError && titleAccessError) {
    throw keywordAccessError;
  }
  const exactLookupOpts: ExactLookupOpts = {
    ...identityTierOpts,
    titleCandidates: titleResults,
    takesHoldersAllowList: opts?.takesHoldersAllowList,
    // #4480: gate tier injections on the caller's shape filters.
    type: opts?.type,
    types: opts?.types,
  };
  // #3783 — stamp lexical-arm membership pre-fusion so evidence's
  // keyword_exact label is earned by an actual FTS hit, never by a solid
  // blended score alone. Both arms are the lexical-evidence class (chunk
  // FTS + title FTS); vector/relational arms are deliberately NOT marked.
  markKeywordHits(keywordResults);
  markKeywordHits(titleResults);
  return { earlyModality, keywordResults, titleResults, exactLookupOpts };
}

/** Post-fusion boost options shared by all three return paths. */
export function buildPostFusionOpts(req: HybridRequest): PostFusionOpts {
  const { query, opts, resolvedMode, suggestions, intentWeightingOn } = req;
  // v0.29.1: resolve salience/recency from caller (back-compat aliases for
  // PR #618's `recencyBoost` numeric scale) or fall back to the heuristic.
  // The wrapper fires from ALL THREE return paths (codex pass-1 #2 + pass-2 #4).
  // wave-g: extracted to resolveEffectiveSalience/resolveEffectiveRecency so
  // hybridSearchCached's knobs-hash key parts (sal=/rec=, v=24) resolve
  // through the IDENTICAL chain — drift here would key cache rows under a
  // different mode than the stored results used.
  const salienceMode: 'off' | 'on' | 'strong' = resolveEffectiveSalience(opts, suggestions);
  const recencyMode: 'off' | 'on' | 'strong' =
    resolveEffectiveRecency(opts, suggestions, intentWeightingOn);
  const postFusionOpts: PostFusionOpts = {
    sourceId: opts?.sourceId,
    sourceIds: opts?.sourceIds,
    excludePrivate: opts?.excludePrivate,
    requireSafeChunks: opts?.requireSafeChunks,
    takesHoldersAllowList: opts?.takesHoldersAllowList,
    applyBacklinks: true,
    salience: salienceMode,
    recency: recencyMode,
    // v0.35.6.0 — floor-ratio gate threaded from resolved mode. Default
    // undefined for all 3 bundles → no behavior change unless caller sets
    // SearchOpts.floorRatio or `search.floor_ratio` config key.
    floorRatio: resolvedMode.floor_ratio,
    // v0.40.4 — graph_signals stage threaded from resolved mode. Defaults
    // per ModeBundle (conservative=false, balanced/tokenmax=true). Per-call
    // SearchOpts.graph_signals overrides through resolveSearchMode.
    // Without this thread, the entire graph-signals wave is dead code —
    // codex outside-voice caught the missing wire pre-merge.
    graphSignalsEnabled: resolvedMode.graph_signals,
    // T2 — title-phrase boost threaded from resolved mode (`title_boost`).
    // The raw query drives the matcher; default factor when the knob is unset.
    query,
    titleBoost: resolvedMode.title_boost,
  };
  return postFusionOpts;
}

/** v0.43 relational recall arm, built once before any return path. */
export async function buildRelationalList(req: HybridRequest): Promise<SearchResult[]> {
  const { engine, query, opts, resolvedMode } = req;
  // v0.43 — build the relational recall arm ONCE here, before any return
  // path, so typed-edge answers contribute on ALL THREE paths: the
  // no-embedding-provider path, the embed-failed keyword fallback, and the
  // main RRF path. Parsed from the original query (deterministic); empty for
  // non-relational queries → pure no-op. (Modality gate lives on the main
  // path; the parser only matches text-shaped relational queries anyway.)
  let relationalList: SearchResult[] = [];
  if (resolvedMode.relationalRetrieval) {
    relationalList = await buildRelationalArm(engine, query, {
      sourceId: opts?.sourceId,
      sourceIds: opts?.sourceIds,
      depth: resolvedMode.relational_retrieval_depth,
      limit: opts?.limit ?? resolvedMode.searchLimit,
      // #4352 remediation: the arm hydrates titles + compiled_truth snippets
      // straight from pages — thread the caller's private-page gate or a
      // remote relational query bypasses the keyword/vector visibility clause.
      excludePrivate: opts?.excludePrivate,
      requireSafeChunks: opts?.requireSafeChunks,
      takesHoldersAllowList: opts?.takesHoldersAllowList,
      onMeta: opts?.onRelationalMeta,
    });
  }
  return relationalList;
}

/** Modality routing (with the opt-in LLM tie-break) and query expansion. */
export async function resolveModalityAndQueries(req: HybridRequest) {
  const { query, opts, resolvedMode, suggestions, degraded } = req;
  const explicitModality =
    opts?.crossModal && opts.crossModal !== 'auto' ? opts.crossModal : undefined;
  let regexModality = explicitModality ?? suggestions.suggestedModality ?? 'text';
  // LLM tie-break fires ONLY when:
  //   - no explicit per-call override
  //   - regex returned 'text' (not confident image/both)
  //   - operator opted in via search.cross_modal.llm_intent
  //   - isAmbiguousModalityQuery says the query is genuinely ambiguous
  if (
    explicitModality === undefined &&
    regexModality === 'text' &&
    resolvedMode.cross_modal_llm_intent &&
    isAmbiguousModalityQuery(query)
  ) {
    try {
      const { classifyModalityWithLLM } = await import('../llm-intent.ts');
      regexModality = await classifyModalityWithLLM(query, 'text');
    } catch {
      // Fail-open: regex result stands.
    }
  }
  const effectiveModality = regexModality;
  const unifiedRouting = resolvedMode.unified_multimodal === true;

  // Determine query variants (optionally with expansion)
  // expandQuery already includes the original query in its return value,
  // so we use it directly instead of prepending query again.
  // v0.32.3 search-lite: expansion fires when (a) resolved mode says yes and
  // (b) an expandFn is wired in. The mode bundle is the default; per-call
  // SearchOpts.expansion still wins via resolveSearchMode's chain.
  //
  // D9: image-modality skips expansion regardless of mode bundle.
  let queries = [query];
  const expansionAllowed = resolvedMode.expansion && effectiveModality !== 'image';
  if (expansionAllowed && opts?.expandFn) {
    try {
      const expanded = await opts.expandFn(query);
      // INVARIANT: queries[0] IS the caller's query. Both fan-outs below tag
      // index 0 as the `original` arm (weight 1, cosine re-score vector), so
      // an expandFn that omits or reorders the original would silently hand
      // the anchor role to a variant. Enforce it here (and dedupe repeats so
      // a duplicated variant can't double-vote) rather than trusting every
      // expandFn (LLM expandQuery, eval replay, harness overrides).
      queries = [query, ...Array.from(new Set(expanded.filter((q) => q !== query)))];
      // "Applied" = produced variants beyond the original, not just called.
      req.expansionApplied = queries.length > 1;
    } catch (err) {
      // Expansion failure is non-fatal — original query proceeds alone,
      // stamped so the consumer knows the multi-query recall arm was lost.
      pushDegraded(degraded, 'expansion_failed', isTimeoutError(err) ? 'timeout' : 'provider_error');
    }
  }
  return { effectiveModality, unifiedRouting, queries };
}

export interface VectorArmsResult {
  vectorArms: VectorArm[];
  queryEmbedding: Float32Array | null;
  imageQueryEmbedding: Float32Array | null;
  unifiedDone: boolean;
}

/** Unified multimodal, image and text vector arms (salvage mode keeps surviving embeds/arms). */
export async function runVectorArms(
  req: HybridRequest,
  { effectiveModality, unifiedRouting, queries, multimodalProviderProbe }: {
    effectiveModality: ModalityMode; unifiedRouting: boolean; queries: string[]; multimodalProviderProbe: string;
  },
): Promise<VectorArmsResult> {
  const { engine, query, opts, resolvedMode, resolvedCol, searchOpts, degraded } = req;
  // Embed all query variants and run vector search.
  //
  // v0.36 cross-modal wave routing:
  //   - 'text' (default): existing text-embedding path, unchanged
  //   - 'image': embedQueryMultimodal + searchVector(embedding_image), skip keyword
  //   - 'both': text + image vector searches in parallel; merged via weighted RRF
  //
  // Every vector list is a ROLE-tagged arm (fusion-lists.ts): the k/weight
  // mapping and the text-only demotion gate read the role, never a position.
  const vectorArms: VectorArm[] = [];
  let queryEmbedding: Float32Array | null = null;
  let imageVectorList: SearchResult[] | null = null;
  let crossModalFellOpen = false;

  // Phase 3 unified routing: when on, route ALL queries through Voyage
  // multimodal-3 + embedding_multimodal column. Bypasses the dual-column
  // branching below — but with D8 fail-open: if the unified path returns
  // zero rows AND the operator hasn't opted into strict unified-only mode,
  // fall through to the dual-column text path. unified_multimodal_only
  // disables the fallback.
  let unifiedDone = false;
  if (unifiedRouting) {
    try {
      const { isAvailable: aiIsAvailable, embedQueryMultimodal } = await import('../../ai/gateway.ts');
      // Probe the MULTIMODAL provider, not the global default — on a
      // multimodal-only install the global default (text) is absent but the
      // multimodal provider is configured, and unified routing embeds via it.
      if (!aiIsAvailable('embedding', multimodalProviderProbe)) {
        throw new Error('gateway not configured for embedding — unified multimodal would also fail');
      }
      const unifiedEmbedding = await embedQueryMultimodal(query);
      const unifiedSearchOpts: SearchOpts = {
        ...searchOpts,
        embeddingColumn: 'embedding_multimodal',
      };
      const unifiedList = await engine.searchVector(unifiedEmbedding, unifiedSearchOpts);
      // D8 fail-open: zero rows + not strict-mode → fall through to dual-column.
      if (unifiedList.length === 0 && !resolvedMode.unified_multimodal_only) {
        console.error(
          `[cross-modal] unified_multimodal returned zero rows for query="${query.slice(0, 60)}". ` +
          `Falling back to dual-column text path (partial coverage during reindex). ` +
          `Set search.unified_multimodal_only=true to bypass this fallback when reindex completes.`,
        );
      } else {
        pushVectorList(vectorArms, unifiedList, 'original');
        queryEmbedding = unifiedEmbedding;
        unifiedDone = true;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[cross-modal] unified_multimodal embed failed; falling back to dual-column path. reason=${reason}`,
      );
      crossModalFellOpen = true;
      // WP2/T3 — the configured unified arm fell over; dual-column carried it.
      pushDegraded(degraded, 'vector_arm_failed', isTimeoutError(err) ? 'timeout' : 'provider_error');
    }
  }

  let imageQueryEmbedding: Float32Array | null = null;
  if (!unifiedDone && (effectiveModality === 'image' || effectiveModality === 'both')) {
    // Attempt image-side embedding. Fail-open: if multimodal is unconfigured
    // OR the embed throws, log a structured warning and fall through to text.
    try {
      const { isAvailable: aiIsAvailable, embedQueryMultimodal } = await import('../../ai/gateway.ts');
      // Probe the MULTIMODAL provider, not the global default — the image side
      // embeds via the multimodal model, which may be configured even when the
      // text/global-default embedding provider is absent (multimodal-only).
      if (!aiIsAvailable('embedding', multimodalProviderProbe)) {
        throw new Error('gateway not configured for embedding — multimodal would also fail');
      }
      const imageEmbedding = await embedQueryMultimodal(query);
      imageQueryEmbedding = imageEmbedding;
      const imageSearchOpts: SearchOpts = {
        ...searchOpts,
        embeddingColumn: 'embedding_image',
      };
      const imageList = await engine.searchVector(imageEmbedding, imageSearchOpts);
      for (const r of imageList) {
        r.modality = r.modality ?? 'image';
      }
      imageVectorList = imageList;
    } catch (err) {
      // Fail-open per behavioral invariant 2.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[cross-modal] image-side embed failed for modality=${effectiveModality}; falling back to text-only. reason=${reason}`,
      );
      crossModalFellOpen = true;
      // WP2/T3 — the image-search branch is no silent bypass: the fell-open
      // arm is named in the meta the surviving text path emits.
      pushDegraded(degraded, 'vector_arm_failed', isTimeoutError(err) ? 'timeout' : 'provider_error');
    }
  }

  if (unifiedDone) {
    // Unified routing already populated vectorArms + queryEmbedding;
    // skip the dual-column branching.
  } else if (effectiveModality === 'image' && imageVectorList !== null) {
    // Image-only path: results come entirely from the image column. Sole
    // arm → composeFusionLists fuses it at vectorK (no text arm to weigh
    // against), exactly as the single-list mapping always did.
    pushVectorList(vectorArms, imageVectorList, 'image');
    queryEmbedding = null; // no text embedding to cosine-re-score against
  } else {
    // 'text' or 'both' (or 'image' that fell open to text). Run the text
    // path normally, with v0.36 (D10) provider-aware embed routing so a
    // query against `embedding_voyage` actually embeds via Voyage, not
    // the global default. Empty embeddingModel falls back to gateway
    // default — preserves pre-v0.36 behavior for the builtin 'embedding'
    // column.
    const embedOpts = resolvedCol.embeddingModel
      ? { embeddingModel: resolvedCol.embeddingModel, dimensions: resolvedCol.dimensions }
      : undefined;
    // v0.42.20.0 (Fix 3) — bound the query embed. Reuse the shared deadline
    // threaded from hybridSearchCached (so the cache-lookup embed + this one
    // share one ~6s budget); direct callers get a fresh deadline. On timeout
    // the embed rejects → salvage below (or keyword-only when all reject).
    const embedDl = opts?._queryEmbedDeadline ?? makeQueryEmbedDeadline();
    // Hermetic eval canaries/CI: queryEmbedFn (non-semantic deterministic
    // embeddings) replaces the gateway query-embed for the text vector arm.
    // No deadline needed — it's a synchronous-ish local computation with no
    // network. Absent queryEmbedFn, the bounded gateway path is unchanged.
    const embedOneQuery = (q: string): Promise<Float32Array> =>
      opts?.queryEmbedFn
        ? Promise.resolve(opts.queryEmbedFn(q))
        : embedQueryBounded(q, embedOpts, embedDl);
    if (!searchSalvageEnabled()) {
      // ENG-7 kill switch (GBRAIN_SEARCH_SALVAGE=off): pre-wave
      // all-or-nothing fan-outs — one variant's failure abandons every
      // embedding and falls back to keyword-only.
      try {
        const embeddings = await Promise.all(queries.map(q => embedOneQuery(q)));
        queryEmbedding = embeddings[0];
        const textLists = await Promise.all(
          embeddings.map(emb => engine.searchVector(emb, searchOpts)),
        );
        for (const list of textLists) {
          for (const r of list) {
            r.modality = r.modality ?? 'text';
          }
        }
        // queries[0] is always the caller's query (expandQuery keeps it first).
        textLists.forEach((list, i) => pushVectorList(vectorArms, list, i === 0 ? 'original' : 'variant'));
        // 'both' mode: also include the image-side list as another input to RRF.
        if (effectiveModality === 'both' && imageVectorList !== null) {
          pushVectorList(vectorArms, imageVectorList, 'image');
        }
      } catch (err) {
        // Embedding failure is non-fatal, fall back to keyword-only —
        // stamped with an enumerated code; raw text to stderr only (D6).
        const timedOut = isTimeoutError(err);
        pushDegraded(degraded, timedOut ? 'embed_timeout' : 'embed_unavailable', timedOut ? 'timeout' : 'provider_error');
        warnOncePerProcess(
          'search-embed-fanout-failed',
          `[gbrain] query embed/vector fan-out failed (keyword fallback): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // WP2/T3 (ENG-15) salvage fan-outs: allSettled on BOTH the embed
      // fan-out and the searchVector fan-out so one variant's failure no
      // longer abandons the survivors (the query-vs-search asymmetry fix).
      const settled = await Promise.allSettled(queries.map(q => embedOneQuery(q)));
      const okEmbeds: Float32Array[] = [];
      const embedFailures: unknown[] = [];
      for (const s of settled) {
        if (s.status === 'fulfilled') okEmbeds.push(s.value);
        else embedFailures.push(s.reason);
      }
      if (embedFailures.length > 0) {
        warnOncePerProcess(
          'search-embed-fanout-failed',
          `[gbrain] ${embedFailures.length}/${settled.length} query embeds failed (salvaging survivors): ` +
            `${embedFailures[0] instanceof Error ? (embedFailures[0] as Error).message : String(embedFailures[0])}`,
        );
      }
      if (okEmbeds.length === 0) {
        // Every embed failed → keyword-only fallback below, honestly staged.
        const allTimeouts = embedFailures.every(isTimeoutError);
        pushDegraded(degraded, allTimeouts ? 'embed_timeout' : 'embed_unavailable', allTimeouts ? 'timeout' : 'provider_error');
      } else {
        const originalOk = settled[0].status === 'fulfilled';
        if (embedFailures.length > 0) {
          // Mixed outcome — only reachable when expansion produced variants.
          pushDegraded(degraded, 'expansion_partial', originalOk ? 'variant_embed_failed' : 'original_embed_failed');
        }
        if (originalOk) {
          queryEmbedding = (settled[0] as PromiseFulfilledResult<Float32Array>).value;
        } else {
          // Registry refinement: variant lists are salvaged, but the cosine
          // re-score needs the ORIGINAL query's vector — skip it rather than
          // re-score in a variant's embedding space.
          queryEmbedding = null;
          pushDegraded(degraded, 'rescore_skipped', 'original_embed_failed');
        }
        const vSettled = await Promise.allSettled(okEmbeds.map(emb => engine.searchVector(emb, searchOpts)));
        const okLists: SearchResult[][] = [];
        const okRoles: Array<'original' | 'variant'> = [];
        let vFirstErr: unknown;
        let vFailed = 0;
        for (let i = 0; i < vSettled.length; i++) {
          const s = vSettled[i];
          if (s.status === 'fulfilled') {
            okLists.push(s.value);
            // okEmbeds[0] is the ORIGINAL query only when its embed survived;
            // the original role additionally requires its searchVector to
            // have succeeded. Otherwise every survivor is a variant (they
            // share the expansion budget — pre-registered original-missing
            // behavior, fusion-lists.ts).
            okRoles.push(i === 0 && originalOk ? 'original' : 'variant');
          } else {
            if (vFailed === 0) vFirstErr = s.reason;
            vFailed += 1;
          }
        }
        if (vFailed > 0) {
          pushDegraded(degraded, 'vector_arm_failed', isTimeoutError(vFirstErr) ? 'timeout' : 'provider_error');
          warnOncePerProcess(
            'search-vector-arm-failed',
            `[gbrain] ${vFailed}/${vSettled.length} searchVector arms failed (salvaging survivors): ` +
              `${vFirstErr instanceof Error ? vFirstErr.message : String(vFirstErr)}`,
          );
        }
        for (const list of okLists) {
          for (const r of list) {
            r.modality = r.modality ?? 'text';
          }
        }
        okLists.forEach((list, i) => pushVectorList(vectorArms, list, okRoles[i]));
        // 'both' mode: also include the image-side list as another input to
        // RRF — only when a text arm survived, matching the pre-wave shape
        // (a total text failure falls back to keyword-only either way).
        if (okLists.length > 0 && effectiveModality === 'both' && imageVectorList !== null) {
          pushVectorList(vectorArms, imageVectorList, 'image');
        }
      }
    }
  }
  return { vectorArms, queryEmbedding, imageQueryEmbedding, unifiedDone };
}
