import type { BrainEngine } from '../engine.ts';
import { isQuarantined } from '../quarantine.ts';
import type { ParsedPage } from '../import-file.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { pipelined } from '../page-state/transactions.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence } from '../takes-fence.ts';
import { extractFactsFromFenceText } from '../facts/extract-from-fence.ts';
import { takesPreparation } from '../takes-write.ts';
import { parseTimelineEntries } from '../link-extraction.ts';
import { eachStoredTimelineRow, extractTimelineFromContent, hasExtractorDetail, supersededCitationTimeline, TimelineKeySet,
  type ExtractedTimelineEntry } from '../timeline-extract.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { sanitizeForJsonb } from '../batch-rows.ts';
import { bodyUnread } from '../page-body/page-shape.ts';
import { bodyBlocks, detachedValue } from '../page-body/segment-blocks.ts';
import { TakesFenceScan } from '../page-body/segment-takes.ts';
import type { BodyRegion } from '../page-body/types.ts';
import { createHash } from 'node:crypto';
import { materializedMarker, materializedMarkerHash, timelineKey, timelineKeyHash } from '../timeline-marker.ts';
import type { OperationError } from '../ops/contract.ts';
import { protectedRegions } from '../fence-scan.ts';
import { FENCE_ROWS_MAX, fenceOperationError, scanCanonicalFences } from '../fence-repair/refusal.ts';
import type { FenceSection } from '../fence-repair/types.ts';
import { contestHeldRows, factsAboveWriter, guardFenceRows, guardFenceTakes, heldRows } from '../trust/fence-guard.ts';
import { propagateFactLowering } from '../trust/propagation.ts';
import { loadWriteGateConfig } from '../trust/gate-outcomes.ts';

const FENCE_PAIRS=[{begin:FACTS_FENCE_BEGIN,end:FACTS_FENCE_END},{begin:TAKES_FENCE_BEGIN,end:TAKES_FENCE_END}];

/**
 * Rows held by fences whose begin sits in markdown code, keyed `row_num:text`,
 * with the section each sits in. Readers treat such a fence as an example and
 * project nothing from it, so a real fence wrapped in code would silently
 * delete the rows it holds.
 */
function quotedFenceRows(fields:Array<[FenceSection,string]>):{facts:Map<string,FenceSection>,takes:Map<string,FenceSection>} {
  const facts=new Map<string,FenceSection>(),takes=new Map<string,FenceSection>();
  for(const [section,field] of fields) for(const region of protectedRegions(field,FENCE_PAIRS).regions) {
    if(region.read) continue;
    const text=field.slice(region.start,region.end);
    if(region.pair===0) for(const f of parseFactsFence(text).facts) facts.set(`${f.rowNum}:${f.claim}`,section);
    else for(const t of parseTakesFence(text).takes) takes.set(`${t.rowNum}:${t.claim}`,section);
  }
  return {facts,takes};
}

type CanonicalBody = Pick<ParsedPage, 'compiled_truth' | 'timeline'>;

/**
 * The caller's authority over the prior canonical content (#5567):
 * `editing` writers are bound to the observed revision and render from the
 * database, `preserving` writers regenerate or overwrite without that binding,
 * `file` writers import file edits bound to the file preimage and never
 * rewrite the user's file, and `immutable` imports publish approved bytes they
 * may never extend.
 */
export type ProjectionWriter = 'editing' | 'preserving' | 'file' | 'immutable';

/**
 * How one stored timeline row relates to the write, judged at preparation:
 * `in_body` exactly matches a new bullet, `drifted` matches one only after
 * normalization, `removed` / `removed_marked` had an unmarked / materialized
 * bullet in the prior body that the new body dropped, `superseded` is what
 * the citation reading before #6226 filed for a citation either body still
 * or once carried (with no detail beyond what the extractor writes) and the
 * current reading replaces, `superseded_annotated` is such a row someone gave
 * its own detail, and `database_only` has no bullet in either body.
 */
export type TimelineRowState = 'in_body' | 'drifted' | 'removed' | 'removed_marked' | 'superseded' | 'superseded_annotated' | 'database_only';
export type TimelineRowAction = 'refresh_detail' | 'delete' | 'keep' | 'materialize';

/**
 *   row state      | editing        | preserving     | file           | immutable
 *   ---------------+----------------+----------------+----------------+---------------
 *   in_body        | refresh_detail | refresh_detail | refresh_detail | refresh_detail
 *   drifted        | delete         | delete         | delete         | delete
 *   removed        | delete         | delete         | delete         | delete
 *   removed_marked | delete         | materialize    | delete         | keep
 *   superseded     | delete         | delete         | delete         | delete
 *   superseded_ann.| keep           | keep           | keep           | keep
 *   database_only  | materialize    | materialize    | keep           | keep
 *
 * A coordinated write deletes only rows whose bullet the writer can see in the
 * prior or new body. A materialized bullet is removed only by a writer bound to
 * a revision or file preimage that contained it; a preserving writer renders it
 * again. Writers that render from the database write bullet-less rows back into
 * the page (`materialize`); rows that fail the render round trip, and every
 * `materialize` row a caller did not render, are kept. A superseded row is
 * never written back (it would re-file the older, misdated reading); one
 * carrying its own detail stays in the database only (#6226, taste T3). `put_page` with the
 * current revision is the supported way to delete a materialized row. Deletes
 * and detail refreshes also require the row id and detail pinned at
 * preparation, so rows that change afterwards are left alone.
 */
const TIMELINE_DECISIONS: Record<ProjectionWriter, Record<TimelineRowState, TimelineRowAction>> = {
  editing: { in_body: 'refresh_detail', drifted: 'delete', removed: 'delete', removed_marked: 'delete', superseded: 'delete', superseded_annotated: 'keep', database_only: 'materialize' },
  preserving: { in_body: 'refresh_detail', drifted: 'delete', removed: 'delete', removed_marked: 'materialize', superseded: 'delete', superseded_annotated: 'keep', database_only: 'materialize' },
  file: { in_body: 'refresh_detail', drifted: 'delete', removed: 'delete', removed_marked: 'delete', superseded: 'delete', superseded_annotated: 'keep', database_only: 'keep' },
  immutable: { in_body: 'refresh_detail', drifted: 'delete', removed: 'delete', removed_marked: 'keep', superseded: 'delete', superseded_annotated: 'keep', database_only: 'keep' },
};

