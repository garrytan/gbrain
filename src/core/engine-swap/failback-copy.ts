/**
 * Failback's diff and copy (docs/guides/engine-swap.md#failback): compares the brain image both engines return through
 * the same read calls (failback-read.ts) and writes only what differs into the old primary, inside the swap run's
 * graduation transaction, so the write fence lets these writes and no others through.
 *
 * Pages are written part by part (the page row, tags, timeline, chunks, raw data, takes, files), then links once every
 * target page exists, then the page timestamps the Rust engine returned. Facts, takes and files keep their ids; pages
 * created after the swap get new row ids on the primary, and a rewritten page records one new version on the primary
 * (both accepted losses, shown in the plan before anything is written).
 */
import type { BrainEngine } from '../engine.ts';
import type { ChunkInput } from '../types.ts';
import { carryChunkMetadata } from '../embed-stale.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { normalizeAliasList } from '../search/alias-normalize.ts';
import { withGraduationRun } from '../persistence/graduation-schema.ts';
import {
  canonical, differingParts, embeddingsAgree, FACT_FIELDS, FILE_FIELDS, hashOf, readConfig, readFacts, readOpenLoops,
  PAGE_PARTS, readPageImage, readSources, refKey, TAKE_FIELDS, type FactImage, type PageImage, type PagePart, type PageRef,
} from './failback-read.ts';

export interface PageDiff { ref: PageRef; parts: PagePart[]; rust: PageImage | null; primary: PageImage | null }

export interface KeyedDiff<K> { add: K[]; change: K[]; remove: K[] }

export interface FailbackDiff {
  pages: PageDiff[];
  counts: { changed: number; added: number; removed: number; unchanged: number };
  facts: KeyedDiff<number>;
  open_loops: KeyedDiff<number>;
  config: KeyedDiff<string>;
  sources: KeyedDiff<string>;
  /** sha256 over every difference and the Rust side's value: a change on either engine after the plan changes it. */
  hash: string;
  /** The Rust side's rows the copy writes. */
  rust: { facts: Map<number, FactImage>; loops: Map<number, Record<string, unknown>>; config: Map<string, string>; sources: Map<string, Record<string, unknown>> };
}

export interface Mismatch { part: string; key: string }

function keyed<K, V>(rust: Map<K, V>, primary: Map<K, V>, same: (a: V, b: V) => boolean): KeyedDiff<K> {
  const out: KeyedDiff<K> = { add: [], change: [], remove: [] };
  for (const [k, v] of rust) {
    const p = primary.get(k);
    if (p === undefined) out.add.push(k);
    else if (!same(v, p)) out.change.push(k);
  }
  for (const k of primary.keys()) if (!rust.has(k)) out.remove.push(k);
  return out;
}

const sameJson = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const sameFact = (a: FactImage, b: FactImage): boolean => canonical(a.row) === canonical(b.row) && embeddingsAgree(a.embedding, b.embedding);

async function pageRefs(engine: BrainEngine): Promise<PageRef[]> {
  return (await engine.listAllPageRefs()).map(r => ({ slug: r.slug, source_id: r.source_id }));
}

/** Reads both engines and returns what differs. Read only. */
export async function diffBrains(rust: BrainEngine, primary: BrainEngine): Promise<FailbackDiff> {
  const refs = new Map<string, PageRef>();
  for (const r of [...await pageRefs(rust), ...await pageRefs(primary)]) refs.set(refKey(r), r);
  const pages: PageDiff[] = [];
  const counts = { changed: 0, added: 0, removed: 0, unchanged: 0 };
  const hashParts: unknown[] = [];
  for (const key of [...refs.keys()].sort()) {
    const ref = refs.get(key)!;
    const [r, p] = await Promise.all([readPageImage(rust, ref), readPageImage(primary, ref)]);
    const parts = differingParts(r, p);
    if (!parts.length) { if (r) counts.unchanged++; continue; }
    if (r && !p) counts.added++; else if (!r && p) counts.removed++; else counts.changed++;
    pages.push({ ref, parts, rust: r, primary: p });
    hashParts.push([key, parts, r ? r.parts : null, r ? r.embeddings.map(e => (e ? hashOf(Array.from(e)) : null)) : null]);
  }
  const [rSources, pSources] = await Promise.all([readSources(rust), readSources(primary)]);
  const sourceIds = [...new Set([...rSources.keys(), ...pSources.keys()])].sort();
  const [rFacts, pFacts, rLoops, pLoops, rConfig, pConfig] = await Promise.all([
    readFacts(rust, sourceIds), readFacts(primary, sourceIds), readOpenLoops(rust, sourceIds), readOpenLoops(primary, sourceIds),
    readConfig(rust), readConfig(primary),
  ]);
  const facts = keyed(rFacts, pFacts, sameFact);
  const open_loops = keyed(rLoops, pLoops, sameJson);
  const config = keyed(rConfig, pConfig, (a, b) => a === b);
  const sources = keyed(rSources, pSources, sameJson);
  hashParts.push(
    ['facts', facts, [...facts.add, ...facts.change].map(id => [rFacts.get(id)!.row, rFacts.get(id)!.embedding ? hashOf(Array.from(rFacts.get(id)!.embedding!)) : null])],
    ['loops', open_loops, [...open_loops.add, ...open_loops.change].map(id => rLoops.get(id))],
    ['config', config, [...config.add, ...config.change].map(k => [k, rConfig.get(k)])],
    ['sources', sources, [...sources.add, ...sources.change].map(k => rSources.get(k))],
  );
  return { pages, counts, facts, open_loops, config, sources, hash: hashOf(hashParts),
    rust: { facts: rFacts, loops: rLoops, config: rConfig, sources: rSources } };
}

