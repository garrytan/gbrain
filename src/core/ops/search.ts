/**
 * Search operation cluster (search + query) — pure move from operations.ts
 * (v0.46.x tranche 1). search_by_image stays in operations.ts (v0.36 Phase 2
 * cluster). Op consts stay module-private; `searchOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import { hybridSearchCached, stampContentFlags, stampUnverifiedExtractions } from '../search/hybrid.ts';
import { looksConceptShaped, classifyQueryShape } from '../search/query-intent.ts';
import {
  gradeRetrievalConfidence,
  shouldEscalateRetrieval,
  confidenceRank,
  type CragMetaBlock,
} from '../search/crag.ts';
import { expandQuery } from '../search/expansion.ts';
import { dedupResults } from '../search/dedup.ts';
import { markKeywordHits } from '../search/evidence.ts';
import { captureEvalCandidate, isEvalCaptureEnabled, isEvalScrubEnabled } from '../eval-capture.ts';
import type { HybridSearchMeta } from '../types.ts';
import { bumpLastRetrievedAt } from '../last-retrieved.ts';
import { applySnippetCap, DEFAULT_AGENT_SNIPPET_CHARS } from '../search/snippet-cap.ts';
import { resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { QUERY_DESCRIPTION, SEARCH_DESCRIPTION } from '../operations-descriptions.ts';
import { OperationError } from './contract.ts';
import type { Operation, OperationContext } from './contract.ts';
import {
  federatedSearchScope,
  resolvePerCallMode,
  stampDeepResearchIds,
  stampEvidenceSafe,
  maybeCaptureSearch,
  thinkSourceScopeOpts,
} from './context.ts';

// --- Search ---

/**
 * WP2/D3 + E1: the `retrieval` response-meta payload for the search/query
 * ops. Carries the already-computed HybridSearchMeta signal (vector arm,
 * cache, budget, degradation stages — populated by the search pipeline) plus
 * the concept-shaped hint, so an MCP caller can distinguish "clean miss"
 * from "the pipeline degraded" without a second call. The `hint` is
 * non-contractual prose (agents read it; nothing should parse it).
 */
function buildRetrievalResponseMeta(
  queryText: string,
  results: unknown[],
  meta: HybridSearchMeta | null,
  opts: { conceptHint?: boolean } = {},
): Record<string, unknown> {
  const m = meta as (HybridSearchMeta & { degraded?: unknown; retrieved_count?: number }) | null;
  const hint = opts.conceptHint && looksConceptShaped(queryText)
    ? "concept-shaped question — the 'query' tool adds multi-query expansion and recovers " +
      'synonym-phrased matches this keyword-leaning search can miss.'
    : undefined;
  return {
    returned_count: results.length,
    retrieved_count: m?.retrieved_count ?? results.length,
    ...(m ? {
      vector_enabled: m.vector_enabled,
      expansion_applied: m.expansion_applied,
      ...(m.cache ? { cache: m.cache.status } : {}),
      ...(m.token_budget ? { token_budget: m.token_budget } : {}),
      ...(m.degraded !== undefined ? { degraded: m.degraded } : {}),
    } : {}),
    ...(hint ? { hint } : {}),
  };
}

/**
 * #3985: normalize the `types` param. MCP passes a real array; the CLI
 * passes `--types person,company` as one string. Rejects non-string entries
 * and an all-empty list loudly (invalid_params) instead of silently
 * dropping the filter. The SQL-level plumbing (SearchOpts.types → both
 * engines' keyword/title/vector legs) has existed since v0.33 (whoknows);
 * this just exposes it on the public search/query ops.
 */
function normalizeTypesParam(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : null;
  if (arr === null || arr.some((t) => typeof t !== 'string')) {
    throw new OperationError(
      'invalid_params',
      '`types` must be an array of page-type strings (CLI: --types person,company).',
    );
  }
  const types = [...new Set((arr as string[]).map((t) => t.trim()).filter(Boolean))];
  if (types.length === 0) {
    throw new OperationError(
      'invalid_params',
      '`types` was provided but contained no usable page-type strings (CLI: --types person,company).',
    );
  }
  return types;
}

const TYPES_PARAM_DESCRIPTION =
  "Filter results to pages whose `type` is in this list (e.g. ['person','company']). " +
  'CLI: --types person,company. Applied at SQL level on every retrieval leg — the same ' +
  'filter `whoknows` uses. Stacks with all other filters.';

const SNIPPET_CHARS_PARAM_DESCRIPTION =
  'Cap each result\'s chunk_text at N characters (a "… [truncated]" marker names the ' +
  'get_page recovery move). 0 forces full text. Unset: subagent tool loops default to ' +
  'the agent.search_snippet_chars config (300; 0=full); every other caller gets full text. (#3800)';

/**
 * #3800: resolve the effective snippet cap for one call. Explicit
 * `snippet_chars` param wins (0 = full text); else subagent callers
 * (ctx.viaSubagent — fail-closed dispatcher flag) read the
 * `agent.search_snippet_chars` config, defaulting to 300; every other
 * caller gets full text (cap 0 = no-op).
 */