/**
 * #5969 (D3): what an ordinary put_page / put_pages body says about its
 * Timeline section (`timeline-omission.ts`); other writers pass none and keep
 * the table above. Only rows the writer saw (`removed`, `removed_marked`)
 * change: an explicitly empty section deletes them for every writer class; a
 * body with no section at all keeps them for a local preserving writer
 * (rendered back like a marked row) and, with `drop_timeline`, deletes them.
 */
export interface TimelineWritePolicy { section: 'present' | 'emptied' | 'omitted'; drop: boolean; preserveOmitted: boolean }

export function timelineRowAction(writer: ProjectionWriter, state: TimelineRowState, policy?: TimelineWritePolicy): TimelineRowAction {
  const action = TIMELINE_DECISIONS[writer][state];
  if (!policy || (state !== 'removed' && state !== 'removed_marked')) return action;
  if (policy.section === 'emptied' || (policy.section === 'omitted' && policy.drop)) return 'delete';
  return policy.section === 'omitted' && policy.preserveOmitted ? 'materialize' : action;
}

function exactTimelineKey(entry: { date: string; source?: string | null; summary: string }): string {
  return JSON.stringify([entry.date.slice(0, 10), sanitizeForJsonb(entry.source ?? ''), sanitizeForJsonb(entry.summary)]);
}

function safeBody(body: CanonicalBody): string {
  return sanitizeRemoteBody([body.compiled_truth, body.timeline ?? ''].join('\n'), { keepMaterializedMarkers: true });
}

function extractTimeline(safe: string, slug: string): Map<string, ExtractedTimelineEntry> {
  const timeline = new Map(extractTimelineFromContent(safe, slug).map(t => [timelineKey(t), t]));
  for (const t of parseTimelineEntries(safe)) timeline.set(timelineKey({ ...t, source: t.source ?? 'markdown' }), { ...t, source: t.source ?? 'markdown', slug });
  return timeline;
}

function canonicalTimeline(body: CanonicalBody, slug: string): Map<string, ExtractedTimelineEntry> {
  return extractTimeline(safeBody(body), slug);
}

/** Tuples of a sanitized text whose bullet is introduced by a marker that still matches it. */
function markedTimeline(safe: string, slug: string, marked = new Set<string>()): Set<string> {
  const lines = safe.split('\n');
  lines.forEach((line, i) => {
    const hash = materializedMarkerHash(line);
    if (!hash || i + 1 >= lines.length) return;
    for (const key of extractTimeline(lines[i + 1], slug).keys()) if (timelineKeyHash(key) === hash) marked.add(key);
  });
  return marked;
}

/** What a body says about timeline rows: its canonical timeline, the tuples a marker still matches, the superseded citation readings. */
interface TimelineView { entries: Map<string, ExtractedTimelineEntry>; marked: Set<string>; superseded: Set<string> }

function timelineView(body: CanonicalBody, slug: string): TimelineView {
  const safe = safeBody(body);
  return { entries: extractTimeline(safe, slug), marked: markedTimeline(safe, slug), superseded: new Set(supersededCitationTimeline(safe).map(t => timelineKey(t))) };
}

/**
 * What a prior body says about the stored rows a write classifies, by the row's index in the rows read and its key:
 * a bullet (`entry`), a bullet a marker still matches (`marked`), a superseded citation reading (`superseded`).
 */
interface PriorRows { entry(i: number, key: string): boolean; marked(i: number, key: string): boolean; superseded(i: number, key: string): boolean }

/** The views a prior snapshot contributes, plus its takes rows per field and whether either field's takes fence warns. */
interface PriorView { rows: PriorRows; takeRows: Set<number>; takesWarn: boolean }

function viewRows(view: TimelineView): PriorRows {
  return { entry: (_, key) => view.entries.has(key), marked: (_, key) => view.marked.has(key), superseded: (_, key) => view.superseded.has(key) };
}

const PRIOR_ENTRY = 1, PRIOR_MARKED = 2, PRIOR_SUPERSEDED = 4;

/**
 * The segmented prior view per snapshot page object, for the stored rows it was asked about (their keys' SHA-256): a
 * write asks for it at preparation, materialization and removal reporting, and each call reads the same revision.
 */
const segmentedPriors = new WeakMap<object, { digest: string; view: PriorView }>();

/**
 * The prior view of a stored segmented page whose body is unread, in one pass block by block (page-body/segment-blocks.ts)
 * and cached for the snapshot (segmentedPriors). Each block is sanitized alone, as the segmenter scans it; every bullet
 * and heading entry and parseTimelineEntries' readings of it count as the body's entries. Only the stored rows asked
 * about are kept, one flag byte each, never the body's entries. A `###` dated entry's detail ends at its block. The
 * takes rows are parsed per field, as canonicalTakeRows does (page-body/segment-takes.ts), in the same pass.
 */
