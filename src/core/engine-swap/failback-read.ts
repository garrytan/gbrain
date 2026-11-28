/**
 * What failback reads (docs/guides/engine-swap.md#failback): a brain image built only from BrainEngine read calls the
 * Rust engine serves (src/core/rust-engine/members.ts), read the same way on both engines so the two can be compared.
 *
 * The Rust store has no row export, and its shadow digests are written only by the seed and the follower, so writes
 * made after the swap never update them. Failback therefore never reads a digest or raw SQL on the Rust side: each
 * part of the image below names the read call it comes from, and `FAILBACK_CARRIED` is the closed list of the columns
 * those calls return. Every other table and column is a named loss (`failbackLosses`).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

export interface PageRef { slug: string; source_id: string }

/** Values compared as text: dates as ISO strings, JSON with sorted keys, numbers as numbers. */
type Plain = string | number | boolean | null | Plain[] | { [k: string]: Plain };

export interface ChunkImage { row: Record<string, Plain>; embedding: Float32Array | null }
export interface PageImage {
  ref: PageRef;
  /** This engine's row id: ids of pages created after the swap differ between the engines (an accepted loss). */
  id: number;
  sealed: boolean;
  parts: {
    page: Record<string, Plain>;
    tags: Plain[];
    links: Plain[];
    timeline: Plain[];
    chunks: Plain[];
    raw: Plain[];
    takes: Plain[];
    files: Plain[];
  };
  embeddings: Array<Float32Array | null>;
}
export type PagePart = keyof PageImage['parts'];
export const PAGE_PARTS: readonly PagePart[] = ['page', 'tags', 'links', 'timeline', 'chunks', 'raw', 'takes', 'files'];

/** Page columns `getPage` returns that failback writes back. */
export const PAGE_FIELDS = [
  'type', 'title', 'compiled_truth', 'timeline', 'frontmatter', 'content_hash', 'effective_date', 'effective_date_source',
  'import_filename', 'source_path', 'source_kind', 'source_uri', 'ingested_via', 'ingested_at', 'created_at', 'updated_at',
] as const;
const BODY_FIELDS = new Set<string>(['compiled_truth', 'timeline']);

/** The page part without the body fields, for a comparison where either side keeps its body in segments. */
function withoutBody(page: Record<string, Plain>): Record<string, Plain> {
  const out: Record<string, Plain> = {};
  for (const [k, v] of Object.entries(page)) if (!BODY_FIELDS.has(k) && k !== 'segmented') out[k] = v;
  return out;
}

export function isSegmented(img: PageImage | null): boolean { return img?.parts.page.segmented === true; }

const CHUNK_FIELDS = ['chunk_index', 'chunk_text', 'chunk_source', 'model', 'token_count', 'language', 'symbol_name', 'symbol_type',
  'start_line', 'end_line', 'parent_symbol_path', 'doc_comment', 'symbol_name_qualified', 'modality'] as const;
const LINK_FIELDS = ['to_slug', 'to_source_id', 'link_type', 'context', 'link_source', 'origin_slug', 'origin_source_id', 'origin_field'] as const;
export const TAKE_FIELDS = ['id', 'row_num', 'claim', 'kind', 'holder', 'weight', 'since_date', 'until_date', 'source', 'superseded_by', 'active',
  'resolved_at', 'resolved_outcome', 'resolved_quality', 'resolved_value', 'resolved_unit', 'resolved_source', 'resolved_by', 'created_at', 'updated_at'] as const;
export const FILE_FIELDS = ['id', 'source_id', 'page_slug', 'filename', 'storage_path', 'mime_type', 'size_bytes', 'content_hash', 'metadata', 'created_at'] as const;
export const FACT_FIELDS = ['id', 'source_id', 'entity_slug', 'fact', 'kind', 'visibility', 'notability', 'context', 'valid_from', 'valid_until',
  'expired_at', 'superseded_by', 'consolidated_at', 'consolidated_into', 'source', 'source_session', 'confidence', 'embedded_at', 'created_at',
  'embedding_model', 'embedded_text_hash', 'claim_metric', 'claim_value', 'claim_unit', 'claim_period', 'trust_tier', 'write_origin'] as const;
