import { searchAnswerFeedback } from '../feedback/record.ts';
import type { RelationalPlanMeta } from '../search/relational-recall.ts';
import type { Notice } from '../agent-output.ts';
import { readHolders } from './context.ts';
/**
 * Search operation cluster (search + query) — pure move from operations.ts
 * (v0.46.x tranche 1). search_by_image stays in operations.ts (v0.36 Phase 2
 * cluster). Op consts stay module-private; `searchOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import { hybridSearchCached, stampContentFlags, stampUnverifiedExtractions } from '../search/hybrid.ts';
import { resolveSearchDateBounds } from '../search/date-bounds.ts';
import { loadSearchModeConfig, resolveSearchMode, SOURCE_BOOSTS_KEY } from '../search/mode.ts';
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
import type { HybridSearchMeta, SearchResult } from '../types.ts';
import { bumpLastRetrievedAt } from '../last-retrieved.ts';
import { applySnippetCap, DEFAULT_AGENT_SNIPPET_CHARS } from '../search/snippet-cap.ts';
import { redactRetrievalOutput } from '../search/output-redaction.ts';
import { projectRows, resultRowsFor } from '../search/lean-rows.ts';
import { buildScoreDetails } from '../search/explain-formatter.ts';
import { TargetTrace, diagnoseProbe, diagnoseTrace, probeTarget, type ExplainTargetDiagnosis } from '../search/explain-target.ts';
import { assembleEvidenceForHits, capDeliveredSnippets, capEvidenceToBudget, deliverEvidence, effectivePlan, resolveEvidencePlan, unsupportedDelivery, type DeliveryMeta, type DeliveryScope, type EvidencePlan, type FrozenHit, type ReturnUnit } from '../search/evidence-delivery.ts';
import { privateProvenanceFilterFragment, resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import { expandEngineTypeFilters } from '../schema-pack/query-types.ts';
import { probeProjectionReadiness } from '../search/projection-readiness.ts';
import { resolveBoostMap, resolveHardExcludes } from '../search/source-boost.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { QUERY_DESCRIPTION, SEARCH_DESCRIPTION } from '../operations-descriptions.ts';
import { declaredNames, titleName } from '../mentions/aliases.ts';
import { heldFilesNotice, stampHeldHits } from '../persistence/held-reads.ts';
import { opError } from './contract.ts';
import type { Operation, OperationContext } from './contract.ts';
import { invalidParam, paramUse, readFix } from './op-fix.ts';
import {
  assertExplicitSourceLive,
  federatedSearchScope,
  parseSourceIdParam,
  resolvePerCallMode,
  stampDeepResearchIds,
  stampEvidenceSafe,
  maybeCaptureSearch,
  thinkSourceScopeOpts,
} from './context.ts';

/**
 * The caller's effective row contract for the `query` op's non-hybrid legs
 * (#4356 image branch, #4610 CRAG escalation slice): an explicit `limit` wins;
 * omitted/0 resolves the mode-derived searchLimit (10/25/50 or the configured
 * `search.searchLimit` override) through the SAME trust-gated chain
 * hybridSearch applies — `resolvePerCallMode` ignores a remote caller's
 * `mode`, so a remote client can't select the tokenmax row count. Resolved
 * lazily by the callers (the config reads only run on the paths that need it).
 */
async function resolveEffectiveLimit(ctx: OperationContext, p: Record<string, unknown>): Promise<number> {
  const perCallMode = resolvePerCallMode(ctx, p.mode);
  const modeInput = await loadSearchModeConfig(ctx.engine);
  const resolved = resolveSearchMode({ mode: perCallMode ?? modeInput.mode, overrides: modeInput.overrides });
  return (p.limit as number) || resolved.searchLimit;
}

// --- Search ---

type SourceScope = { sourceId?: string; sourceIds?: string[] };

/**
 * The returned rows: redacted, snippet-capped, then projected to the caller's
 * row shape (C1: lean for remote callers unless `fields: "full"`, the host's
 * `mcp.result_rows: full` or gbrain's thin client). Every internal consumer
 * (capture, response meta, last-retrieved bump) has already read full rows.
 */
function searchOutput(ctx: OperationContext, p: Record<string, unknown>, results: SearchResult[], meta: Record<string, unknown>, snippetCap: number,
  evidence?: { delivery: DeliveryMeta; explicitSnippet: boolean }): SearchResult[] {
  const rows = resultRowsFor(ctx, p.fields);
  // `explain: true` — every row carries its score breakdown (kept in lean rows).
  if (p.explain === true) for (const r of results) r.score_details = buildScoreDetails(r);
  // The shape is reported where it can vary: remote callers, or an explicit `fields`.
  const shown = ctx.remote !== false || p.fields !== undefined ? { rows } : {};
  if (!evidence) {
    const output = redactRetrievalOutput(results, { ...meta, ...shown });
    ctx.emitResponseMeta?.('retrieval', output.meta);
    return projectRows(applySnippetCap(output.results, snippetCap), rows);
  }
  // Evidence delivery: explicit snippet_chars wins over the delivered blocks;
  // otherwise the blocks are returned whole (their budget already bounds
  // them). The cap runs before the meta is emitted so it can report itself.
  const output = redactRetrievalOutput(results, { ...meta, delivery: evidence.delivery, ...shown });
  // An explicit budget's cap holds at this final boundary too (snippet
  // markers and redaction recounted); without one both are no-ops.
  const capped = evidence.explicitSnippet ? capDeliveredSnippets(output.results, snippetCap, output.meta.delivery) : capEvidenceToBudget(output.results, output.meta.delivery);
  ctx.emitResponseMeta?.('retrieval', output.meta);
  return projectRows(capped, rows);
}

/** C1: the per-call row-shape escape hatch shared by `search` and `query` (`detail` is query's low/medium/high). */
const FIELDS_PARAM = {
  type: 'string' as const,
  enum: ['lean', 'full'],
  description: "lean (remote default) or full.",
};

/** Evidence delivery params shared by `search` and `query`. */
const RETURN_UNIT_PARAM = {
  type: 'string' as const,
  enum: ['chunk', 'window', 'section', 'page', 'auto'],
  description: 'auto (default) returns whole conversations.',
};
const RETURN_WINDOW_PARAM = {
  type: 'number' as const,
  description: 'Neighbor chunks each side for window (1-3).',
};

/**
 * With a plan, `token_budget` budgets the delivered evidence, so query's
 * chunk-level budget stays off; query's token_budget without a return_unit
 * keeps its chunk-mode meaning.
 */
async function evidencePlanFor(ctx: OperationContext, p: Record<string, unknown>, snippetCap: number, op: 'search' | 'query'): Promise<EvidencePlan | null> {
  return resolveEvidencePlan(ctx.engine, {
    legacyBudget: op === 'query' && typeof p.token_budget === 'number',
    remote: ctx.remote,
    viaSubagent: ctx.viaSubagent,
    returnUnit: p.return_unit,
    returnWindow: p.return_window,
    budget: p.token_budget,
    snippetChars: p.snippet_chars,
    snippetCap,
    op,
  });
}

/**
 * Run the evidence stage when a plan applies: the rows to serialize plus the
 * delivery handed to searchOutput. Hits from a cache hit are not live, so a
 * failed fetch drops them instead of falling back to cached text.
 */
