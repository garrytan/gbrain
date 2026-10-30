/**
 * Segmented page storage (Wave B, spec 7.1-7.3): ranged reads of a segmented
 * body, one segment text at a time, never the whole body as one string.
 *
 * Two views, chosen by space and audience:
 *
 * - The read projection (space 'projected', either audience; space 'stored'
 *   for a remote caller): the text projectPageText gives the joined body
 *   (page-window/document.ts), the one text Wave A windows, outlines, chunks
 *   and evidence are cut from, the same for local and remote callers.
 *   Projected offsets are its UTF-8 bytes: truth segments, the low-tier block
 *   after the truth, TIMELINE_SEPARATOR and the timeline segments when the
 *   timeline shows any text. Each segment is projected whole from its stored
 *   regions (segment-projection.ts) after the withdrawal overlay, then cut.
 * - The trusted body (space 'stored', audience 'trusted'): the stored stream
 *   after the withdrawal overlay, what readPageSnapshot gives a trusted reader
 *   of an inline page (export, derived passes, a local full read). It has no
 *   coordinates of its own: `projectedStart` repeats `storedStart`.
 *
 * Offsets are located from manifest sums: a page's rows are one light query,
 * static projection sizes add up, and only segments with facts slots are read
 * to add their rendered facts tables and to load the page's fence overlay
 * (`projectedLayout`, cached on the handle). A stored-space range selects the
 * rows it overlaps; a token, a rendered facts table or a block the overlay
 * rewrote is emitted whole or not at all.
 *
 * Offsets can drift without a revision change (a hold or a tier change moves
 * the projection, and a withdrawal block outside a facts region changes a
 * segment's length the sums do not see): a read can then repeat or skip text,
 * never show text the projection hides.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { TIMELINE_SEPARATOR } from '../page-window/document.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { credentialSafeProjection } from '../credential-projection.ts';
import { loadFenceChunkOverlay, markFenceChunk, renderFenceLowTier, type FenceChunkOverlay, type FenceLowTierRow } from '../eligibility/fence-overlay.ts';
import { partialFenceRuns, withdrawalFenceBlocks } from '../facts/withdrawal-overlay.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';
import { assertRowsTile, generationBodyBytes } from './body-tiling.ts';
import { readEntryState } from './entry-state.ts';
import { FENCE_MAX_BYTES, SEGMENT_MAX_BYTES } from './limits.ts';
import { ledgerApplies, readBodyLedger, overlaySegmentText, type BodyLedger } from './segment-ledger.ts';
import { regionTrust, SEGMENTER_VERSION, type FactsSlot, type OutlineHeading, type StoredRegion } from './segmenter.ts';
import { overlaidPieces, projectionStaleError, projectSegment, type ProjectedPiece, type SegmentProjection } from './segment-projection.ts';
import type { BodyRegion, JsonObject } from './types.ts';
import { opError } from '../ops/contract.ts';
import { REVISION_BACKFILL_PENDING } from '../page-state/types.ts';

export type BodySpace = 'stored' | 'projected';
export type BodyAudience = 'trusted' | 'remote';

export type { BodyLedger } from './segment-ledger.ts';

/** One manifest row of the read generation, without its JSON metadata. */
export interface BodyRow {
  seq: number;
  occurrenceId: number;
  region: BodyRegion;
  sha256: Uint8Array;
  byteStart: number;
  byteLen: number;
  lineStart: number;
  lineCount: number;
  staticProjBytes: number;
  staticProjLines: number;
  outlineCount: number;
  hasFacts: boolean;
  hasDate: boolean;
}

/**
 * What a caller authorized before it reads a segmented body: the page's knowledge revision and, when its snapshot says,
 * the body generation. Every visibility, deletion, metadata or body change advances the revision, so a pinned read
 * refuses (revision_changed) rather than read a body or a page state nobody authorized; `admit` re-runs the parts of
 * the authorization the revision does not cover (a trust floor, a re-derivation hold) and throws to refuse.
 */
export interface BodyPin {
  revision: string;
  generation?: number;
  admit?: () => Promise<void>;
}

/** A segmented body opened for reading: the page, the generation's rows and the ledger. Reuse it across reads of one request. */
export interface SegmentedBody {
  pageId: number;
  sourceId: string;
  slug: string;
  generation: number;
  bodyBytes: number;
  bodyLines: number;
  truthBytes: number;
  flags: JsonObject;
  rows: BodyRow[];
  ledger: BodyLedger;
  /** The page was segmented by another segmenter version: every segment's regions are recomputed. */
  stale: boolean;
  layout?: ProjectedLayout;
  /** Set when the read follows an authorization: confirmBodyPin checks it again before the text is returned. */
  pin?: BodyPin;
}