async function resolveSnippetCap(ctx: OperationContext, p: Record<string, unknown>): Promise<number> {
  if (typeof p.snippet_chars === 'number' && Number.isFinite(p.snippet_chars)) {
    return Math.max(0, Math.floor(p.snippet_chars as number));
  }
  if (ctx.viaSubagent !== true) return 0;
  try {
    const raw = await ctx.engine.getConfig('agent.search_snippet_chars');
    if (raw != null && raw !== '') {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
  } catch { /* fail-open to the default */ }
  return DEFAULT_AGENT_SNIPPET_CHARS;
}

const search: Operation = {
  name: 'search',
  description: SEARCH_DESCRIPTION,
  params: {
    query: { type: 'string', required: true, description: "Search text. Exact tokens, names, and structured-field values work best here (e.g. 'acme-example series A'), since this op does no LLM expansion. This is the search text param — there is no `text` or `q` param." },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
    mode: { type: 'string', description: 'Search mode (conservative|balanced|tokenmax). Local callers only.' },
    // #3985: multi-type filter (plumbing shipped v0.33; exposed here).
    types: { type: 'array', items: { type: 'string' }, description: TYPES_PARAM_DESCRIPTION },
    // #3800: subagent token economy — per-call snippet cap.
    snippet_chars: { type: 'number', description: SNIPPET_CHARS_PARAM_DESCRIPTION },
    // #4398: per-call source scope, mirroring `query` — MCP clients passed it
    // here, got 'unknown parameter ignored', and read UNSCOPED results.
    source_id: {
      type: 'string',
      description:
        "Scope search to a single source. Defaults to OperationContext.sourceId (set from CLI --source / GBRAIN_SOURCE / .gbrain-source dotfile). Pass '__all__' to span every source for trusted local callers; for remote callers '__all__' spans only your granted sources.",
    },
    // #4415: explicit ranking-axis overrides (the same knobs `query` has had
    // since v0.29.1). The auto-detect banks are English regex, so on a
    // non-English brain the recency/salience stages never fire — these flags
    // (CLI: --salience / --recency) are the per-call override; the
    // search.intent_patterns config is the per-brain fix.
    salience: {
      type: 'string',
      enum: ['off', 'on', 'strong'],
      description:
        "Salience boost (emotional_weight + take_count, no time component): 'off' | 'on' | 'strong'. " +
        'Omit and gbrain auto-detects from query text. Independent of `recency`.',
    },
    recency: {
      type: 'string',
      enum: ['off', 'on', 'strong'],
      description:
        "Recency boost (per-prefix age decay, no mattering signal): 'off' | 'on' | 'strong'. " +
        'Omit and gbrain auto-detects. Independent of `salience`. Ignored on the keyword-only opt-out path.',
    },
  },
  handler: async (ctx, p) => {
    const startedAt = Date.now();
    const queryText = p.query as string;
    const limit = (p.limit as number) || 20;
    const offset = (p.offset as number) || 0;
    // #3985: validated multi-type filter, threaded into both branches below.
    const types = normalizeTypesParam(p.types);
    // #3800: snippet cap (param > subagent config default > full text).
    const snippetCap = await resolveSnippetCap(ctx, p);
    // #4398: explicit per-call source_id wins over ctx.sourceId, resolved
    // through the single trust+grant resolver (resolveRequestedScope inside
    // federatedSearchScope) — out-of-grant ids throw permission_denied, and
    // #2561's unqualified trusted-local federated span is unchanged.
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    const scope = federatedSearchScope(ctx, sourceIdParam);
    // #4352 — untrusted callers never see `visibility: private` pages
    // (config-gated; trusted local CLI unchanged).
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);

    // T4/D5 — per-call mode honored ONLY for trusted/local callers so a remote
    // OAuth client can't escalate to the costly tokenmax bundle. Local + unknown
    // mode → loud reject; remote + mode set → silently ignored (uses config).
    const perCallMode = resolvePerCallMode(ctx, p.mode);

    // T4/D17 — escape hatch: keyword-only when the operator opts out of the
    // hybrid `search` contract (privacy/cost: no query text to an embedding
    // provider). Defaults to cheap-hybrid (D4/D15).
    const keywordOnly = (await ctx.engine.getConfig('search.mcp_keyword_only')) === 'true';

    if (keywordOnly) {
      const raw = await ctx.engine.searchKeyword(queryText, { limit, offset, excludePrivate, ...(types ? { types } : {}), ...scope });
      const results = dedupResults(raw);
      // #3783 — every row here IS a keyword hit (direct FTS path); mark
      // before stamping so evidence still reads keyword_exact.
      markKeywordHits(results);
      stampDeepResearchIds(results);
      stampEvidenceSafe(results);
      // #1699: the keyword-only opt-out must STILL surface the content_flag
      // agent-warning channel (hybridSearch stamps it; this branch bypasses
      // hybridSearch, so stamp explicitly). Fail-open inside the helper.
      await stampContentFlags(ctx.engine, results);
      // #160: same for the unverified auto-extracted stub marker (no boost
      // to cancel on this path — keyword-only never applies the compiled-
      // truth boost — but the provenance marker must still surface).
      await stampUnverifiedExtractions(ctx.engine, results);
      bumpLastRetrievedAt(ctx.engine, results.map((r) => r.page_id));
      maybeCaptureSearch(ctx, queryText, results, Date.now() - startedAt, false);
      ctx.emitResponseMeta?.('retrieval', buildRetrievalResponseMeta(queryText, results, null, { conceptHint: true }));
      // #3800: cap AFTER capture/meta so eval + cache see the real payload.
      return applySnippetCap(results, snippetCap);
    }

    // Cheap-hybrid (D4/D15): full vector+keyword+RRF+pool+title+alias, but
    // expansion OFF (no per-call LLM cost). `query` op is the full-control variant.
    let capturedMeta: HybridSearchMeta | null = null;
    const results = await hybridSearchCached(ctx.engine, queryText, {
      limit,
      offset,
      expansion: false,
      excludePrivate,
      ...(types ? { types } : {}),
      ...scope,
      ...(perCallMode ? { mode: perCallMode } : {}),
      // #4415: agent-explicit recency + salience (same posture as `query`).
      salience: p.salience as 'off' | 'on' | 'strong' | undefined,
      recency: p.recency as 'off' | 'on' | 'strong' | undefined,
      onMeta: (m) => { capturedMeta = m; },
    });
    stampDeepResearchIds(results);
    const latency_ms = Date.now() - startedAt;
    bumpLastRetrievedAt(ctx.engine, results.map((r) => r.page_id));
    maybeCaptureSearch(ctx, queryText, results, latency_ms, true, capturedMeta);
    ctx.emitResponseMeta?.('retrieval', buildRetrievalResponseMeta(queryText, results, capturedMeta, { conceptHint: true }));
    // #3800: cap AFTER capture/meta so eval + cache see the real payload.
    return applySnippetCap(results, snippetCap);
  },
  scope: 'read',
  cliHints: { name: 'search', positional: ['query'] },
};