async function withEvidence(ctx: OperationContext, p: Record<string, unknown>, results: SearchResult[], plan: EvidencePlan | null,
  scope: DeliveryScope, meta: HybridSearchMeta | null): Promise<{ rows: SearchResult[]; evidence?: { delivery: DeliveryMeta; explicitSnippet: boolean } }> {
  const applied = effectivePlan(plan, results);
  if (!applied) return { rows: results };
  const d = await deliverEvidence(ctx.engine, results, applied, { ...scope, requireSafeChunks: ctx.remote !== false }, { liveHits: meta?.cache?.status !== 'hit' });
  return { rows: d.results, evidence: { delivery: d.delivery, explicitSnippet: typeof p.snippet_chars === 'number' && Number.isFinite(p.snippet_chars) } };
}

/** withEvidence + the response meta for the rows actually returned + searchOutput. */
async function evidenceOutput(ctx: OperationContext, p: Record<string, unknown>, results: SearchResult[], plan: EvidencePlan | null, scope: DeliveryScope,
  meta: HybridSearchMeta | null, snippetCap: number, buildMeta: (rows: SearchResult[]) => Promise<Record<string, unknown>>): Promise<SearchResult[]> {
  const ev = await withEvidence(ctx, p, results, plan, scope, meta);
  return searchOutput(ctx, p, ev.rows, await buildMeta(ev.rows), snippetCap, ev.evidence);
}

/**
 * #5004/#5247: does the caller's read scope still hold pages of any kind
 * below the safe-chunk index version? Every remote chunk read withholds them
 * (the `requireSafeChunks` predicate in each engine leg) until they are
 * re-sealed (`gbrain repair safe-chunks`, or an unchanged re-import), so a
 * remote result on such a brain may be incomplete, not a clean or complete
 * answer. Same scope precedence as sourceScopeOpts (federated array > scalar
 * > brain-wide); LIMIT 1 probe, portable SQL on both engines, fail-open.
 *
 * The predicate is the plain range `chunker_version < N` (the column is
 * SMALLINT NOT NULL, so it is the same set as `NOT safeChunksFilter`), NOT
 * the COALESCE form the read legs use: only the range matches the partial
 * `pages_safe_chunk_pending_idx`, which holds unsealed pages only, and this
 * runs on every remote result.
 */