/** Where every row of the read projection sits (`projectedLayout`). */
export interface ProjectedLayout {
  /** Document byte of each row's projection, its bytes and its newlines; -1 for timeline rows when the timeline shows nothing. */
  rowStart: number[];
  rowBytes: number[];
  rowNewlines: number[];
  /** Rendered facts table bytes per slot, for rows with facts slots. */
  rowFacts: Array<number[] | null>;
  /** The low-tier block after the truth ('' when none) and where it starts. */
  lowTier: string;
  lowTierStart: number;
  /** Where the timeline text starts after TIMELINE_SEPARATOR; -1 when the page shows no timeline. */
  timelineByte: number;
  totalBytes: number;
  newlines: number;
  overlay: FenceChunkOverlay | undefined;
}

export interface BodyRangeRequest {
  pageId: number;
  /** Default: the live generation. */
  generation?: number;
  space: BodySpace;
  /** Bytes in that space, [start, end); `end` may be Infinity. */
  start: number;
  end: number;
  audience: BodyAudience;
  /** Rows of one region only (the low-tier block counts as truth; TIMELINE_SEPARATOR as neither). */
  region?: BodyRegion;
  /** An opened body (openSegmentedBody), reused across reads. */
  body?: SegmentedBody;
  /** The page's ledger when the caller read a snapshot; else loaded. */
  ledger?: BodyLedger;
  /** The authorization this read follows (openSegmentedBody). */
  pin?: BodyPin;
}