async function segmentedPriorView(engine: BrainEngine, page: { id: number; slug: string; source_id: string }, slug: string, keys: readonly string[]): Promise<PriorView> {
  const digest = createHash('sha256').update(keys.join('\0')).digest('hex');
  const cached = segmentedPriors.get(page);
  if (cached?.digest === digest) return cached.view;
  const index = new Map<string, number[]>();
  keys.forEach((key, i) => { const at = index.get(key); if (at) at.push(i); else index.set(key, [i]); });
  const flags = new Uint8Array(keys.length);
  const mark = (key: string, bit: number) => { for (const i of index.get(key) ?? []) flags[i]! |= bit; };
  const takes = new Map<BodyRegion, TakesFenceScan>((['truth', 'timeline'] as const).map(region => [region, new TakesFenceScan(page)]));
  let region: BodyRegion | null = null;
  let regionAt = 0;
  for await (const block of bodyBlocks(engine, page)) {
    if (block.region && block.region !== region) { region = block.region; regionAt = block.at; }
    if (block.region) takes.get(block.region)!.push({ text: block.text, at: block.at - regionAt });
    const safe = sanitizeRemoteBody(block.text, { keepMaterializedMarkers: true });
    for (const t of extractTimelineFromContent(safe, slug)) mark(timelineKey(t), PRIOR_ENTRY);
    for (const t of parseTimelineEntries(safe)) mark(timelineKey({ ...t, source: t.source ?? 'markdown' }), PRIOR_ENTRY);
    for (const key of markedTimeline(safe, slug)) mark(key, PRIOR_MARKED);
    for (const t of supersededCitationTimeline(safe)) mark(timelineKey(t), PRIOR_SUPERSEDED);
  }
  const fields = [...takes.values()].map(scan => scan.result());
  const view: PriorView = {
    rows: { entry: i => (flags[i]! & PRIOR_ENTRY) !== 0, marked: i => (flags[i]! & PRIOR_MARKED) !== 0, superseded: i => (flags[i]! & PRIOR_SUPERSEDED) !== 0 },
    takeRows: new Set(fields.flatMap(field => field.parsed.takes.map(t => t.rowNum))), takesWarn: fields.some(field => field.parsed.warnings.length > 0),
  };
  segmentedPriors.set(page, { digest, view });
  return view;
}

/** The prior snapshot's view of `rows` (its stored timeline rows): from its strings, or streamed when its segmented body is unread. */
async function priorView(engine: BrainEngine, page: PageSnapshot['page'], slug: string, rows: readonly StoredTimelineRow[]): Promise<PriorView> {
  if (bodyUnread(page)) return segmentedPriorView(engine, page, slug, rows.map(row => timelineKey(row)));
  const fields = [page.compiled_truth, page.timeline ?? ''].map(field => parseTakesFence(field));
  return { rows: viewRows(timelineView(page, slug)),
    takeRows: new Set(fields.flatMap(field => field.takes.map(t => t.rowNum))), takesWarn: fields.some(field => field.warnings.length > 0) };
}

/**
 * The canonical timeline of a segmented body fed one block at a time (`add`), extractTimeline's two passes merged in its
 * order (every bullet and heading entry, then parseTimelineEntries' readings over them). An entry whose timelineKey is in
 * `recorded` (the page's stored rows) is not kept: unrecordedCanonicalTimeline drops it, and once a page is extracted
 * its recorded entries are nearly all of it.
 */
export function segmentedCanonicalCollector(slug: string, recorded?: { has(key: string): boolean }): { add(text: string): void; result(): Map<string, ExtractedTimelineEntry> } {
  const extracted = new Map<string, ExtractedTimelineEntry>();
  const parsed = new Map<string, ExtractedTimelineEntry>();
  return {
    add(text) {
      const safe = sanitizeRemoteBody(text, { keepMaterializedMarkers: true });
      for (const t of extractTimelineFromContent(safe, slug)) {
        const key = timelineKey(t);
        if (!recorded?.has(key)) extracted.set(key, detachedValue(t));
      }
      for (const t of parseTimelineEntries(safe)) {
        const key = timelineKey({ ...t, source: t.source ?? 'markdown' });
        if (!recorded?.has(key)) parsed.set(key, detachedValue({ ...t, source: t.source ?? 'markdown', slug }));
      }
    },
    result() {
      for (const [key, entry] of parsed) extracted.set(key, entry);
      return extracted;
    },
  };
}

/**
 * @internal Work of the managed timeline extraction over a page (`storedRows`: stored rows walked by
 * unrecordedCanonicalTimeline and segmentedCanonicalTimeline; `kept`: canonical entries a segmented body's read kept).
 * Counts, not time.
 */
export const canonicalTimelineWork = { storedRows: 0, kept: 0 };

/**
 * The canonical timeline of a stored segmented page whose body is unread, block by block (segmentedCanonicalCollector),
 * less the entries a stored row of the page records: the rows are walked in pages and held as key digests
 * (TimelineKeySet), so the read keeps what an insert-only caller may add, never every entry the body yields.
 */
async function segmentedCanonicalTimeline(engine: BrainEngine, page: { id: number; slug: string; source_id: string }, slug: string): Promise<Map<string, ExtractedTimelineEntry>> {
  const recorded = new TimelineKeySet();
  await eachStoredTimelineRow(engine, Number(page.id), row => {
    canonicalTimelineWork.storedRows++;
    recorded.add(timelineKey({ date: row.date_text, source: row.source, summary: row.summary }));
  });
  const collector = segmentedCanonicalCollector(slug, recorded);
  for await (const block of bodyBlocks(engine, page)) collector.add(block.text);
  const kept = collector.result();
  canonicalTimelineWork.kept += kept.size;
  return kept;
}

/**
 * The canonical timeline of a stored page (a snapshot's page) for an insert-only caller: a segmented body is read
 * block by block and keeps only entries no stored row records. Read it before a transaction; unrecordedCanonicalTimeline
 * filters it inside one.
 */
export async function storedCanonicalTimeline(engine: BrainEngine, page: PageSnapshot['page'], slug: string): Promise<Map<string, ExtractedTimelineEntry>> {
  return bodyUnread(page) ? segmentedCanonicalTimeline(engine, page, slug) : canonicalTimeline(page, slug);
}

/**
 * Character ranges of materialized timeline history in a raw body: each marker
 * line whose hash matches the bullet after it, that bullet, and its indented
 * detail lines. This is database history written back into the page, not
 * newly authored text.
 */
export function materializedHistoryRanges(body: string): Array<[number, number]> {
  const lines = body.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const ranges: Array<[number, number]> = [];
  lines.forEach((line, i) => {
    const hash = materializedMarkerHash(line);
    if (!hash || i + 1 >= lines.length) return;
    if (![...extractTimeline(lines[i + 1], '').keys()].some(key => timelineKeyHash(key) === hash)) return;
    let last = i + 1;
    while (last + 1 < lines.length && /^[ \t]+\S/.test(lines[last + 1]) && !/^[ \t]*[-*+] /.test(lines[last + 1])) last++;
    ranges.push([starts[i], starts[last] + lines[last].length]);
  });
  return ranges;
}

