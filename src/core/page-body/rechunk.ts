/**
 * Re-chunk sealed segmented pages stored under an older SEGMENTED_CHUNKER_VERSION (`gbrain reindex --segmented`).
 *
 * Preview first: the preview chunks each page's live occurrences with today's segmented chunker, compares the result
 * with the stored rows, and writes nothing. `--apply` re-stages only the occurrences whose chunks change, one staging
 * batch (STAGE_BATCH_BYTES of segments) per transaction under the page lock: the batch's new rows are staged above the
 * live generation (staging kind `resegment`), vectors of unchanged chunk texts are copied from the same occurrence's
 * stored rows (text-keyed reuse), and the generation flip retires the occurrence's old rows. Occurrence ids, segment
 * texts, the manifest and the knowledge revision stay as they are (the body did not change), so per-segment
 * derivations stay settled and nothing is re-extracted; new chunk texts carry no vector until the embed sweep. The page
 * keeps serving its old rows until each batch flips, and is stamped at SEGMENTED_CHUNKER_VERSION only when every batch
 * landed. No migration or upgrade step runs this.
 */
import type { BrainEngine } from '../engine.ts';
import { isQuarantined } from '../quarantine.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import { newFenceChunkBudget, type FenceChunkBudget } from '../markdown-chunks.ts';
import { reuseSegmentChunkVectors } from '../import-chunk-reuse.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { applySegmentedBody, sealSegmentedPage } from '../persistence/segmented-apply.ts';
import { withPageTierKept } from '../trust/fence-append.ts';
import { openSegmentedStaging, segmentWriteScope, stageOccurrenceChunks } from './ingest.ts';
import { readPageBodyPolicy, STAGE_BATCH_BYTES } from './limits.ts';
import { SEGMENTED_CHUNKER_VERSION } from './segment-chunks.ts';
import type { JsonObject, ManifestRow, SegmentChunkInput } from './types.ts';

export interface SegmentedRechunkPage {
  source_id: string;
  slug: string;
  /** The page's chunker version when the run read it. */
  chunker_version: number;
  segments: number;
  /** Stored chunk rows of the live occurrences, and the rows today's chunker makes of them. */
  chunks: number;
  chunks_after: number;
  /** Occurrences whose chunks change, and chunk texts no stored row of the same occurrence holds (they need a vector). */
  segments_changed: number;
  new_chunk_texts: number;
  /** Apply only. `moved`: another write published while this page was re-chunked; it keeps its version, run again. */
  state?: 'rechunked' | 'stamped' | 'moved' | 'failed';
  vectors_reused?: number;
  error?: string;
}

export interface SegmentedRechunkReceipt {
  dry_run: boolean;
  chunker_version: number;
  pages: SegmentedRechunkPage[];
  commands: { apply: string[] | null; embed: string[] | null; preview: string[] };
}

/** @internal Work counts for the re-chunk tests: staging batches chunked, batches that flipped, rows staged and vectors reused. */
export const rechunkWork = { batches: 0, flips: 0, staged: 0, reused: 0 };

interface RechunkPageRow {
  id: number; slug: string; source_id: string; title: string; type: string; page_kind: string; frontmatter: JsonObject | null;
  body_generation: number | string; body_flags: JsonObject | null; chunker_version: number | null; contextual_retrieval_mode: string | null;
  corpus_generation: string | null; knowledge_revision: string; sealed: boolean; updated_us: string; deleted_at: string | null;
  content_hash: string; body_bytes: number | string; truth_bytes: number | string; body_lines: number | string; segment_count: number;
  segmenter_version: number; truth_lead: string | null; timeline_lead: string | null;
}

class PageMoved extends Error {}

const PAGE_SQL = `SELECT id, slug, source_id, title, type, page_kind, frontmatter, body_generation, body_flags, chunker_version,
    contextual_retrieval_mode, corpus_generation, knowledge_revision::text AS knowledge_revision,
    (text_projection_revision = knowledge_revision) IS TRUE AS sealed, (extract(epoch FROM updated_at) * 1000000)::bigint::text AS updated_us, deleted_at, content_hash, body_bytes, truth_bytes,
    body_lines, segment_count, segmenter_version, truth_lead, timeline_lead
  FROM pages WHERE id=$1 AND body_storage='segmented'`;

