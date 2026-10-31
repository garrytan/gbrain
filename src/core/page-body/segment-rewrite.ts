/**
 * Fence rewrites of segmented bodies (Wave B, spec 6.4 and 11): forget strikes
 * and purge drops fence rows of a segmented page without holding its body as
 * one string. Only the facts and takes regions the segmenter stored
 * (`protected_regions`) are decoded and handed to the transform; a region that
 * crosses a forced cut is joined with its neighbours, up to the single-string
 * ceiling. A changed live body is staged again through `prepareSegmentedBody`
 * from a stream of its segments with the changed ones replaced, so unchanged
 * segments keep their rows, texts and chunks, and publishes through the
 * generation flip in the caller's transaction. A changed retained generation
 * (purge) is rebuilt under its own number. Memory stays O(segment) on every
 * path.
 */
import type { BrainEngine } from '../engine.ts';
import { isQuarantined } from '../quarantine.ts';
import { FACTS_FENCE_END } from '../facts-fence.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { applySegmentedBody, sealSegmentedPage } from '../persistence/segmented-apply.ts';
import { withPageTierKept } from '../trust/fence-append.ts';
import { prepareSegmentedBody, readSegmentedBody, type SegmentedStagingOwner } from './ingest.ts';
import { FENCE_MAX_BYTES, readPageBodyPolicy, STAGE_BATCH_BYTES } from './limits.ts';
import { fenceTooLargeError } from './read-range.ts';
import { pageBodySegmentedError } from './page-shape.ts';
import { readEntryState } from './entry-state.ts';
import { ContentHashStream } from './content-hash-stream.ts';
import type { StoredRegion } from './segmenter.ts';
import type { BodyRegion, JsonObject, ManifestRow } from './types.ts';
import { assertGenerationTiles } from './body-tiling.ts';
import { deleteRewrittenDerivations } from './segment-derive.ts';

/** Rewrites one fence (the text of a stored facts or takes region, markers included), given the body region holding it; called in body order. */
export type FenceTransform = (fence: string, at: { region: BodyRegion }) => Promise<string>;

/** Rows `from..to` of a generation, replaced by `bytes`. */
interface FenceUnit { from: number; to: number; bytes: Uint8Array }

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fenceRegions = (row: ManifestRow) => (row.protectedRegions as StoredRegion[]).filter(r => r.kind === 'facts' || r.kind === 'takes');
/** The region runs on into the next segment (it crosses a forced cut there). */
const runsOn = (r: StoredRegion) => r.open_start !== undefined && r.open_end === undefined;

/**
 * Every fence unit of `rows` the transform changes, in order. Reads only segments holding a fence. A unit joins the
 * segments a fence region runs on through, and a segment that ends inside a facts marker (the next one's entry state
 * carries the marker's first bytes) with the next: a fence region of a segment starting inside its opener begins at the
 * region's recorded `open_start`, in the segment before, and a facts fence whose closer a cut splits ends after the
 * closer's last bytes, which the next segment holds outside any facts region. A fence longer than FENCE_MAX_BYTES,
 * counted from its begin marker through its end marker, refuses before its segments are read.
 */
