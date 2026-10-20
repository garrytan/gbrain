/**
 * Splicing a segmented body (Wave B, spec 6.1 and 6.3): replace stored byte
 * ranges of a segmented page's live generation and stage the next generation
 * from the segments the change touches, never from the whole body.
 *
 * Segmentation is append-stable and resumable (segmenter.ts): a run started
 * at a segment's entry state over its bytes reproduces a full run's cuts. So
 * a splice resumes at the last clean entry point at or before the first
 * replaced byte, feeds the touched segments with the replacements applied,
 * and stops at the first old segment boundary where the new run's exit state
 * equals that segment's entry state: every segment after it keeps its bytes,
 * text and chunks and only moves (a new manifest row under the same
 * occurrence, its offsets and content_hash midstate recomputed). An append is
 * an insertion at the end of its region, so it re-segments the old tail and
 * the new text and moves nothing.
 *
 * Work is O(touched segments + replacement bytes) in segmentation, plus the
 * text of every moved segment for the content_hash stream (O(suffix) for an
 * edit, nothing for an append). New segments equal to a replaced one keep its
 * occurrence and chunks; the rest are chunked here, with vectors reused by
 * chunk text from the replaced occurrences' rows (spec 4.4).
 *
 * A change that flips a region's global fence trust (1.3) restages the whole
 * body ('rescanned'), as does a caller that forces it ('full').
 */
import type { BrainEngine } from '../engine.ts';
import { stableJson } from '../persistence/digest.ts';
import { faultPoint } from '../persistence/fault-points.ts';
import type { Principal } from '../persistence/model.ts';
import { BODY_LEAD_BYTES, STAGE_BATCH_BYTES } from './limits.ts';
import type { BodyRegion, JsonObject, ManifestRow, ManifestRowInput, SegmentedBodyColumns, SegmentTextInput } from './types.ts';
import { regionFlags, regionTrust, segmentStream, SEGMENTER_VERSION, type SegmentOut, type StoredRegion } from './segmenter.ts';
import { isCleanResumePoint, readEntryState, timelineEntryState, type EntryState } from './entry-state.ts';
import { ContentHashStream } from './content-hash-stream.ts';
import { occurrenceKey, occurrencesWithoutChunks, openSegmentedStaging, prepareSegmentedBody, rowUnchanged, segmentWriteScope, stageOccurrenceChunks,
  utf8Prefix, type PreparedSegmentedBody, type SegmentChunkingContext, type SegmentedStagingOwner } from './ingest.ts';

/** Stored range [start, end) of the live body replaced by bytes; start === end inserts. Sorted, disjoint, each inside one region. */
export interface BodyReplacement { start: number; end: number; bytes: Uint8Array }

/** The live segmented page a splice changes (metadata only: no body). */
export interface SplicePage {
  id: number;
  generation: number;
  title: string;
  type: string;
  flags: JsonObject | null;
  truthLead: string;
  timelineLead: string;
  bodyBytes: number;
  truthBytes: number;
  bodyLines: number;
  segmentCount: number;
  /** The projection is sealed now; an unsealed page stays unsealed and its projection runs after commit. */
  sealed: boolean;
  /** The tier and corpus generation its stored vectors were embedded under (its contextual-retrieval stamp), for vector reuse. */
  crTier: 'title' | 'none';
  corpusGeneration: string | null;
  pageKind: string;
}

export interface SegmentedSpliceInput {
  sourceId: string;
  slug: string;
  page: SplicePage;
  frontmatter: JsonObject;
  tags: readonly string[];
  replacements: readonly BodyReplacement[];
  owner: SegmentedStagingOwner;
  chunking: SegmentChunkingContext;
  /** Restage the whole body (the forced full-rewrite probe of the append cost test). */
  full?: boolean;
}

export interface SegmentedSplice {
  prepared: PreparedSegmentedBody;
  /** The whole body was restaged: a region's fence trust flipped, or 'full'. */
  rescanned: boolean;
}

/**
 * @internal Deterministic work counters for the append and edit cost tests: bytes fed to the segmenter
 * ('segmented'), segment text bytes read back ('read') and manifest rows loaded ('rows'). Counts, never time.
 */
export const spliceWork = { segmented: 0, read: 0, rows: 0, matches: 0 };

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const missing = (row: ManifestRow) => new Error('Segment text ' + hex(row.sha256) + ' of page ' + row.pageId + ' is missing.');

