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
import { extractTimelineFromContent, hasExtractorDetail, supersededCitationTimeline, type ExtractedTimelineEntry } from '../timeline-extract.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { sanitizeForJsonb } from '../batch-rows.ts';
import { materializedMarker, materializedMarkerHash, timelineKey, timelineKeyHash } from '../timeline-marker.ts';
import type { OperationError } from '../ops/contract.ts';
import { protectedRegions } from '../fence-scan.ts';
import { FENCE_ROWS_MAX, fenceOperationError, scanCanonicalFences } from '../fence-repair/refusal.ts';
import type { FenceSection } from '../fence-repair/types.ts';

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

/** Tuples whose bullet is introduced by a marker that still matches it. */
function markedTimeline(body: CanonicalBody, slug: string): Set<string> {
  const lines = safeBody(body).split('\n');
  const marked = new Set<string>();
  lines.forEach((line, i) => {
    const hash = materializedMarkerHash(line);
    if (!hash || i + 1 >= lines.length) return;
    for (const key of extractTimeline(lines[i + 1], slug).keys()) if (timelineKeyHash(key) === hash) marked.add(key);
  });
  return marked;
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
 * differs only by whitespace is not duplicated.
 */
export async function unrecordedCanonicalTimeline(engine: BrainEngine, pageId: number, body: CanonicalBody, slug: string): Promise<ExtractedTimelineEntry[]> {
  const stored = new Set((await storedTimeline(engine, pageId)).map(row => timelineKey(row)));
  return [...canonicalTimeline(body, slug)].filter(([key]) => !stored.has(key)).map(([, entry]) => entry);
}

/** Classify stored rows against a new body and the writer's prior snapshot. */
function classifyTimeline(rows: StoredTimelineRow[], body: CanonicalBody, prior: CanonicalBody | null, slug: string, writer: ProjectionWriter,
  policy?: TimelineWritePolicy) {
  const timeline = canonicalTimeline(body, slug);
  const exactIncoming = new Map([...timeline.values()].map(t => [exactTimelineKey(t), sanitizeForJsonb(t.detail ?? '')]));
  const priorTimeline = prior ? new Set(canonicalTimeline(prior, slug).keys()) : new Set<string>();
  const priorMarked = prior ? markedTimeline(prior, slug) : new Set<string>();
  const superseded = new Set([body, ...(prior ? [prior] : [])].flatMap(b => supersededCitationTimeline(safeBody(b)).map(t => timelineKey(t))));
  const pinned = rows.map(row => {
    const key = timelineKey(row);
    const state: TimelineRowState = exactIncoming.has(exactTimelineKey(row)) ? 'in_body' : timeline.has(key) ? 'drifted'
      : priorMarked.has(key) ? 'removed_marked' : priorTimeline.has(key) ? 'removed'
      : superseded.has(key) ? (hasExtractorDetail(row) ? 'superseded' : 'superseded_annotated') : 'database_only';
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
  const { pinned } = classifyTimeline(await storedTimeline(engine, prior.page.id), body, prior.page, slug, writer, policy);
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
  return same && markedTimeline({ compiled_truth: block, timeline: '' }, slug).size === 1 ? block : null;
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
  const { pinned } = classifyTimeline(await storedTimeline(engine, prior.page.id), body, prior.page, slug, writer, policy);
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
  const { pinned } = classifyTimeline(await storedTimeline(engine, page.id), page, page, page.slug, 'editing');
  const renderable = new Set<string>();
  let unrenderable = 0;
  for (const row of pinned) {
    if (row.action !== 'materialize' || exclude.has(Number(row.id))) continue;
    if (renderMaterializedBullet(row, page.slug)) renderable.add(row.key);
    else unrenderable++;
  }
  return { materializable: renderable.size, unrenderable };
}

function canonicalTakeRows(body: CanonicalBody): Set<number> {
  return new Set([body.compiled_truth, body.timeline ?? ''].flatMap(field => parseTakesFence(field).takes.map(t => t.rowNum)));
}

/**
 * Validate a canonical body and compile its provider-free projections. A fence
 * the shared scan refuses throws typed `invalid_fence` (wire `invalid_params`)
 * naming the first defect's fence, section and reason.
 */
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
 * what this writer actually edited.
 */
export async function prepareCanonicalProjections(engine: BrainEngine, page: ParsedPage, slug: string, sourceId: string,
  prior: PageSnapshot | null, writer: ProjectionWriter, policy?: TimelineWritePolicy): Promise<(tx: BrainEngine, pageId?: number) => Promise<CanonicalProjectionResult>> {
  const { factRows, takes, quoted, sections } = compileCanonicalProjections(page, slug, sourceId);
  // #6259: a page the content-quality gate hid as junk projects no facts or takes. Rows projected before it
  // was quarantined are left as they are (hiding them would need a new row state); only new projection stops.
  const projectFences = !isQuarantined(page.frontmatter);
  const { timeline, exactIncoming, pinned } = classifyTimeline(prior ? await storedTimeline(engine, prior.page.id) : [],
    page, prior?.page ?? null, slug, writer, policy);
  const deletions = JSON.stringify(pinned.filter(row => row.action === 'delete')
    .map(({ id, date, source, summary, detail, state }) => ({ id, date, source, summary, detail, removed: state === 'removed' || state === 'removed_marked' })));
  const refreshes = JSON.stringify(pinned.filter(row => row.action === 'refresh_detail')
    .map(row => ({ id: row.id, detail: row.detail, next: exactIncoming.get(exactTimelineKey(row)) }))
    .filter(row => row.next !== row.detail));
  const priorTakes = prior ? canonicalTakeRows(prior.page) : new Set<number>();
  // TE1 (#6188): when the prior takes fence does not parse, its stored rows count as prior canonical rows, so a
  // row Tier 1 normalized (same number, holder `system` -> `brain`) updates its stored take instead of colliding.
  const priorCanonical = prior && [prior.page.compiled_truth, prior.page.timeline ?? ''].some(field => parseTakesFence(field).warnings.length)
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
    const factFields = factRows.map(fact => () => tx.executeRaw(`UPDATE facts SET kind=$4,notability=$5,context=$6,
        valid_from=COALESCE($7::timestamptz,valid_from),valid_until=$8::timestamptz,expired_at=$9::timestamptz,
        source=$10,confidence=$11,claim_metric=$12,claim_value=$13,claim_unit=$14,claim_period=$15,attributed_to=$16
        WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num=$3`,
      [sourceId, slug, fact.row_num, fact.kind, fact.notability, fact.context, fact.valid_from?.toISOString() ?? null,
        fact.valid_until?.toISOString() ?? null, fact.expired_at?.toISOString() ?? null, fact.source, fact.confidence,
        fact.claim_metric ?? null, fact.claim_value ?? null, fact.claim_unit ?? null, fact.claim_period ?? null, fact.attributed_to ?? null]));
    const checkTakes = () => refuseCollisions(tx, id);
    const dropTakes = () => tx.executeRaw('DELETE FROM takes WHERE page_id=$1 AND row_num=ANY($2::integer[])', [id, takeRowsGone]);
    // Full canonical versions include resolution fields; a revert restores those
    // fields from Markdown too, without the ordinary immutable-resolution API.
    const resolveTakes = takes.map(take => () => tx.executeRaw(`UPDATE takes SET resolved_at=$3::timestamptz,
      resolved_quality=$4,resolved_outcome=$5,resolved_source=$6,resolved_value=$7,resolved_unit=$8,resolved_by=$9
      WHERE page_id=$1 AND row_num=$2`, [id, take.rowNum, take.resolvedAt ?? null, take.resolvedQuality ?? null,
      take.resolvedQuality === 'correct' ? true : take.resolvedQuality === 'incorrect' ? false : null,
      take.resolvedEvidence ?? null, take.resolvedValue ?? null, take.resolvedUnit ?? null, take.resolvedBy ?? null]));
    // Event-page references have a different canonical origin and remain intact;
    // new rows carry their Markdown detail on insert, pinned rows refresh only from their preimage.
    const timelineRows = [
      () => tx.executeRaw<{ date: string; removed: boolean }>(`DELETE FROM timeline_entries t USING jsonb_to_recordset($2::text::jsonb) AS d(id integer,date date,source text,summary text,detail text,removed boolean)
        WHERE t.page_id=$1 AND t.event_page_id IS NULL AND t.id=d.id AND t.date=d.date AND t.source=d.source
          AND t.summary=d.summary AND t.detail=d.detail RETURNING t.date::text AS date, d.removed`, [id, deletions])
        .then(rows => { for (const row of rows) if (row.removed) removedDates.push(row.date); return rows; }),
      ...[...timeline.values()].map(entry => () => tx.addTimelineEntry(slug, entry, { sourceId })),
      () => tx.executeRaw(`UPDATE timeline_entries t SET detail=r.next FROM jsonb_to_recordset($2::text::jsonb) AS r(id integer,detail text,next text)
        WHERE t.page_id=$1 AND t.event_page_id IS NULL AND t.id=r.id AND t.detail=r.detail`, [id, refreshes]),
    ];
    if (!projectFences) {
      await pipelined(tx, timelineRows);
      return { timelineRowsRemoved: removedSummary(removedDates) };
    }
    if (factRows.length) {
      await pipelined(tx, [expireFacts]);
      await tx.insertFacts(factRows, { source_id: sourceId }); // gbrain-allow-direct-insert: canonical fence projection shares the journal publication transaction
      await pipelined(tx, [...factFields, checkTakes, dropTakes]);
    } else await pipelined(tx, [expireFacts, checkTakes, dropTakes]);
    if (takes.length) {
      await tx.addTakesBatch(takes.map(t => takesPreparation.toCanonicalBatchInput(id, t)));
      await pipelined(tx, [...resolveTakes, ...timelineRows]);
    } else await pipelined(tx, timelineRows);
    return { timelineRowsRemoved: removedSummary(removedDates) };
  };
}

export interface CanonicalProjectionResult { timelineRowsRemoved: TimelineRowsRemoved | null }