const query: Operation = {
  name: 'query',
  description: QUERY_DESCRIPTION,
  params: {
    // v0.27.1: `query` is no longer strictly required — `--image <path>`
    // is the alternative entry point for image-similarity search. The CLI
    // validator at src/cli.ts honors `cliHints.altRequired` and admits the
    // image-only invocation. MCP / programmatic callers must still pass
    // `query` OR `image` (handler refuses if both are absent).
    query: { type: 'string', required: false, description: "Question or topic text for hybrid retrieval with expansion (e.g. 'agents that do web research'). This is the search text param — there is no `text` or `q` param. Optional ONLY because `image` is the alternative entry point; a call with neither fails with invalid_params." },
    /** v0.27.1: image-similarity search. Path resolved on the CLI side
     *  before the op fires (the op receives raw bytes neither side; the
     *  CLI loads the file, base64-encodes, and passes through `image`). */
    image: { type: 'string', description: 'Base64-encoded image bytes for image-similarity search (CLI: --image <path>).' },
    image_mime: { type: 'string', description: 'MIME type for the image bytes (auto-derived from path on CLI; required when calling op directly).' },
    // #4356 — the text/hybrid path no longer hard-defaults this to 20; an
    // omitted OR falsy (0) `limit` resolves from the active search mode's
    // searchLimit (10/25/50 for conservative/balanced/tokenmax by default,
    // overridable via the `search.searchLimit` config key — see mode.ts
    // `pick()`). 0 is treated as "unset" rather than "return zero rows",
    // matching the existing convention on every other limit surface with
    // this same shape (`search`'s own limit below, and the image-
    // similarity branch below it) — none of which support a literal
    // empty-result request today; introducing that only here would be a
    // new, undocumented asymmetry rather than a limit-consistency fix.
    // (`search_by_image`, a separate op in src/core/ops/image.ts, has the
    // same convention but isn't "in this file".) The image-similarity path
    // (`image` param) is unaffected by this change and still hard-defaults
    // to 20 regardless of mode — out of scope here, tracked separately
    // (#4356 Problem 2).
    limit: { type: 'number', description: 'Max results. For text queries, omitted or 0 resolves from the active search mode (10 conservative / 25 balanced / 50 tokenmax by default, or the configured `search.searchLimit` override). For image-similarity queries (`image` param), always defaults to 20 regardless of mode.' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
    // #3985: multi-type filter (plumbing shipped v0.33; exposed here).
    types: { type: 'array', items: { type: 'string' }, description: TYPES_PARAM_DESCRIPTION },
    // #3800: subagent token economy — per-call snippet cap.
    snippet_chars: { type: 'number', description: SNIPPET_CHARS_PARAM_DESCRIPTION },
    expand: { type: 'boolean', description: 'Enable multi-query expansion (default: true)' },
    detail: { type: 'string', description: 'Result detail level: low (compiled truth only), medium (default, all with dedup), high (all chunks)' },
    mode: { type: 'string', description: 'Search mode (conservative|balanced|tokenmax). Local callers only; remote uses configured mode.' },
    // v0.20.0 Cathedral II Layer 10 C1/C2: language + symbol-kind filters.
    lang: { type: 'string', description: 'Filter to chunks where content_chunks.language matches (e.g., typescript, python, ruby)' },
    symbol_kind: { type: 'string', description: 'Filter to chunks where content_chunks.symbol_type matches (e.g., function, class, method, type, interface)' },
    // v0.20.0 Cathedral II Layer 7 (A2) / Layer 10 C3: two-pass structural expansion.
    near_symbol: { type: 'string', description: 'Anchor retrieval at this qualified symbol name (e.g., BrainEngine.searchKeyword). Enables A2 two-pass.' },
    walk_depth: { type: 'number', description: 'Structural walk depth 1-2. Default 0 (off). Expands anchors through code_edges with 1/(1+hop) decay.' },
    // v0.29.1 — orthogonal recency + salience axes. YOU (the agent) decide.
    salience: {
      type: 'string',
      enum: ['off', 'on', 'strong'],
      description:
        "v0.29.1 salience boost — emotional_weight + take_count, NO time component.\n" +
        "  'off' — default for entity / canonical / definitional queries\n" +
        "  'on'  — surface emotionally-weighted + take-rich pages\n" +
        "  'strong' — aggressive mattering tilt\n" +
        "Omit and gbrain auto-detects from query text. Independent of `recency`.",
    },
    recency: {
      type: 'string',
      enum: ['off', 'on', 'strong'],
      description:
        "v0.29.1 recency boost — per-prefix age decay, NO mattering signal.\n" +
        "  'off' — default for canonical truth\n" +
        "  'on'  — daily/, media/x/, chat/ decay aggressively; concepts/, originals/, writing/ stay evergreen\n" +
        "  'strong' — multiplies the recency factor by 1.5 (use for 'today' / 'right now')\n" +
        "Omit and gbrain auto-detects. Independent of `salience` (orthogonal axes).",
    },
    since: {
      type: 'string',
      description:
        "v0.29.1 — filter to pages whose effective_date is >= this. ISO-8601 (YYYY-MM-DD or full timestamp) OR relative ('7d', '2w', '1y'). Replaces deprecated `afterDate`.",
    },
    until: {
      type: 'string',
      description:
        "v0.29.1 — filter to effective_date <= this. Same format as `since`. Replaces deprecated `beforeDate`. YYYY-MM-DD lands at end-of-day.",
    },
    source_id: {
      type: 'string',
      description:
        "v0.34: scope search to a single source. Defaults to OperationContext.sourceId (set from CLI --source / GBRAIN_SOURCE / .gbrain-source dotfile). Pass '__all__' to span every source for trusted local callers; for remote callers '__all__' spans only your granted sources.",
    },
    cross_modal: {
      type: 'string',
      enum: ['text', 'image', 'both', 'auto'],
      description:
        "v0.36 cross-modal search routing.\n" +
        "  'text' (default for non-image-intent queries) — text-only path, no behavior change vs v0.35.\n" +
        "  'image' — route the query through Voyage multimodal-3 + the embedding_image column. Best for 'show me photos of...' phrasings.\n" +
        "  'both' — run text AND image searches in parallel; merge via weighted RRF.\n" +
        "  'auto' — same effect as omitting the field; intent classifier decides based on query phrasing.",
    },
    embedding_column: {
      type: 'string',
      description:
        "v0.36: route vector search through a non-default embedding column. Defaults to 'embedding' (the brain's primary column) unless `search_embedding_column` config sets a different default. Per-call override for A/B benchmarking across providers (e.g. 'embedding_voyage', 'embedding_openai'). Column MUST be declared in the `embedding_columns` config registry — unknown names throw with a paste-ready hint listing valid columns.",
    },
    adaptive_return: {
      type: 'boolean',
      description:
        "v0.41.33 — return a TIGHT, intent-sized result set instead of the full top-K. YOU (the agent) set this per query to serve the user well:\n" +
        "  TRUE when the user's question has a small, specific answer — a lookup ('what is X', 'who is Y', 'what's my <thing>', 'what did Z decide'), a single-fact recall, or when you'll route the result into a precise downstream step (a classifier, a decision, an exact citation). The user gets the answer, not a wall of loosely-related pages, and you spend fewer tokens reading noise.\n" +
        "  Omit / FALSE for breadth — 'everything about X', 'list all', 'what do I know about Y', exploration, brainstorming, or any time you'd rather see more candidates and judge for yourself. Recall matters more there, so take the full top-K.\n" +
        "Safe by construction: it NEVER returns empty when there are matches (you always get at least the top hit), and it only applies to the first page (omit when paginating). Caps come from config (search.adaptive_return_entity_max / _other_max; default 2 / 6) — pass `limit` 1 alongside this for a hard single-answer cap.",
    },
    autocut: {
      type: 'boolean',
      description:
        "v0.42.3.0 — autocut is the SMART DEFAULT (already ON when the reranker runs, which it does in the default search mode). It returns only the confident cluster by cutting where the relevance score drops off a cliff, so an obvious single answer comes back as 1 result and a genuine handful comes back as that handful — not a fixed wall of 20+.\n" +
        "  You almost never set this. Pass FALSE only to FORCE the full top-K when you deliberately want breadth — broad exploration, 'show me everything about X', enumeration where you'd rather over-collect and judge for yourself, or when you suspect the top hit is wrong and want to see the alternatives.\n" +
        "  TRUE is redundant in default mode (it's already on); it only matters to override a brain whose config turned autocut off.\n" +
        "Safe by construction: never returns empty when there are matches, only applies to the first page (omit when paginating), and is a no-op when no reranker scored the results (so it can't cut on an untrustworthy signal). Distinct from `adaptive_return`: autocut cuts on the score cliff; adaptive_return caps by question intent. Leave both unset for the smart default.",
    },
    relational: {
      type: 'boolean',
      description:
        "v0.43 — relational recall arm. SMART DEFAULT (on in balanced/tokenmax). When the question is about a RELATIONSHIP ('who invested in widget-co', 'who introduced me to alice', 'what connects fund-a and fund-b'), the brain resolves the named entity and walks its typed-edge graph (invested_in, works_at, founded, …), surfacing the answer even when no passage mentions both sides. Pure no-op for non-relational questions. Pass FALSE to force lexical/vector-only retrieval (e.g. debugging why a graph answer appeared). You almost never set this.",
    },
  },
  handler: async (ctx, p) => {
    const startedAt = Date.now();
    const expand = p.expand !== false;
    const detail = (p.detail as 'low' | 'medium' | 'high') || undefined;
    const queryText = p.query as string | undefined;
    // #3985: validated multi-type filter (text path; the image-similarity
    // branch below also honors it — searchVector filters types at SQL level).
    const types = normalizeTypesParam(p.types);
    // #3800: snippet cap (param > subagent config default > full text).
    const snippetCap = await resolveSnippetCap(ctx, p);
    const imageData = p.image as string | undefined;
    const imageMime = (p.image_mime as string) || 'image/jpeg';
    const embeddingColumnParam =
      typeof p.embedding_column === 'string' && p.embedding_column.length > 0
        ? (p.embedding_column as string)
        : undefined;
    // Explicit per-call source_id must win over ctx.sourceId. `__all__` spans
    // every source for trusted local callers, but only the caller's granted
    // sources for remote callers (resolveRequestedScope is the single
    // trust+grant resolver shared by every source-scoped read op). This scope
    // is spread into BOTH the image-similarity searchVector path and the text
    // hybridSearch path below, so both honor the same grant.
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    // #2561: unqualified trusted-local query spans federated sources (per-call
    // source_id / remote grants still resolve through resolveRequestedScope).
    const querySourceScope = federatedSearchScope(ctx, sourceIdParam);
    // #4352 — same enforcement for the full-control query op (both the image
    // searchVector branch and the text hybrid path below).
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);

    // v0.27.1: image-similarity branch. Bypasses hybridSearch (which is
    // text-only); embeds the image via embedMultimodal and runs a direct
    // vector search against the embedding_image column.
    if (imageData) {
      const { embedMultimodal } = await import('../ai/gateway.ts');
      const [vec] = await embedMultimodal([
        { kind: 'image_base64', data: imageData, mime: imageMime },
      ]);
      // v0.34.1 (#861 F2 — 6th leak surface): the image path bypasses
      // hybridSearch and calls searchVector directly, so it needs its
      // own thread of the source scope. Pre-fix, this branch leaked
      // image pages across sources independent of the text path's fix.
      const results = await ctx.engine.searchVector(vec, {
        limit: (p.limit as number) || 20,
        offset: (p.offset as number) || 0,
        embeddingColumn: 'embedding_image',
        excludePrivate,
        ...(types ? { types } : {}),
        ...querySourceScope,
      });
      return applySnippetCap(results, snippetCap);
    }

    if (!queryText) {
      // WP3: typed envelope — a caller mistake must classify as invalid_params
      // over MCP, not the internal_error a plain throw produced.
      throw new OperationError(
        'invalid_params',
        'query requires either `query` (text) or `image` (base64 bytes).',
        'Pass `query` with your search text (e.g. {"query": "acme-example roadmap"}), or `image` with base64 image bytes.',
      );
    }

    // v0.25.0 — capture meta side-channel. hybridSearch's return contract
    // stays SearchResult[] (Cathedral II callers depend on that); meta
    // arrives via callback so eval capture can record what actually ran.
    //
    // v0.34 (Codex finding #2): thread ctx.sourceId so multi-source brains
    // get source-scoped retrieval. Explicit `source_id` param wins over
    // ctx.sourceId for callers that want to override (per-call multi-source
    // search). When the param is the literal '__all__', force-allow
    // cross-source mode (matches SearchOpts.sourceId contract).
    let capturedMeta: HybridSearchMeta | null = null;
    // v0.32.x search-lite: route the query op through hybridSearchCached so
    // semantic cache + token budget + intent weighting fire automatically.
    // Plain hybridSearch remains the bare API for callers that opt out.
    // (#1663: `let` — the CRAG gate below may swap in an escalated run.)
    let results = await hybridSearchCached(ctx.engine, queryText, {
      // #4356 — was a hard `|| 20`, independent of the mode-resolution
      // hybridSearchCached applies when `limit` is falsy (undefined OR 0):
      // `opts?.limit || resolvedMode.searchLimit` (hybrid.ts). Passing
      // `undefined` through instead of hard-defaulting to 20 lets that
      // resolution apply (10/25/50 for conservative/balanced/tokenmax).
      // `(p.limit as number) || undefined` keeps 0 in that same "unset"
      // bucket rather than requesting a literal empty result — see the
      // `limit` param description above for why.
      limit: (p.limit as number) || undefined,
      offset: (p.offset as number) || 0,
      excludePrivate,
      expansion: expand,
      expandFn: expand ? expandQuery : undefined,
      // T4/D5 — per-call mode (local/trusted only; remote ignored).
      ...((): { mode?: string } => { const m = resolvePerCallMode(ctx, p.mode); return m ? { mode: m } : {}; })(),
      detail,
      // #3985: multi-type filter — SearchOpts.types reaches every leg.
      types,
      language: (p.lang as string) || undefined,
      symbolKind: (p.symbol_kind as string) || undefined,
      nearSymbol: (p.near_symbol as string) || undefined,
      walkDepth: typeof p.walk_depth === 'number' ? (p.walk_depth as number) : undefined,
      ...querySourceScope,
      // v0.29.1 — agent-explicit recency + salience. Omitted = heuristic defaults.
      salience: p.salience as 'off' | 'on' | 'strong' | undefined,
      recency: p.recency as 'off' | 'on' | 'strong' | undefined,
      since: typeof p.since === 'string' ? p.since : undefined,
      until: typeof p.until === 'string' ? p.until : undefined,
      // v0.32.x search-lite: token budget + cache opt-outs.
      tokenBudget: typeof p.token_budget === 'number' ? (p.token_budget as number) : undefined,
      useCache: typeof p.use_cache === 'boolean' ? (p.use_cache as boolean) : undefined,
      intentWeighting: typeof p.intent_weighting === 'boolean' ? (p.intent_weighting as boolean) : undefined,
      // v0.36 cross-modal routing param.
      crossModal: p.cross_modal as 'text' | 'image' | 'both' | 'auto' | undefined,
      onMeta: (m) => { capturedMeta = m; },
      // v0.36 (D15): per-call embedding column override. Resolver rejects
      // unknown names at hybrid entry with EmbeddingColumnNotRegisteredError;
      // the error surfaces back to the agent as the op error envelope.
      // Source scope is already threaded via ...querySourceScope above
      // (master's #1182 cleanup of the duplicate sourceScopeOpts spread).
      embeddingColumn: embeddingColumnParam,
      // v0.41.33 — agent-explicit adaptive return-sizing. Omitted = off
      // (config default applies). hybridSearchCached skips the cache when on.
      adaptiveReturn: typeof p.adaptive_return === 'boolean' ? (p.adaptive_return as boolean) : undefined,
      // v0.42.3.0 — autocut ceiling override. Omitted = smart default (ON in
      // reranked modes). `false` forces the full top-K.
      autocut: typeof p.autocut === 'boolean' ? (p.autocut as boolean) : undefined,
      // v0.43 — relational recall override. Omitted = smart default (mode bundle).
      relationalRetrieval: typeof p.relational === 'boolean' ? (p.relational as boolean) : undefined,
    });
    // #1663 — CRAG confidence gate. Grade what retrieval returned (zero-LLM;
    // reads the stamped honesty signals: evidence, exact_lookup, rerank
    // score), attach grade + query shape to the retrieval meta on EVERY call,
    // and — config-gated, default OFF — escalate a weak result once:
    //   search.crag_escalation=true → one high-ceiling retrieval re-run
    //     (expansion + relational + wide limit, autocut off). Filters
    //     (scope/types/since/until/lang) are preserved; keep the better run.
    //   search.crag_think=true → still weak + LOCAL caller → run think and
    //     attach its synthesis to the meta (spend-gated by config + trust).
    const queryShape = classifyQueryShape(queryText);
    let grade = gradeRetrievalConfidence(results);
    const crag: CragMetaBlock = {
      confidence: grade.level,
      reason: grade.reason,
      query_shape: queryShape,
      ...(grade.top_rerank_score !== undefined ? { top_rerank_score: grade.top_rerank_score } : {}),
    };
    if (grade.level === 'weak') {
      const [escalationCfg, thinkCfg] = await Promise.all([
        ctx.engine.getConfig('search.crag_escalation').catch(() => null),
        ctx.engine.getConfig('search.crag_think').catch(() => null),
      ]);
      if (shouldEscalateRetrieval(grade, { enabled: escalationCfg === 'true' })) {
        try {
          let escalatedMeta: HybridSearchMeta | null = null;
          const escalated = await hybridSearchCached(ctx.engine, queryText, {
            limit: Math.max((p.limit as number) || 20, 50),
            offset: (p.offset as number) || 0,
            expansion: true,
            expandFn: expandQuery,
            relationalRetrieval: true,
            autocut: false,
            detail,
            // Preserve the caller's #3985 type filter on the re-run (raw
            // pass-through; the base call already rejected malformed input).
            ...(Array.isArray(p.types) || typeof p.types === 'string'
              ? {
                  types: (Array.isArray(p.types) ? (p.types as string[]) : (p.types as string).split(','))
                    .map((t) => t.trim())
                    .filter(Boolean),
                }
              : {}),
            language: (p.lang as string) || undefined,
            symbolKind: (p.symbol_kind as string) || undefined,
            // Preserve the caller's symbol-proximity constraints too — an
            // escalated set that ignores --near-symbol/--walk-depth must not
            // replace correctly-filtered weak results.
            nearSymbol: (p.near_symbol as string) || undefined,
            walkDepth: typeof p.walk_depth === 'number' ? (p.walk_depth as number) : undefined,
            ...querySourceScope,
            since: typeof p.since === 'string' ? p.since : undefined,
            until: typeof p.until === 'string' ? p.until : undefined,
            crossModal: p.cross_modal as 'text' | 'image' | 'both' | 'auto' | undefined,
            embeddingColumn: embeddingColumnParam,
            onMeta: (m) => { escalatedMeta = m; },
          });
          const regraded = gradeRetrievalConfidence(escalated);
          crag.escalated = true;
          crag.escalated_confidence = regraded.level;
          if (confidenceRank(regraded.level) > confidenceRank(grade.level)) {
            results = escalated;
            capturedMeta = escalatedMeta;
            grade = regraded;
            crag.confidence = regraded.level;
            crag.reason = regraded.reason;
          }
        } catch {
          // Escalation is best-effort — never fail the original result set.
        }
      }
      if (grade.level === 'weak') {
        // The honest next move for a still-weak result. Hint always; auto-run
        // only when the operator opted in AND the caller is trusted-local
        // (spend + privacy: think synthesizes with the configured LLM).
        crag.escalate_to_think = true;
        if (thinkCfg === 'true' && ctx.remote === false) {
          try {
            const { runThink } = await import('../think/index.ts');
            const thinkScope = thinkSourceScopeOpts(ctx);
            const t = await runThink(ctx.engine, {
              question: queryText,
              since: typeof p.since === 'string' ? p.since : undefined,
              until: typeof p.until === 'string' ? p.until : undefined,
              ...thinkScope,
              remote: false,
            });
            crag.think = {
              answer: t.answer,
              citations: t.citations.length,
              ...(t.synthesis_status ? { synthesis_status: t.synthesis_status } : {}),
              model: t.modelUsed,
            };
          } catch {
            // think escalation is best-effort; the hint above still stands.
          }
        }
      }
    }
    const latency_ms = Date.now() - startedAt;

    // v0.37.0 (D11): op-layer last_retrieved_at write-back. Same shape as the
    // search handler — fire-and-forget, internal callers bypass this path.
    bumpLastRetrievedAt(ctx.engine, results.map((r) => r.page_id));

    // Op-layer capture (v0.25.0). Fire-and-forget. meta tells gbrain-evals
    // what hybridSearch *actually* did so replay can distinguish "with API
    // key" from "keyword-only fallback" and "expansion fired" from
    // "expansion requested + silently fell back."
    if (isEvalCaptureEnabled(ctx.config)) {
      const meta: HybridSearchMeta = capturedMeta ?? {
        vector_enabled: false, detail_resolved: detail ?? null, expansion_applied: false,
      };
      void captureEvalCandidate(
        ctx.engine,
        {
          tool_name: 'query',
          query: queryText,
          results,
          meta,
          latency_ms,
          remote: ctx.remote ?? false,
          expand_enabled: expand,
          detail: detail ?? null,
          job_id: ctx.jobId ?? null,
          subagent_id: ctx.subagentId ?? null,
        },
        { scrub_pii: isEvalScrubEnabled(ctx.config) },
      );
    }

    // WP2/D3: query never nudges toward itself — no concept hint here.
    // #1663: the CRAG grade rides the same retrieval meta channel.
    ctx.emitResponseMeta?.('retrieval', {
      ...buildRetrievalResponseMeta(queryText, results, capturedMeta),
      crag,
    });
    // #3800: cap AFTER capture/meta/CRAG so every internal consumer graded
    // and recorded the real payload; only the returned envelope is snipped.
    return applySnippetCap(results, snippetCap);
  },
  scope: 'read',
  cliHints: { name: 'query', positional: ['query'] },
};