export const SOURCE_FIELDS = ['id', 'name', 'local_path', 'last_commit', 'last_sync_at', 'config', 'created_at', 'contextual_retrieval_mode', 'trust_frontmatter_overrides'] as const;

/**
 * The closed list of what failback carries: per table, the columns a Rust read call returns and failback writes.
 * `derived` columns are recomputed by the primary on write (ids, revisions, search vectors, body storage), so they are
 * not losses. Any other column of these tables, and every other table, is reported by `failbackLosses`.
 */
export const FAILBACK_CARRIED: Readonly<Record<string, { read: string; columns: readonly string[]; derived: readonly string[] }>> = {
  pages: { read: 'listAllPageRefs + getPage', columns: [...PAGE_FIELDS, 'slug', 'source_id', 'deleted_at'],
    // Recomputed by the old primary when it writes the page (ids, revisions, body storage, search vector, chunk seal).
    derived: ['id', 'search_vector', 'knowledge_revision', 'text_projection_revision', 'generation', 'corpus_generation', 'contextual_retrieval_mode',
      'chunker_version', 'embedding_signature', 'body_storage', 'body_bytes', 'truth_bytes', 'body_lines', 'body_generation', 'segment_count',
      'segmenter_version', 'body_flags', 'truth_lead', 'timeline_lead'] },
  tags: { read: 'getTags', columns: ['page_id', 'tag'], derived: ['id'] },
  links: { read: 'getLinks', columns: ['from_page_id', 'to_page_id', 'link_type', 'context', 'link_source', 'origin_page_id', 'origin_field'], derived: ['id'] },
  timeline_entries: { read: 'getTimeline', columns: ['page_id', 'date', 'source', 'summary', 'detail'], derived: ['id'] },
  content_chunks: { read: 'getChunksWithEmbeddings', columns: ['page_id', ...CHUNK_FIELDS, 'embedding'],
    // The chunk projection's own bookkeeping, rebuilt when the old primary seals the page.
    derived: ['id', 'search_vector', 'embedded_at', 'edges_backfilled_at', 'embedding_pending_since', 'projected_byte_start', 'projected_byte_end',
      'occurrence_id', 'local_ordinal', 'raw_byte_start', 'raw_byte_end', 'body_generation', 'retired_generation', 'created_at'] },
  raw_data: { read: 'getRawData', columns: ['page_id', 'source', 'data', 'fetched_at'], derived: ['id'] },
  takes: { read: 'listTakes', columns: ['page_id', ...TAKE_FIELDS], derived: [] },
  files: { read: 'listFilesForPage', columns: ['page_id', ...FILE_FIELDS], derived: [] },
  facts: { read: 'listFactsKeyset', columns: [...FACT_FIELDS, 'embedding'], derived: [] },
  open_loops: { read: 'listOpenLoops', columns: ['*'], derived: [] },
  config: { read: 'getAllConfig', columns: ['key', 'value'], derived: [] },
  sources: { read: 'listAllSources + getSource', columns: [...SOURCE_FIELDS, 'archived'], derived: [] },
  /** Re-derived from each written page's frontmatter (`setPageAliases`). */
  page_aliases: { read: 'getPage (frontmatter aliases)', columns: ['*'], derived: [] },
};

/**
 * Fact columns the Rust engine stores but no read call returns (on any engine: they are not in FactRow). A fact
 * changed on Rust keeps the old primary's values for them (the Rust engine never rewrites them in place; fence
 * re-extraction deletes and inserts); a fact added on Rust after the swap could hold them, so failback refuses by name.
 */
