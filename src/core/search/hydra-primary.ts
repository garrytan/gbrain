/**
 * HydraDB as this brain's search backend (`gbrain cloud primary on`, set by
 * connect): `hybridSearchCached` returns HydraDB's ranking instead of the
 * local pipeline's.
 *
 * Each hit resolves to this brain's own page row under the caller's full read
 * policy (pageReadFilter + buildVisibilityClause: source, private, safe chunks,
 * trust, deleted, archived, quarantine), anchored on the page chunk its passage
 * overlaps most, so every later stage reads a normal row. A hit for a page this
 * brain does not hold (another device's) becomes a `cloud` row unless the
 * caller has a trust floor; a held page the caller may not read is dropped.
 * Source, type, date and slug filters retain the cloud ranking. Image/symbol
 * walks and any HydraDB error or slow answer return null for local fallback.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageType, SearchResult } from '../types.ts';
import { isConfigTruthy } from '../config.ts';
import { warnOncePerProcess } from '../utils.ts';
import { HYDRADB_CONFIG, hydraQueryMode, hasHydraKey, queryHydraResponse, type HydraHit, resolveHydraConnection, type HydraConnection } from '../hydradb.ts';
import { pageKey, pageReadability, pageReadFilter } from './read-policy-sql.ts';
import { buildVisibilityClause } from './sql-ranking.ts';
import type { HybridSearchOpts } from './hybrid.ts';
import { UNTIMED } from './stage-timings.ts';
import { expandEngineTypeFilters } from '../schema-pack/query-types.ts';
import { hydraFilter } from './hydra-filters.ts';
import { hydraHits, hydraRelatedHits, hydraMarkdown, attachHydraMarkdown } from '../hydradb-response.ts';
import { enforceTokenBudget } from './token-budget.ts';
import type { HybridSearchMeta } from '../types.ts';

export const usesHydraSearch = (meta: HybridSearchMeta | null): boolean => meta?.backend === 'hydradb';
export async function hydraPrimaryEnabled(engine: BrainEngine): Promise<boolean> {
  return await hasHydraKey() && isConfigTruthy(await engine.getConfig(HYDRADB_CONFIG.primary));
}

const PRIMARY_TIMEOUT_MS = 2_500;

/** Options that narrow results in ways HydraDB's query cannot express. */
// Image embeddings and structural symbol walks are distinct local operations.

interface ChunkRow { page_id: number; slug: string; source_id: string; title: string; type: string;
  chunk_id: number; chunk_index: number; chunk_text: string; chunk_source: SearchResult['chunk_source'];
  knowledge_revision: string; effective_date: string | null; language: string | null; symbol_type: string | null }

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

async function readableChunks(engine: BrainEngine, refs: Array<{ sourceId: string; slug: string }>, opts: HybridSearchOpts | undefined): Promise<Map<string, ChunkRow[]>> {
  const params: unknown[] = [refs.map(r => r.sourceId), refs.map(r => r.slug)];
  const filter = pageReadFilter('p', opts, params);
  const rows = await engine.executeRaw<ChunkRow>(
    `SELECT p.id AS page_id, p.slug, p.source_id, p.title, p.type, p.knowledge_revision, p.effective_date, cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source, cc.language, cc.symbol_type
     FROM pages p
     JOIN sources s ON s.id = p.source_id
     JOIN unnest($1::text[], $2::text[]) AS refs(source_id, slug) ON p.source_id = refs.source_id AND p.slug = refs.slug
     JOIN content_chunks cc ON cc.page_id = p.id ${opts?.detail === 'low' ? "AND cc.chunk_source = 'compiled_truth'" : ''}
     WHERE ${filter} ${buildVisibilityClause('p', 's', { excludePrivate: opts?.excludePrivate, requireSafeChunks: opts?.requireSafeChunks, minTrust: opts?.minTrust, suppressFlagged: opts?.suppressFlagged })}`,
    params);
  const byPage = new Map<string, ChunkRow[]>();
  for (const row of rows) byPage.set(pageKey(row.source_id, row.slug), [...(byPage.get(pageKey(row.source_id, row.slug)) ?? []), row]);
  return byPage;
}

export async function hydraPrimarySearch(engine: BrainEngine, query: string, opts: HybridSearchOpts | undefined, limit: number): Promise<SearchResult[] | null> {
  if (opts?.nearSymbol || opts?.crossModal === 'image') return null;
  if (!await hydraPrimaryEnabled(engine)) return null;
  const conn = await resolveHydraConnection(engine);
  if (!conn) return null;
  const types = await expandEngineTypeFilters(engine, opts ?? {});
  opts = { ...opts, ...types };
  if (opts.types?.length === 0) {
    opts.onMeta?.({ backend: 'hydradb', vector_enabled: false, detail_resolved: opts.detail ?? null, expansion_applied: false, degraded: [], retrieved_count: 0 });
    return [];
  }
  return (opts?._timings ?? UNTIMED).stage('hydradb', () => rankFromHydra(engine, conn, query, opts, limit));
}