/** Every difference as `{part, key}`: empty means both engines return the same answers to every read call failback makes. */
export function mismatchesOf(diff: FailbackDiff): Mismatch[] {
  const out: Mismatch[] = [];
  for (const p of diff.pages) for (const part of p.parts) out.push({ part: `pages.${part}`, key: refKey(p.ref) });
  for (const [name, d] of [['facts', diff.facts], ['open_loops', diff.open_loops], ['config', diff.config], ['sources', diff.sources]] as const) {
    for (const k of [...d.add, ...d.change, ...d.remove] as Array<string | number>) out.push({ part: name, key: String(k) });
  }
  return out;
}

function vectorText(v: Float32Array | null): string | null {
  return v ? `[${Array.from(v).join(',')}]` : null;
}

async function vectorType(engine: BrainEngine, table: string): Promise<string> {
  const [row] = await engine.executeRaw<{ udt_name: string }>(
    `SELECT udt_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'embedding'`, [table]);
  return row?.udt_name === 'halfvec' ? 'halfvec' : 'vector';
}

async function pageIdOn(tx: BrainEngine, ref: PageRef): Promise<number> {
  const [row] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL', [ref.slug, ref.source_id]);
  if (!row) throw new Error(`page ${refKey(ref)} is missing on the primary after its write`);
  return Number(row.id);
}