// ---------------------------------------------------------------------------
// CLI→MCP gap-closure wave — search/cache introspection ops. Read-only views
// shared with the `gbrain search modes|stats|tune` + `gbrain cache stats` CLI
// (the builders live in core/search/). User story for each: a thin-client
// user whose CLI routes these subcommands remotely, or an agent asked to
// diagnose retrieval quality/cost. Telemetry ops are admin-scoped
// (operational counters, the get_status_snapshot posture); search_modes is
// read-scoped (resolved knob values only — agents budget their own calls
// with it, no usage data).
// ---------------------------------------------------------------------------

const search_stats: Operation = {
  name: 'search_stats',
  description:
    'Search observability over a window: cache hit rate, intent/mode mix, budget drops, ' +
    'rank-1 score drift, graph-signals failure counts. Same payload as the search-stats ' +
    'dashboard JSON. Coverage caveat: telemetry is best-effort (short-lived CLI calls may ' +
    'not flush), so zero counts can reflect the coverage gap rather than zero usage.',
  params: {
    days: { type: 'number', required: false, description: 'Window in days (default 7, clamped 1..365).' },
  },
  scope: 'admin',
  area: 'search',
  handler: async (ctx, p) => {
    const { withRelationGuard } = await import('./contract.ts');
    return withRelationGuard(async () => {
      const { readSearchStats, readGraphSignalsStats, telemetryCoverage } = await import('../search/telemetry.ts');
      const rawDays = typeof p.days === 'number' && Number.isFinite(p.days) ? p.days : 7;
      const days = Math.max(1, Math.min(365, rawDays));
      const stats = await readSearchStats(ctx.engine, { days });
      const graph_signals = await readGraphSignalsStats(ctx.engine, days);
      return {
        schema_version: 2,
        ...stats,
        coverage: telemetryCoverage(),
        graph_signals,
        _meta: {
          metric_glossary: {
            cache_hit_rate: 'cache_hits / (cache_hits + cache_misses) — fraction of searches that reused a recent answer instead of running fresh',
            avg_results: 'mean number of result rows returned per search call',
            avg_tokens: 'mean estimated tokens in the returned chunk text (char/4 heuristic)',
            total_budget_dropped: 'sum of results dropped because the call exceeded its tokenBudget',
            graph_signals_enabled: 'whether graph_signals is on for the active mode (or via search.graph_signals override)',
            graph_signals_failures_count: 'count of fail-open events in the JSONL audit over the window',
          },
        },
      };
    }, 'Search telemetry');
  },
};

