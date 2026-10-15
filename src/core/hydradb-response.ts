/** HydraDB's structured evidence and SDK Markdown rendering, after local admission. */
import { buildString } from '@hydradb/sdk/helpers';
import type { HydraHit } from './hydradb.ts';
import type { SearchResult } from './types.ts';

type RecordValue = Record<string, any>;
export interface HydraResponse extends RecordValue { chunks?: RecordValue[]; sources?: RecordValue[]; llm_prompt?: string }
export interface HydraEvidence { response: HydraResponse; chunk: RecordValue; aliases: string[] }
export const HYDRA_MARKDOWN = Symbol('hydradb-markdown');
const HYDRA_RENDERER = Symbol('hydradb-renderer');
type Render = (row: SearchResult) => string;
interface Presentation { markdown: string; texts: string[] }

/** Metadata may live on a source rather than repeated on every chunk. */
export function hydraHits(response: HydraResponse): HydraHit[] {
  const sources = new Map((response.sources ?? []).map(s => [s.id, s]));
  return (response.chunks ?? []).flatMap(chunk => {
    const id = chunk.id ?? chunk.context_id;
    const source = sources.get(id);
    const metadata = chunk.additional_metadata ?? source?.additional_metadata ?? {};
    const sourceId = metadata.gbrain_source, slug = metadata.gbrain_slug;
    const text = chunk.chunk_content ?? chunk.content;
    if (typeof sourceId !== 'string' || typeof slug !== 'string' || typeof text !== 'string' || !text) return [];
    return [{ title: (chunk.source_title ?? source?.title ?? slug).replace(/\.md$/, ''), text, sourceId, slug, metadata,
      evidence: { response, chunk: { ...chunk, id, chunk_uuid: chunk.chunk_uuid ?? chunk.chunk_id },
        aliases: [chunk.chunk_uuid, chunk.chunk_id].filter((s): s is string => typeof s === 'string') } }];
  });
}

/** Related chunks also need their own metadata and read-policy checks. */
export function hydraRelatedChunks(response: HydraResponse): RecordValue[] {
  const related = Object.entries(response.additional_context ?? {}).map(([id, chunk]) => ({ ...(chunk as RecordValue), chunk_uuid: (chunk as RecordValue).chunk_uuid ?? id }));
  const forceful = response.forceful_relations;
  const entries = Array.isArray(forceful) ? forceful : [...(forceful?.declared ?? []), ...(forceful?.inferred ?? [])];
  related.push(...entries.map((e: RecordValue) => e.chunk ?? e.context).filter(Boolean));
  return related;
}

export function hydraRelatedHits(response: HydraResponse): HydraHit[] {
  return hydraHits({ ...response, chunks: hydraRelatedChunks(response) });
}

const refs = (path: RecordValue, graph: RecordValue): string[] => {
  const explicit = path.source_chunk_ids ?? path.chunk_ids;
  if (Array.isArray(explicit) && explicit.length) return explicit;
  const edges = (path.triplets ?? []).map((t: RecordValue) => t.relation?.chunk_id).filter(Boolean);
  if (edges.length) return edges;
  return Object.entries(graph.chunk_id_to_group_ids ?? {}).filter(([, groups]) => (groups as string[]).includes(path.group_id)).map(([id]) => id);
};
const camelPath = (p: RecordValue) => ({ groupId: p.group_id, sourceChunkIds: p.source_chunk_ids ?? p.chunk_ids,
  relevancyScore: p.relevancy_score, combinedContext: p.combined_context ?? p.path_summary,
  triplets: (p.triplets ?? []).map((t: RecordValue) => ({ source: t.source ?? {}, target: t.target ?? {},
    relation: { ...t.relation, canonical_predicate: t.relation?.canonical_predicate ?? t.relation?.predicate } })) });
const camelFact = (f: RecordValue) => ({ ...f, eventStart: f.event_start, eventEnd: f.event_end,
  datePrecision: f.date_precision, evidencePhrase: f.evidence_phrase });