export interface BodyRangePiece {
  bytes: Buffer;
  /** Stored-stream byte the piece stands at (for a token or a facts table, its region's start). */
  storedStart: number;
  /** Byte of the piece in the read projection (the trusted body: equal to storedStart). */
  projectedStart: number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const HEAVY_BATCH = 64;

/**
 * @internal Manifest rows a read visits (`visits`): each row a range read, a block walk or a layout pass looks at, for
 * the linearity test. A pass that filters the whole manifest per block visits rows x blocks; one walk visits each row
 * a bounded number of times. Counts, not time.
 */
export const bodyRowWork = { visits: 0 };
const toJson = (v: unknown) => typeof v === 'string' ? JSON.parse(v) as unknown : v;
const bytesOf = (v: unknown): Uint8Array => { const b = v as Uint8Array; return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
const newlines = (s: string) => { let n = 0; for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++; return n; };

/** The page row a pin was taken at: same revision and, when pinned, the same body generation. */
async function checkPin(pin: BodyPin, page: Record<string, unknown> | undefined, pageId: number): Promise<void> {
  const revision = page?.revision == null ? REVISION_BACKFILL_PENDING : String(page.revision);
  if (!page || revision !== pin.revision || (pin.generation !== undefined && Number(page.body_generation) !== pin.generation)) {
    const slug = page?.slug == null ? String(pageId) : String(page.slug);
    throw opError('revision_changed', `Page ${slug} changed after this read was authorized; nothing from the read was returned.`,
      "Read the page again: get_page body: 'none' returns its current revision, then read the window or outline you wanted.",
      { legacy_error: 'invalid_params', detail: JSON.stringify({ page_id: pageId }) });
  }
  await pin.admit?.();
}

/** A generation's manifest rows, each carrying the generation read (`generation` null: the page's live one at the statement). */
function manifestRows(engine: BrainEngine, pageId: number, generation: number | null): Promise<Record<string, unknown>[]> {
  return engine.executeRaw<Record<string, unknown>>(`SELECT m.seq, m.occurrence_id, m.region, m.sha256, m.byte_start, m.byte_len,
      m.line_start, m.line_count, m.static_proj_bytes, m.static_proj_lines, jsonb_array_length(m.outline) AS outline_count,
      jsonb_array_length(m.facts_slots) > 0 AS has_facts, m.date_min IS NOT NULL AS has_date, g.generation
    FROM (SELECT COALESCE($2::bigint, (SELECT body_generation FROM pages WHERE id=$1)) AS generation) g
    JOIN page_body_manifest m ON m.page_id=$1 AND m.staging_id IS NULL AND m.gen_from<=g.generation AND (m.gen_to IS NULL OR m.gen_to>g.generation)
    ORDER BY m.seq`, [pageId, generation]);
}

/**
 * Open a segmented body. With `pin` the read is the authorized one: the page must still be at the pinned revision (and
 * generation), the caller's admission is re-run, and the rows read are that generation's.
 *
 * The page row, the manifest rows and (given `expect`, the slug and source the caller already holds) the ledger are
 * read at once: rows read for another generation than the page row names (a body published between the statements)
 * are read again, and a ledger read under a name the page row does not carry is read again under its own.
 */
export async function openSegmentedBody(engine: BrainEngine, opts: { pageId: number; generation?: number; ledger?: BodyLedger; pin?: BodyPin;
  expect?: { slug: string; sourceId: string } }): Promise<SegmentedBody> {
  const requested = opts.pin?.generation ?? opts.generation ?? null;
  const [[page], read, expected] = await Promise.all([
    engine.executeRaw<Record<string, unknown>>(`SELECT id, source_id, slug, body_storage, body_generation, body_bytes, body_lines, truth_bytes,
      body_flags, segmenter_version, knowledge_revision::text AS revision FROM pages WHERE id=$1`, [opts.pageId]),
    manifestRows(engine, opts.pageId, requested),
    opts.ledger || !opts.expect ? undefined : readBodyLedger(engine, opts.expect.sourceId, opts.expect.slug),
  ]);
  if (opts.pin) await checkPin(opts.pin, page, opts.pageId);
  const generation = requested ?? Number(page?.body_generation);
  // An earlier generation (a segmented version) keeps its manifest rows after the page was demoted to inline storage.
  if (!page || (page.body_storage !== 'segmented' && generation === Number(page.body_generation))) throw new Error(`Page ${opts.pageId} is not a segmented page.`);
  const rows = requested === null && Number(read[0]?.generation) !== generation ? await manifestRows(engine, opts.pageId, generation) : read;
  const slug = String(page.slug);
  const sourceId = String(page.source_id);
  const bodyRows = rows.map(r => ({
    seq: Number(r.seq), occurrenceId: Number(r.occurrence_id), region: r.region as BodyRegion, sha256: bytesOf(r.sha256),
    byteStart: Number(r.byte_start), byteLen: Number(r.byte_len), lineStart: Number(r.line_start), lineCount: Number(r.line_count), staticProjBytes: Number(r.static_proj_bytes),
    staticProjLines: Number(r.static_proj_lines), outlineCount: Number(r.outline_count), hasFacts: r.has_facts === true, hasDate: r.has_date === true,
  }));
  assertRowsTile(bodyRows, { slug, sourceId, total: await generationBodyBytes(engine, { id: opts.pageId, body_generation: page.body_generation, body_bytes: page.body_bytes }, generation) });
  const ledger = opts.ledger ?? (expected && opts.expect!.slug === slug && opts.expect!.sourceId === sourceId ? expected : await readBodyLedger(engine, sourceId, slug));
  return {
    pageId: opts.pageId, sourceId, slug, generation, bodyBytes: Number(page.body_bytes ?? 0), bodyLines: Number(page.body_lines ?? 0), truthBytes: Number(page.truth_bytes ?? 0),
    flags: (toJson(page.body_flags) ?? {}) as JsonObject, ledger, stale: Number(page.segmenter_version) !== SEGMENTER_VERSION, ...(opts.pin ? { pin: opts.pin } : {}),
    rows: bodyRows,
  };
}

/** After a pinned read, before its text is returned: the page is still at the pin and still admits the caller. */
export async function confirmBodyPin(engine: BrainEngine, body: SegmentedBody): Promise<void> {
  if (!body.pin) return;
  const [page] = await engine.executeRaw<Record<string, unknown>>('SELECT slug, body_generation, knowledge_revision::text AS revision FROM pages WHERE id=$1', [body.pageId]);
  await checkPin(body.pin, page, body.pageId);
}

interface LoadedSegment {
  row: BodyRow;
  bytes: Uint8Array;
  entryState: unknown;
  protectedRegions: StoredRegion[];
  /** The text's sha256 is not the row's. */
  mismatch: boolean;
}

/** The rows' texts and JSON metadata, one text at a time (metadata in batches, read alongside the batch's first text). */
async function* loadSegments(engine: BrainEngine, body: SegmentedBody, rows: readonly BodyRow[], stop?: () => void): AsyncIterable<LoadedSegment> {
  const readText = (row: BodyRow) => { stop?.(); return engine.readSegmentTexts(body.sourceId, [row.sha256]); };
  for (let at = 0; at < rows.length; at += HEAVY_BATCH) {
    const batch = rows.slice(at, at + HEAVY_BATCH);
    const [first, metaRows] = await Promise.all([readText(batch[0]!), engine.executeRaw<Record<string, unknown>>(`SELECT occurrence_id, entry_state, protected_regions
      FROM page_body_manifest WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[]) AND staging_id IS NULL AND gen_from<=$3 AND (gen_to IS NULL OR gen_to>$3)`,
    [body.pageId, batch.map(r => r.occurrenceId), body.generation])]);
    const meta = new Map(metaRows.map(m => [Number(m.occurrence_id), m]));
    for (const [i, row] of batch.entries()) {
      const m = meta.get(row.occurrenceId);
      const bytes = (i === 0 ? first : await readText(row)).get(Buffer.from(row.sha256).toString('hex'));
      if (!m || bytes === undefined) throw projectionStaleError(row.byteStart, 'its manifest row or text is missing');
      yield {
        row, bytes, entryState: toJson(m.entry_state), protectedRegions: (toJson(m.protected_regions) ?? []) as StoredRegion[],
        mismatch: !createHash('sha256').update(bytes).digest().equals(Buffer.from(row.sha256)),
      };
    }
  }
}

function overlaidText(engine: BrainEngine, body: SegmentedBody, seg: LoadedSegment, raw: string, view: 'read' | 'trusted'): Promise<string> {
  return overlaySegmentText(engine, body.ledger, { sourceId: body.sourceId, byteStart: seg.row.byteStart, entryState: seg.entryState }, raw, view);
}

/** The fence overlay for a segment: the page's (layout), plus the rows of fence blocks outside its facts slots. */
async function segmentOverlay(engine: BrainEngine, body: SegmentedBody, seg: LoadedSegment, text: string, base: FenceChunkOverlay | undefined) {
  if (seg.row.hasFacts || !text.includes('gbrain:facts:begin')) return base;
  const extra = await loadFenceChunkOverlay(engine, { sourceId: body.sourceId, slug: body.slug, compiled_truth: fenceBlockText(text) });
  if (!extra) return base;
  if (!base) return extra;
  return { omit: new Set([...base.omit, ...extra.omit]), demote: new Map([...base.demote, ...extra.demote]),
    unconfirmed: new Set([...(base.unconfirmed ?? []), ...(extra.unconfirmed ?? [])]) };
}

function fenceBlockText(text: string): string {
  return withdrawalFenceBlocks(text).map(b => text.slice(b.start, b.end)).join('\n');
}

async function projectLoaded(engine: BrainEngine, body: SegmentedBody, seg: LoadedSegment, overlay: FenceChunkOverlay | undefined): Promise<SegmentProjection> {
  const raw = utf8.decode(seg.bytes);
  const text = await overlaidText(engine, body, seg, raw, 'read');
  return projectSegment({ region: seg.row.region, bytes: seg.bytes, byteStart: seg.row.byteStart, lineStart: seg.row.lineStart, entryState: seg.entryState,
    protectedRegions: seg.protectedRegions, fenceTrust: regionTrust(body.flags, seg.row.region) },
  { text, fenceOverlay: await segmentOverlay(engine, body, seg, text, overlay), stale: body.stale || seg.mismatch });
}

interface RowSummary { bytes: number; newlines: number; facts: number[]; lowTier: FenceLowTierRow[]; blank: boolean }

function summarize(p: SegmentProjection): RowSummary {
  let bytes = 0, lines = 0, blank = true;
  for (const piece of p.pieces) {
    bytes += Buffer.byteLength(piece.text, 'utf8');
    lines += newlines(piece.text);
    if (blank && piece.text.trim()) blank = false;
  }
  return { bytes, newlines: lines, facts: p.factsBytes, lowTier: p.lowTier, blank };
}

/**
 * Where each row sits in the read projection. Reads only the segments with facts slots (twice when the page's fence
 * overlay is not empty: its world rows decide the overlay), plus, when no stored sum says so, timeline segments until
 * one shows text.
 */
export async function projectedLayout(engine: BrainEngine, body: SegmentedBody): Promise<ProjectedLayout> {
  if (body.layout) return body.layout;
  const factsRows = body.rows.filter(r => r.hasFacts);
  const summaries = new Map<number, RowSummary>();
  const blocks: string[] = [];
  for await (const seg of loadSegments(engine, body, factsRows)) {
    const text = await overlaidText(engine, body, seg, utf8.decode(seg.bytes), 'read');
    blocks.push(fenceBlockText(text));
    summaries.set(seg.row.seq, summarize(await projectLoaded(engine, body, seg, undefined)));
  }
  const overlay = blocks.length ? await loadFenceChunkOverlay(engine, { sourceId: body.sourceId, slug: body.slug, compiled_truth: blocks.join('\n') }) : undefined;
  if (overlay) for await (const seg of loadSegments(engine, body, factsRows)) summaries.set(seg.row.seq, summarize(await projectLoaded(engine, body, seg, overlay)));

  const n = body.rows.length;
  const layout: ProjectedLayout = { rowStart: new Array(n).fill(-1), rowBytes: new Array(n).fill(0), rowNewlines: new Array(n).fill(0),
    rowFacts: new Array(n).fill(null), lowTier: '', lowTierStart: 0, timelineByte: -1, totalBytes: 0, newlines: 0, overlay };
  let pos = 0, lines = 0;
  const place = (i: number) => {
    const row = body.rows[i]!;
    const s = summaries.get(row.seq);
    layout.rowStart[i] = pos;
    layout.rowBytes[i] = s?.bytes ?? row.staticProjBytes;
    layout.rowNewlines[i] = s?.newlines ?? row.staticProjLines;
    layout.rowFacts[i] = s?.facts ?? null;
    pos += layout.rowBytes[i]!;
    lines += layout.rowNewlines[i]!;
  };
  body.rows.forEach((row, i) => { if (row.region === 'truth') place(i); });
  const low = (region: BodyRegion) => body.rows.filter(r => r.region === region).flatMap(r => summaries.get(r.seq)?.lowTier ?? []);
  layout.lowTier = [...renderFenceLowTier(low('truth')), ...renderFenceLowTier(low('timeline'))]
    .map(({ tier, unconfirmed, body: text }) => '\n\n' + markFenceChunk(tier, credentialSafeProjection(sanitizeRemoteBody(text)), unconfirmed)).join('');
  layout.lowTierStart = pos;
  pos += Buffer.byteLength(layout.lowTier, 'utf8');
  lines += newlines(layout.lowTier);
  if (await timelineVisible(engine, body, summaries)) {
    pos += Buffer.byteLength(TIMELINE_SEPARATOR, 'utf8');
    lines += newlines(TIMELINE_SEPARATOR);
    layout.timelineByte = pos;
    body.rows.forEach((row, i) => { if (row.region === 'timeline') place(i); });
  }
  layout.totalBytes = pos;
  layout.newlines = lines;
  body.layout = layout;
  return layout;
}

/** projectPageText shows the timeline only when its projection holds non-whitespace text. */
async function timelineVisible(engine: BrainEngine, body: SegmentedBody, summaries: Map<number, RowSummary>): Promise<boolean> {
  for (const row of body.rows) {
    if (row.region !== 'timeline') continue;
    const known = summaries.get(row.seq);
    if (known) { if (!known.blank) return true; continue; }
    if (row.staticProjBytes === 0) continue;
    if (row.hasDate || row.outlineCount > 0) return true;
    for await (const seg of loadSegments(engine, body, [row])) if (!summarize(await projectLoaded(engine, body, seg, undefined)).blank) return true;
  }
  return false;
}

/** Projected totals for `body: 'none'` and window metadata: bytes, lines (as window.ts totalLines counts them), timeline start. */
export async function projectedTotals(engine: BrainEngine, body: SegmentedBody): Promise<{ total_bytes: number; total_lines: number; timeline_byte_start: number }> {
  const layout = await projectedLayout(engine, body);
  let last = '';
  if (layout.totalBytes > 0) {
    for await (const piece of readBodyRange(engine, { pageId: body.pageId, space: 'projected', start: layout.totalBytes - 1, end: layout.totalBytes, audience: 'remote', body })) last = piece.bytes.toString('latin1');
  }
  const lines = layout.totalBytes === 0 ? 0 : layout.newlines + (last.endsWith('\n') ? 0 : 1);
  return { total_bytes: layout.totalBytes, total_lines: lines, timeline_byte_start: layout.timelineByte };
}

export type ProjectedUnit = { kind: 'row'; index: number; start: number } | { kind: 'text'; text: string; start: number; storedStart: number; region: BodyRegion | null };
type Unit = ProjectedUnit;

/** The read projection's parts in document order: truth rows, the low-tier block, the separator, timeline rows. */
export function projectedUnits(body: SegmentedBody, layout: ProjectedLayout): Unit[] {
  const out: Unit[] = [];
  body.rows.forEach((row, i) => { if (row.region === 'truth') out.push({ kind: 'row', index: i, start: layout.rowStart[i]! }); });
  if (layout.lowTier) out.push({ kind: 'text', text: layout.lowTier, start: layout.lowTierStart, storedStart: body.truthBytes, region: 'truth' });
  if (layout.timelineByte >= 0) {
    out.push({ kind: 'text', text: TIMELINE_SEPARATOR, start: layout.timelineByte - Buffer.byteLength(TIMELINE_SEPARATOR, 'utf8'), storedStart: body.truthBytes, region: null });
    body.rows.forEach((row, i) => { if (row.region === 'timeline') out.push({ kind: 'row', index: i, start: layout.rowStart[i]! }); });
  }
  return out;
}

/**
 * Whether text the read projection hides or rewrites starts before `end` (read-view bytes, or stored bytes): a row whose
 * projection is not its stored bytes or that holds facts, the low-tier block, or (stored) a timeline the view omits.
 * Stored offsets past such text would measure it for a remote caller (get_page edit_target, edit_page `within`).
 */
export async function hiddenBefore(engine: BrainEngine, body: SegmentedBody, end: number, space: 'projected' | 'stored'): Promise<boolean> {
  const layout = await projectedLayout(engine, body);
  if (space === 'stored' && layout.timelineByte < 0 && body.bodyBytes > body.truthBytes && end > body.truthBytes) return true;
  return projectedUnits(body, layout).some(u => (space === 'projected' ? u.start : u.kind === 'row' ? body.rows[u.index]!.byteStart : u.storedStart) < end
    && (u.kind === 'text' ? u.text !== TIMELINE_SEPARATOR : layout.rowBytes[u.index] !== body.rows[u.index]!.byteLen || body.rows[u.index]!.hasFacts));
}

const unitBytes = (u: Unit, layout: ProjectedLayout) => u.kind === 'row' ? layout.rowBytes[u.index]! : Buffer.byteLength(u.text, 'utf8');

/** One segment of the trusted body: its row, its stored bytes and entry state, and its text after the withdrawal overlay in pieces. */
export interface TrustedSegment {
  row: BodyRow;
  raw: Uint8Array;
  entryState: unknown;
  pieces: ProjectedPiece[];
}

/** The longest run of segments joined across forced cuts that a pass holds as one string. */
export const BLOCK_MAX_BYTES = 8 * SEGMENT_MAX_BYTES;

/** `page_body_segmented`: a run a derived pass must read whole is over BLOCK_MAX_BYTES. */
export function blockTooLargeError(slug: string, sourceId: string, bytes: number) {
  return opError('page_body_segmented',
    `Page ${slug} (source ${sourceId}) has a ${bytes}-byte run a derived pass must read whole (a line or fence longer than a segment), over its ${BLOCK_MAX_BYTES}-byte bound. Nothing was derived from it.`,
    'Break the long line or fence into shorter lines and write the page again.');
}

/** `page_body_segmented`: a facts fence a withdrawal must read whole is longer than FENCE_MAX_BYTES (limits.ts). */
export function fenceTooLargeError(slug: string, sourceId: string, bytes: number) {
  return opError('page_body_segmented',
    `Page ${slug} (source ${sourceId}) has a facts fence of at least ${bytes} bytes, over the ${FENCE_MAX_BYTES}-byte bound a withdrawal reads a fence whole within. Nothing was read from it.`,
    'Split the facts fence into fences under the bound and write the page again.');
}

const MARKER_CARRY_MAX = Math.max(FACTS_FENCE_BEGIN.length, FACTS_FENCE_END.length) - 1;
/** The end of `text` that begins a facts marker without completing it: the bytes of a marker a forced cut splits. */
export function markerCarry(text: string): string {
  for (let k = Math.min(text.length, MARKER_CARRY_MAX); k > 0; k--) {
    const tail = text.slice(-k);
    if (FACTS_FENCE_BEGIN.startsWith(tail) || FACTS_FENCE_END.startsWith(tail)) return tail;
  }
  return '';
}

/**
 * The stored text of the facts fence a forced cut splits that begins at stored byte `openStart` of `region` (its slots'
 * `open_start`): read from the live segments one at a time, from the one holding its opener (one that records no slot
 * of it when the cut fell inside the opener) through its end marker, or to the region's end for a fence that never
 * closes. A fence longer than FENCE_MAX_BYTES, counted from its begin marker, refuses before more is read.
 */
export async function readStoredFence(engine: Pick<BrainEngine, 'readManifest' | 'readSegmentTexts'>, page: { id: number; slug: string; sourceId: string }, region: BodyRegion, openStart: number): Promise<string> {
  const end = Buffer.from(FACTS_FENCE_END, 'utf8');
  const parts: Buffer[] = [];
  let bytes = 0;
  for (const row of await engine.readManifest(page.id, { region })) {
    if (row.byteStart + row.byteLen <= openStart) continue;
    const sha = Buffer.from(row.sha256).toString('hex');
    const text = (await engine.readSegmentTexts(page.sourceId, [row.sha256])).get(sha);
    if (!text) throw new Error(`Segment text ${sha} of page ${page.id} is missing.`);
    const part = Buffer.from(text).subarray(Math.max(0, openStart - row.byteStart));
    const seam = Buffer.concat([...parts.slice(-1).map(p => p.subarray(Math.max(0, p.length - end.length + 1))), part]);
    const at = seam.indexOf(end);
    const seamStart = bytes - (seam.length - part.length);
    parts.push(part);
    bytes += part.length;
    const fenceBytes = at === -1 ? bytes : seamStart + at + end.length;
    if (fenceBytes > FENCE_MAX_BYTES) throw fenceTooLargeError(page.slug, page.sourceId, fenceBytes);
    if (at !== -1) return Buffer.concat(parts).subarray(0, fenceBytes).toString('utf8');
  }
  return Buffer.concat(parts).toString('utf8');
}

/**
 * The trusted body of `rows` (rows of `body`, in order), one segment at a time: what readBodyRange's trusted stored read
 * cuts. Under a ledger that applies, a facts fence block cannot be overlaid in pieces, so the segments a block spans,
 * and a segment that ends inside a facts marker (a marker a forced cut splits) with the next one, are joined, overlaid
 * whole and yielded as one segment covering their rows, as withdrawal discovery and rewriteLiveSegmentedFences join
 * them. A fence longer than FENCE_MAX_BYTES, counted from its begin marker through its end marker, refuses with
 * `page_body_segmented`; a read that starts inside a block (a range after its start) refuses with `page_projection_stale`.
 * `stop` is called before each segment text is read; it throws to end the read there.
 */
export async function* trustedSegments(engine: BrainEngine, body: SegmentedBody, rows: readonly BodyRow[], stop?: () => void): AsyncIterable<TrustedSegment> {
  const emit = async (segs: LoadedSegment[]): Promise<TrustedSegment> => {
    const first = segs[0]!;
    const bytes = segs.length === 1 ? first.bytes : Buffer.concat(segs.map(seg => seg.bytes));
    const row = segs.length === 1 ? first.row : { ...first.row, byteLen: bytes.length, lineCount: segs.reduce((n, seg) => n + seg.row.lineCount, 0) };
    const raw = utf8.decode(bytes);
    return { row, raw: bytes, entryState: first.entryState, pieces: overlaidPieces(raw, await overlaidText(engine, body, { ...first, row }, raw, 'trusted')) };
  };
  if (!ledgerApplies(body.ledger)) {
    for await (const seg of loadSegments(engine, body, rows, stop)) yield await emit([seg]);
    return;
  }
  const bound = (bytes: number) => { if (bytes > FENCE_MAX_BYTES) throw fenceTooLargeError(body.slug, body.sourceId, bytes); };
  let held: LoadedSegment[] = [];
  // After the held segments: whether a fence block is open, the marker bytes they end with, and where the open block begins.
  let open = false, carry = '', openAt = 0;
  for await (const seg of loadSegments(engine, body, rows, stop)) {
    if (held.length && !open && !carry) { yield await emit(held); held = []; }
    if (!held.length) { open = readEntryState(seg.entryState)?.withdrawal.open === true; carry = ''; openAt = seg.row.byteStart; }
    held.push(seg);
    const text = carry + utf8.decode(seg.bytes);
    const base = seg.row.byteStart - Buffer.byteLength(carry, 'utf8');
    const { head, tail } = partialFenceRuns(text, open);
    if (open && head > 0) bound(base + Buffer.byteLength(text.slice(0, head), 'utf8') - openAt);
    const carried = open && head === 0;
    open = tail < text.length;
    if (open && !carried) openAt = base + Buffer.byteLength(text.slice(0, tail), 'utf8');
    if (open) bound(seg.row.byteStart + seg.row.byteLen - openAt);
    carry = markerCarry(text);
  }
  if (held.length) yield await emit(held);
}

export async function* readBodyRange(engine: BrainEngine, req: BodyRangeRequest): AsyncIterable<BodyRangePiece> {
  if (!(req.start >= 0) || !(req.end >= req.start) || !Number.isInteger(req.start) || (!Number.isInteger(req.end) && req.end !== Infinity)) {
    throw new Error(`readBodyRange: [${req.start}, ${req.end}) is not a byte range.`);
  }
  if (req.end === req.start) return;
  const body = req.body ?? await openSegmentedBody(engine, req);
  if (req.space === 'projected') return yield* projectedRange(engine, body, req);
  bodyRowWork.visits += body.rows.length;
  const indices = body.rows.flatMap((r, i) => (!req.region || r.region === req.region) && r.byteStart < req.end && r.byteStart + r.byteLen > req.start ? [i] : []);
  const rows = indices.map(i => body.rows[i]!);
  if (req.audience === 'trusted') {
    for await (const seg of trustedSegments(engine, body, rows)) {
      for (const piece of seg.pieces) {
        const cut = cutStored(piece, seg.row.byteStart, req.start, req.end);
        if (cut) yield { bytes: cut.bytes, storedStart: cut.storedStart, projectedStart: cut.storedStart };
      }
    }
    return;
  }
  const layout = await projectedLayout(engine, body);
  let k = 0;
  for await (const seg of loadSegments(engine, body, rows)) {
    let doc = layout.rowStart[indices[k++]!]!;
    if (doc < 0) continue;
    for (const piece of (await projectLoaded(engine, body, seg, layout.overlay)).pieces) {
      const cut = cutStored(piece, seg.row.byteStart, req.start, req.end);
      if (cut) yield { bytes: cut.bytes, storedStart: cut.storedStart, projectedStart: doc + cut.offset };
      doc += Buffer.byteLength(piece.text, 'utf8');
    }
  }
}

/** The part of a piece inside stored range [start, end): linear text byte for byte, anything else whole. */
function cutStored(piece: ProjectedPiece, base: number, start: number, end: number): { bytes: Buffer; storedStart: number; offset: number } | null {
  const s = base + piece.rawStart;
  const e = base + piece.rawEnd;
  if (!(e > start && s < end) && !(s === e && s >= start && s < end)) return null;
  const bytes = Buffer.from(piece.text, 'utf8');
  if (!piece.linear) return { bytes, storedStart: s, offset: 0 };
  const from = Math.max(start, s) - s;
  return { bytes: bytes.subarray(from, Math.min(end, e) - s), storedStart: s + from, offset: from };
}

async function* projectedRange(engine: BrainEngine, body: SegmentedBody, req: BodyRangeRequest): AsyncIterable<BodyRangePiece> {
  const layout = await projectedLayout(engine, body);
  const units = projectedUnits(body, layout);
  bodyRowWork.visits += units.length;
  const wanted = units.filter(u => {
    const region = u.kind === 'row' ? body.rows[u.index]!.region : u.region;
    return (!req.region || region === req.region) && u.start < req.end && u.start + unitBytes(u, layout) > req.start;
  });
  const rows = wanted.flatMap(u => u.kind === 'row' ? [body.rows[u.index]!] : []);
  const segments = loadSegments(engine, body, rows)[Symbol.asyncIterator]();
  for (const u of wanted) {
    if (u.kind === 'text') {
      const bytes = Buffer.from(u.text, 'utf8');
      const from = Math.max(req.start, u.start) - u.start;
      yield { bytes: bytes.subarray(from, Math.min(req.end, u.start + bytes.length) - u.start), storedStart: u.storedStart, projectedStart: u.start + from };
      continue;
    }
    const next = await segments.next();
    if (next.done) return;
    let doc = u.start;
    for (const piece of (await projectLoaded(engine, body, next.value, layout.overlay)).pieces) {
      const bytes = Buffer.from(piece.text, 'utf8');
      const from = Math.max(req.start, doc) - doc;
      const to = Math.min(req.end, doc + bytes.length) - doc;
      if (to > from) {
        const storedStart = next.value.row.byteStart + piece.rawStart + (piece.linear ? from : 0);
        yield { bytes: bytes.subarray(from, to), storedStart, projectedStart: doc + from };
      }
      doc += bytes.length;
      if (doc >= req.end) break;
    }
  }
}

/** The projected byte where 1-based line `line` starts (totalBytes past the last line); reads at most one segment. */
export async function projectedLineStart(engine: BrainEngine, body: SegmentedBody, line: number): Promise<number> {
  const layout = await projectedLayout(engine, body);
  let want = line - 1;
  if (want <= 0) return 0;
  for (const u of projectedUnits(body, layout)) {
    const count = u.kind === 'row' ? layout.rowNewlines[u.index]! : newlines(u.text);
    if (want > count) { want -= count; continue; }
    let text = '';
    if (u.kind === 'text') text = u.text;
    else for await (const piece of readBodyRange(engine, { pageId: body.pageId, space: 'projected', start: u.start, end: u.start + layout.rowBytes[u.index]!, audience: 'remote', body })) text += piece.bytes.toString('utf8');
    let at = -1;
    for (let k = 0; k < want; k++) { at = text.indexOf('\n', at + 1); if (at === -1) return u.start + Buffer.byteLength(text, 'utf8'); }
    return u.start + Buffer.byteLength(text.slice(0, at + 1), 'utf8');
  }
  return layout.totalBytes;
}

export interface BodyOutlineEntry { heading: string; level: number; byte_start: number; region: BodyRegion }

/**
 * The stored outline (headings of each segment's static projection outside code fences and protected regions, at
 * most OUTLINE_MAX_HEADINGS per segment), paged by entry index: reads the metadata of the rows the page covers, no
 * segment text. Offsets are read-projection bytes; line numbers are not stored.
 */
export async function projectedOutline(engine: BrainEngine, body: SegmentedBody, from: number, limit: number):
  Promise<{ entries: BodyOutlineEntry[]; total_entries: number; from_index: number; next_from_index?: number }> {
  const layout = await projectedLayout(engine, body);
  const visible = body.rows.map((row, i) => ({ row, i })).filter(({ i }) => layout.rowStart[i]! >= 0)
    .sort((a, b) => layout.rowStart[a.i]! - layout.rowStart[b.i]!);
  const total = visible.reduce((n, v) => n + v.row.outlineCount, 0);
  const entries: BodyOutlineEntry[] = [];
  const needed: typeof visible = [];
  let index = 0;
  for (const v of visible) {
    if (index + v.row.outlineCount > from && index < from + limit) needed.push(v);
    index += v.row.outlineCount;
  }
  const meta = needed.length ? new Map((await engine.executeRaw<Record<string, unknown>>(`SELECT occurrence_id, facts_slots, outline FROM page_body_manifest
    WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[]) AND staging_id IS NULL AND gen_from<=$3 AND (gen_to IS NULL OR gen_to>$3)`,
  [body.pageId, needed.map(v => v.row.occurrenceId), body.generation])).map(m => [Number(m.occurrence_id), m])) : new Map();
  index = 0;
  let next = 0;
  for (const v of visible) {
    const m = needed.includes(v) ? meta.get(v.row.occurrenceId) : undefined;
    if (!m) { index += v.row.outlineCount; continue; }
    const slots = (toJson(m.facts_slots) ?? []) as FactsSlot[];
    const facts = layout.rowFacts[v.i] ?? [];
    for (const h of (toJson(m.outline) ?? []) as OutlineHeading[]) {
      if (index >= from && entries.length < limit) {
        let byte = layout.rowStart[v.i]! + h.proj_byte;
        slots.forEach((slot, k) => { if (slot.proj_byte <= h.proj_byte) byte += facts[k] ?? 0; });
        entries.push({ heading: h.text, level: h.level, byte_start: byte, region: v.row.region });
        next = index + 1;
      }
      index++;
    }
  }
  return { entries, total_entries: total, from_index: from, ...(next < total && entries.length ? { next_from_index: next } : {}) };
}