async function rankFromHydra(engine: BrainEngine, conn: HydraConnection, query: string, opts: HybridSearchOpts | undefined, limit: number): Promise<SearchResult[] | null> {
  const admits = hydraFilter(opts); // invalid dates fail before any query leaves the machine
  try {
    const sources = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : undefined);
    const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
    const wanted = Math.min(1000, limit + offset);
    const mode = hydraQueryMode(await engine.getConfig(HYDRADB_CONFIG.mode));
    const response = await queryHydraResponse(conn, query, { sources, types: opts?.types ?? (opts?.type ? [opts.type] : undefined),
      maxResults: Math.min(1000, wanted * 4), mode, timeoutMs: mode === 'thinking' ? 15_000 : PRIMARY_TIMEOUT_MS });
    const hits = hydraHits(response).filter(h => !sources || sources.includes(h.sourceId));
    const related = hydraRelatedHits(response).filter(h => !sources || sources.includes(h.sourceId));
    const all = [...hits, ...related];
    const held = await pageReadability(engine, all.map(h => ({ slug: h.slug, source_id: h.sourceId })), opts);
    const chunks = await readableChunks(engine, all, opts);
    const admitted = new Set<string>();
    for (const hit of all) {
      const key = pageKey(hit.sourceId, hit.slug);
      const local = chunks.get(key)?.find(c => admits({ slug: c.slug, type: c.type, date: c.effective_date, language: c.language, symbolKind: c.symbol_type }));
      const fresh = local && hit.metadata.gbrain_revision === local.knowledge_revision;
      const remote = !held.has(key) && !opts?.minTrust && !opts?.suppressFlagged && admits({ slug: hit.slug,
        type: typeof hit.metadata.gbrain_type === 'string' ? hit.metadata.gbrain_type : undefined,
        date: typeof hit.metadata.gbrain_date === 'string' ? hit.metadata.gbrain_date : undefined });
      if (fresh || remote) {
        for (const id of hit.evidence?.aliases ?? []) admitted.add(id);
        if (hit.evidence?.chunk.id) admitted.add(hit.evidence.chunk.id);
      }
    }
    const selected: HydraHit[] = [];
    const seen = new Set<string>();
    const rows: SearchResult[] = [];
    for (const hit of hits) {
      const key = pageKey(hit.sourceId, hit.slug);
      const candidates = chunks.get(key)?.filter(c => admits({ slug: c.slug, type: c.type, date: c.effective_date, language: c.language, symbolKind: c.symbol_type }));
      if (candidates?.length) {
        const passage = words(hit.text);
        const best = candidates.map(c => ({ c, n: [...words(c.chunk_text)].filter(w => passage.has(w)).length })).reduce((a, b) => (b.n > a.n ? b : a)).c;
        if (seen.has(`${best.chunk_id}`)) continue;
        seen.add(`${best.chunk_id}`); selected.push(hit);
        rows.push({ slug: best.slug, page_id: best.page_id, title: best.title, type: best.type as PageType, chunk_text: hydraMarkdown({ ...hit, title: best.title, metadata: { ...hit.metadata, gbrain_type: best.type, gbrain_date: best.effective_date ? new Date(best.effective_date).toISOString() : undefined } }, best.chunk_text, admitted, all),
          chunk_source: best.chunk_source, chunk_id: best.chunk_id, chunk_index: best.chunk_index, score: 0, stale: false, source_id: best.source_id,
          effective_date: best.effective_date ? new Date(best.effective_date).toISOString() : null });
      } else if (!held.has(key) && !opts?.minTrust && !opts?.suppressFlagged && !seen.has(key)
        && admits({ slug: hit.slug, type: typeof hit.metadata.gbrain_type === 'string' ? hit.metadata.gbrain_type : undefined,
          date: typeof hit.metadata.gbrain_date === 'string' ? hit.metadata.gbrain_date : undefined })) {
        seen.add(key); selected.push(hit);
        rows.push({ result_type: 'cloud', slug: `cloud/${hit.slug}`, page_id: 0, title: hit.title, type: 'note', chunk_text: hydraMarkdown(hit, hit.text, admitted, all),
          chunk_source: 'compiled_truth', chunk_id: 0, chunk_index: 0, score: 0, stale: false, source_id: hit.sourceId } as SearchResult);
      }
      if (rows.length >= wanted) break;
    }
    rows.forEach((r, i) => { r.score = 1 / (i + 1); });
    attachHydraMarkdown(rows, hits, related, admitted, selected, opts?.tokenBudget);
    const budgeted = enforceTokenBudget(rows.slice(offset, offset + limit), opts?.tokenBudget);
    opts?.onMeta?.({ backend: 'hydradb', hydradb_mode: mode, vector_enabled: false, detail_resolved: opts.detail ?? null, expansion_applied: false,
      degraded: [], retrieved_count: rows.length, ...(opts?.tokenBudget ? { token_budget: budgeted.meta } : {}) });
    return budgeted.results;
  } catch (e) {
    warnOncePerProcess('hydradb-primary-fallback', `[gbrain] HydraDB search unavailable (${(e as Error).message}); searching this brain locally.`);
    return null;
  }
}