/** Never flatten an unfiltered provider response: every supporting chunk must be admitted. */
export function hydraMarkdown(hit: HydraHit, text: string, admitted: Set<string>, related: HydraHit[]): string {
  const evidence = hit.evidence;
  if (!evidence) return text;
  const { response, chunk, aliases } = evidence;
  const graph = response.graph_context ?? {};
  const owns = (ids: string[]) => ids.some(id => aliases.includes(id));
  const allowed = (path: RecordValue) => { const ids = refs(path, graph); return ids.length > 0 && ids.every(id => admitted.has(id)) && owns(ids); };
  const paths = [...(graph.query_paths ?? []), ...(Array.isArray(response.graph) ? response.graph : response.graph?.paths ?? [])].filter(allowed);
  const relations = (graph.chunk_relations ?? []).filter(allowed);
  const supportIds = [...(chunk.extra_context_ids ?? []), ...paths.flatMap(p => refs(p, graph)), ...relations.flatMap((p: RecordValue) => refs(p, graph))];
  const extra = related.filter(h => !h.evidence?.aliases.some(id => aliases.includes(id))
    && supportIds.some(id => h.evidence?.aliases.includes(id)) && h.evidence?.aliases.every(id => admitted.has(id)));
  const sdkChunk = (h: HydraHit, body: string) => ({ id: h.evidence?.chunk.id, chunkUuid: h.evidence?.chunk.chunk_uuid,
    sourceTitle: h.title, chunkContent: body + (h.evidence?.aliases.some(id => admitted.has(id)) && typeof h.evidence?.chunk.enrichment === 'string' ? '\n\n**Enriched content:**\n' + h.evidence.chunk.enrichment : '') + (h.evidence?.aliases.some(id => admitted.has(id)) && Array.isArray(h.evidence?.chunk.temporal) ? '\n\n**Dated facts:**\n' + h.evidence.chunk.temporal.map((f: RecordValue) => f.content).filter((s: unknown) => typeof s === 'string').join('\n') : ''), relevancyScore: h.evidence?.chunk.relevancy_score ?? h.evidence?.chunk.score,
    additionalMetadata: Object.fromEntries(Object.entries(h.metadata).filter(([key]) => key !== 'gbrain_revision')) });
  const factAllowed = (fact: RecordValue | undefined): boolean => !!fact && (
    typeof fact.chunk_id === 'string' ? admitted.has(fact.chunk_id) : typeof fact.source_id === 'string' && admitted.has(fact.source_id));
  const facts = (response.temporal_facts ?? []).filter((f: RecordValue) => factAllowed(f) && (f.source_id === chunk.id || aliases.includes(f.chunk_id)));
  const duration = response.temporal_duration;
  const safeDuration = duration && factAllowed(duration.from) && (!duration.to || factAllowed(duration.to))
    && (duration.from.source_id === chunk.id || aliases.includes(duration.from.chunk_id));
  // Deliberately omit the full llm_prompt here: filtered/windowed results must not revive rejected evidence.
  return buildString({ chunks: [sdkChunk(hit, text), ...extra.map(h => sdkChunk(h, h.text))],
    graphContext: { queryPaths: paths.map(camelPath), chunkRelations: relations.map(camelPath) },
    temporalFilter: response.temporal_filter, temporalFacts: facts.map(camelFact),
    ...(safeDuration ? { temporalDuration: { ...duration, fromDate: duration.from_date, toDate: duration.to_date } } : {}) });
}