/** Sealed, live segmented pages below the current segmented chunker, in a stable order. */
async function candidates(engine: BrainEngine, scope: { sourceId?: string; slug?: string }): Promise<Array<{ id: number }>> {
  const params: unknown[] = [SEGMENTED_CHUNKER_VERSION];
  let where = '';
  if (scope.sourceId) { params.push(scope.sourceId); where += ` AND source_id=$${params.length}`; }
  if (scope.slug) { params.push(scope.slug); where += ` AND slug=$${params.length}`; }
  return engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE body_storage='segmented' AND deleted_at IS NULL
    AND chunker_version < $1 AND (text_projection_revision = knowledge_revision) IS TRUE${where} ORDER BY source_id, slug`, params);
}

/** The tier and corpus generation the page's stored vectors were embedded under, so reuse admits them as a write would. */
const reuseTier = (page: RechunkPageRow) => page.contextual_retrieval_mode === 'title'
  ? { tier: 'title' as const, corpusGeneration: page.corpus_generation } : { tier: 'none' as const, corpusGeneration: null };

const chunkKey = (c: { chunk_source: string; chunk_text: string; raw_byte_start: number; raw_byte_end: number;
  projected_byte_start?: number | null; projected_byte_end?: number | null }) =>
  JSON.stringify([c.chunk_source, c.chunk_text, c.raw_byte_start, c.raw_byte_end, c.projected_byte_start ?? null, c.projected_byte_end ?? null]);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

interface BatchPlan {
  /** Today's chunks of the changed occurrences. */
  held: SegmentChunkInput[];
  changed: number[];
  /** Stored rows of the changed occurrences (the flip retires them), of the whole batch, and today's chunk count. */
  retiring: number;
  stored: number;
  chunksAfter: number;
  newTexts: number;
}

/** Chunk one batch of occurrences with today's chunker (nothing staged) and compare with the stored rows. */
async function planBatch(exec: BrainEngine, page: RechunkPageRow, batch: readonly ManifestRow[], fenceBudget: FenceChunkBudget): Promise<BatchPlan> {
  const held: SegmentChunkInput[] = [];
  const frontmatter = page.frontmatter ?? {};
  await stageOccurrenceChunks(exec, { pageId: page.id, sourceId: page.source_id, slug: page.slug, generation: Number(page.body_generation),
    occurrences: batch, title: page.title, frontmatter, flags: page.body_flags ?? {},
    chunking: { quarantined: isQuarantined(frontmatter), ...reuseTier(page) }, retiredOccurrences: [], hold: held, fenceBudget });
  const ids = batch.map(row => Number(row.occurrenceId));
  const stored = await exec.executeRaw<{ occurrence_id: unknown; chunk_source: string; chunk_text: string; raw_byte_start: unknown; raw_byte_end: unknown;
    projected_byte_start: unknown; projected_byte_end: unknown }>(`SELECT c.occurrence_id, c.chunk_source, c.chunk_text, c.raw_byte_start, c.raw_byte_end,
      c.projected_byte_start, c.projected_byte_end FROM content_chunks c JOIN pages p ON p.id = c.page_id
     WHERE c.page_id = $1 AND c.occurrence_id = ANY($2::bigint[]) AND ${chunkGenerationFilter('p', 'c')}
     ORDER BY c.occurrence_id, c.local_ordinal`, [page.id, ids]);
  const before = new Map<number, Array<{ key: string; text: string }>>();
  for (const row of stored) {
    const id = Number(row.occurrence_id);
    const entry = { key: chunkKey({ chunk_source: row.chunk_source, chunk_text: row.chunk_text, raw_byte_start: Number(row.raw_byte_start),
      raw_byte_end: Number(row.raw_byte_end), projected_byte_start: num(row.projected_byte_start), projected_byte_end: num(row.projected_byte_end) }),
      text: `${row.chunk_source}\0${row.chunk_text}` };
    const list = before.get(id);
    if (list) list.push(entry); else before.set(id, [entry]);
  }
  const after = new Map<number, SegmentChunkInput[]>();
  for (const c of held) { const list = after.get(c.occurrence_id); if (list) list.push(c); else after.set(c.occurrence_id, [c]); }
  const plan: BatchPlan = { held: [], changed: [], retiring: 0, stored: stored.length, chunksAfter: held.length, newTexts: 0 };
  for (const id of ids) {
    const old = before.get(id) ?? [];
    const next = after.get(id) ?? [];
    if (old.length === next.length && next.every((c, i) => chunkKey(c) === old[i]!.key)) continue;
    plan.changed.push(id);
    plan.retiring += old.length;
    plan.held.push(...next);
    const texts = new Set(old.map(o => o.text));
    plan.newTexts += next.filter(c => !texts.has(`${c.chunk_source}\0${c.chunk_text}`)).length;
  }
  rechunkWork.batches++;
  return plan;
}

async function readPage(exec: Pick<BrainEngine, 'executeRaw'>, id: number): Promise<RechunkPageRow | null> {
  return (await exec.executeRaw<RechunkPageRow>(PAGE_SQL, [id]))[0] ?? null;
}

/** Under the page lock: the page is still the sealed, live generation this run expects, else it moved. */
async function lockedPage(tx: BrainEngine, ref: { id: number; sourceId: string; slug: string }, generation: number): Promise<RechunkPageRow> {
  await tx.lockPageKeys([{ sourceId: ref.sourceId, slug: ref.slug }]);
  const page = await readPage(tx, ref.id);
  if (!page || Number(page.body_generation) !== generation || !page.sealed || page.deleted_at) throw new PageMoved();
  return page;
}

/** Re-stage one batch's changed occurrences and flip, in the caller's transaction; returns the vectors reused. */
async function flipBatch(tx: BrainEngine, page: RechunkPageRow, plan: BatchPlan, owner: { kind: string; id: string }, retireMaxRows: number): Promise<number> {
  if (plan.retiring > retireMaxRows) {
    throw new Error(`A staging batch of ${page.slug} retires ${plan.retiring} chunk rows, over the flip's limit of ${retireMaxRows}.`);
  }
  const generation = Number(page.body_generation);
  const next = generation + 1;
  const stagingId = await openSegmentedStaging(tx, { sourceId: page.source_id, slug: page.slug, declaredBytes: Number(page.body_bytes),
    live: { id: page.id, generation, storage: 'segmented', title: page.title, type: page.type, flags: page.body_flags },
    owner: { kind: 'resegment', principalKind: owner.kind, principalId: owner.id, baseRevision: page.knowledge_revision } });
  const reused = await reuseSegmentChunkVectors(tx, { pageId: page.id, retiredOccurrences: plan.changed, chunks: plan.held, title: page.title, ...reuseTier(page) });
  const indexes = await tx.stageSegmentChunks(page.id, next, plan.held);
  await tx.setBodyStagingState(stagingId, 'prepared');
  // The body is unchanged: the flip keeps the knowledge revision (and so the seal), as a materialization does.
  const [prior] = await tx.executeRaw<{ revision: string | null }>("SELECT current_setting('gbrain.materializing_revision', true) AS revision");
  await tx.executeRaw("SELECT set_config('gbrain.materializing_revision', $1, true)", [page.knowledge_revision]);
  const applied = await withPageTierKept(tx, { sourceId: page.source_id, slug: page.slug }, () => applySegmentedBody(tx, {
    slug: page.slug, sourceId: page.source_id, pageId: page.id, promotion: false, retireMaxRows,
    meta: { title: page.title, type: page.type as never, frontmatter: page.frontmatter ?? {}, page_kind: page.page_kind as never },
    prepared: { stagingId, expectedGeneration: generation, newGeneration: next, createRows: null, createChunks: null, closeOccurrences: [],
      retireChunkOccurrences: plan.changed, unchunked: 0, priorStale: false, bodyUnchanged: false, stagedChunkIndexes: indexes,
      rows: { texts: 0, manifest: 0, chunks: indexes.length },
      body: { content_hash: page.content_hash, body_bytes: Number(page.body_bytes), truth_bytes: Number(page.truth_bytes),
        body_lines: Number(page.body_lines), segment_count: page.segment_count, segmenter_version: page.segmenter_version,
        truth_lead: page.truth_lead ?? '', timeline_lead: page.timeline_lead ?? '', body_flags: page.body_flags ?? {} } } }));
  if (!applied.complete) throw new Error(`The re-chunk flip of ${page.slug} left rows to retire after its transaction.`);
  // A re-chunk is not an edit: the page keeps its updated_at, restored exactly (microseconds survive no driver date round trip).
  await tx.executeRaw(`UPDATE pages SET updated_at = 'epoch'::timestamptz + $2::bigint * interval '1 microsecond' WHERE id=$1`, [page.id, page.updated_us]);
  await sealSegmentedPage(tx, page.id);
  await tx.executeRaw("SELECT set_config('gbrain.materializing_revision', $1, true)", [prior?.revision ?? '']);
  rechunkWork.flips++;
  rechunkWork.staged += indexes.length;
  rechunkWork.reused += reused;
  return reused;
}