async function hasUnsealedPagesInScope(ctx: OperationContext, scope: SourceScope, excludePrivate: boolean,
  filters: { types?: string[]; excludeSlugPrefixes: string[] }): Promise<boolean> {
  if (scope.sourceIds?.length === 0) return false;
  const params: unknown[] = [];
  // The same page filters the search itself applied: a withheld page it could never return is not a gap.
  const clauses = [pageReadFilter('p', { ...scope, excludePrivate }, params, true)];
  if (filters.types) {
    params.push(filters.types);
    clauses.push(`p.type = ANY($${params.length}::text[])`);
  }
  for (const prefix of filters.excludeSlugPrefixes) {
    params.push(prefix);
    clauses.push(`LEFT(p.slug, LENGTH($${params.length}::text)) <> $${params.length}`);
  }
  try {
    const rows = await ctx.engine.executeRaw(
      `SELECT 1 FROM pages p
       WHERE ${clauses.join(' AND ')}
         AND p.chunker_version < ${SAFE_FENCE_CHUNKER_VERSION} LIMIT 1`,
      params,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Agents guess page types ("company", "account", "deal") that a brain may not
 * have, and a filter on a type with no pages silently hides every page
 * (gbrain-evals Cat 40: type-filtered agent runs failed 62% of tasks against
 * 51% unfiltered). Requested types with no readable pages in scope are
 * dropped, the rest stay; when none remain the filter is lifted. Either way
 * the caller is told which types exist so it can refine.
 */
async function reconcileTypeFilter(ctx: OperationContext, scope: SourceScope, excludePrivate: boolean,
  types: string[] | undefined): Promise<{ types: string[] | undefined; notice?: string }> {
  if (!types || scope.sourceIds?.length === 0) return { types };
  const params: unknown[] = [];
  let present: Set<string>;
  try {
    const rows = await ctx.engine.executeRaw<{ type: string }>(
      `SELECT DISTINCT p.type FROM pages p WHERE ${pageReadFilter('p', { ...scope, excludePrivate }, params, true)} LIMIT 500`, params);
    present = new Set(rows.map(r => r.type));
  } catch {
    return { types };
  }
  const keep: string[] = [];
  const missing: string[] = [];
  for (const type of types) {
    // A schema-pack lookup failure propagates: typed reads fail closed rather than fall back to literal types.
    const expanded = (await expandEngineTypeFilters(ctx.engine, { types: [type], ...scope })).types ?? [type];
    (expanded.length === 0 || expanded.some(t => present.has(t)) ? keep : missing).push(type);
  }
  if (missing.length === 0) return { types };
  const available = [...present].sort().join(', ');
  return keep.length === 0
    ? { types: undefined, notice: `No pages have type ${missing.join(', ')}, so the type filter was dropped and every page type was searched. Page types in this brain: ${available}.` }
    : { types: keep, notice: `No pages have type ${missing.join(', ')}; filtered to ${keep.join(', ')}. Page types in this brain: ${available}.` };
}

const FACT_MATCH_STOPWORDS = new Set(['the', 'and', 'for', 'who', 'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'our', 'your', 'their', 'now', 'current', 'currently', 'should', 'does', 'did', 'has', 'have', 'how', 'any', 'all', 'about', 'into', 'its', 'next']);

export interface AliasDeclaration { name: string; alias: string; slug: string }

const isWordChar = (c: string | undefined) => c !== undefined && /\w/.test(c);

/** Case-insensitive index of `word` in `text`; with `wholeWord`, edges that are word characters must sit on word boundaries. */
function indexOfName(text: string, word: string, wholeWord: boolean): number {
  const target = word.toLowerCase();
  for (let i = 0; i + word.length <= text.length; i++) {
    if (text.slice(i, i + word.length).toLowerCase() !== target) continue;
    if (!wholeWord) return i;
    if (isWordChar(word[0]) && isWordChar(text[i - 1])) continue;
    if (isWordChar(word[word.length - 1]) && isWordChar(text[i + word.length])) continue;
    return i;
  }
  return -1;
}

/**
 * Pages often declare another name for their subject ("Account code: MULI",
 * "also known as ..."), and documents elsewhere use only that name, so a
 * search for one name misses them (gbrain-evals Cat 40: amendments and
 * corrections that named a customer only by its code). This reads the
 * declarations in the returned evidence; the name is the page title after
 * its last colon. Only declarations where the query uses one name and not
 * the other are reported.
 */
export function aliasDeclarations(rows: Array<{ slug: string; title?: string; chunk_text?: string }>, queryText: string): AliasDeclaration[] {
  const q = queryText.toLowerCase();
  const out = new Map<string, AliasDeclaration>();
  for (const row of rows.slice(0, 10)) {
    const name = titleName(row.title ?? '');
    if (!name) continue;
    for (const alias of declaredNames(row.chunk_text ?? '', name)) {
      const hasName = q.includes(name.toLowerCase());
      const hasAlias = indexOfName(q, alias, true) >= 0;
      if (hasName === hasAlias) continue;
      out.set(`${name}\u0000${alias}`, { name, alias, slug: row.slug });
    }
  }
  return [...out.values()].slice(0, 5);
}

type DeclarationRow = { slug: string; title?: string; chunk_text?: string };

/**
 * One declaration scan per search: the fan-out and the response meta share
 * this memo, and the meta reuses the fan-out's scan whenever it reads the
 * same top rows (no fan-out pages spliced in, chunk text unchanged by
 * evidence delivery); otherwise it scans its own rows, so the result never
 * differs from scanning them directly.
 */
export class DeclarationMemo {
  private rows: DeclarationRow[] | null = null;
  private found: AliasDeclaration[] = [];
  scan(rows: DeclarationRow[], queryText: string): AliasDeclaration[] {
    const top = rows.slice(0, 10);
    const same = this.rows !== null && this.rows.length === top.length
      && top.every((r, i) => r.slug === this.rows![i].slug && r.title === this.rows![i].title && r.chunk_text === this.rows![i].chunk_text);
    if (!same) { this.rows = top; this.found = aliasDeclarations(top, queryText); }
    return this.found;
  }
}

/**
 * When the evidence declares another name for the entity the query names,
 * also search under that name and splice the new pages in after the top two
 * results, so documents that use only the other name are not left for the
 * agent to discover (most agents did not act on the notice alone). Nothing is
 * dropped: cutting the tail to make room lost the page that answered
 * (gbrain-evals Cat 40, family B).
 */
async function withDeclaredNameFanOut(results: SearchResult[], queryText: string, memo: DeclarationMemo,
  run: (query: string, limit: number) => Promise<SearchResult[]>): Promise<SearchResult[]> {
  const [first] = memo.scan(results, queryText);
  if (!first) return results;
  const nameAt = indexOfName(queryText, first.name, false);
  const [from, to, at] = nameAt >= 0
    ? [first.name, first.alias, nameAt]
    : [first.alias, first.name, indexOfName(queryText, first.alias, true)];
  const alt = queryText.slice(0, at) + to + queryText.slice(at + from.length);
  let extra: SearchResult[];
  try { extra = await run(alt, 5); } catch { return results; }
  const seen = new Set(results.map(r => `${r.source_id ?? ''}\u0000${r.slug}`));
  const fresh = extra.filter(r => !seen.has(`${r.source_id ?? ''}\u0000${r.slug}`));
  if (fresh.length === 0) return results;
  return [...results.slice(0, 2), ...fresh, ...results.slice(2)];
}

export interface SavedFactMatch { id: number; fact: string; entity_slug: string | null; kind: string; valid_from: string; source: string }

/**
 * Facts saved with `remember` live in the facts table, not in page chunks, so
 * page search never returns them (gbrain-evals Cat 40: agents saved a
 * correction with remember and the next session's search missed it). This
 * finds active facts whose text or entity shares at least three quarters of the query's words,
 * under the same source scope and visibility rules recall applies.
 */
async function matchingSavedFacts(ctx: OperationContext, scope: SourceScope, queryText: string, aliases: AliasDeclaration[] = []): Promise<SavedFactMatch[]> {
  // A query naming one of two declared names also matches facts saved under the other.
  for (const a of aliases) queryText += ` ${a.name} ${a.alias}`;
  const terms = [...new Set(queryText.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]+/gu) ?? [])]
    .filter(t => t.length >= 3 && !FACT_MATCH_STOPWORDS.has(t)).slice(0, 12);
  if (terms.length === 0 || !ctx.emitResponseMeta) return [];
  const sources = scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? ctx.sourceId ?? 'default'];
  const remote = ctx.remote !== false;
  const visibility = remote ? `AND f.visibility = 'world' AND ${privateProvenanceFilterFragment('f')}` : '';
  try {
    // Most searches have no saved fact to find: one indexed probe (idx_facts_since) with the
    // same active-fact and visibility predicates skips the LIKE ANY scan when no fact qualifies.
    const any = await ctx.engine.executeRaw(
      `SELECT 1 FROM facts f
       WHERE f.source_id = ANY($1::text[])
         AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())
         AND f.source != ALL($2::text[])
         ${visibility}
       LIMIT 1`,
      [sources, [...AUDIT_ROW_SOURCES]],
    );
    if (any.length === 0) return [];
    const rows = await ctx.engine.executeRaw<SavedFactMatch & { haystack: string }>(
      `SELECT f.id, f.fact, f.entity_slug, f.kind, f.valid_from::text AS valid_from, f.source,
         lower(f.fact || ' ' || COALESCE(f.entity_slug, '')) AS haystack
       FROM facts f
       WHERE f.source_id = ANY($1::text[])
         AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())
         AND f.source != ALL($2::text[])
         AND lower(f.fact || ' ' || COALESCE(f.entity_slug, '')) LIKE ANY($3::text[])
         ${visibility}
       ORDER BY f.valid_from DESC, f.id DESC
       LIMIT 200`,
      [sources, [...AUDIT_ROW_SOURCES], terms.map(t => `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`)],
    );
    const need = Math.max(Math.min(2, terms.length), Math.ceil(terms.length * 0.75));
    return rows
      .map(r => ({ r, hits: terms.filter(t => r.haystack.includes(t)).length }))
      .filter(x => x.hits >= need)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 5)
      .map(({ r: { haystack: _h, ...fact } }) => ({ ...fact, id: Number(fact.id) }));
  } catch {
    return [];
  }
}

/**
 * WP2/D3 + E1: the `retrieval` response-meta payload for the search/query
 * ops. Carries the already-computed HybridSearchMeta signal (vector arm,
 * cache, budget, degradation stages — populated by the search pipeline) plus
 * the concept-shaped hint, so an MCP caller can distinguish "clean miss"
 * from "the pipeline degraded" without a second call. The `hint` is
 * non-contractual prose (agents read it; nothing should parse it).
 *
 * #5004: this is the ONE producer of the channel (keyword-only path included,
 * which never runs hybridSearch), so the safe-chunk fence is disclosed here:
 * a result for a remote caller whose scope still holds unsealed pages gets
 * `safe_index_pending` appended, whether it came back empty or partial. The
 * withholding itself is unchanged.
 *
 * #5988: hits whose page's newer file is held get `stale` (the rows are the
 * call's own copies, stamped in place), and a scope with held files gets
 * `held_files` per source plus the `held_files` degraded notice.
 */
async function buildRetrievalResponseMeta(
  ctx: OperationContext,
  scope: SourceScope,
  queryText: string,
  results: unknown[],
  meta: HybridSearchMeta | null,
  opts: { conceptHint?: boolean; types?: string[]; typeFilterNotice?: string; declarations?: DeclarationMemo; feedbackOp?: 'query' | 'search' } = {},
): Promise<Record<string, unknown>> {
  const m = meta as (HybridSearchMeta & { degraded?: unknown[]; retrieved_count?: number }) | null;
  const hint = opts.conceptHint && looksConceptShaped(queryText)
    ? "concept-shaped question — the 'query' tool adds multi-query expansion and recovers " +
      'synonym-phrased matches this keyword-leaning search can miss.'
    : undefined;
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  const excludeSlugPrefixes = resolveHardExcludes();
  const safeIndexPending = ctx.remote !== false
    && await hasUnsealedPagesInScope(ctx, scope, excludePrivate, { types: opts.types, excludeSlugPrefixes });
  const readiness = await probeProjectionReadiness(ctx.engine, {
    ...scope,
    excludePrivate,
    types: opts.types,
    excludeSlugPrefixes,
  });
  const aliases = (opts.declarations ?? new DeclarationMemo()).scan(results as DeclarationRow[], queryText);
  const savedFacts = await matchingSavedFacts(ctx, scope, queryText, aliases);
  const heldFiles = await stampHeldHits(ctx.engine, results as SearchResult[], scope, ctx).catch(() => []);
  const heldNotice = heldFilesNotice(heldFiles, ctx.remote !== false);
  if (heldNotice) ctx.emitNotice?.(heldNotice);
  const degraded = [...(m?.degraded ?? [])];
  if (safeIndexPending) degraded.push({ stage: 'safe_index_pending' });
  if (readiness.status !== 'ready') {
    degraded.push({ stage: readiness.status === 'projection_pending' ? 'projection_pending' : 'projection_status_unknown' });
  }
  const planNotice = relationalPlanNotice(m?.relational_plan);
  if (planNotice) ctx.emitNotice?.(planNotice);
  return {
    returned_count: results.length,
    retrieved_count: m?.retrieved_count ?? results.length,
    ...(m ? {
      vector_enabled: m.vector_enabled,
      expansion_applied: m.expansion_applied,
      ...(m.cache ? { cache: m.cache.status } : {}),
      ...(m.token_budget ? { token_budget: m.token_budget } : {}),
      ...(m.vector_pool_underfilled ? { vector_pool_underfilled: m.vector_pool_underfilled } : {}),
      ...(m.decide ? { decide: m.decide } : {}),
      ...(m.rerank ? { rerank: m.rerank } : {}),
      ...(m.answerability ? { answerability: m.answerability } : {}),
      ...(m.relational_plan ? { relational_plan: m.relational_plan } : {}),
    } : {}),
    ...((m?.degraded !== undefined || degraded.length > 0) ? { degraded } : {}),
    projection_readiness: readiness,
    ...(opts.typeFilterNotice ? { type_filter_notice: opts.typeFilterNotice } : {}),
    ...(savedFacts.length ? { saved_facts: savedFacts } : {}),
    ...(aliases.length ? { other_names: aliases } : {}),
    ...(heldFiles.length ? { held_files: heldFiles } : {}),
    ...(hint || readiness.hint ? { hint: [hint, readiness.hint].filter(Boolean).join(' ') } : {}),
    ...(opts.feedbackOp ? await searchAnswerFeedback(ctx, opts.feedbackOp, results as SearchResult[]) : {}),
  };
}

/**
 * #3985: normalize the `types` param. MCP passes a real array; the CLI
 * passes `--types person,company` as one string. Rejects non-string entries
 * and a non-empty list whose entries trim/filter to nothing loudly
 * (invalid_params) instead of silently dropping the filter.
 *
 * #5390: a structurally empty array (`[]`), `""` or a whitespace-only string
 * carries no user intent — it is
 * what OpenAI-family MCP clients send when an LLM over-fills every optional
 * parameter with a type-zero value. Treat it as absent (no filter applied)
 * rather than throwing, so the search still runs unfiltered. A non-empty
 * list that filters to nothing (`['']`, `',,'`) still throws, so a CLI
 * `--types ,` typo is still loud. The SQL-level plumbing (SearchOpts.types
 * → both engines' keyword/title/vector legs) has existed since v0.33
 * (whoknows); this just exposes it on the public search/query ops.
 */
function normalizeTypesParam(ctx: OperationContext, tool: 'search' | 'query', raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  // #5390: a structurally empty array, an empty string or a whitespace-only
  // string is treated as absent, not as a request for an impossible filter.
  // The CLI typo guard below still catches `',,'`, `' , '` and `['']`.
  if (Array.isArray(raw) && raw.length === 0) return undefined;
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : null;
  const example = ctx.remote === false ? 'person,company' : ['person', 'company'];
  if (arr === null || arr.some((t) => typeof t !== 'string')) {
    throw invalidParam(ctx, tool, 'types', `\`types\` must be an array of page-type strings (e.g. ${paramUse(ctx, 'types', example)}).`, { example });
  }
  const types = [...new Set((arr as string[]).map((t) => t.trim()).filter(Boolean))];
  if (types.length === 0) {
    throw invalidParam(ctx, tool, 'types',
      `\`types\` was provided but contained no usable page-type strings (e.g. ${paramUse(ctx, 'types', example)}).`, { example });
  }
  return types;
}

const TYPES_PARAM_DESCRIPTION = "Page types, e.g. ['person'].";

const SOURCE_ID_PARAM_DESCRIPTION = "One source, or '__all__'.";
const SALIENCE_PARAM = { type: 'string' as const, enum: ['off', 'on', 'strong'], description: 'Boost emotional pages (default: auto).' };

/**
 * Ranking explanation params, declared on `query` only and advertised on the
 * full MCP surface only: every declared param is re-sent to the model on each
 * turn, so the cheap `search` tool and the starter list stay lean (a starter
 * session reaches them with `request_tools {surface: 'full'}`). The local CLI
 * passes them to `search` too (`gbrain search --explain`).
 */
const EXPLAIN_PARAMS = {
  explain: { type: 'boolean' as const, description: 'Per-row score_details.', fullSurfaceOnly: true },
  explain_target: { type: 'string' as const, description: 'Expected page (slug or source:slug): why it is missing.', fullSurfaceOnly: true },
};

/** `explain_target` is `slug` or `source_id:slug` (slugs never contain ':'). */
function parseExplainTarget(raw: string): { slug: string; sourceId?: string } {
  const at = raw.indexOf(':');
  return at > 0 ? { sourceId: raw.slice(0, at), slug: raw.slice(at + 1) } : { slug: raw };
}

/**
 * explain_target, before the search: resolve the target among the pages this
 * caller can read (one probe under the same scope and visibility the search
 * uses). Returns the trace to thread into the search, or an early diagnosis
 * (not visible / ambiguous) that needs no trace.
 */
async function prepareExplainTarget(
  ctx: OperationContext, p: Record<string, unknown>, scope: SourceScope, excludePrivate: boolean, tool: 'search' | 'query',
): Promise<{ trace?: TargetTrace; early?: ExplainTargetDiagnosis } | null> {
  if (typeof p.explain_target !== 'string' || p.explain_target.trim() === '') return null;
  const { slug, sourceId } = parseExplainTarget(p.explain_target.trim());
  const retry = { tool, arguments: explainRetryArgs(p) };
  let probe;
  try {
    probe = await probeTarget((sql, params) => ctx.engine.executeRaw(sql, params), slug,
      { ...scope, excludePrivate, requireSafeChunks: ctx.remote !== false });
  } catch {
    return { trace: new TargetTrace({ slug, sourceId }) };
  }
  const early = diagnoseProbe({ slug, sourceId }, probe, { requireSafeChunks: ctx.remote !== false, retry });
  if (early && (early.code === 'target_not_found_or_not_visible' || early.code === 'target_ambiguous')) return { early };
  const resolvedSource = sourceId ?? (probe.length === 1 ? probe[0].source_id : undefined);
  return { trace: new TargetTrace({ slug, sourceId: resolvedSource }), ...(early ? { early } : {}) };
}

/** The caller's search arguments, minus explain params, so every fix is a complete retry call. */
function explainRetryArgs(p: Record<string, unknown>): Record<string, unknown> {
  const { explain: _e, explain_target: _t, ...rest } = p;
  return rest;
}

/** Adds the explain_target diagnosis to the retrieval meta when one was requested. */
function withExplainTarget(meta: Record<string, unknown>, diagnosis: ExplainTargetDiagnosis | undefined): Record<string, unknown> {
  return diagnosis ? { ...meta, explain_target: diagnosis } : meta;
}

/** explain_target, after the search: diagnose, refine an unretrieved target with the probe, and emit the fix as a notice. */
function finishExplainTarget(
  ctx: OperationContext, p: Record<string, unknown>, prep: { trace?: TargetTrace; early?: ExplainTargetDiagnosis } | null,
  results: SearchResult[], tool: 'search' | 'query',
): ExplainTargetDiagnosis | undefined {
  if (!prep) return undefined;
  let diag = prep.early;
  if (prep.trace) {
    const traced = diagnoseTrace(prep.trace, results, { tool, arguments: explainRetryArgs(p) });
    // A probe finding (no chunks / stale projection / unsealed) explains an unretrieved page better than "no arm found it".
    diag = traced.state === 'not_retrieved' && prep.early ? { ...prep.early, stages: traced.stages } : traced;
  }
  if (diag?.fix) {
    const notice: Notice = { code: diag.code, kind: 'info', why: diag.why, fix: diag.fix };
    ctx.emitNotice?.(notice);
  }
  if (!diag) return undefined;
  const { fix: _fix, ...wire } = diag;
  return wire as ExplainTargetDiagnosis;
}
const RECENCY_PARAM = { type: 'string' as const, enum: ['off', 'on', 'strong'], description: "Boost recent pages (default: auto)." };

const SNIPPET_CHARS_PARAM_DESCRIPTION = 'Max chars per chunk_text (0 = full).';

/** The query op's image branch embed; a brain that opted out of embedding refuses before the image reaches a provider. */
async function embedSearchImage(ctx: OperationContext, data: string, mime: string): Promise<Float32Array> {
  const { assertBrainEmbeddingEnabled } = await import('../embedding-dim-check.ts');
  await assertBrainEmbeddingEnabled(ctx.engine, ctx.config);
  const { embedMultimodal } = await import('../ai/gateway.ts');
  const [vec] = await embedMultimodal([{ kind: 'image_base64', data, mime }]);
  return vec;
}

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
  idempotent: true,
  outputRedaction: 'retrieval',
  description: SEARCH_DESCRIPTION,
  params: {
    query: { type: 'string', required: true, description: "Exact tokens or names, e.g. 'acme-example series A'." },
    limit: { type: 'number', description: 'Max results (default 20).' },
    offset: { type: 'number', description: 'Rows to skip.' },
    mode: { type: 'string', description: 'Local callers only.' },
    // #4398: per-call source scope, mirroring `query` — MCP clients passed it
    // here, got 'unknown parameter ignored', and read UNSCOPED results.
    source_id: { type: 'string', description: SOURCE_ID_PARAM_DESCRIPTION },
    // #3985: multi-type filter (plumbing shipped v0.33; exposed here).
    types: { type: 'array', items: { type: 'string' }, description: TYPES_PARAM_DESCRIPTION },
    // #3800: subagent token economy — per-call snippet cap.
    snippet_chars: { type: 'number', description: SNIPPET_CHARS_PARAM_DESCRIPTION },
    return_unit: RETURN_UNIT_PARAM,
    return_window: RETURN_WINDOW_PARAM,
    token_budget: { type: 'number', description: 'Evidence token cap (default 6000).' },
    // #4415: explicit ranking-axis overrides (the same knobs `query` has had
    // since v0.29.1). The auto-detect banks are English regex, so on a
    // non-English brain the recency/salience stages never fire — these flags
    // (CLI: --salience / --recency) are the per-call override; the
    // search.intent_patterns config is the per-brain fix.
    salience: SALIENCE_PARAM,
    recency: RECENCY_PARAM,
    fields: FIELDS_PARAM,
  },
  handler: async (ctx, p) => {
    const startedAt = Date.now();
    const queryText = p.query as string;
    const limit = (p.limit as number) || 20;
    const offset = (p.offset as number) || 0;
    // #3985: validated multi-type filter, threaded into both branches below.
    let types = normalizeTypesParam(ctx, 'search', p.types);
    // #3800: snippet cap (param > subagent config default > full text).
    const snippetCap = await resolveSnippetCap(ctx, p);
    const plan = await evidencePlanFor(ctx, p, snippetCap, 'search');
    // #4398: explicit per-call source_id wins over ctx.sourceId, validated
    // (invalid ids throw invalid_params) then resolved through the single
    // trust+grant resolver (resolveRequestedScope inside federatedSearchScope)
    // — out-of-grant ids throw permission_denied, and #2561's unqualified
    // trusted-local federated span is unchanged.
    const sourceIdParam = parseSourceIdParam(p.source_id, 'search', { allowAll: true });
    const scope = federatedSearchScope(ctx, sourceIdParam);
    // #4620: an explicit source_id must name a live source (after the grant check).
    await assertExplicitSourceLive(ctx, sourceIdParam);
    // #4352 — untrusted callers never see `visibility: private` pages
    // (config-gated; trusted local CLI unchanged).
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    const typeFilter = await reconcileTypeFilter(ctx, scope, excludePrivate, types);
    types = typeFilter.types;

    // T4/D5 — per-call mode honored ONLY for trusted/local callers so a remote
    // OAuth client can't escalate to the costly tokenmax bundle. Local + unknown
    // mode → loud reject; remote + mode set → silently ignored (uses config).
    const perCallMode = resolvePerCallMode(ctx, p.mode, 'search');

    // T4/D17 — escape hatch: keyword-only when the operator opts out of the
    // hybrid `search` contract (privacy/cost: no query text to an embedding
    // provider). Defaults to cheap-hybrid (D4/D15).
    const keywordOnly = (await ctx.engine.getConfig('search.mcp_keyword_only')) === 'true';

    if (keywordOnly) {
      if (types) {
        types = (await expandEngineTypeFilters(ctx.engine, { types, ...scope })).types;
        if (types?.length === 0) return [];
      }
      const sourceBoosts = resolveBoostMap(undefined, await ctx.engine.getConfig(SOURCE_BOOSTS_KEY));
      const raw = await ctx.engine.searchKeyword(queryText, { limit, offset, excludePrivate, requireSafeChunks: ctx.remote !== false, source_boosts: sourceBoosts, ...(types ? { types } : {}), ...scope });
      const results = dedupResults(raw).map(r => ({ ...r }));
      // #3783 — every row here IS a keyword hit (direct FTS path); mark
      // before stamping so evidence still reads keyword_exact.
      markKeywordHits(results);
      stampDeepResearchIds(results);
      stampEvidenceSafe(results);
      // #1699: the keyword-only opt-out must STILL surface the content_flag
      // agent-warning channel (hybridSearch stamps it; this branch bypasses
      // hybridSearch, so stamp explicitly). Fail-open inside the helper.
      await stampContentFlags(ctx.engine, results, { ...scope, excludePrivate });
      // #160: same for the unverified auto-extracted stub marker (no boost
      // to cancel on this path — keyword-only never applies the compiled-
      // truth boost — but the provenance marker must still surface).
      await stampUnverifiedExtractions(ctx.engine, results, { ...scope, excludePrivate });
      bumpLastRetrievedAt(ctx.engine, results.map((r) => r.page_id));
      maybeCaptureSearch(ctx, queryText, results, Date.now() - startedAt, false);
      // #3800: cap AFTER capture/meta so eval + cache see the real payload.
      return evidenceOutput(ctx, p, results, plan, { ...scope, excludePrivate }, null, snippetCap,
        rows => buildRetrievalResponseMeta(ctx, scope, queryText, rows, null, { conceptHint: true, types, typeFilterNotice: typeFilter.notice }));
    }

    // Cheap-hybrid (D4/D15): full vector+keyword+RRF+pool+title+alias, but
    // expansion OFF (no per-call LLM cost). `query` op is the full-control variant.
    let capturedMeta: HybridSearchMeta | null = null;
    const explainPrep = await prepareExplainTarget(ctx, p, scope, excludePrivate, 'search');
    const searchOpts = {
      limit,
      offset,
      expansion: false,
      excludePrivate,
      requireSafeChunks: ctx.remote !== false,
      takesHoldersAllowList: readHolders(ctx),
      ...(types ? { types } : {}),
      ...scope,
      ...(perCallMode ? { mode: perCallMode } : {}),
      // #4415: agent-explicit recency + salience (same posture as `query`).
      salience: p.salience as 'off' | 'on' | 'strong' | undefined,
      recency: p.recency as 'off' | 'on' | 'strong' | undefined,
      decide: { remote: ctx.remote !== false },
    };
    const primary = await hybridSearchCached(ctx.engine, queryText, {
      ...searchOpts, onMeta: (m) => { capturedMeta = m; }, explain: p.explain === true, explainTarget: explainPrep?.trace,
    });
    const declarations = new DeclarationMemo();
    const results = (await withDeclaredNameFanOut(primary, queryText, declarations,
      (alt, altLimit) => hybridSearchCached(ctx.engine, alt, { ...searchOpts, limit: altLimit, offset: 0 }))).map(r => ({ ...r }));
    stampDeepResearchIds(results);
    const latency_ms = Date.now() - startedAt;
    bumpLastRetrievedAt(ctx.engine, results.map((r) => r.page_id));
    maybeCaptureSearch(ctx, queryText, results, latency_ms, true, capturedMeta);
    // #3800: cap AFTER capture/meta so eval + cache see the real payload.
    return evidenceOutput(ctx, p, results, plan, { ...scope, excludePrivate }, capturedMeta, snippetCap,
      async rows => withExplainTarget(await buildRetrievalResponseMeta(ctx, scope, queryText, rows, capturedMeta, { conceptHint: true, types, typeFilterNotice: typeFilter.notice, declarations, feedbackOp: 'search' }), finishExplainTarget(ctx, p, explainPrep, results, 'search')));
  },
  scope: 'read', mutating: false,
  cliHints: { name: 'search', positional: ['query'] },
};