export const FACT_COLUMNS_WITHOUT_READ = ['row_num', 'source_markdown_slug', 'event_type', 'dimension', 'value', 'value_hash', 'dim_status', 'attributed_to'] as const;

function plain(value: unknown): Plain {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(plain);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (typeof value === 'object') {
    const out: Record<string, Plain> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = plain(v);
    }
    return out;
  }
  return String(value);
}

/** Timestamps compare at millisecond precision as UTC ISO text, whatever type the engine's driver returned. */
function instant(value: unknown): Plain {
  if (value === undefined || value === null || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}
function day(value: unknown): Plain {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
function num(value: unknown): Plain {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value);
}

const INSTANT_FIELDS = new Set(['created_at', 'updated_at', 'ingested_at', 'fetched_at', 'resolved_at', 'valid_from', 'valid_until', 'expired_at',
  'consolidated_at', 'embedded_at', 'last_sync_at', 'due_at', 'opened_at', 'last_activity_at', 'closed_at']);
const DAY_FIELDS = new Set(['date', 'effective_date', 'since_date', 'until_date']);
const NUM_FIELDS = new Set(['id', 'weight', 'confidence', 'notability', 'size_bytes', 'token_count', 'start_line', 'end_line', 'chunk_index', 'row_num',
  'superseded_by', 'consolidated_into', 'fact_id', 'resolved_value', 'resolved_quality']);

export function pick(row: object, fields: readonly string[]): Record<string, Plain> {
  const out: Record<string, Plain> = {};
  for (const f of fields) {
    const v = (row as Record<string, unknown>)[f];
    out[f] = INSTANT_FIELDS.has(f) ? instant(v) : DAY_FIELDS.has(f) ? day(v) : NUM_FIELDS.has(f) ? num(v) : plain(v);
  }
  return out;
}

export function canonical(value: unknown): string {
  return JSON.stringify(plain(value));
}

export function hashOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function sorted<T>(rows: T[]): T[] {
  return rows.map(r => [canonical(r), r] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(x => x[1]);
}

function vectorOf(value: unknown): Float32Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) return Float32Array.from(value as number[]);
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t.startsWith('[')) return null;
    return Float32Array.from(JSON.parse(t) as number[]);
  }
  if (ArrayBuffer.isView(value)) return Float32Array.from(value as unknown as ArrayLike<number>);
  return null;
}

/**
 * Two embeddings agree when both are absent, or both have the same length and a cosine similarity of at least 0.9999:
 * a primary that stores half-precision vectors keeps about three significant digits of the Rust store's floats.
 */
export function embeddingsAgree(a: Float32Array | null, b: Float32Array | null): boolean {
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  if (na === 0 || nb === 0) return na === nb;
  return dot / Math.sqrt(na * nb) >= 0.9999;
}

const PAGE_TAKES_LIMIT = 500;

async function takesOf(engine: BrainEngine, pageId: number): Promise<Plain[]> {
  const out: Plain[] = [];
  for (const active of [true, false]) {
    for (let offset = 0; ; offset += PAGE_TAKES_LIMIT) {
      const rows = await engine.listTakes({ page_id: pageId, active, limit: PAGE_TAKES_LIMIT, offset });
      out.push(...rows.map(t => pick(t, TAKE_FIELDS)));
      if (rows.length < PAGE_TAKES_LIMIT) break;
    }
  }
  return sorted(out);
}