async function changedUnits(engine: BrainEngine, sourceId: string, rows: readonly ManifestRow[], transform: FenceTransform): Promise<FenceUnit[]> {
  const units: FenceUnit[] = [];
  const joinsNext = (i: number) => i + 1 < rows.length && rows[i + 1]!.region === rows[i]!.region
    && (fenceRegions(rows[i]!).some(runsOn) || !!readEntryState(rows[i + 1]!.entryState)?.withdrawal.carry);
  for (let from = 0; from < rows.length; from++) {
    if (!fenceRegions(rows[from]!).length && !joinsNext(from)) continue;
    let to = from;
    while (joinsNext(to)) to++;
    const span = rows.slice(from, to + 1);
    const spanStart = span[0]!.byteStart;
    const extents: Array<{ start: number; end: number; closer: boolean }> = [];
    for (const row of span) {
      const regions = fenceRegions(row);
      const last = extents[extents.length - 1];
      const entry = row === span[0] ? undefined : readEntryState(row.entryState)?.withdrawal;
      if (entry?.open && entry.carry && last?.end === row.byteStart && !regions.some(r => r.start === 0)) {
        last.end += Buffer.byteLength(FACTS_FENCE_END, 'utf8') - Buffer.byteLength(entry.carry, 'utf8');
        last.closer = true;
      }
      for (const r of regions) {
        const start = row.byteStart + r.start, end = row.byteStart + r.end;
        const tail = extents[extents.length - 1];
        if (tail && tail.end === start) tail.end = end;
        else extents.push({ start: Math.min(start, r.open_start ?? start), end, closer: false });
      }
    }
    const overBound = extents.find(e => e.end - e.start > FENCE_MAX_BYTES);
    if (overBound || (extents[0] && extents[0].start < spanStart)) {
      const [page] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE id=$1', [span[0]!.pageId]);
      if (overBound) throw fenceTooLargeError(page?.slug ?? String(span[0]!.pageId), sourceId, overBound.end - overBound.start);
      throw pageBodySegmentedError({ slug: page?.slug, source_id: sourceId }, 'fence rewrite of a fence whose opener lies before the segments joined for it');
    }
    const texts = await engine.readSegmentTexts(sourceId, span.map(row => row.sha256));
    const raw = Buffer.concat(span.map(row => {
      const text = texts.get(hex(row.sha256));
      if (!text) throw new Error(`Segment text ${hex(row.sha256)} of page ${row.pageId} is missing.`);
      return text;
    }));
    const parts: Buffer[] = [];
    let cursor = 0, changed = false;
    for (const e of extents) {
      const r = { start: e.start - spanStart, end: e.end - spanStart };
      const fence = raw.subarray(r.start, r.end).toString('utf8');
      if (e.closer && !fence.endsWith(FACTS_FENCE_END)) throw new Error(`Facts fence at stored byte ${e.start} of page ${span[0]!.pageId} does not end with its end marker across the cut.`);
      const next = await transform(fence, { region: span[0]!.region });
      parts.push(raw.subarray(cursor, r.start), Buffer.from(next, 'utf8'));
      cursor = r.end;
      if (next !== fence) changed = true;
    }
    if (changed) units.push({ from, to, bytes: Buffer.concat([...parts, raw.subarray(cursor)]) });
    from = to;
  }
  return units;
}

/** One region of a generation's stored stream with the changed units replaced, read one segment batch at a time. */
async function* rewrittenRegion(engine: BrainEngine, sourceId: string, rows: readonly ManifestRow[], units: readonly FenceUnit[], region: BodyRegion): AsyncIterable<Uint8Array> {
  const unitAt = new Map(units.map(unit => [unit.from, unit]));
  const batchBytes = STAGE_BATCH_BYTES[engine.kind];
  let batch: ManifestRow[] = [], bytes = 0;
  async function* flush(): AsyncIterable<Uint8Array> {
    const texts = await engine.readSegmentTexts(sourceId, batch.map(row => row.sha256));
    for (const row of batch) {
      const text = texts.get(hex(row.sha256));
      if (!text) throw new Error(`Segment text ${hex(row.sha256)} of page ${row.pageId} is missing.`);
      yield text;
    }
    batch = []; bytes = 0;
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.region !== region) continue;
    const unit = unitAt.get(i);
    if (unit) {
      yield* flush();
      yield unit.bytes;
      i = unit.to;
      continue;
    }
    if (batch.length && bytes + row.byteLen > batchBytes) yield* flush();
    batch.push(row);
    bytes += row.byteLen;
  }
  if (batch.length) yield* flush();
}