interface StoredTimelineRow { id: number; date: string; source: string; summary: string; detail: string }

function storedTimeline(engine: BrainEngine, pageId: number): Promise<StoredTimelineRow[]> {
  return engine.executeRaw<StoredTimelineRow>(`SELECT id,date::text AS date,source,summary,detail FROM timeline_entries
    WHERE page_id=$1 AND event_page_id IS NULL ORDER BY date,id`, [pageId]);
}

/**
 * Timeline tuples the coordinator projects from a canonical page body that
 * have no stored row on the page under the same normalized key. Insert-only
 * callers (managed `extract --stale`) add exactly these, so a stored row that
 * differs only by whitespace is not duplicated. `storedRows` is the caller's
 * own read of the page's non-event rows (a batched walk); without it the rows
 * are walked in pages (eachStoredTimelineRow), never held as one array.
 */
export async function unrecordedCanonicalTimeline(engine: BrainEngine, pageId: number, body: CanonicalBody | ReadonlyMap<string, ExtractedTimelineEntry>,
  slug: string, storedRows?: ReadonlyArray<Pick<StoredTimelineRow, 'date' | 'source' | 'summary'>>): Promise<ExtractedTimelineEntry[]> {
  const entries = body instanceof Map ? body : canonicalTimeline(body as CanonicalBody, slug);
  if (storedRows) {
    const stored = new Set(storedRows.map(row => timelineKey(row)));
    return [...entries].filter(([key]) => !stored.has(key)).map(([, entry]) => entry);
  }
  const unrecorded = new Map(entries);
  await eachStoredTimelineRow(engine, pageId, row => {
    canonicalTimelineWork.storedRows++;
    unrecorded.delete(timelineKey({ date: row.date_text, source: row.source, summary: row.summary }));
  });
  return [...unrecorded.values()];
}

/** Classify stored rows against a new body and the writer's prior snapshot's view. */
function classifyTimeline(rows: StoredTimelineRow[], body: CanonicalBody, prior: PriorRows | null, slug: string, writer: ProjectionWriter,
  policy?: TimelineWritePolicy) {
  const incoming = timelineView(body, slug);
  const timeline = incoming.entries;
  const exactIncoming = new Map([...timeline.values()].map(t => [exactTimelineKey(t), sanitizeForJsonb(t.detail ?? '')]));
  const pinned = rows.map((row, i) => {
    const key = timelineKey(row);
    const state: TimelineRowState = exactIncoming.has(exactTimelineKey(row)) ? 'in_body' : timeline.has(key) ? 'drifted'
      : prior?.marked(i, key) ? 'removed_marked' : prior?.entry(i, key) ? 'removed'
      : incoming.superseded.has(key) || prior?.superseded(i, key) ? (hasExtractorDetail(row) ? 'superseded' : 'superseded_annotated') : 'database_only';
    return { ...row, key, state, action: timelineRowAction(writer, state, policy) };
  });
  return { timeline, exactIncoming, pinned };
}

/** True when the body carries at least one timeline entry the coordinator would project. */
export function bodyHasTimelineEntries(body: CanonicalBody, slug: string): boolean {
  return canonicalTimeline(body, slug).size > 0;
}

/** Dates of the timeline rows a write removed (or would remove): the rows it saw in the prior body and dropped. */
export interface TimelineRowsRemoved { count: number; earliest: string; latest: string }

function removedSummary(dates: string[]): TimelineRowsRemoved | null {
  if (!dates.length) return null;
  const sorted = dates.map(d => d.slice(0, 10)).sort();
  return { count: sorted.length, earliest: sorted[0]!, latest: sorted[sorted.length - 1]! };
}

/** The stored rows this writer would delete because the new body dropped their bullets, judged now. */
export async function timelineRowsToRemove(engine: BrainEngine, body: CanonicalBody, prior: PageSnapshot, slug: string,
  writer: ProjectionWriter, policy?: TimelineWritePolicy): Promise<TimelineRowsRemoved | null> {
  const rows = await storedTimeline(engine, prior.page.id);
  const { pinned } = classifyTimeline(rows, body, (await priorView(engine, prior.page, slug, rows)).rows, slug, writer, policy);
  return removedSummary(pinned.filter(row => row.action === 'delete' && (row.state === 'removed' || row.state === 'removed_marked')).map(row => row.date));
}

const collapse = (text: string) => sanitizeForJsonb(text).replace(/\s+/g, ' ').trim();
export const TIMELINE_COMMENT_MARKUP = /<!--|-->/;

/**
 * Render one row as a marked bullet, or null when render-then-extract would
 * not return exactly this tuple and its normalized detail (delimiters in the
 * source, `Referenced in [` backlink receipts, empty sources, ...).
 */