/** One live page and every dependent row, from read calls only. Null when the page is absent or soft-deleted. */
export async function readPageImage(engine: BrainEngine, ref: PageRef): Promise<PageImage | null> {
  const scope = { sourceId: ref.source_id };
  const page = await engine.getPage(ref.slug, scope);
  if (!page || page.deleted_at) return null;
  const [tags, links, timeline, chunks, raw, files] = await Promise.all([
    engine.getTags(ref.slug, scope),
    engine.getLinks(ref.slug, scope),
    engine.getTimeline(ref.slug, { ...scope, limit: 2_147_483_647 }),
    engine.getChunksWithEmbeddings(ref.slug, { ...scope, includeUnsealed: true }),
    engine.getRawData(ref.slug, undefined, scope),
    engine.listFilesForPage(Number(page.id)),
  ]);
  const takes = await takesOf(engine, Number(page.id));
  const segmented = page.body_storage === 'segmented';
  const orderedChunks = [...chunks].sort((a, b) => a.chunk_index - b.chunk_index);
  return {
    ref,
    id: Number(page.id),
    sealed: page.knowledge_revision != null && String(page.text_projection_revision) === String(page.knowledge_revision),
    parts: {
      // A page stored in segments has no one-string body (its getters throw); content_hash still covers its body.
      page: segmented ? { ...pick(page, PAGE_FIELDS.filter(f => !BODY_FIELDS.has(f))), segmented: true } : pick(page, PAGE_FIELDS),
      tags: [...tags].sort(),
      links: sorted(links.map(l => pick({ ...l, to_source_id: l.to_source_id ?? ref.source_id }, LINK_FIELDS))),
      timeline: sorted(timeline.map(t => pick(t, ['date', 'source', 'summary', 'detail']))),
      chunks: orderedChunks.map(c => ({ ...pick(c, CHUNK_FIELDS), embedding_dims: vectorOf(c.embedding)?.length ?? null })),
      raw: sorted(raw.map(r => pick(r, ['source', 'data', 'fetched_at']))),
      takes,
      files: sorted(files.map(f => pick(f, FILE_FIELDS))),
    },
    embeddings: orderedChunks.map(c => vectorOf(c.embedding)),
  };
}

/** The parts of a page that differ between the two images (`page` first). Embeddings compare by `embeddingsAgree`. */
export function differingParts(a: PageImage | null, b: PageImage | null): PagePart[] {
  if (!a || !b) return a || b ? [...PAGE_PARTS] : [];
  const segmented = isSegmented(a) || isSegmented(b);
  const out = PAGE_PARTS.filter(p => (p === 'page' && segmented
    ? canonical(withoutBody(a.parts.page)) !== canonical(withoutBody(b.parts.page))
    : canonical(a.parts[p]) !== canonical(b.parts[p])));
  if (!out.includes('chunks') && a.embeddings.some((e, i) => !embeddingsAgree(e, b.embeddings[i] ?? null))) out.push('chunks');
  return out;
}

export function refKey(ref: PageRef): string { return `${ref.source_id}/${ref.slug}`; }

export interface FactImage { row: Record<string, Plain>; embedding: Float32Array | null }

const FACT_PAGE = 100;

/** Every fact of every source, active or not, keyed by id (ids survive the swap: the store's counter starts above the primary's). */
export async function readFacts(engine: BrainEngine, sourceIds: readonly string[]): Promise<Map<number, FactImage>> {
  const out = new Map<number, FactImage>();
  for (const source of sourceIds) {
    let after: { createdAt: string; id: number | null } | null = null;
    for (;;) {
      const rows = await engine.listFactsKeyset(source, after, { activeOnly: false, limit: FACT_PAGE });
      for (const f of rows) out.set(Number(f.id), { row: pick(f, FACT_FIELDS), embedding: vectorOf(f.embedding) });
      if (rows.length < FACT_PAGE) break;
      const last = rows[rows.length - 1]!;
      after = { createdAt: last.created_at_iso ?? new Date(last.created_at).toISOString(), id: Number(last.id) };
    }
  }
  return out;
}

export const LOOP_STATUSES = ['open', 'done', 'dropped', 'stale'] as const;
const LOOP_LIMIT = 1000;

export class UnboundedReadError extends Error {
  constructor(readonly table: string, detail: string) { super(detail); }
}