const query: Operation = {
  name: 'query',
  idempotent: true,
  outputRedaction: 'retrieval',
  description: QUERY_DESCRIPTION,
  params: {
    // v0.27.1: `query` is no longer strictly required — `--image <path>`
    // is the alternative entry point for image-similarity search. The CLI
    // validator at src/cli.ts honors `cliHints.altRequired` and admits the
    // image-only invocation. MCP / programmatic callers must still pass
    // `query` OR `image` (handler refuses if both are absent).
    query: { type: 'string', required: false, description: "Question or topic (required unless image)." },
    /** v0.27.1: image-similarity search. Path resolved on the CLI side
     *  before the op fires (the op receives raw bytes neither side; the
     *  CLI loads the file, base64-encodes, and passes through `image`). */
    image: { type: 'string', description: 'Base64 image.' },
    image_mime: { type: 'string', description: 'MIME type of image.' },
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
    // (`search_by_image`, a separate op in src/core/ops/image.ts, keeps its
    // own independent flat-20 default — different public contract, out of
    // scope here.) #4356 Problem 2: the image-similarity path (`image`
    // param) below now resolves the SAME mode-derived searchLimit as the
    // text path (was a hard `|| 20` regardless of mode, the last search arm
    // in this op that didn't honor conservative/balanced/tokenmax).
    limit: { type: 'number', description: 'Default 10/25/50 by search mode.' },
    offset: { type: 'number', description: 'Rows to skip.' },
    // #3985: multi-type filter (plumbing shipped v0.33; exposed here).
    types: { type: 'array', items: { type: 'string' }, description: TYPES_PARAM_DESCRIPTION },
    // #3800: subagent token economy — per-call snippet cap.
    snippet_chars: { type: 'number', description: SNIPPET_CHARS_PARAM_DESCRIPTION },
    return_unit: RETURN_UNIT_PARAM,
    return_window: RETURN_WINDOW_PARAM,
    token_budget: { type: 'number', description: 'Evidence token cap.' },
    expand: { type: 'boolean', description: 'Default true; false skips the LLM expansion.' },
    detail: { type: 'string', description: 'low (compiled truth), medium (default) or high (all chunks).' },
    fields: FIELDS_PARAM,
    mode: { type: 'string', description: 'Local callers only.' },
    // v0.20.0 Cathedral II Layer 10 C1/C2: language + symbol-kind filters.
    lang: { type: 'string', description: 'Code language.' },
    symbol_kind: { type: 'string', description: 'Code symbol type.' },
    // v0.20.0 Cathedral II Layer 7 (A2) / Layer 10 C3: two-pass structural expansion.
    near_symbol: { type: 'string', description: 'Anchor code symbol.' },
    walk_depth: { type: 'number', description: 'Code walk depth 1-2.' },
    // v0.29.1 — orthogonal recency + salience axes. YOU (the agent) decide.
    salience: SALIENCE_PARAM,
    recency: RECENCY_PARAM,
    since: { type: 'string', description: 'On/after: YYYY-MM-DD or 7d/2w/1y.' },
    until: { type: 'string', description: 'On/before.' },
    source_id: { type: 'string', description: SOURCE_ID_PARAM_DESCRIPTION },
    cross_modal: { type: 'string', enum: ['text', 'image', 'both', 'auto'], description: 'Default auto.' },
    embedding_column: { type: 'string', description: 'Registered embedding column.' },
    adaptive_return: { type: 'boolean', description: 'true when one answer is wanted (fewer rows; never returns empty); omit for breadth.' },
    autocut: { type: 'boolean', description: 'Default on (never returns empty); false gives full top-K for breadth, unlike adaptive_return.' },
    relational: { type: 'boolean', description: 'Relationship-graph arm (default on).' },
    ...EXPLAIN_PARAMS,
  },
  handler: async (ctx, p) => {
    const startedAt = Date.now();
    const expand = p.expand !== false;
    const detail = (p.detail as 'low' | 'medium' | 'high') || undefined;
    const queryText = p.query as string | undefined;
    // #3985: validated multi-type filter (text path; the image-similarity
    // branch below also honors it — searchVector filters types at SQL level).
    let types = normalizeTypesParam(ctx, 'query', p.types);
    // #3800: snippet cap (param > subagent config default > full text).
    const snippetCap = await resolveSnippetCap(ctx, p);
    const plan = await evidencePlanFor(ctx, p, snippetCap, 'query');
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
    // #4620: an explicit source_id must name a live source (after the grant check).
    await assertExplicitSourceLive(ctx, sourceIdParam);
    // #4352 — same enforcement for the full-control query op (both the image
    // searchVector branch and the text hybrid path below).
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);

    // Image-similarity branch: bypasses the text-only hybridSearch, embeds the
    // image via embedMultimodal and searches the embedding_image column.
    if (imageData) {
      const dates = resolveSearchDateBounds({
        since: typeof p.since === 'string' ? p.since : undefined,
        until: typeof p.until === 'string' ? p.until : undefined,
      });
      if (types) {
        types = (await expandEngineTypeFilters(ctx.engine, { types, ...querySourceScope })).types;
        if (types?.length === 0) return [];
      }
      const imageMeta: HybridSearchMeta = {
        vector_enabled: true, expansion_applied: false, detail_resolved: null, degraded: [],
      };
      const vec = await embedSearchImage(ctx, imageData, imageMime);
      // v0.34.1 (#861 F2 — 6th leak surface): the image path bypasses
      // hybridSearch and calls searchVector directly, so it needs its
      // own thread of the source scope. Pre-fix, this branch leaked
      // image pages across sources independent of the text path's fix.
      // #4356 Problem 2: the image path also bypasses hybridSearch's mode
      // resolution, so its default limit didn't honor the active search
      // mode. resolveEffectiveLimit applies the same chain (and the same
      // remote trust gate) hybridSearch does.
      const results = (await ctx.engine.searchVector(vec, {
        limit: await resolveEffectiveLimit(ctx, p),
        offset: (p.offset as number) || 0,
        embeddingColumn: 'embedding_image',
        excludePrivate,
        requireSafeChunks: ctx.remote !== false,
        takesHoldersAllowList: readHolders(ctx),
        ...(types ? { types } : {}),
        ...querySourceScope,
        ...dates,
        onVectorPoolMeta: info => {
          if (!info.underfilled) return;
          const { underfilled, ...detail } = info;
          imageMeta.vector_pool_underfilled = { ...detail, incomplete: true };
          imageMeta.degraded = [{ stage: 'vector_candidates_incomplete',
            reason: info.reason === 'deadline' ? 'timeout' : info.reason ?? 'candidate_budget' }];
        },
      })).map(r => ({ ...r }));
      stampDeepResearchIds(results);
      imageMeta.retrieved_count = results.length;
      return searchOutput(ctx, p, results, { ...await buildRetrievalResponseMeta(ctx, querySourceScope, queryText ?? '', results, imageMeta, { types }), ...(plan && (plan.unit !== 'auto' || plan.explicitUnit) ? { delivery: unsupportedDelivery(plan, 'image_query_unsupported') } : {}) }, snippetCap);
    }

    if (!queryText) {
      // WP3: typed envelope — a caller mistake must classify as invalid_params
      // over MCP, not the internal_error a plain throw produced.
      throw opError(
        'invalid_params',
        'query requires either `query` (text) or `image` (base64 bytes).',
        ctx.remote === false
          ? `Pass the search text as the positional argument (e.g. gbrain query "acme-example roadmap"), or ${paramUse(ctx, 'image', 'photo.png')}.`
          : 'Pass `query` with your search text (e.g. {"query": "acme-example roadmap"}), or `image` with base64 image bytes.',
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
    const typeFilter = await reconcileTypeFilter(ctx, querySourceScope, excludePrivate, types);
    types = typeFilter.types;
    let capturedMeta: HybridSearchMeta | null = null;
    const explainPrep = await prepareExplainTarget(ctx, p, querySourceScope, excludePrivate, 'query');
    // v0.32.x search-lite: route the query op through hybridSearchCached so
    // token budget and intent weighting apply at the operation boundary.
    // Semantic cache reuse is suspended in the wrapper.
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
      requireSafeChunks: ctx.remote !== false, decide: { remote: ctx.remote !== false, answerability: true },
      takesHoldersAllowList: readHolders(ctx),
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
      tokenBudget: !plan && typeof p.token_budget === 'number' ? (p.token_budget as number) : undefined,
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
      // (config default applies). The wrapper still applies adaptive sizing
      // while semantic cache reuse is suspended.
      adaptiveReturn: typeof p.adaptive_return === 'boolean' ? (p.adaptive_return as boolean) : undefined,
      // v0.42.3.0 — autocut ceiling override. Omitted = smart default (ON in
      // reranked modes). `false` forces the full top-K.
      autocut: typeof p.autocut === 'boolean' ? (p.autocut as boolean) : undefined,
      // v0.43 — relational recall override. Omitted = smart default (mode bundle).
      relationalRetrieval: typeof p.relational === 'boolean' ? (p.relational as boolean) : undefined,
      explain: p.explain === true, explainTarget: explainPrep?.trace,
    });
    const declarations = new DeclarationMemo();
    results = await withDeclaredNameFanOut(results, queryText, declarations, (alt, altLimit) => hybridSearchCached(ctx.engine, alt, {
      limit: altLimit, excludePrivate, requireSafeChunks: ctx.remote !== false, takesHoldersAllowList: readHolders(ctx),
      expansion: false, types, ...querySourceScope,
    }));
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
    let grade = gradeRetrievalConfidence(results, { query: queryText });
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
      // #4610: pass the documented guard inputs. `callerExpanded: expand`
      // implements the long-documented high-ceiling skip — a first pass that
      // already ran with expansion (the default) doesn't pay for a second
      // expansion LLM call + rerank over a near-identical query. Escalation
      // now fires for callers that explicitly opted out of expansion (the
      // shape where the forced-expansion re-run has something new to find).
      if (shouldEscalateRetrieval(grade, {
        enabled: escalationCfg === 'true',
        alreadyEscalated: false,
        callerExpanded: expand,
      })) {
        try {
          // The caller's effective row contract (shared with the image
          // branch — NOT a hardcoded 20, which over-delivered on conservative
          // and under-delivered on tokenmax). Resolved here, not earlier, so
          // the config reads only run on the rare escalation path.
          const effectiveLimit = await resolveEffectiveLimit(ctx, p);
          let escalatedMeta: HybridSearchMeta | null = null;
          const escalated = await hybridSearchCached(ctx.engine, queryText, {
            excludePrivate,
            requireSafeChunks: ctx.remote !== false,
            takesHoldersAllowList: readHolders(ctx),
            limit: Math.max(effectiveLimit, 50),
            offset: (p.offset as number) || 0,
            expansion: true,
            expandFn: expandQuery,
            relationalRetrieval: true,
            autocut: false, decide: { remote: ctx.remote !== false, rerankOnly: true }, // System One: S2-S5 off on the re-run
            detail,
            // Preserve the caller's #3985 type filter on the re-run, as
            // normalized for the base call (#5390: [] and "" stay absent).
            ...(types ? { types } : {}),
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
          // Grade the FULL escalated sweep (rank-1 is what the grader reads),
          // then adopt only the caller-visible window. #4610: the re-run is
          // deliberately wide (limit >= 50, autocut off), but `limit` is the
          // caller's row contract — pre-fix, an adopted escalation handed the
          // whole uncut sweep back (14-18 rows for a limit:10 request), and
          // bumpLastRetrievedAt + eval capture recorded the oversized set.
          const regraded = gradeRetrievalConfidence(escalated, { query: queryText });
          crag.escalated = true;
          crag.escalated_confidence = regraded.level;
          if (confidenceRank(regraded.level) > confidenceRank(grade.level)) {
            results = escalated.slice(0, effectiveLimit);
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
            const { embedQuery } = await import('../embedding.ts');
            const thinkScope = thinkSourceScopeOpts(ctx);
            const t = await runThink(ctx.engine, {
              question: queryText,
              since: typeof p.since === 'string' ? p.since : undefined,
              until: typeof p.until === 'string' ? p.until : undefined,
              ...thinkScope,
              remote: false,
              // #3734: activate takes' vector retrieval arm for CRAG think escalation.
              embedQuestion: (q) => embedQuery(q),
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

    results = results.map(r => ({ ...r }));
    stampDeepResearchIds(results);

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
    // #3800: cap AFTER capture/meta/CRAG so every internal consumer graded
    // and recorded the real payload; only the returned envelope is snipped.
    return evidenceOutput(ctx, p, results, plan, { ...querySourceScope, excludePrivate, detail }, capturedMeta, snippetCap,
      async rows => withExplainTarget({ ...(await buildRetrievalResponseMeta(ctx, querySourceScope, queryText, rows, capturedMeta, { types, typeFilterNotice: typeFilter.notice, declarations, feedbackOp: 'query' })), crag }, finishExplainTarget(ctx, p, explainPrep, results, 'query')));
  },
  scope: 'read', mutating: false,
  cliHints: { name: 'query', positional: ['query'] },
};


/**
 * Evidence delivery for a frozen, ordered hit list: exactly the evidence the
 * `query` op returns for those hits (same plan resolution, assembler and
 * redaction). gbrain-evals uses it for product-path parity (E3); agents can
 * use it to widen hits from an earlier search. Hits are resolved under the
 * caller's read scope — out-of-scope, deleted or private-to-caller hits are
 * reported by index in `unresolved`, never read.
 */
const assemble_evidence: Operation = {
  name: 'assemble_evidence',
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    'Deliver whole evidence for an ordered list of search hits (each {source_id, slug, chunk_id} from a prior search/query result): ' +
    "the same windows, sections or pages `query` returns with return_unit, packed into token_budget. Use it to widen hits you already have " +
    "instead of calling get_page per hit. Returns { results, delivery, unresolved }; results carry chunk_text (the evidence) and `delivered`.",
  params: {
    hits: { type: 'array', required: true, items: { type: 'object' }, description: 'Ordered hits, best first (max 50): [{ "source_id": "default", "slug": "chat/session-0412", "chunk_id": 8812 }]. chunk_id 0 addresses the page\'s first chunk.' },
    return_unit: { ...RETURN_UNIT_PARAM, description: "Evidence unit: 'chunk' | 'window' | 'section' | 'page' | 'auto' (default 'page')." },
    return_window: RETURN_WINDOW_PARAM,
    token_budget: { type: 'number', description: 'Token budget for the delivered evidence (default search.return_budget_default = 6000, auto search.return_budget_conversation = 24000; remote max 32000).' },
    detail: { type: 'string', enum: ['low', 'medium', 'high'], description: "As query: 'low' delivers compiled truth only (no timeline text)." },
  },
  scope: 'read', mutating: false,
  annotations: { title: 'assemble evidence', readOnlyHint: true },
  handler: async (ctx, p) => {
    const hits = p.hits;
    if (!Array.isArray(hits) || hits.some(h => typeof h !== 'object' || h === null
      || typeof (h as Record<string, unknown>).source_id !== 'string' || typeof (h as Record<string, unknown>).slug !== 'string'
      || !Number.isInteger((h as Record<string, unknown>).chunk_id))) {
      throw invalidParam(ctx, 'assemble_evidence', 'hits', 'hits must be an array of { source_id: string, slug: string, chunk_id: integer }.',
        { def: assemble_evidence.params.hits, example: [{ source_id: 'default', slug: 'chat/session-0412', chunk_id: 8812 }] });
    }
    const scope = federatedSearchScope(ctx);
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    const out = await assembleEvidenceForHits(ctx.engine, {
      hits: hits as FrozenHit[],
      return_unit: (p.return_unit as ReturnUnit | undefined) ?? 'page',
      return_window: p.return_window as number | undefined,
      budget_tokens: p.token_budget as number | undefined,
      detail: p.detail as 'low' | 'medium' | 'high' | undefined,
      caller: { remote: ctx.remote !== false, ...scope, excludePrivate },
    });
    return out;
  },
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
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
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
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Read-only search-mode dashboard: active mode, EVERY mode-bundle knob resolved with ' +
    'attribution (mode default vs config override), the three frozen bundles, and a ' +
    'reranker_readiness verdict (whether the resolved reranker will actually run; remote ' +
    'callers get the verdict without the host key inventory). Brain-level planes only — ' +
    'per-call SearchOpts overrides on individual searches are not shown (per_call_note in ' +
    'the payload spells this out). Never mutates; to change modes, tell the user to set the ' +
    'search.mode config key on the brain host.',
  params: {},
  scope: 'read', mutating: false,
  area: 'search',
  handler: async (ctx) => {
    const { buildModesReport, redactReadinessForRemote } = await import('../search/modes-report.ts');
    // Untrusted (remote) callers get the readiness verdict without the host's
    // provider-key inventory (env var names + presence + paste-ready fix).
    const modesReport = await buildModesReport(ctx.engine);
    return ctx.remote === false ? modesReport : redactReadinessForRemote(modesReport);
  },
};

const search_tune: Operation = {
  name: 'search_tune',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
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
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Semantic query-cache introspection: resolved knobs (enabled, similarity threshold, TTL) ' +
    'plus row counts and total hits. Read-only; clearing/pruning the cache stays on the CLI.',
  params: {},
  scope: 'admin',
  area: 'search',
  handler: async (ctx) => {
    const { withRelationGuard } = await import('./contract.ts');
    return withRelationGuard(async () => {
      const { SemanticQueryCache, loadCacheConfig, semanticResultCacheAvailable } = await import('../search/query-cache.ts');
      const config = await loadCacheConfig(ctx.engine);
      const cache = new SemanticQueryCache(ctx.engine, config);
      const stats = await cache.stats();
      return {
        schema_version: 1,
        enabled: semanticResultCacheAvailable() && (config.enabled ?? true),
        similarity_threshold: config.similarityThreshold,
        ttl_seconds: config.ttlSeconds,
        ...stats,
      };
    }, 'Query-cache statistics');
  },
};

// Ops in EXACTLY the canonical `operations` array order.
export const searchOperations: Operation[] = [
  search, query, assemble_evidence, search_stats, search_modes, search_tune, cache_stats,
];

/**
 * A multi-relation question whose chain did not produce answers gets a
 * notice naming why and the next call, so the agent never reads ordinary
 * results as "the graph has no answer".
 */
function relationalPlanNotice(plan: RelationalPlanMeta | undefined): Notice | null {
  if (!plan || plan.status === 'fired') return null;
  if (plan.status === 'unsupported') {
    return { code: 'relational_chain', kind: 'degraded', why: `This question chains relationships in a way the planner does not run (${plan.reason ?? 'unsupported'}), so no graph answer is included; split it into one-relationship questions, or call traverse_graph with explicit hops.` };
  }
  if (plan.status === 'anchor_not_found') {
    const anchor = plan.anchor ?? '';
    return { code: 'relational_chain', kind: 'degraded', why: `No page matches "${anchor}" in the searched sources, so the relationship chain did not run; the results are ordinary text matches.`,
      fix: readFix('Find the entity page first, then ask again with its exact name (or call traverse_graph with its slug and explicit hops).', { argv: ['gbrain', 'search', anchor], mcp: { tool: 'search', arguments: { query: anchor } } }) };
  }
  if (plan.status === 'truncated') {
    return { code: 'relational_chain', kind: 'info', why: `The relationship chain hit its ${plan.cap_hit?.cap ?? ''} cap at hop ${plan.cap_hit?.hop ?? '?'}, so lower-ranked answers were dropped; narrow the question or start from a more specific entity.` };
  }
  const hop = plan.empty_hop ?? 1;
  const slug = plan.anchor_slugs?.[0];
  return { code: 'relational_chain', kind: 'degraded', why: `Hop ${hop} of the relationship chain found no typed links${hop === 1 ? ` from "${plan.anchor ?? ''}"` : ''}; the relationship may only be written as plain mentions. The results are ordinary text matches.`,
    ...(slug ? { fix: readFix('A depth-1 walk shows what the start page is linked to.', { argv: ['gbrain', 'graph-query', slug, `--${'depth'}`, '1'], mcp: { tool: 'traverse_graph', arguments: { slug, depth: 1 } } }) } : {}) };
}