export function renderMaterializedBullet(row: { date: string; source: string; summary: string; detail?: string | null }, slug: string): string | null {
  // Same normalization as timelineKey: sources are trimmed, summaries and details collapsed.
  const tuple = { date: row.date.slice(0, 10), source: sanitizeForJsonb(row.source).trim(), summary: collapse(row.summary) };
  const detail = collapse(row.detail ?? '');
  // Pre-#4277 backlink receipts are graph noise the extractors deliberately skip.
  if (/^Referenced in\s+\[/i.test(tuple.summary)) return null;
  // #6184: a row carrying HTML comment markup (a junk row the citation parser filed from a section END marker)
  // would write a second copy of that marker into the page; it stays database-side until `gbrain repair timeline-comments`.
  if (TIMELINE_COMMENT_MARKUP.test(`${row.source}\n${row.summary}\n${row.detail ?? ''}`)) return null;
  const block = [materializedMarker(tuple), `- **${tuple.date}** | ${tuple.source} — ${tuple.summary}`, ...(detail ? [`  ${detail}`] : [])].join('\n');
  const extracted = [...canonicalTimeline({ compiled_truth: block, timeline: '' }, slug).values()];
  if (extracted.length !== 1) return null;
  const [entry] = extracted;
  const same = entry.date === tuple.date && entry.source === tuple.source && entry.summary === tuple.summary && (entry.detail ?? '') === detail;
  return same && markedTimeline(safeBody({ compiled_truth: block, timeline: '' }), slug).size === 1 ? block : null;
}

export interface TimelineMaterialization { timeline: string; materialized: number; unrenderable: number }

/**
 * Write the writer's `materialize` rows back into the page's timeline section,
 * after existing bullets in date-then-row-id order, one bullet per normalized
 * tuple. Called during preparation, before the body is imported, rendered and
 * digested, by writers that render the canonical file from the database.
 */
export async function materializeTimeline(engine: BrainEngine, body: CanonicalBody, slug: string,
  prior: PageSnapshot | null, writer: ProjectionWriter, policy?: TimelineWritePolicy): Promise<TimelineMaterialization> {
  const timelineText = body.timeline ?? '';
  if (!prior) return { timeline: timelineText, materialized: 0, unrenderable: 0 };
  const rows = await storedTimeline(engine, prior.page.id);
  const { pinned } = classifyTimeline(rows, body, (await priorView(engine, prior.page, slug, rows)).rows, slug, writer, policy);
  const blocks: string[] = [];
  const seen = new Set<string>();
  let unrenderable = 0;
  for (const row of pinned) {
    if (row.action !== 'materialize' || seen.has(row.key)) continue;
    const block = renderMaterializedBullet(row, slug);
    if (!block) { unrenderable++; continue; }
    seen.add(row.key);
    blocks.push(block);
  }
  if (!blocks.length) return { timeline: timelineText, materialized: 0, unrenderable };
  const existing = timelineText.replace(/\s+$/, '');
  return { timeline: [...(existing ? [existing] : []), ...blocks].join('\n'), materialized: blocks.length, unrenderable };
}

/** Database-only timeline rows on one page, split by whether they can be materialized. */
export async function pendingTimelineRows(engine: BrainEngine, page: { id: number; slug: string } & CanonicalBody, exclude: ReadonlySet<number> = new Set()) {
  const { pinned } = classifyTimeline(await storedTimeline(engine, page.id), page, viewRows(timelineView(page, page.slug)), page.slug, 'editing');
  const renderable = new Set<string>();
  let unrenderable = 0;
  for (const row of pinned) {
    if (row.action !== 'materialize' || exclude.has(Number(row.id))) continue;
    if (renderMaterializedBullet(row, page.slug)) renderable.add(row.key);
    else unrenderable++;
  }
  return { materializable: renderable.size, unrenderable };
}

/**
 * Validate a canonical body and compile its provider-free projections. A fence
 * the shared scan refuses throws typed `invalid_fence` (wire `invalid_params`)
 * naming the first defect's fence, section and reason.
 */
/** #6574: a canonical projection at least this slow logs its steps. */
const SLOW_PROJECTION_MS = 30_000;

/** Rows per timeline INSERT (#6574): each statement stays well inside the publication's 5 s statement_timeout. */
const TIMELINE_INSERT_CHUNK = 500;

function timelineChunks(timeline: ReadonlyMap<string, ExtractedTimelineEntry>): ExtractedTimelineEntry[][] {
  const entries = [...timeline.values()];
  const chunks: ExtractedTimelineEntry[][] = [];
  for (let at = 0; at < entries.length; at += TIMELINE_INSERT_CHUNK) chunks.push(entries.slice(at, at + TIMELINE_INSERT_CHUNK));
  return chunks;
}

/**
 * #6574: a page's canonical timeline rows in one statement per chunk, in body order. The publication already holds the page's
 * row lock (lockPageKeys), so the rows go straight to its id; free text is sanitized as addTimelineEntry does (#2011).
 */
function insertCanonicalTimeline(tx: BrainEngine, pageId: number, entries: ExtractedTimelineEntry[]) {
  const rows = JSON.stringify(entries.map((entry, ord) => ({ ord, date: entry.date, source: sanitizeForJsonb(entry.source || ''),
    summary: sanitizeForJsonb(entry.summary), detail: sanitizeForJsonb(entry.detail || '') })));
  return tx.executeRaw(`INSERT INTO timeline_entries (page_id,date,source,summary,detail)
    SELECT $1,r.date::date,r.source,r.summary,r.detail FROM jsonb_to_recordset($2::text::jsonb) AS r(ord integer,date text,source text,summary text,detail text)
    ORDER BY r.ord
    ON CONFLICT (page_id,date,md5(summary),source) DO NOTHING`, [pageId, rows]);
}

/** The page body's own entry for one timeline row (same date, source and summary), inserted when the page carries it. */
export async function reprojectTimelineRow(tx: BrainEngine, pageId: number, body: CanonicalBody, slug: string,
  row: { date: string; source: string | null; summary: string }): Promise<boolean> {
  const entry = canonicalTimeline(body, slug).get(timelineKey({ ...row, date: String(row.date) }));
  if (!entry) return false;
  await insertCanonicalTimeline(tx, pageId, [entry]);
  return true;
}

export function compileCanonicalProjections(page: ParsedPage, slug: string, sourceId: string) {
  const scan=scanCanonicalFences(page);
  if(scan.defects.length) throw fenceOperationError(scan.defects[0]!, slug, sourceId);
  const fields:Array<[FenceSection,string]>=[['body',page.compiled_truth],['timeline',page.timeline ?? '']];
  return { factRows: extractFactsFromFenceText(scan.facts,slug,sourceId), takes: scan.takes, sections: scan.sections, quoted: scan.quoting ? quotedFenceRows(fields) : null };
}

/**
 * Refuse, rather than silently delete, rows a fence quoted in markdown code
 * still holds: readers project nothing from such a fence, so a real fence
 * wrapped in a code block would otherwise expire its facts and drop its takes.
 */
async function refuseQuotedFenceLoss(tx: BrainEngine, pageId: number, quoted: { facts: Map<string, FenceSection>; takes: Map<string, FenceSection> },
  takeRowsGone: number[], factRows: ReturnType<typeof extractFactsFromFenceText>, slug: string, sourceId: string): Promise<void> {
  const refuse = (fence: 'facts' | 'takes', lost: Array<{ row_num: number; section: FenceSection }>) => fenceOperationError({ reason: 'quoted_fence_rows', fence,
    section: lost[0]!.section, rows: [...new Set(lost.map(r => Number(r.row_num)))].slice(0, FENCE_ROWS_MAX), columns: [], line: null }, slug, sourceId);
  if (quoted.takes.size && takeRowsGone.length) {
    const gone = await tx.executeRaw<{ row_num: number; claim: string }>('SELECT row_num,claim FROM takes WHERE page_id=$1 AND row_num=ANY($2::integer[])', [pageId, takeRowsGone]);
    const lost = gone.flatMap(r => { const section = quoted.takes.get(`${r.row_num}:${r.claim}`); return section ? [{ row_num: r.row_num, section }] : []; });
    if (lost.length) throw refuse('takes', lost);
  }
  if (quoted.facts.size) {
    const kept = new Set(factRows.map(f => `${f.row_num}:${f.fact}:${f.visibility}`));
    const live = await tx.executeRaw<{ row_num: number; fact: string; visibility: string }>(`SELECT row_num,fact,visibility FROM facts
      WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL`, [sourceId, slug]);
    const lost = live.flatMap(r => { const section = kept.has(`${r.row_num}:${r.fact}:${r.visibility}`) ? undefined : quoted.facts.get(`${r.row_num}:${r.fact}`);
      return section ? [{ row_num: r.row_num, section }] : []; });
    if (lost.length) throw refuse('facts', lost);
  }
}

/** A new fence row's number already names a different stored take: typed `invalid_fence`, wire `take_row_collision` (E4). */
function takeCollision(rows: number[], sections: Map<number, FenceSection>, slug: string, sourceId: string): OperationError {
  return fenceOperationError({ reason: 'stored_row_collision', fence: 'takes', section: sections.get(rows[0]!) ?? 'body', rows: rows.slice(0, FENCE_ROWS_MAX), columns: [], line: null },
    slug, sourceId, { legacy_error: 'take_row_collision' });
}

/**
 * Prepare provider-free projections outside publication. `prior` is the
 * caller's snapshot at its observed revision; stored timeline rows and take
 * row numbers are pinned here so the publication transaction only removes
 * what this writer actually edited. A prior body left unread (a segmented page
 * over the single-string ceiling) is read block by block (segmentedPriorView).
 */
export async function prepareCanonicalProjections(engine: BrainEngine, page: ParsedPage, slug: string, sourceId: string,
  prior: PageSnapshot | null, writer: ProjectionWriter, policy?: TimelineWritePolicy): Promise<(tx: BrainEngine, pageId?: number) => Promise<CanonicalProjectionResult>> {
  const { factRows, takes, quoted, sections } = compileCanonicalProjections(page, slug, sourceId);
  // #6259: a page the content-quality gate hid as junk projects no facts or takes. Rows projected before it
  // was quarantined are left as they are (hiding them would need a new row state); only new projection stops.
  const projectFences = !isQuarantined(page.frontmatter);
  const storedRows = prior ? await storedTimeline(engine, prior.page.id) : [];
  const prior_ = prior ? await priorView(engine, prior.page, slug, storedRows) : null;
  const { timeline, exactIncoming, pinned } = classifyTimeline(storedRows, page, prior_?.rows ?? null, slug, writer, policy);
  const deletionRows = pinned.filter(row => row.action === 'delete')
    .map(({ id, date, source, summary, detail, state }) => ({ id, date, source, summary, detail, removed: state === 'removed' || state === 'removed_marked' }));
  const refreshRows = pinned.filter(row => row.action === 'refresh_detail')
    .map(row => ({ id: row.id, detail: row.detail, next: exactIncoming.get(exactTimelineKey(row)) }))
    .filter(row => row.next !== row.detail);
  const priorTakes = prior_?.takeRows ?? new Set<number>();
  // TE1 (#6188): when the prior takes fence does not parse, its stored rows count as prior canonical rows, so a
  // row Tier 1 normalized (same number, holder `system` -> `brain`) updates its stored take instead of colliding.
  const priorCanonical = prior && prior_?.takesWarn
    ? new Set([...priorTakes, ...(await engine.executeRaw<{ row_num: number }>('SELECT row_num FROM takes WHERE page_id=$1', [prior.page.id])).map(r => Number(r.row_num))])
    : priorTakes;
  const newTakes = JSON.stringify(takes.filter(t => !priorCanonical.has(t.rowNum)).map(t => ({ row_num: t.rowNum, claim: t.claim, kind: t.kind, holder: t.holder })));
  const takeRowsGone = [...priorTakes].filter(n => !takes.some(t => t.rowNum === n));
  const collisions = async (db: BrainEngine, pageId: number) => (await db.executeRaw<{ row_num: number }>(`SELECT k.row_num FROM takes k
    JOIN jsonb_to_recordset($2::text::jsonb) AS n(row_num integer,claim text,kind text,holder text) ON n.row_num=k.row_num
    WHERE k.page_id=$1 AND (k.claim,k.kind,k.holder) IS DISTINCT FROM (n.claim,n.kind,n.holder) ORDER BY k.row_num LIMIT $3`, [pageId, newTakes, FENCE_ROWS_MAX])).map(r => Number(r.row_num));
  const refuseCollisions = async (db: BrainEngine, pageId: number) => {
    const rows = await collisions(db, pageId);
    if (rows.length) throw takeCollision(rows, sections.takes, slug, sourceId);
  };
  if (prior && projectFences) await refuseCollisions(engine, prior.page.id);
  // #5984: `pageId` is the caller's own read of the page in this transaction. The
  // statements are issued as pipelines; an engine call that sends more than one
  // statement (insertFacts, addTakesBatch) ends one, so order is kept.
  return async (tx, pageId) => {
    const id = pageId ?? (await tx.readPageSnapshot(slug, { sourceId }))?.page.id;
    if (id == null) return { timelineRowsRemoved: null };
    // #5969: only rows this statement actually deleted count; a row changed since preparation is left alone and uncounted.
    const removedDates: string[] = [];
    // W1 #6783 §12 (a): a timeline row or take more trusted than the writer is never deleted, replaced or deactivated by
    // it. It stays as it is and a `forget` proposal asks the owner (trust/fence-guard.ts), decided before any statement runs.
    const heldTimeline = await heldRows(tx, 'timeline_entries', [...deletionRows, ...refreshRows].map(row => Number(row.id)));
    const deletions = JSON.stringify(deletionRows.filter(row => !heldTimeline.has(Number(row.id))));
    const refreshes = JSON.stringify(refreshRows.filter(row => !heldTimeline.has(Number(row.id))));
    const heldTakes = projectFences ? await guardFenceTakes(tx, id, takes, takeRowsGone) : [];
    const heldRowNums = new Set(heldTakes.map(row => row.row_num));
    const projectedTakes = heldRowNums.size ? takes.filter(take => !heldRowNums.has(take.rowNum)) : takes;
    const contestHeld = async () => [
      ...await contestHeldRows(tx, { sourceId, slug, table: 'timeline_entries', proposer: 'fence_projection',
        rows: [...heldTimeline].map(([rowId, tier]) => ({ id: rowId, tier, change: deletionRows.some(row => Number(row.id) === rowId) ? 'removed' as const : 'detail_changed' as const })) }),
      ...await contestHeldRows(tx, { sourceId, slug, table: 'takes', proposer: 'fence_projection', rows: heldTakes }),
    ];
    if (quoted && projectFences) await refuseQuotedFenceLoss(tx, id, quoted, takeRowsGone, factRows, slug, sourceId);
    // Fact IDs in permanent receipts remain meaningful when a canonical row is
    // removed/replaced. Expire and detach its row position instead of deleting it.
    // Conversation-extractor rows share the page coordinate without a fence
    // (#1928, as in the extract_facts reconcile); their replay owns them. A
    // fence row that takes one of their row numbers wins that position.
    const incoming = JSON.stringify(factRows.map(f => ({ row_num: f.row_num, fact: f.fact, visibility: f.visibility })));
    const expireFacts = () => tx.executeRaw(`UPDATE facts f SET expired_at=COALESCE(expired_at,now()),row_num=NULL
      WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL
      AND (COALESCE(f.source,'') NOT LIKE 'cli:extract-conversation-facts%'
        OR EXISTS (SELECT 1 FROM jsonb_to_recordset($3::text::jsonb) AS c(row_num integer) WHERE c.row_num=f.row_num))
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($3::text::jsonb) AS n(row_num integer,fact text,visibility text)
        WHERE n.row_num=f.row_num AND n.fact=f.fact AND n.visibility=f.visibility)`, [sourceId, slug, incoming]);
    // #6574: every fence row's fields refresh in one statement, not one round trip per row.
    const fieldRows = JSON.stringify([...new Map(factRows.map(fact => [fact.row_num, fact])).values()].map(fact => ({ row_num: fact.row_num, kind: fact.kind, notability: fact.notability,
      context: fact.context, valid_from: fact.valid_from?.toISOString() ?? null, valid_until: fact.valid_until?.toISOString() ?? null,
      expired_at: fact.expired_at?.toISOString() ?? null, source: fact.source, confidence: fact.confidence, claim_metric: fact.claim_metric ?? null,
      claim_value: fact.claim_value ?? null, claim_unit: fact.claim_unit ?? null, claim_period: fact.claim_period ?? null, attributed_to: fact.attributed_to ?? null })));
    const factFields = () => factRows.length ? tx.executeRaw(`UPDATE facts f SET kind=r.kind,notability=r.notability,context=r.context,
        valid_from=COALESCE(r.valid_from::timestamptz,f.valid_from),valid_until=r.valid_until::timestamptz,expired_at=r.expired_at::timestamptz,
        source=r.source,confidence=r.confidence,claim_metric=r.claim_metric,claim_value=r.claim_value,claim_unit=r.claim_unit,
        claim_period=r.claim_period,attributed_to=r.attributed_to
      FROM jsonb_to_recordset($3::text::jsonb) AS r(row_num integer,kind text,notability text,context text,valid_from text,valid_until text,
        expired_at text,source text,confidence real,claim_metric text,claim_value double precision,claim_unit text,claim_period text,attributed_to text)
      WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.row_num=r.row_num
        AND (f.kind,f.notability,f.context,f.valid_from,f.valid_until,f.expired_at,f.source,f.confidence,f.claim_metric,f.claim_value,f.claim_unit,
          f.claim_period,f.attributed_to) IS DISTINCT FROM (r.kind,r.notability,r.context,COALESCE(r.valid_from::timestamptz,f.valid_from),
          r.valid_until::timestamptz,r.expired_at::timestamptz,r.source,r.confidence,r.claim_metric,r.claim_value,r.claim_unit,r.claim_period,r.attributed_to)`,
      [sourceId, slug, fieldRows]) : Promise.resolve([]);
    const checkTakes = () => refuseCollisions(tx, id);
    const dropTakes = () => tx.executeRaw('DELETE FROM takes WHERE page_id=$1 AND row_num=ANY($2::integer[])', [id, takeRowsGone.filter(n => !heldRowNums.has(n))]);
    // A fence row's resolution cells are written as Markdown says, so a revert to a version that carries them restores
    // them. A row without resolution cells keeps the stored resolution (a database-only grade, e.g. unmanaged
    // grade_takes) unless its claim changed in place, which drops the old claim's grade. A held take keeps its grade:
    // the guard decided before any of these statements run (W1 #6783 §6.2).
    const fenceResolved = projectedTakes.filter(take => take.resolvedAt !== undefined || take.resolvedQuality !== undefined);
    const claims = JSON.stringify(projectedTakes.map(take => ({ row_num: take.rowNum, claim: take.claim })));
    const clearChangedResolutions = () => projectedTakes.length ? tx.executeRaw(`UPDATE takes k SET resolved_at=NULL,resolved_quality=NULL,
        resolved_outcome=NULL,resolved_source=NULL,resolved_value=NULL,resolved_unit=NULL,resolved_by=NULL
      FROM jsonb_to_recordset($2::text::jsonb) AS n(row_num integer,claim text)
      WHERE k.page_id=$1 AND k.row_num=n.row_num AND k.resolved_at IS NOT NULL AND k.claim IS DISTINCT FROM n.claim`, [id, claims]) : Promise.resolve([]);
    const resolutions = JSON.stringify(fenceResolved.map(take => ({ row_num: take.rowNum, resolved_at: take.resolvedAt ?? null,
      resolved_quality: take.resolvedQuality ?? null,
      resolved_outcome: take.resolvedQuality === 'correct' ? true : take.resolvedQuality === 'incorrect' ? false : null,
      resolved_source: take.resolvedEvidence ?? null, resolved_value: take.resolvedValue ?? null, resolved_unit: take.resolvedUnit ?? null,
      resolved_by: take.resolvedBy ?? null })));
    const resolveTakes = () => fenceResolved.length ? tx.executeRaw(`UPDATE takes k SET resolved_at=r.resolved_at::timestamptz,resolved_quality=r.resolved_quality,
        resolved_outcome=r.resolved_outcome,resolved_source=r.resolved_source,resolved_value=r.resolved_value,resolved_unit=r.resolved_unit,
        resolved_by=r.resolved_by
      FROM jsonb_to_recordset($2::text::jsonb) AS r(row_num integer,resolved_at text,resolved_quality text,resolved_outcome boolean,
        resolved_source text,resolved_value real,resolved_unit text,resolved_by text)
      WHERE k.page_id=$1 AND k.row_num=r.row_num AND (k.resolved_at,k.resolved_quality,k.resolved_outcome,k.resolved_source,k.resolved_value,k.resolved_unit,
        k.resolved_by) IS DISTINCT FROM (r.resolved_at::timestamptz,r.resolved_quality,r.resolved_outcome,r.resolved_source,r.resolved_value,r.resolved_unit,
        r.resolved_by)`, [id, resolutions]) : Promise.resolve([]);
    // Event-page references have a different canonical origin and remain intact;
    // new rows carry their Markdown detail on insert, pinned rows refresh only from their preimage.
    const timelineRows = [
      () => tx.executeRaw<{ date: string; removed: boolean }>(`DELETE FROM timeline_entries t USING jsonb_to_recordset($2::text::jsonb) AS d(id integer,date date,source text,summary text,detail text,removed boolean)
        WHERE t.page_id=$1 AND t.event_page_id IS NULL AND t.id=d.id AND t.date=d.date AND t.source=d.source
          AND t.summary=d.summary AND t.detail=d.detail RETURNING t.date::text AS date, d.removed`, [id, deletions])
        .then(rows => { for (const row of rows) if (row.removed) removedDates.push(row.date); return rows; }),
      ...timelineChunks(timeline).map(rows => () => insertCanonicalTimeline(tx, id, rows)),
      () => tx.executeRaw(`UPDATE timeline_entries t SET detail=r.next FROM jsonb_to_recordset($2::text::jsonb) AS r(id integer,detail text,next text)
        WHERE t.page_id=$1 AND t.event_page_id IS NULL AND t.id=r.id AND t.detail=r.detail`, [id, refreshes]),
    ];
    const started = Date.now();
    const steps: Array<[string, number]> = [];
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const at = Date.now();
      try { return await run(); } finally { steps.push([name, Date.now() - at]); }
    };
    try {
      if (!projectFences) {
        await step('timeline', () => pipelined(tx, timelineRows));
        const held = await step('held', contestHeld);
        return { timelineRowsRemoved: removedSummary(removedDates), ...(held.length ? { contested: held } : {}) };
      }
      // #5575: rows more trusted than the writer are never expired by it, and new rows pass the write gate (trust/fence-guard.ts).
      // The timeline rows are independent of the fact and take rows, so they ride in the first pipeline.
      const guard = await step('timeline', () => guardFenceRows(tx, { sourceId, slug, incoming, rows: factRows, cfg: loadWriteGateConfig },
        () => pipelined(tx, [expireFacts, ...timelineRows])));
      if (guard.rows.length) await step('facts', () => tx.insertFacts(guard.rows, { source_id: sourceId })); // gbrain-allow-direct-insert: canonical fence projection shares the journal publication transaction
      const contested = await step('fact_trust', () => guard.finish(tx));
      // W1 #6783 §12 (b): a fence row's field rewrite can lower a more trusted fact (the tier trigger); what was derived from it follows.
      const above = factRows.length ? await factsAboveWriter(tx, sourceId, slug) : [];
      await step('fact_fields', () => pipelined(tx, [factFields, checkTakes, dropTakes, clearChangedResolutions]));
      if (above.length) await propagateFactLowering(tx, above);
      if (projectedTakes.length) {
        await step('takes', async () => {
          await tx.addTakesBatch(projectedTakes.map(t => takesPreparation.toCanonicalBatchInput(id, t)));
          await resolveTakes();
        });
      }
      const all = [...contested, ...await step('held', contestHeld)];
      return { timelineRowsRemoved: removedSummary(removedDates), ...(all.length ? { contested: all } : {}) };
    } finally {
      // #6574: a slow projection names its slow step and its row counts, so a round-trip-bound publish is visible in one line.
      const elapsed = Date.now() - started;
      if (elapsed >= SLOW_PROJECTION_MS) {
        process.stderr.write(`[persistence] phase=publication reason=slow_projection source=${sourceId} slug=${slug} elapsed_ms=${elapsed}`
          + ` timeline_rows=${timeline.size} fact_rows=${factRows.length} take_rows=${takes.length}`
          + ` steps=${steps.map(([name, ms]) => `${name}:${ms}`).join(',')}\n`);
      }
    }
  };
}

export interface CanonicalProjectionResult { timelineRowsRemoved: TimelineRowsRemoved | null; /** #5575 A5: trust proposals the guarded fence re-projection filed. */ contested?: string[] }