const search_modes: Operation = {
  name: 'search_modes',
  description:
    'Read-only search-mode dashboard: active mode, per-knob resolved value with attribution ' +
    '(mode default vs config override), and the three frozen bundles. Never mutates; to ' +
    'change modes, tell the user to set the search.mode config key on the brain host.',
  params: {},
  scope: 'read',
  area: 'search',
  handler: async (ctx) => {
    const { buildModesReport } = await import('../search/modes-report.ts');
    return buildModesReport(ctx.engine);
  },
};

const search_tune: Operation = {
  name: 'search_tune',
  description:
    'Read-only tuning recommendations derived from the last 7 days of search telemetry: ' +
    'what should change, why, and the paste-ready config command per recommendation — relay ' +
    'them to the user. Applying is CLI-only by design [CDX-21]: this op NEVER mutates config.',
  params: {},
  scope: 'admin',
  area: 'search',
  handler: async (ctx) => {
    const { withRelationGuard } = await import('./contract.ts');
    return withRelationGuard(async () => {
      const { buildTuneRecommendations } = await import('../search/tune-recommendations.ts');
      return buildTuneRecommendations(ctx.engine);
    }, 'Search telemetry');
  },
};

const cache_stats: Operation = {
  name: 'cache_stats',
  description:
    'Semantic query-cache introspection: resolved knobs (enabled, similarity threshold, TTL) ' +
    'plus row counts and total hits. Read-only; clearing/pruning the cache stays on the CLI.',
  params: {},
  scope: 'admin',
  area: 'search',
  handler: async (ctx) => {
    const { withRelationGuard } = await import('./contract.ts');
    return withRelationGuard(async () => {
      const { SemanticQueryCache, loadCacheConfig } = await import('../search/query-cache.ts');
      const config = await loadCacheConfig(ctx.engine);
      const cache = new SemanticQueryCache(ctx.engine, config);
      const stats = await cache.stats();
      return {
        schema_version: 1,
        enabled: config.enabled ?? true,
        similarity_threshold: config.similarityThreshold,
        ttl_seconds: config.ttlSeconds,
        ...stats,
      };
    }, 'Query-cache statistics');
  },
};

// Ops in EXACTLY the canonical `operations` array order.
export const searchOperations: Operation[] = [
  search, query, search_stats, search_modes, search_tune, cache_stats,
];