async function rechunkPage(engine: BrainEngine, id: number, apply: boolean, retireMaxRows: number): Promise<SegmentedRechunkPage | null> {
  const first = await readPage(engine, id);
  if (!first) return null;
  const rows = await engine.readManifest(first.id);
  const out: SegmentedRechunkPage = { source_id: first.source_id, slug: first.slug, chunker_version: Number(first.chunker_version ?? 0),
    segments: rows.length, chunks: 0, chunks_after: 0, segments_changed: 0, new_chunk_texts: 0 };
  const tally = (plan: BatchPlan) => {
    out.chunks += plan.stored;
    out.chunks_after += plan.chunksAfter;
    out.segments_changed += plan.changed.length;
    out.new_chunk_texts += plan.newTexts;
  };
  const ref = { id: first.id, sourceId: first.source_id, slug: first.slug };
  const fenceBudget = newFenceChunkBudget();
  const batchBytes = STAGE_BATCH_BYTES[engine.kind];
  const batches: ManifestRow[][] = [];
  for (let start = 0; start < rows.length;) {
    let end = start, bytes = 0;
    while (end < rows.length && (end === start || bytes + rows[end]!.byteLen <= batchBytes)) bytes += rows[end++]!.byteLen;
    batches.push(rows.slice(start, end));
    start = end;
  }
  if (!apply) {
    for (const batch of batches) tally(await planBatch(engine, first, batch, fenceBudget));
    return out;
  }
  const scope = await segmentWriteScope(engine, first.source_id);
  const { principal } = await maintenanceAttribution(engine);
  let generation = Number(first.body_generation);
  let reused = 0;
  try {
    for (const batch of batches) {
      await scope(exec => exec.transaction(async tx => {
        const page = await lockedPage(tx, ref, generation);
        const plan = await planBatch(tx, page, batch, fenceBudget);
        tally(plan);
        if (!plan.changed.length) return;
        reused += await flipBatch(tx, page, plan, principal, retireMaxRows);
        generation++;
      }));
    }
    await scope(exec => exec.transaction(async tx => {
      const page = await lockedPage(tx, ref, generation);
      await tx.executeRaw('UPDATE pages SET chunker_version=$2 WHERE id=$1', [page.id, SEGMENTED_CHUNKER_VERSION]);
    }));
    return { ...out, state: out.segments_changed ? 'rechunked' : 'stamped', vectors_reused: reused };
  } catch (error) {
    if (error instanceof PageMoved) return { ...out, state: 'moved', vectors_reused: reused };
    return { ...out, state: 'failed', vectors_reused: reused, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Preview (default) or apply the re-chunk of every sealed segmented page below SEGMENTED_CHUNKER_VERSION in scope. */
export async function runSegmentedRechunk(engine: BrainEngine, opts: { apply?: boolean; sourceId?: string; slug?: string } = {}): Promise<SegmentedRechunkReceipt> {
  const apply = opts.apply === true;
  const { flipRetireMaxRows } = await readPageBodyPolicy(engine);
  const pages: SegmentedRechunkPage[] = [];
  for (const { id } of await candidates(engine, opts)) {
    const page = await rechunkPage(engine, Number(id), apply, flipRetireMaxRows);
    if (page) pages.push(page);
  }
  const scope = [...(opts.sourceId ? ['--source', opts.sourceId] : []), ...(opts.slug ? ['--slug', opts.slug] : [])];
  const embed = apply && pages.some(p => p.state === 'rechunked' && p.new_chunk_texts > 0);
  return { dry_run: !apply, chunker_version: SEGMENTED_CHUNKER_VERSION, pages,
    commands: { apply: !apply && pages.length ? ['gbrain', 'reindex', '--segmented', ...scope, '--apply'] : null,
      embed: embed ? ['gbrain', 'embed', '--stale'] : null, preview: ['gbrain', 'reindex', '--segmented', ...scope] } };
}

export function formatSegmentedRechunkReceipt(r: SegmentedRechunkReceipt): string[] {
  const lines = [`reindex --segmented${r.dry_run ? ' (preview, nothing written)' : ''}: ${r.pages.length} page(s) below segmented chunker ${r.chunker_version}`];
  for (const p of r.pages) {
    lines.push(`  ${p.source_id}/${p.slug}  v${p.chunker_version}  ${p.segments} segments, ${p.chunks} -> ${p.chunks_after} chunks, `
      + `${p.segments_changed} segment(s) change, ${p.new_chunk_texts} new chunk text(s)${p.state ? `  ${p.state}` : ''}`
      + `${p.vectors_reused ? `, ${p.vectors_reused} vector(s) reused` : ''}${p.error ? `: ${p.error}` : ''}`);
  }
  if (r.commands.apply) lines.push(`Apply: ${r.commands.apply.join(' ')}`);
  if (r.commands.embed) lines.push(`New chunk texts get vectors from the embed sweep: ${r.commands.embed.join(' ')}`);
  if (r.pages.some(p => p.state === 'moved')) lines.push(`A page changed while it was re-chunked; run again: ${r.commands.preview.join(' ')} --apply`);
  return lines;
}