const bodyBytesOf = (rows: readonly ManifestRow[], units: readonly FenceUnit[]) => rows.reduce((n, row) => n + row.byteLen, 0)
  + units.reduce((n, unit) => n + unit.bytes.length - rows.slice(unit.from, unit.to + 1).reduce((m, row) => m + row.byteLen, 0), 0);

async function rewriteOwner(engine: BrainEngine): Promise<SegmentedStagingOwner> {
  const { principal } = await maintenanceAttribution(engine);
  return { kind: 'edit', principalKind: principal.kind, principalId: principal.id, baseRevision: null };
}

/** The replaced rows' segment shas: texts the rewrite stopped referencing from this generation. */
const replacedShas = (rows: readonly ManifestRow[], units: readonly FenceUnit[]) => units.flatMap(unit => rows.slice(unit.from, unit.to + 1).map(row => row.sha256));

/**
 * The tier and corpus generation the page's stored vectors were embedded under (its contextual-retrieval stamp), so vector
 * reuse admits them as an import of the same body would. A fence edit is not authorship: the stamp stays as it is.
 */
const rewriteTier = (page: { contextual_retrieval_mode: string | null; corpus_generation: string | null }) => page.contextual_retrieval_mode === 'title'
  ? { tier: 'title' as const, corpusGeneration: page.corpus_generation } : { tier: 'none' as const, corpusGeneration: null };

export interface LiveFenceRewrite {
  /** Segment shas the old generation referenced in place of the rewritten units. */
  replaced: Uint8Array[];
  /** page_segment_derivations rows deleted because they may hold the replaced text (deleteRewrittenDerivations). */
  derivations: number;
  /** False when the page was left unsealed (its projection runs after commit: `buildSegmentedProjection`). */
  sealed: boolean;
}

/**
 * Rewrite the fences of a segmented page's live body through `transform`, in
 * the caller's transaction: a new generation whose unchanged segments keep
 * their rows and chunks, and whose rewritten segments get new occurrences
 * (their chunks staged here, the old ones retired by the flip), and the
 * derivation rows that may hold the replaced text are deleted. A fence edit
 * is not authorship, so the page keeps its trust tier; a soft-deleted page
 * stays deleted. Null when no fence changed (nothing is written).
 */
export async function rewriteLiveSegmentedFences(tx: BrainEngine, pageId: number, transform: FenceTransform): Promise<LiveFenceRewrite | null> {
  const [page] = await tx.executeRaw<{ id: number; slug: string; source_id: string; title: string; type: string; page_kind: string; frontmatter: JsonObject | null;
    body_generation: number | string; body_flags: JsonObject | null; body_storage: string; deleted_at: string | null; tags: string[];
    contextual_retrieval_mode: string | null; corpus_generation: string | null }>(`SELECT p.id,p.slug,p.source_id,p.title,
      p.type,p.page_kind,p.frontmatter,p.body_generation,p.body_flags,p.body_storage,p.deleted_at,p.contextual_retrieval_mode,p.corpus_generation,
      COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id),'[]'::jsonb) AS tags FROM pages p WHERE p.id=$1`, [pageId]);
  if (page?.body_storage !== 'segmented') return null;
  const sourceId = page.source_id, slug = page.slug, frontmatter = page.frontmatter ?? {};
  const rows = await tx.readManifest(pageId);
  await assertGenerationTiles(tx, pageId, undefined, rows);
  const units = await changedUnits(tx, sourceId, rows, transform);
  if (!units.length) return null;
  const generation = Number(page.body_generation);
  const prepared = await prepareSegmentedBody(tx, { sourceId, slug, title: page.title, type: page.type, frontmatter, tags: page.tags,
    live: { id: pageId, generation, storage: 'segmented', title: page.title, type: page.type, flags: page.body_flags },
    truth: rewrittenRegion(tx, sourceId, rows, units, 'truth'), timeline: rewrittenRegion(tx, sourceId, rows, units, 'timeline'),
    hasTimeline: rows.some(row => row.region === 'timeline'), flags: page.body_flags ?? {}, declaredBytes: bodyBytesOf(rows, units),
    owner: await rewriteOwner(tx), chunking: { quarantined: isQuarantined(frontmatter), ...rewriteTier(page) } });
  const { flipRetireMaxRows } = await readPageBodyPolicy(tx);
  const applied = await withPageTierKept(tx, { sourceId, slug }, () => applySegmentedBody(tx, { slug, sourceId, pageId, prepared, promotion: false,
    retireMaxRows: flipRetireMaxRows, meta: { title: page.title, type: page.type as never, frontmatter, page_kind: page.page_kind as never } }));
  if (page.deleted_at) await tx.executeRaw('UPDATE pages SET deleted_at=$2 WHERE id=$1', [pageId, page.deleted_at]);
  if (applied.complete) await sealSegmentedPage(tx, pageId);
  const derivations = await deleteRewrittenDerivations(tx, pageId, rows, units);
  return { replaced: replacedShas(rows, units), sealed: applied.complete, derivations };
}