/** Every open loop by id. `listOpenLoops` returns at most 1000 rows per call, so a full bucket is refused, never truncated. */
export async function readOpenLoops(engine: BrainEngine, sourceIds: readonly string[]): Promise<Map<number, Record<string, Plain>>> {
  const out = new Map<number, Record<string, Plain>>();
  for (const source of sourceIds) {
    const all = await engine.listOpenLoops({ sourceIds: [source], limit: LOOP_LIMIT });
    let rows = all;
    if (all.length >= LOOP_LIMIT) {
      rows = [];
      for (const status of LOOP_STATUSES) {
        const bucket = await engine.listOpenLoops({ sourceIds: [source], status: status as never, limit: LOOP_LIMIT });
        if (bucket.length >= LOOP_LIMIT) throw new UnboundedReadError('open_loops', `source ${source} has ${LOOP_LIMIT} or more ${status} open loops, more than one read call returns`);
        rows.push(...bucket);
      }
      if (rows.length < all.length) throw new UnboundedReadError('open_loops', `source ${source} has open loops in a status failback does not list`);
    }
    for (const row of rows) out.set(Number(row.id), pick(row, Object.keys(row).sort()));
  }
  return out;
}

/** Sources with the columns `getSource` returns, archived ones included. */
export async function readSources(engine: BrainEngine): Promise<Map<string, Record<string, Plain>>> {
  const out = new Map<string, Record<string, Plain>>();
  const live = new Set((await engine.listAllSources()).map(s => s.id));
  for (const s of await engine.listAllSources({ includeArchived: true })) {
    const detail = await engine.getSource(s.id);
    out.set(s.id, { ...pick({ ...s, ...(detail ?? {}) }, SOURCE_FIELDS), archived: !live.has(s.id) });
  }
  return out;
}

/**
 * Engine-local config keys: each engine keeps its own (the same list `gbrain migrate` skips), plus the brain server's
 * owner token lists (served/auth.ts). Those name token rows of the Rust store, which failback never carries, so on the
 * old engine they would name nothing; they also must never carry a swap run's probe token back (probe-token.ts).
 */
export const FAILBACK_LOCAL_CONFIG = new Set(['engine', 'version', 'embedding_columns', 'search_embedding_column',
  'rust_server.owner_token_ids', 'rust_server.owner_token_expires']);

export async function readConfig(engine: BrainEngine): Promise<Map<string, string>> {
  const all = await engine.getAllConfig();
  return new Map(Object.entries(all).filter(([k]) => !FAILBACK_LOCAL_CONFIG.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export interface FailbackLosses {
  /** Tables of the primary failback does not carry (no Rust read call returns them): rows keep their state at the swap. */
  not_carried_tables: string[];
  /** Columns of carried tables failback does not write back (no read call returns them, or no write call takes them). */
  not_carried_fields: Record<string, string[]>;
}

/** The closed loss list, from the primary's live schema against `FAILBACK_CARRIED`. */
export async function failbackLosses(primary: BrainEngine): Promise<FailbackLosses> {
  const rows = await primary.executeRaw<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN pg_class k ON k.relname = c.table_name JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = c.table_schema
      WHERE c.table_schema = current_schema() AND k.relkind IN ('r','p') AND NOT k.relispartition
      ORDER BY c.table_name, c.ordinal_position`);
  const tables = new Map<string, string[]>();
  for (const r of rows) tables.set(r.table_name, [...(tables.get(r.table_name) ?? []), r.column_name]);
  const notTables: string[] = [];
  const notFields: Record<string, string[]> = {};
  for (const [table, cols] of [...tables].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const carried = FAILBACK_CARRIED[table];
    if (!carried) { if (table !== 'persistence_graduation') notTables.push(table); continue; }
    if (carried.columns.includes('*')) continue;
    const missing = cols.filter(c => !carried.columns.includes(c) && !carried.derived.includes(c));
    if (missing.length) notFields[table] = missing;
  }
  return { not_carried_tables: notTables, not_carried_fields: notFields };
}