/** Save the canonical server Markdown only when its entire evidence set survived admission. */
export function attachHydraMarkdown(rows: object[], hits: HydraHit[], related: HydraHit[], admitted: Set<string>, selected: HydraHit[], budget?: number): void {
  const response = hits[0]?.evidence?.response;
  rows.forEach((row, i) => Object.assign(row, { [HYDRA_MARKDOWN]: true, [HYDRA_RENDERER]: (shown: SearchResult) => {
    const hit = selected[i]!;
    const fresh = !shown.delivered?.revision || shown.delivered.revision === hit.metadata.gbrain_revision;
    return fresh ? hydraMarkdown({ ...hit, title: shown.title ?? hit.title }, shown.chunk_text, admitted, [...hits, ...related]) : shown.chunk_text;
  } }));
  if (!rows.length || budget || !response?.llm_prompt || hits.length !== selected.length || related.some(h => !h.evidence?.aliases.every(id => admitted.has(id)))) return;
  const all = [...hits, ...related];
  if ((response.chunks?.length ?? 0) !== hits.length || (response.sources ?? []).some(s => !admitted.has(s.id))) return;
  const forceful = response.forceful_relations;
  const declared = Array.isArray(forceful) ? forceful : [...(forceful?.declared ?? []), ...(forceful?.inferred ?? [])];
  const rawRelated = [...Object.values(response.additional_context ?? {}), ...declared.map((e: RecordValue) => e.chunk ?? e.context)];
  if (rawRelated.some((c: any) => !c || !admitted.has(c.chunk_uuid ?? c.chunk_id))) return;
  if ((response.alias_expansions ?? []).length || (response.source_facts ?? []).some((f: RecordValue) => !admitted.has(f.chunk_id ?? f.source_id))) return;
  if (all.some(h => !h.evidence?.aliases.length || !h.evidence.aliases.every(id => admitted.has(id)))) return;
  const graph = response.graph_context ?? {};
  const paths = [...(graph.query_paths ?? []), ...(graph.chunk_relations ?? []), ...(Array.isArray(response.graph) ? response.graph : response.graph?.paths ?? [])];
  if (paths.some((p: RecordValue) => { const ids = refs(p, graph); return !ids.length || ids.some(id => !admitted.has(id)); })) return;
  if ((response.temporal_facts ?? []).some((f: RecordValue) => !admitted.has(f.chunk_id ?? f.source_id))) return;
  const duration = response.temporal_duration;
  if (duration && [duration.from, duration.to].filter(Boolean).some(f => !admitted.has(f.chunk_id ?? f.source_id))) return;
  const presentation: Presentation = { markdown: buildString(response), texts: rows.map(r => (r as { chunk_text: string }).chunk_text) };
  for (const row of rows) Object.assign(row, { [HYDRA_MARKDOWN]: presentation });
}

/** Re-check text after delivery, redaction, snippets and budgets before using the server's whole prompt. */
export function markdownForHydraRows(rows: Array<{ chunk_text?: string; chunk?: string; title?: string }>, original = rows, budgeted = false): string {
  const presentation = (original[0] as { [HYDRA_MARKDOWN]?: Presentation } | undefined)?.[HYDRA_MARKDOWN];
  const texts = rows.map(r => r.chunk_text ?? r.chunk ?? '');
  if (budgeted) return texts.join('\n\n');
  if (presentation && typeof presentation === 'object' && texts.length === presentation.texts.length && texts.every((text, i) => text === presentation.texts[i])) return presentation.markdown;
  const formatted = rows.map((row, i) => {
    const source = original.find(r => (r as SearchResult).slug === (row as SearchResult).slug && (r as SearchResult).source_id === (row as SearchResult).source_id) as (SearchResult & { [HYDRA_RENDERER]?: Render }) | undefined;
    const delivery = (row as SearchResult).delivered;
    return source?.[HYDRA_RENDERER] && delivery && delivery.unit !== 'chunk' && !delivery.truncated ? source[HYDRA_RENDERER](row as SearchResult) : texts[i];
  });
  return texts.length ? '# HydraDB context\n\n' + formatted.map((text, i) => `## ${i + 1}. ${rows[i]!.title ?? 'Memory'}\n\n${text}`).join('\n\n') : '# HydraDB context\n\nNo matching memory found.';
}

/** Delivery redacts/copies rows, so retain formatting separately from its authoritative text and match spans. */
export function carryHydraRenderers(rows: SearchResult[], original: SearchResult[]): void {
  for (const row of rows) {
    const source = original.find(r => r.slug === row.slug && r.source_id === row.source_id && r.chunk_id === row.chunk_id) as (SearchResult & { [HYDRA_RENDERER]?: Render }) | undefined;
    if (source?.[HYDRA_RENDERER]) Object.assign(row, { [HYDRA_RENDERER]: source[HYDRA_RENDERER], [HYDRA_MARKDOWN]: true });
  }
}