const MANIFEST_COLUMNS = `page_id,occurrence_id,seq,region,source_id,sha256,byte_start,byte_len,line_start,line_count,cut_kind,entry_state,
  protected_regions,facts_slots,static_proj_bytes,static_proj_lines,outline,date_min,date_max,hash_state`;

/**
 * Rebuild retained generation `generation` of a segmented page with its fences
 * rewritten (purge of a version), in the caller's transaction. The generation
 * gets rows of its own: rows it shared with neighbouring generations keep
 * their other generations, and the rebuilt rows (new occurrences, every
 * coordinate and hash midstate recomputed) cover exactly this one. Each
 * version row of the generation gets the rebuilt content_hash and size.
 * Returns the replaced segment shas, or null when no fence changed. A change
 * to the page's live generation is refused (the page row is locked, so the
 * generation cannot become live under the rebuild).
 */
export async function rewriteSegmentedGeneration(tx: BrainEngine, pageId: number, generation: number, transform: FenceTransform,
  version: { title: string; type: string; frontmatter: JsonObject; tags: readonly string[] }): Promise<Uint8Array[] | null> {
  const [page] = await tx.executeRaw<{ slug: string; source_id: string; body_flags: JsonObject | null; body_storage: string; body_generation: number | string }>(
    'SELECT slug,source_id,body_flags,body_storage,body_generation FROM pages WHERE id=$1 FOR UPDATE', [pageId]);
  if (!page) return null;
  const sourceId = page.source_id;
  const rows = await tx.readManifest(pageId, { generation });
  await assertGenerationTiles(tx, pageId, generation, rows);
  const units = await changedUnits(tx, sourceId, rows, transform);
  if (!units.length) return null;
  // Rebuilding rows in place is for retained generations only: the live one changes by a flip (rewriteLiveSegmentedFences),
  // which moves the revision and the chunks with it.
  if (page.body_storage === 'segmented' && Number(page.body_generation) === generation) {
    throw new Error(`rewriteSegmentedGeneration: generation ${generation} is the live body of page ${page.slug}; rewrite it with rewriteLiveSegmentedFences.`);
  }
  const prepared = await prepareSegmentedBody(tx, { sourceId, slug: page.slug, live: null, ...version,
    truth: rewrittenRegion(tx, sourceId, rows, units, 'truth'), timeline: rewrittenRegion(tx, sourceId, rows, units, 'timeline'),
    hasTimeline: rows.some(row => row.region === 'timeline'), flags: page.body_flags ?? {}, declaredBytes: bodyBytesOf(rows, units),
    owner: await rewriteOwner(tx), chunking: { quarantined: true, corpusGeneration: null, tier: 'none' } });
  const staging = prepared.stagingId, next = generation + 1;
  // The part of each shared row after this generation moves to a copy (staged, so the live-seq index sees one live row);
  // the part before it ends here; rows that began here go. Then the rebuilt rows take [generation, next).
  await tx.executeRaw(`INSERT INTO page_body_manifest (${MANIFEST_COLUMNS},gen_from,gen_to,staging_id) SELECT ${MANIFEST_COLUMNS},$3::bigint,gen_to,$4::uuid
    FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$3)`, [pageId, generation, next, staging]);
  await tx.executeRaw('UPDATE page_body_manifest SET gen_to=$2 WHERE page_id=$1 AND staging_id IS NULL AND gen_from<$2 AND (gen_to IS NULL OR gen_to>$2)', [pageId, generation]);
  await tx.executeRaw('DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from=$2', [pageId, generation]);
  await tx.stageManifestRows(prepared.createRows!.map(row => ({ ...row, pageId, genFrom: generation })));
  await tx.executeRaw(`UPDATE page_body_manifest SET staging_id=NULL, gen_to=CASE WHEN gen_from=$2 THEN $3 ELSE gen_to END
    WHERE page_id=$1 AND staging_id=$4::uuid`, [pageId, generation, next, staging]);
  await tx.setBodyStagingState(staging, 'committed');
  await tx.executeRaw(`UPDATE page_versions SET content_hash=$3,body_bytes=$4 WHERE page_id=$1 AND body_generation=$2 AND body_storage='segmented'`,
    [pageId, generation, prepared.body.content_hash, prepared.body.body_bytes]);
  return replacedShas(rows, units);
}