/** A row whose stored metadata names no stored-stream position (nothing open across its cut), so it can move unchanged. */
function positionFree(row: ManifestRow): boolean {
  const entry = readEntryState(row.entryState);
  if (!entry) return false;
  if (entry.trusted.open || entry.untrusted.open || entry.trusted.truncatedAt !== null || entry.untrusted.truncatedAt !== null) return false;
  const opens = (list: unknown[]) => (list as Array<{ open_start?: number; open_end?: number }>).some(r => r.open_start !== undefined || r.open_end !== undefined);
  return !opens(row.protectedRegions) && !opens(row.factsSlots);
}

/** The region a replacement belongs to; an insertion at truthBytes, the boundary, appends to truth. */
const replacementRegion = (page: Pick<SplicePage, 'truthBytes' | 'bodyBytes'>, r: BodyReplacement): BodyRegion =>
  page.bodyBytes > page.truthBytes && (r.start === r.end ? r.start > page.truthBytes : r.start >= page.truthBytes) ? 'timeline' : 'truth';

/**
 * Whether replacements touch a row, and its bytes with them applied ('first': the row starts its region, so an insertion
 * at its start is its own). An insertion is owned by one row only: a row of the region it belongs to.
 */
function applyToRow(row: Pick<ManifestRow, 'byteStart' | 'byteLen' | 'region'>, reps: readonly BodyReplacement[], first: boolean,
  regionOf: (r: BodyReplacement) => BodyRegion): { touched: boolean; pieces: (bytes: Uint8Array) => Uint8Array[] } {
  const start = Number(row.byteStart), end = start + row.byteLen;
  const mine = reps.filter(r => r.start === r.end
    ? regionOf(r) === row.region && (r.start > start || (first && r.start === start)) && r.start <= end : r.start < end && r.end > start);
  return { touched: mine.length > 0, pieces: bytes => {
    const out: Uint8Array[] = [];
    let cur = start;
    for (const r of mine) {
      if (r.start === r.end || r.start >= start) {
        if (r.start > cur) out.push(bytes.subarray(cur - start, r.start - start));
        out.push(r.bytes);
        cur = r.start === r.end ? r.start : Math.min(r.end, end);
      } else cur = Math.max(cur, Math.min(r.end, end));
    }
    if (cur < end) out.push(bytes.subarray(cur - start));
    return out;
  } };
}

/** Net bytes the replacements ending at or before stored byte p add. */
const shiftAt = (reps: readonly BodyReplacement[], p: number) => reps.reduce((n, r) => r.end <= p ? n + r.bytes.length - (r.end - r.start) : n, 0);

async function readTexts(engine: BrainEngine, sourceId: string, rows: readonly ManifestRow[]): Promise<Map<string, Uint8Array>> {
  const texts = await engine.readSegmentTexts(sourceId, rows.map(row => row.sha256));
  for (const row of rows) {
    const text = texts.get(hex(row.sha256));
    if (!text) throw missing(row);
    spliceWork.read += text.length;
  }
  return texts;
}

/** The live rows of the page from seq 'from' to the end. */
async function suffixRows(engine: BrainEngine, page: SplicePage, from: number): Promise<ManifestRow[]> {
  const rows = await engine.readManifest(page.id, { generation: page.generation, lastN: Math.max(0, page.segmentCount - from) });
  spliceWork.rows += rows.length;
  if (rows.length !== page.segmentCount - from || (rows[0] && rows[0].seq !== from)) {
    throw new Error('Page ' + page.id + ' generation ' + page.generation + ' does not tile seq ' + from + '..' + (page.segmentCount - 1) + '; read it again.');
  }
  return rows;
}

/** Seq of the live row holding stored byte p (the last row starting at or before it). */
async function rowAt(engine: BrainEngine, page: SplicePage, p: number): Promise<number> {
  const [row] = await engine.executeRaw<{ seq: number }>('SELECT seq FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=$2'
    + ' AND (gen_to IS NULL OR gen_to>$2) AND byte_start<=$3 ORDER BY byte_start DESC, seq DESC LIMIT 1', [page.id, page.generation, p]);
  return Number(row?.seq ?? 0);
}