/** Upserts rows by id with the listed columns (values already in column order), then sets the id sequence above them. */
async function upsertById(tx: BrainEngine, table: string, cols: readonly string[], rows: unknown[][], casts: Record<string, string> = {}): Promise<void> {
  if (!rows.length) return;
  const placeholders = cols.map((c, i) => `$${i + 1}${casts[c] ?? ''}`).join(', ');
  const updates = cols.filter(c => c !== 'id').map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
  const sql = `INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updates}`;
  for (const row of rows) await tx.executeRaw(sql, row);
  await tx.executeRaw(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`);
}

const jsonText = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

async function writePage(tx: BrainEngine, d: PageDiff): Promise<void> {
  const ref = d.ref;
  const scope = { sourceId: ref.source_id };
  if (!d.rust) { await tx.deletePage(ref.slug, scope); return; }
  const img = d.rust;
  const parts = new Set<PagePart>(d.primary ? d.parts : PAGE_PARTS);
  const p = img.parts.page as Record<string, unknown>;
  if (parts.has('page')) {
    await tx.putPage(ref.slug, {
      type: p.type as never, title: String(p.title ?? ''), compiled_truth: String(p.compiled_truth ?? ''), timeline: String(p.timeline ?? ''),
      frontmatter: (p.frontmatter ?? {}) as Record<string, unknown>, content_hash: (p.content_hash ?? undefined) as string | undefined,
      effective_date: p.effective_date ? new Date(`${String(p.effective_date)}T00:00:00Z`) : null, effective_date_source: (p.effective_date_source ?? null) as never,
      import_filename: (p.import_filename ?? null) as string | null, source_path: (p.source_path ?? null) as string | null,
      source_kind: (p.source_kind ?? null) as string | null, source_uri: (p.source_uri ?? null) as string | null, ingested_via: (p.ingested_via ?? null) as string | null,
    }, { ...scope, allowEmptyOverwrite: true });
    await tx.setPageAliases(ref.slug, ref.source_id, normalizeAliasList((p.frontmatter as Record<string, unknown> | null)?.aliases));
  }
  const pageId = await pageIdOn(tx, ref);
  if (parts.has('tags')) {
    await tx.executeRaw('DELETE FROM tags WHERE page_id = $1', [pageId]);
    for (const tag of img.parts.tags as string[]) await tx.addTag(ref.slug, tag, scope);
  }
  if (parts.has('timeline')) {
    await tx.executeRaw('DELETE FROM timeline_entries WHERE page_id = $1', [pageId]);
    for (const t of img.parts.timeline as Array<Record<string, string | null>>) {
      await tx.addTimelineEntry(ref.slug, { date: String(t.date), source: t.source ?? undefined, summary: String(t.summary ?? ''), detail: t.detail ?? undefined },
        { ...scope, skipExistenceCheck: true });
    }
  }
  if (parts.has('chunks')) {
    await tx.deleteChunks(ref.slug, scope);
    const chunks: ChunkInput[] = (img.parts.chunks as Array<Record<string, unknown>>).map((c, i) => carryChunkMetadata(c as never, {
      chunk_index: Number(c.chunk_index), chunk_text: String(c.chunk_text ?? ''), chunk_source: c.chunk_source as never,
      embedding: img.embeddings[i] ?? undefined, model: (c.model ?? undefined) as string | undefined, token_count: (c.token_count ?? undefined) as number | undefined,
    }));
    if (chunks.length) await tx.upsertChunks(ref.slug, chunks, { ...scope, pageId, ...(img.sealed ? { sealChunkerVersion: MARKDOWN_CHUNKER_VERSION } : {}) });
  }
  if (parts.has('raw')) {
    await tx.executeRaw('DELETE FROM raw_data WHERE page_id = $1', [pageId]);
    for (const r of img.parts.raw as Array<Record<string, unknown>>) {
      await tx.putRawData(ref.slug, String(r.source), (r.data ?? {}) as object, scope);
      if (r.fetched_at) await tx.executeRaw('UPDATE raw_data SET fetched_at = $1::timestamptz WHERE page_id = $2 AND source = $3', [r.fetched_at, pageId, r.source]);
    }
  }
  if (parts.has('takes')) {
    const takes = img.parts.takes as Array<Record<string, unknown>>;
    const keep = takes.map(t => Number(t.id));
    await tx.executeRaw('DELETE FROM takes WHERE page_id = $1 AND NOT (id = ANY($2::bigint[]))', [pageId, keep]);
    // created_at / updated_at travel when the read returned them for every row; otherwise the primary's defaults apply.
    const cols = ['page_id', ...TAKE_FIELDS].filter(c => !(c === 'created_at' || c === 'updated_at') || takes.every(t => t[c] != null));
    await upsertById(tx, 'takes', cols, takes.map(t => cols.map(c => (c === 'page_id' ? pageId : c === 'superseded_by' ? null : t[c] ?? null))));
    for (const t of takes) if (t.superseded_by != null) await tx.executeRaw('UPDATE takes SET superseded_by = $1 WHERE id = $2', [t.superseded_by, t.id]);
  }
  if (parts.has('files')) {
    const files = img.parts.files as Array<Record<string, unknown>>;
    await tx.executeRaw('DELETE FROM files WHERE page_id = $1 AND NOT (id = ANY($2::bigint[]))', [pageId, files.map(f => Number(f.id))]);
    const cols = ['page_id', ...FILE_FIELDS];
    await upsertById(tx, 'files', cols, files.map(f => cols.map(c => (c === 'page_id' ? pageId : c === 'metadata' ? jsonText(f.metadata ?? {}) : f[c] ?? null))),
      { metadata: '::text::jsonb' });
  }
}

async function writeLinks(tx: BrainEngine, d: PageDiff): Promise<void> {
  if (!d.rust) return;
  const pageId = await pageIdOn(tx, d.ref);
  await tx.executeRaw('DELETE FROM links WHERE from_page_id = $1', [pageId]);
  for (const l of d.rust.parts.links as Array<Record<string, string | null>>) {
    await tx.addLink(d.ref.slug, String(l.to_slug), l.context ?? undefined, l.link_type ?? undefined, l.link_source ?? undefined, l.origin_slug ?? undefined,
      l.origin_field ?? undefined, { fromSourceId: d.ref.source_id, toSourceId: l.to_source_id ?? d.ref.source_id, ...(l.origin_source_id ? { originSourceId: l.origin_source_id } : {}) });
  }
}

export interface CopyReport { pages: number; facts: number; open_loops: number; config: number; sources: number }

/**
 * Writes `diff` into the primary under the run. Each page is one transaction; links follow once every page exists, and
 * the page timestamps last (writes to dependents can move `updated_at`). Rerunning after a stop is safe: the next
 * diff names only what is still different.
 */
export async function copyBack(primary: BrainEngine, runId: string, diff: FailbackDiff, progress?: (line: string) => void): Promise<CopyReport> {
  const run = <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => withGraduationRun(primary, runId, fn);
  const { sources: rSources, facts: rFacts, loops: rLoops, config: rConfig } = diff.rust;
  if (diff.sources.add.length || diff.sources.change.length) {
    await run(async tx => {
      for (const id of [...diff.sources.add, ...diff.sources.change]) {
        const s = rSources.get(id)! as Record<string, unknown>;
        await tx.executeRaw(`INSERT INTO sources (id, name, local_path, last_commit, last_sync_at, config, created_at, contextual_retrieval_mode, trust_frontmatter_overrides, archived)
          VALUES ($1, $2, $3, $4, $5::timestamptz, $6::text::jsonb, COALESCE($7::timestamptz, now()), $8, COALESCE($9, false), COALESCE($10, false))
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, local_path = EXCLUDED.local_path, last_commit = EXCLUDED.last_commit, last_sync_at = EXCLUDED.last_sync_at,
            config = EXCLUDED.config, contextual_retrieval_mode = EXCLUDED.contextual_retrieval_mode, trust_frontmatter_overrides = EXCLUDED.trust_frontmatter_overrides,
            archived = EXCLUDED.archived, created_at = EXCLUDED.created_at`,
        [id, s.name ?? id, s.local_path ?? null, s.last_commit ?? null, s.last_sync_at ?? null, jsonText(s.config ?? {}), s.created_at ?? null,
          s.contextual_retrieval_mode ?? null, s.trust_frontmatter_overrides ?? null, s.archived ?? null]);
      }
    });
  }
  let done = 0;
  for (const d of diff.pages) {
    await run(tx => writePage(tx, d));
    if (++done % 100 === 0) progress?.(`failback: ${done}/${diff.pages.length} pages written`);
  }
  for (const d of diff.pages) if (d.rust && (!d.primary || d.parts.includes('links'))) await run(tx => writeLinks(tx, d));
  for (const d of diff.pages) {
    if (!d.rust) continue;
    const p = d.rust.parts.page as Record<string, unknown>;
    await run(tx => tx.executeRaw(`UPDATE pages SET created_at = COALESCE($1::timestamptz, created_at), updated_at = COALESCE($2::timestamptz, updated_at),
        ingested_at = $3::timestamptz WHERE slug = $4 AND source_id = $5 AND deleted_at IS NULL`,
      [p.created_at ?? null, p.updated_at ?? null, p.ingested_at ?? null, d.ref.slug, d.ref.source_id]));
  }
  if (diff.facts.add.length || diff.facts.change.length || diff.facts.remove.length) {
    const vt = await vectorType(primary, 'facts');
    await run(async tx => {
      if (diff.facts.remove.length) await tx.executeRaw('DELETE FROM facts WHERE id = ANY($1::bigint[])', [diff.facts.remove]);
      const ids = [...diff.facts.add, ...diff.facts.change].sort((a, b) => a - b);
      const cols = [...FACT_FIELDS, 'embedding'];
      await upsertById(tx, 'facts', cols, ids.map(id => {
        const f = rFacts.get(id)!;
        return cols.map(c => (c === 'embedding' ? vectorText(f.embedding) : c === 'superseded_by' ? null : f.row[c] ?? null));
      }), { embedding: `::text::${vt}` });
      for (const id of ids) {
        const sup = rFacts.get(id)!.row.superseded_by;
        if (sup != null) await tx.executeRaw('UPDATE facts SET superseded_by = $1 WHERE id = $2', [sup, id]);
      }
    });
  }
  if (diff.open_loops.add.length || diff.open_loops.change.length || diff.open_loops.remove.length) {
    const cols = (await primary.executeRaw<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'open_loops' ORDER BY ordinal_position`));
    await run(async tx => {
      if (diff.open_loops.remove.length) await tx.executeRaw('DELETE FROM open_loops WHERE id = ANY($1::bigint[])', [diff.open_loops.remove]);
      const ids = [...diff.open_loops.add, ...diff.open_loops.change];
      const present = cols.filter(c => ids.every(id => c.column_name in (rLoops.get(id) ?? {})));
      await upsertById(tx, 'open_loops', present.map(c => c.column_name), ids.map(id => present.map(c => {
        const v = (rLoops.get(id) as Record<string, unknown>)[c.column_name];
        return c.data_type === 'jsonb' ? jsonText(v) : v ?? null;
      })), Object.fromEntries(present.filter(c => c.data_type === 'jsonb').map(c => [c.column_name, '::text::jsonb'])));
    });
  }
  if (diff.config.add.length || diff.config.change.length || diff.config.remove.length) {
    await run(async tx => {
      for (const k of [...diff.config.add, ...diff.config.change]) await tx.setConfig(k, rConfig.get(k)!);
      for (const k of diff.config.remove) await tx.unsetConfig(k);
    });
  }
  return {
    pages: diff.pages.length, facts: diff.facts.add.length + diff.facts.change.length + diff.facts.remove.length,
    open_loops: diff.open_loops.add.length + diff.open_loops.change.length + diff.open_loops.remove.length,
    config: diff.config.add.length + diff.config.change.length + diff.config.remove.length,
    sources: diff.sources.add.length + diff.sources.change.length,
  };
}