/**
 * `content_hash` of a segmented page's body at `generation` with its fences
 * rewritten (as an import through the purge overlay would hash it), streamed;
 * null when no fence changes, so the stored hash stands.
 */
export async function rewrittenContentHash(engine: BrainEngine, pageId: number, sourceId: string, generation: number, transform: FenceTransform,
  meta: { title: unknown; type: unknown; frontmatter: Record<string, unknown>; tags: string[] }): Promise<string | null> {
  const rows = await engine.readManifest(pageId, { generation });
  await assertGenerationTiles(engine, pageId, generation, rows);
  const units = await changedUnits(engine, sourceId, rows, transform);
  if (!units.length) return null;
  const hash = ContentHashStream.begin(meta);
  for await (const bytes of rewrittenRegion(engine, sourceId, rows, units, 'truth')) hash.pushTruth(utf8.decode(bytes));
  for await (const bytes of rewrittenRegion(engine, sourceId, rows, units, 'timeline')) hash.pushTimeline(utf8.decode(bytes));
  return hash.finish(meta);
}

/**
 * Whether a segmented body (live, or `generation`) contains any of `needles`,
 * case-insensitively, within one region: each segment is lower-cased on its
 * own and searched with the tail of the previous one prepended (a needle split
 * by a cut is found). `'deadline'` when `deadline` (performance.now()) passed.
 */
export async function segmentedBodyContains(engine: BrainEngine, pageId: number, sourceId: string, needles: readonly string[],
  opts: { generation?: number; deadline?: number } = {}): Promise<boolean | 'deadline'> {
  const lowered = needles.map(n => n.toLowerCase()).filter(Boolean);
  if (!lowered.length) return false;
  const keep = Math.max(...lowered.map(n => n.length)) - 1;
  let carry = '', region: BodyRegion | null = null;
  for await (const part of readSegmentedBody(engine, pageId, sourceId, opts.generation === undefined ? {} : { generation: opts.generation })) {
    if (opts.deadline !== undefined && performance.now() > opts.deadline) return 'deadline';
    if (part.region !== region) { carry = ''; region = part.region; }
    const text = carry + utf8.decode(part.bytes).toLowerCase();
    if (lowered.some(n => text.includes(n))) return true;
    carry = keep > 0 ? text.slice(-keep) : '';
  }
  return false;
}