/** One region of the whole body with the replacements applied (the rescan path). */
async function* virtualRegion(engine: BrainEngine, sourceId: string, rows: readonly ManifestRow[], reps: readonly BodyReplacement[], region: BodyRegion,
  regionOf: (r: BodyReplacement) => BodyRegion): AsyncIterable<Uint8Array> {
  const mine = rows.filter(row => row.region === region);
  const batchBytes = STAGE_BATCH_BYTES[engine.kind];
  for (let i = 0; i < mine.length;) {
    let j = i, bytes = 0;
    while (j < mine.length && (j === i || bytes + mine[j]!.byteLen <= batchBytes)) bytes += mine[j++]!.byteLen;
    const batch = mine.slice(i, j);
    const texts = await readTexts(engine, sourceId, batch);
    for (const row of batch) {
      for (const piece of applyToRow(row, reps, row === mine[0], regionOf).pieces(texts.get(hex(row.sha256))!)) {
        if (!piece.length) continue;
        spliceWork.segmented += piece.length;
        yield piece;
      }
    }
    i = j;
  }
}

/** Restage the whole body with the replacements applied under 'flags' (the rescan of spec 1.3). */
async function restageWhole(engine: BrainEngine, input: SegmentedSpliceInput, flags: JsonObject): Promise<PreparedSegmentedBody> {
  const { page } = input;
  const rows = await engine.readManifest(page.id, { generation: page.generation });
  spliceWork.rows += rows.length;
  const delta = input.replacements.reduce((n, r) => n + r.bytes.length - (r.end - r.start), 0);
  return prepareSegmentedBody(engine, { sourceId: input.sourceId, slug: input.slug, title: page.title, type: page.type, frontmatter: input.frontmatter, tags: input.tags,
    live: { id: page.id, generation: page.generation, storage: 'segmented', title: page.title, type: page.type, flags: page.flags },
    truth: virtualRegion(engine, input.sourceId, rows, input.replacements, 'truth', r => replacementRegion(input.page, r)),
    timeline: virtualRegion(engine, input.sourceId, rows, input.replacements, 'timeline', r => replacementRegion(input.page, r)),
    hasTimeline: page.bodyBytes > page.truthBytes, flags, declaredBytes: page.bodyBytes + delta, owner: input.owner, chunking: input.chunking });
}

interface NewRow { row: ManifestRowInput; text: Uint8Array; segment?: SegmentOut; moved?: ManifestRow }
type RowCore = Omit<ManifestRowInput, 'seq' | 'byteStart' | 'lineStart' | 'hashState' | 'pageId' | 'genFrom' | 'stagingId' | 'sourceId'>;

const segmentCore = (segment: SegmentOut): RowCore => ({ occurrenceId: 0, region: segment.region, sha256: segment.sha256, byteLen: segment.bytes.length,
  lineCount: segment.lineCount, cutKind: segment.cutKind, entryState: segment.entryState as unknown as JsonObject, protectedRegions: segment.protectedRegions,
  factsSlots: segment.factsSlots, staticProjBytes: segment.staticProjBytes, staticProjLines: segment.staticProjLines, outline: segment.outline,
  dateMin: segment.dateMin, dateMax: segment.dateMax });

const rowCore = (row: ManifestRow): RowCore => ({ occurrenceId: Number(row.occurrenceId), region: row.region, sha256: row.sha256, byteLen: row.byteLen,
  lineCount: row.lineCount, cutKind: row.cutKind, entryState: row.entryState, protectedRegions: row.protectedRegions, factsSlots: row.factsSlots,
  staticProjBytes: row.staticProjBytes, staticProjLines: row.staticProjLines, outline: row.outline, dateMin: row.dateMin, dateMax: row.dateMax });

/**
 * Stage the next generation of a segmented page with 'replacements' applied. Null when the change empties or creates
 * a region, which this path does not do: the caller takes its whole-body path.
 */
export async function spliceSegmentedBody(engine: BrainEngine, input: SegmentedSpliceInput): Promise<SegmentedSplice | null> {
  const { page, replacements: reps } = input;
  const flags = page.flags ?? {};
  if (!reps.length) throw new Error('spliceSegmentedBody: no replacements.');
  const hasTimeline = page.bodyBytes > page.truthBytes;
  const regionOf = (r: BodyReplacement): BodyRegion => replacementRegion(page, r);
  for (const r of reps) {
    const [lo, hi] = regionOf(r) === 'truth' ? [0, page.truthBytes] : [page.truthBytes, page.bodyBytes];
    if (lo === hi || r.start < lo || r.end > hi || (r.start === lo && r.end === hi && r.bytes.length === 0)) return null;
  }
  if (input.full) return { prepared: await restageWhole(engine, input, flags), rescanned: true };

  // Resume at the last clean entry point at or before the row holding the first replaced byte.
  const first = reps[0]!;
  const firstSeq = await rowAt(engine, page, first.start === first.end ? Math.max(0, first.start - 1) : first.start);
  let base = Math.max(0, firstSeq - 4);
  let rows = await suffixRows(engine, page, base);
  const clean = (row: ManifestRow) => { const entry = readEntryState(row.entryState); return !!entry && isCleanResumePoint(entry); };
  let f = firstSeq - base;
  for (;;) {
    while (f > 0 && rows[f - 1]!.region === rows[f]!.region && !clean(rows[f]!)) f--;
    if (clean(rows[f]!) || base === 0 || f > 0) break;
    const more = Math.max(0, base - 64);
    rows = await suffixRows(engine, page, more);
    f += base - more;
    base = more;
  }
  if (!clean(rows[f]!) || rows.slice(f).some(row => !readEntryState(row.entryState))) return null;
  const prior = base + f === 0 ? null : f > 0 ? rows[f - 1]! : (await suffixRows(engine, page, base - 1))[0]!;

  const writes = await segmentWriteScope(engine, input.sourceId, { kind: input.owner.principalKind as Principal['kind'], id: input.owner.principalId });
  const live = { id: page.id, generation: page.generation, storage: 'segmented' as const, title: page.title, type: page.type, flags: page.flags };
  const stagingId = await openSegmentedStaging(engine, { sourceId: input.sourceId, slug: input.slug, declaredBytes: page.bodyBytes, live, owner: input.owner });
  try {
    const generation = page.generation + 1;
    const out: NewRow[] = [];
    const replaced: ManifestRow[] = [];
    const exits: Partial<Record<BodyRegion, EntryState>> = {};
    const touchedAt = rows.map((row, i) => applyToRow(row, reps, base + i === 0 || (i > 0 && rows[i - 1]!.region !== row.region)
      || (i === 0 && prior !== null && prior.region !== row.region), regionOf));
    const hasher = prior ? ContentHashStream.fromState(prior.hashState) : ContentHashStream.begin({ title: page.title, type: page.type });
    let byteStart = Number(rows[f]!.byteStart), lineStart = Number(rows[f]!.lineStart), seq = base + f;
    const push = (core: RowCore, text: Uint8Array, extra: Pick<NewRow, 'segment' | 'moved'>) => {
      const decoded = utf8.decode(text);
      if (core.region === 'truth') hasher.pushTruth(decoded); else hasher.pushTimeline(decoded);
      out.push({ ...extra, text, row: { ...core, pageId: page.id, genFrom: generation, seq: seq++, byteStart, lineStart, hashState: hasher.exportState(),
        sourceId: input.sourceId, stagingId } });
      byteStart += text.length;
      lineStart += core.lineCount;
    };
    const regionEndOf = (i: number) => { let j = i; while (j < rows.length && rows[j]!.region === rows[i]!.region) j++; return j; };
    /** Rows from k to the next touched row (or the region's end) move by delta; a touched row there resumes from its own entry state. */
    const canMove = (k: number, delta: number) => {
      const end = regionEndOf(k);
      let j = k;
      for (; j < end && !touchedAt[j]!.touched; j++) if (delta !== 0 && !positionFree(rows[j]!)) return false;
      return j >= end || (clean(rows[j]!) && (delta === 0 || positionFree(rows[j]!)));
    };

    let i = f;
    let entryOverride: EntryState | null = null;
    while (i < rows.length) {
      const row = rows[i]!;
      const regionEnd = regionEndOf(i);
      const stored = readEntryState(row.entryState)!;
      const delta = shiftAt(reps, Number(row.byteStart));
      if (i !== f && !touchedAt[i]!.touched && (!entryOverride || stableJson(entryOverride) === stableJson(stored)) && canMove(i, delta)) {
        entryOverride = null;
        let until = i;
        while (until < regionEnd && !touchedAt[until]!.touched) until++;
        for (let at = i; at < until;) {
          let to = at, bytes = 0;
          while (to < until && (to === at || bytes + rows[to]!.byteLen <= STAGE_BATCH_BYTES[engine.kind])) bytes += rows[to++]!.byteLen;
          const texts = await readTexts(engine, input.sourceId, rows.slice(at, to));
          for (const moved of rows.slice(at, to)) push(rowCore(moved), texts.get(hex(moved.sha256))!, { moved });
          at = to;
        }
        i = until;
        continue;
      }
      // Segment from row i with the replacements applied, until an old boundary resynchronizes or the region ends.
      const entry = entryOverride ?? stored;
      entryOverride = null;
      let consumed = i;
      const source = async function* () {
        for (let j = i; j < regionEnd; j++) {
          consumed = j + 1;
          const texts = await readTexts(engine, input.sourceId, [rows[j]!]);
          for (const piece of touchedAt[j]!.pieces(texts.get(hex(rows[j]!.sha256))!)) {
            if (!piece.length) continue;
            spliceWork.segmented += piece.length;
            yield piece;
          }
        }
      };
      const end = row.region === 'truth' && hasTimeline ? 'region_end' as const : 'eof' as const;
      let resync = -1;
      let last: SegmentOut | null = null;
      for await (const segment of segmentStream(source(), entry, { byteStart, lineStart, fenceTrust: regionTrust(flags, row.region), end })) {
        push(segmentCore(segment), segment.bytes, { segment });
        last = segment;
        // A cut on an old boundary with that row's entry state: every row after it is unchanged.
        for (let k = i + 1; k < regionEnd && k <= consumed; k++) {
          const oldStart = Number(rows[k]!.byteStart);
          if (oldStart + shiftAt(reps, oldStart) !== byteStart) continue;
          if (!touchedAt[k]!.touched && stableJson(segment.exitState) === stableJson(rows[k]!.entryState) && clean(rows[k]!) && canMove(k, shiftAt(reps, oldStart))) resync = k;
          break;
        }
        if (resync >= 0) break;
      }
      replaced.push(...rows.slice(i, resync >= 0 ? resync : regionEnd));
      if (resync >= 0) { i = resync; continue; }
      if (last) exits[row.region] = last.exitState;
      if (row.region === 'truth' && last && regionEnd < rows.length) entryOverride = timelineEntryState(last.exitState);
      i = regionEnd;
    }

    // A region re-segmented to its end may have flipped its fence trust (1.3): the whole body is restaged under the new trust.
    const flipped: JsonObject = { ...flags };
    let flip = false;
    for (const region of ['truth', 'timeline'] as const) {
      const exit = exits[region];
      if (!exit) continue;
      const observed = regionFlags(exit, regionTrust(flags, region)).observedFenceTrust;
      if (observed === regionTrust(flags, region)) continue;
      flipped[region === 'truth' ? 'fence_trust' : 'timeline_fence_trust'] = observed;
      flip = true;
    }
    if (flip) {
      await engine.setBodyStagingState(stagingId, 'aborted').catch(() => undefined);
      return { prepared: await restageWhole(engine, input, flipped), rescanned: true };
    }

    // New segments equal to a replaced occurrence keep it (and its chunks); moved rows keep theirs.
    const byKey = new Map<string, ManifestRow[]>();
    for (const row of replaced) {
      const key = occurrenceKey(row.sha256, row.entryState, regionTrust(flags, row.region));
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    const used = new Set<ManifestRow>();
    const fresh: NewRow[] = [];
    const changed: ManifestRowInput[] = [];
    const closeOccurrences: number[] = [];
    const pending: SegmentTextInput[] = [];
    for (const item of out) {
      let keep = item.moved;
      if (!keep) {
        const candidates = (byKey.get(occurrenceKey(item.row.sha256, item.row.entryState, item.segment!.fenceTrust)) ?? []).filter(row => !used.has(row));
        keep = candidates.find(row => row.seq === item.row.seq) ?? candidates[0];
        if (keep) used.add(keep);
      }
      if (keep) {
        item.row.occurrenceId = Number(keep.occurrenceId);
        if (rowUnchanged(keep, item.row)) continue;
        changed.push(item.row);
        closeOccurrences.push(item.row.occurrenceId);
        continue;
      }
      fresh.push(item);
      changed.push(item.row);
      pending.push({ sha256: item.row.sha256, body: item.text, lineCount: item.row.lineCount });
    }
    const ids = fresh.length ? await engine.allocateBodyOccurrenceIds(fresh.length) : [];
    fresh.forEach((item, k) => { item.row.occurrenceId = ids[k]!; });
    const retireChunkOccurrences = replaced.filter(row => !used.has(row)).map(row => Number(row.occurrenceId));
    closeOccurrences.push(...retireChunkOccurrences);

    if (pending.length) await writes(exec => exec.stageSegmentTexts(input.sourceId, pending, { stagingId }));
    await faultPoint('segmented:texts_staged', { sourceId: input.sourceId });
    if (changed.length) await writes(exec => exec.stageManifestRows(changed));
    await faultPoint('segmented:manifest_staged', { sourceId: input.sourceId });

    const lastOld = rows[rows.length - 1]!;
    const delta = byteStart - (Number(lastOld.byteStart) + lastOld.byteLen);
    const truthDelta = reps.filter(r => regionOf(r) === 'truth').reduce((n, r) => n + r.bytes.length - (r.end - r.start), 0);
    const lines = out.reduce((n, item) => n + item.row.lineCount, 0) - rows.slice(f).reduce((n, row) => n + row.lineCount, 0);
    const lead = (region: BodyRegion, kept: string) => {
      const head = out.find(item => item.row.region === region);
      const startsRegion = !!head && (region === 'truth' ? head.row.byteStart === 0 : head.row.byteStart === page.truthBytes + truthDelta);
      return startsRegion && !head!.moved ? utf8Prefix(head!.text, BODY_LEAD_BYTES) : kept;
    };
    const body: SegmentedBodyColumns = {
      content_hash: hasher.finish({ frontmatter: input.frontmatter, tags: [...input.tags] }),
      body_bytes: page.bodyBytes + delta, truth_bytes: page.truthBytes + truthDelta, body_lines: page.bodyLines + lines,
      segment_count: seq, segmenter_version: SEGMENTER_VERSION,
      truth_lead: lead('truth', page.truthLead), timeline_lead: lead('timeline', page.timelineLead),
      body_flags: { ...flags, has_protected: flags.has_protected === true || out.some(item => (item.row.protectedRegions as StoredRegion[]).length > 0) },
    };
    const chunkable = await occurrencesWithoutChunks(engine, page.id, page.generation, changed);
    const chunks = await stageOccurrenceChunks(engine, { pageId: page.id, sourceId: input.sourceId, slug: input.slug, generation, occurrences: chunkable,
      title: page.title, frontmatter: input.frontmatter, flags: body.body_flags, chunking: input.chunking, retiredOccurrences: retireChunkOccurrences });
    await faultPoint('segmented:chunks_staged', { sourceId: input.sourceId });
    const kept = new Set(out.filter(item => !fresh.includes(item)).map(item => item.row.occurrenceId));
    retireChunkOccurrences.push(...chunkable.filter(row => kept.has(row.occurrenceId)).map(row => row.occurrenceId));
    await engine.setBodyStagingState(stagingId, 'prepared');
    return { rescanned: false, prepared: { stagingId, expectedGeneration: page.generation, newGeneration: generation, createRows: null, createChunks: null,
      closeOccurrences, retireChunkOccurrences, unchunked: input.chunking.quarantined ? 0 : chunkable.length - chunks.occurrences, priorStale: !page.sealed, body,
      bodyUnchanged: changed.length === 0 && retireChunkOccurrences.length === 0, rows: { texts: fresh.length, manifest: changed.length, chunks: chunks.rows },
      stagedChunkIndexes: chunks.indexes } };
  } catch (error) {
    await engine.setBodyStagingState(stagingId, 'aborted').catch(() => undefined);
    throw error;
  }
}

/** The live segmented page a splice reads, from its row (metadata only); null when the page is not segmented. */
export async function splicePage(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<SplicePage | null> {
  const [row] = await engine.executeRaw<{ id: number; body_generation: string; title: string; type: string; body_flags: JsonObject | null; truth_lead: string | null;
    timeline_lead: string | null; body_bytes: string; truth_bytes: string; body_lines: string; segment_count: number; sealed: boolean; body_storage: string;
    contextual_retrieval_mode: string | null; corpus_generation: string | null; page_kind: string }>(
    'SELECT id, body_generation::text AS body_generation, title, type, body_flags, truth_lead, timeline_lead, body_bytes::text AS body_bytes,'
    + ' truth_bytes::text AS truth_bytes, body_lines::text AS body_lines, segment_count, body_storage, contextual_retrieval_mode, corpus_generation, page_kind,'
    + ' (text_projection_revision = knowledge_revision) IS TRUE AS sealed FROM pages WHERE id=$1', [pageId]);
  if (!row || row.body_storage !== 'segmented') return null;
  const title = row.contextual_retrieval_mode === 'title';
  return { id: Number(row.id), generation: Number(row.body_generation), title: row.title, type: row.type, flags: row.body_flags, truthLead: row.truth_lead ?? '',
    timelineLead: row.timeline_lead ?? '', bodyBytes: Number(row.body_bytes), truthBytes: Number(row.truth_bytes), bodyLines: Number(row.body_lines),
    segmentCount: Number(row.segment_count), sealed: row.sealed, crTier: title ? 'title' : 'none', corpusGeneration: title ? row.corpus_generation : null,
    pageKind: row.page_kind };
}
