/**
 * Timeline extraction from rendered markdown — CORE module.
 *
 * Lives in core (not commands/extract.ts, its historical home) because core
 * consumers (timeline-write-through.ts re-derives the canonical DB tuple from
 * the spliced bullet; the cycle synthesize path) must not import the command
 * module: commands/extract.ts transitively loads the write-through/ops layer,
 * and a core->commands import closes a module cycle that leaves the command
 * module partially evaluated under dynamic import ("Export named ... not
 * found" at runtime, invisible to tsc). commands/extract.ts re-exports these
 * names, so its existing importers are unaffected.
 */

import { parseInlineCitationTimelineEntries, findTimelineSourceDelimiter, parseTimelineEntries } from './link-extraction.ts';
import { isDatedTimelineLine, supersededInlineCitationEntries } from './timeline-citations.ts';
import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { firstMaterializedMarkerIndex } from './timeline-marker.ts';
import { bodyBlocks, detachedValue, retainedGenerationBlocks } from './page-body/segment-blocks.ts';

export interface ExtractedTimelineEntry {
  slug: string;
  date: string;
  source: string;
  summary: string;
  detail?: string;
}

// #3957: the link-aware `Source — Summary` delimiter finder moved to
// link-extraction.ts (findTimelineSourceDelimiter) so the DB-side parser
// (parseTimelineEntries) applies the IDENTICAL split — FS- and DB-extracted
// rows must share one (source, summary) shape or the timeline dedup index
// duplicates every bullet extracted through both paths.
const findDelimiterOutsideLinks = findTimelineSourceDelimiter;

// A Format 1 bullet line; this extractor's inline-citation pass (Format 3) skips it.
const bulletLinePattern = /^-\s+\*\*\d{4}-\d{2}-\d{2}\*\*\s*\|/;

/** Extract timeline entries from markdown content */
export function extractTimelineFromContent(content: string, slug: string): ExtractedTimelineEntry[] {
  const entries: ExtractedTimelineEntry[] = [];

  // Format 1: Bullet — - **YYYY-MM-DD** | Source — Summary
  // The delimiter search is link-aware (see findDelimiterOutsideLinks): a
  // no-delimiter bullet is kept whole as the summary rather than fragmented.
  const bulletPattern = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|\s*(.+)$/gm;
  let match;
  while ((match = bulletPattern.exec(content)) !== null) {
    const rest = match[2].trim();
    // #4277: dated auto-generated backlink receipts
    // (`- **date** | Referenced in [X](y.md)`) are graph-maintenance noise —
    // the date is the backlink write's, not an entity event's. Skip them.
    // Pre-split guard (rest must START with the marker) mirrors
    // parseTimelineEntries in link-extraction.ts so FS- and DB-side
    // extraction stay in lockstep, and leaves write-through rendered
    // `source — summary` bullets that merely mention the phrase intact.
    if (/^Referenced in\s+\[/i.test(rest)) continue;
    const at = findDelimiterOutsideLinks(rest);
    if (at >= 0) {
      entries.push({ slug, date: match[1], source: rest.slice(0, at).trim(), summary: rest.slice(at + 1).trim() });
    } else {
      entries.push({ slug, date: match[1], source: 'markdown', summary: rest });
    }
  }

  // Format 2: Header — ### YYYY-MM-DD — Title
  const headerPattern = /^###\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)$/gm;
  while ((match = headerPattern.exec(content)) !== null) {
    const afterIdx = match.index + match[0].length;
    const nextHeader = content.indexOf('\n### ', afterIdx);
    const nextSection = content.indexOf('\n## ', afterIdx);
    const endIdx = Math.min(
      nextHeader >= 0 ? nextHeader : content.length,
      nextSection >= 0 ? nextSection : content.length,
    );
    // #5567: a materialized bullet appended after this header is its own entry.
    const section = content.slice(afterIdx, endIdx);
    const marker = firstMaterializedMarkerIndex(section);
    const detail = (marker >= 0 ? section.slice(0, marker) : section).trim();
    entries.push({ slug, date: match[1], source: 'markdown', summary: match[2].trim(), detail: detail || undefined });
  }

  // Format 3: Inline citation — [Source: <source>, YYYY-MM-DD]
  //
  // This is the citation convention gbrain's own quality rules require on
  // every brain write (skills/conventions/quality.md), so dated evidence is
  // pervasive in curated pages — but until now the extractor could not see
  // it, and a page whose dates all live in citations scored zero timeline
  // coverage. The entry's summary is the sentence the citation annotates
  // (the surrounding line with citation markers stripped).
  //
  // Lines already captured by Format 1 are skipped: a timeline bullet often
  // carries its own [Source: ...] citation, and re-extracting it would file
  // a duplicate entry under a different (source, summary) shape that the
  // DB-level uniqueness cannot collapse.
  for (const entry of parseInlineCitationTimelineEntries(content, {
    skipLine: (line) => bulletLinePattern.test(line),
  })) {
    entries.push({ slug, date: entry.date, source: entry.source, summary: entry.summary });
  }

  return entries;
}

type TimelineTuple = Pick<ExtractedTimelineEntry, 'date' | 'source' | 'summary'>;
const tupleKey = (e: TimelineTuple) => JSON.stringify([e.date, e.source, e.summary]);

/**
 * #6226: the tuples the inline-citation pass of either parser filed for this
 * text before one citation could name several dated sources, and that the
 * current reading no longer produces (supersededInlineCitationEntries).
 */
export function supersededCitationTimeline(content: string): TimelineTuple[] {
  return [
    ...supersededInlineCitationEntries(content, { skipLine: (line) => bulletLinePattern.test(line) }),
    ...supersededInlineCitationEntries(content, { skipLine: isDatedTimelineLine }),
  ];
}

/**
 * The detail an extractor itself writes for a citation row: none (file
 * extraction) or `Source: <source>` (database extraction). Any other detail
 * was added by someone, so a row carrying it is never retired as an older
 * reading (#6226, taste T3): timelineKey ignores detail.
 */
export function hasExtractorDetail(row: { source: string; detail?: string | null }): boolean {
  const detail = (row.detail ?? '').replace(/\s+/g, ' ').trim();
  return detail === '' || detail === `Source: ${row.source}`.replace(/\s+/g, ' ').trim();
}

/**
 * Every (date, source, summary) tuple a page text yields under either timeline
 * parser: the file-walk parser above and the DB-side parseTimelineEntries.
 * Reconciliation keeps and retracts against this union, so the file and DB
 * extraction paths never undo each other's rows.
 */
function markdownTimelineKeys(text: string, slug: string): Set<string> {
  const keys = new Set(extractTimelineFromContent(text, slug).map(tupleKey));
  for (const entry of parseTimelineEntries(text)) keys.add(tupleKey({ ...entry, source: entry.source ?? '' }));
  return keys;
}

/** Membership of timeline keys: a Set of them, or a TimelineKeySet. */
export interface TimelineKeyLookup { has(key: string): boolean }

const LOW = 2 ** 32;
const AMBIGUOUS = 1;
const MARKED = 2;

/**
 * A set of keys held as two hashes of each (53 and 32 bits of its SHA-256), not the key strings: a few dozen bytes a
 * key instead of a few hundred, for sets with one key per stored timeline row of a large page. A key never added
 * answers true only when both of its hashes collide with an added key's (about 2^-85 a pair); two added keys whose
 * first hashes collide share one entry, which then answers for either. `mark` flags an added key (a stored row the
 * body produces), so one entry per row answers both questions.
 */
export class TimelineKeySet implements TimelineKeyLookup {
  /** Open addressing over two plain number arrays (a Map costs about 80 bytes an entry, these about 25): slot i holds the first hash + 1 (0: empty) and the second hash plus its flags times LOW. */
  private firsts: number[] = new Array<number>(1024).fill(0);
  private values: number[] = new Array<number>(1024).fill(0);
  private count = 0;
  add(key: string): void {
    const [a, b] = keyDigest(key);
    const i = this.slot(a);
    if (this.firsts[i] === 0) {
      this.firsts[i] = a + 1;
      this.values[i] = b;
      if (++this.count * 4 > this.firsts.length * 3) this.grow();
      return;
    }
    const at = this.values[i]!;
    if (at % LOW !== b) this.values[i] = at - (at % LOW) + b + (Math.floor(at / LOW) & AMBIGUOUS ? 0 : AMBIGUOUS * LOW);
  }
  has(key: string): boolean {
    return this.entry(key) !== -1;
  }
  /** Flag an added key; false when it was not added. */
  mark(key: string): boolean {
    const i = this.entry(key);
    if (i === -1) return false;
    if (!(Math.floor(this.values[i]! / LOW) & MARKED)) this.values[i] = this.values[i]! + MARKED * LOW;
    return true;
  }
  marked(key: string): boolean {
    const i = this.entry(key);
    return i !== -1 && (Math.floor(this.values[i]! / LOW) & MARKED) !== 0;
  }
  get size(): number { return this.count; }
  /** The slot holding first hash `a`, or the empty slot where it goes. */
  private slot(a: number): number {
    const mask = this.firsts.length - 1;
    let i = a % this.firsts.length;
    while (this.firsts[i] !== 0 && this.firsts[i] !== a + 1) i = (i + 1) & mask;
    return i;
  }
  private entry(key: string): number {
    const [a, b] = keyDigest(key);
    const i = this.slot(a);
    if (this.firsts[i] === 0) return -1;
    const at = this.values[i]!;
    return (Math.floor(at / LOW) & AMBIGUOUS) !== 0 || at % LOW === b ? i : -1;
  }
  private grow(): void {
    const { firsts, values } = this;
    this.firsts = new Array<number>(firsts.length * 2).fill(0);
    this.values = new Array<number>(firsts.length * 2).fill(0);
    for (let j = 0; j < firsts.length; j++) {
      if (firsts[j] === 0) continue;
      const i = this.slot(firsts[j]! - 1);
      this.firsts[i] = firsts[j]!;
      this.values[i] = values[j]!;
    }
  }
}

function keyDigest(key: string): [number, number] {
  const hash = createHash('sha256').update(key).digest();
  return [hash.readUIntBE(0, 6) * 32 + (hash[6]! >> 3), hash.readUInt32BE(8)];
}

/**
 * What a page text says about its timeline rows: the tuples either parser yields, and the older citation readings it
 * supersedes. Read from a segmented body (segmentedTimelineText) with `within`, both hold only those keys, and a
 * stored row whose key is not in `within` (one written after the read) is never retracted against them. `runs` holds
 * the keys of the body's runs whose blocks were their stored text, which a retained generation need not read again.
 */
export interface TimelineTextKeys { kept: TimelineKeyLookup; superseded: TimelineKeyLookup; within?: TimelineKeyLookup; runs?: ReadonlySet<string> }

/** The key retraction compares a stored row by (`within` of segmentedTimelineText). */
export const storedTimelineKey = (row: TimelineTuple): string => tupleKey(row);

export interface SegmentedTimelineOptions {
  /**
   * The keys (storedTimelineKey) of the page's stored rows: kept is then the keys of `within` the body produces (marked
   * there, so the result holds no set of its own) and superseded only keys of `within`.
   */
  within?: TimelineKeySet;
  /** Collect the entries parseTimelineEntries reads (default true); `parsed` counts them either way. */
  entries?: boolean;
  /** Asked before each segment read (bodyBlocks): true ends the read with BodyReadStopped. */
  stop?: () => boolean;
  /** Each block's text, for a caller deriving more from the same walk. */
  onBlock?: (text: string) => void;
}

/**
 * TimelineTextKeys of a segmented page's `${compiled_truth}\n${timeline}`, block by block (page-body/segment-blocks.ts),
 * with the entries parseTimelineEntries reads there, in body order, and their count. Blocks start outside timeline
 * detail runs, so each entry is read whole. With `within` and `entries: false` the result holds at most one key per
 * stored row, not one per entry.
 */
export async function segmentedTimelineText(engine: Pick<BrainEngine, 'executeRaw' | 'readSegmentTexts'>, page: { id: number; slug: string; source_id?: string },
  opts: SegmentedTimelineOptions = {}): Promise<TimelineTextKeys & { entries: ReturnType<typeof parseTimelineEntries>; parsed: number; runs: Set<string> }> {
  const kept = new Set<string>();
  const superseded = new Set<string>();
  const runs = new Set<string>();
  const entries: ReturnType<typeof parseTimelineEntries> = [];
  const { within } = opts;
  let parsed = 0;
  for await (const block of bodyBlocks(engine as BrainEngine, page, { runKeys: runs, ...(opts.stop ? { stop: opts.stop } : {}) })) {
    for (const key of markdownTimelineKeys(block.text, page.slug)) if (!within) kept.add(key); else within.mark(key);
    for (const entry of supersededCitationTimeline(block.text)) {
      const key = tupleKey(entry);
      if (!within || within.has(key)) superseded.add(key);
    }
    const read = parseTimelineEntries(block.text);
    parsed += read.length;
    if (opts.entries !== false) entries.push(...detachedValue(read));
    opts.onBlock?.(block.text);
  }
  return { kept: within ? { has: key => within.marked(key) } : kept, superseded, ...(within ? { within } : {}), runs, entries, parsed };
}

/** A page's stored non-event timeline row as reconciliation reads it (`date` is `YYYY-MM-DD`). */
export type StoredTimelineTuple = TimelineTuple & { id: number; detail: string | null };

function storedTimelineRows(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string): Promise<StoredTimelineTuple[]> {
  return engine.executeRaw<StoredTimelineTuple>(
    `SELECT t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.source, t.summary, t.detail FROM timeline_entries t
      JOIN pages p ON p.id = t.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND t.event_page_id IS NULL`, [sourceId, slug]);
}

const STORED_ROWS_PAGE = 5_000;

/**
 * Each stored non-event timeline row of a page (`date_text` is `date::text`, unrecordedCanonicalTimeline's form),
 * STORED_ROWS_PAGE rows at a time by id, so a page with many rows is never held as one array.
 */
export async function eachStoredTimelineRow(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number,
  fn: (row: StoredTimelineTuple & { date_text: string }) => void): Promise<void> {
  for (let after = 0; ;) {
    const rows = await engine.executeRaw<StoredTimelineTuple & { date_text: string }>(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, date::text AS date_text, source, summary, detail FROM timeline_entries
        WHERE page_id = $1 AND event_page_id IS NULL AND id > $2 ORDER BY id LIMIT $3`, [pageId, after, STORED_ROWS_PAGE]);
    for (const row of rows) fn(row);
    if (rows.length < STORED_ROWS_PAGE) return;
    after = Number(rows[rows.length - 1]!.id);
  }
}

/**
 * The stored rows of a page a segmented read of it can retract: those whose key `keys` (segmentedTimelineText with
 * `within`) neither keeps nor leaves out of `within`, streamed (eachStoredTimelineRow).
 */
export async function unkeptTimelineRows(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, keys: TimelineTextKeys): Promise<StoredTimelineTuple[]> {
  const out: StoredTimelineTuple[] = [];
  await eachStoredTimelineRow(engine, pageId, ({ date_text: _text, ...row }) => {
    const key = tupleKey(row);
    if (!keys.kept.has(key) && (!keys.within || keys.within.has(key))) out.push(row);
  });
  return out;
}

/**
 * Reconcile a page's timeline rows with its current text: retract every row
 * an earlier version of the page produced that the current text no longer
 * does (a corrected or deleted dated bullet, however many edits ago). Rows no
 * version of the page ever produced (enrichment, meeting fan-out, inferred
 * anchors) and event-page projections are never touched. The page_versions
 * scan only runs when the page holds a row the current text does not produce,
 * and keeps only the keys of those rows. A retained segmented generation is read
 * run by run (retainedGenerationBlocks), skipping each run whose key the live body
 * or an earlier generation already read; `stop` is asked before each of its segment reads.
 * Returns the orphaned rows; they are deleted unless `dryRun`. `storedRows`
 * is the caller's own read of those rows (a batched walk), used instead of reading them here.
 * `current` is the page text, or its keys when the caller read a segmented body (segmentedTimelineText).
 * `expectedRevision` is the page revision `current` was read at (GBRA-161 PR 5, T-2): the delete then runs with the page
 * row locked and only while the page is still at that revision; a page that moved deletes nothing and returns no rows.
 */
export async function retractRemovedTimelineEntries(
  engine: Pick<BrainEngine, 'executeRaw' | 'readManifest' | 'readSegmentTexts'>,
  slug: string,
  sourceId: string,
  current: string | TimelineTextKeys,
  opts: { dryRun?: boolean; storedRows?: ReadonlyArray<StoredTimelineTuple>; stop?: () => boolean; expectedRevision?: string } = {},
): Promise<Array<TimelineTuple & { id: number }>> {
  const kept = typeof current === 'string' ? markdownTimelineKeys(current, slug) : current.kept;
  const within = typeof current === 'string' ? undefined : current.within;
  const rows = opts.storedRows ?? await storedTimelineRows(engine, sourceId, slug);
  const extra = rows.filter(row => !kept.has(tupleKey(row)) && (!within || within.has(tupleKey(row))));
  if (!extra.length) return [];
  const versions = await engine.executeRaw<{ compiled_truth: string | null; timeline: string | null; body_storage: string; page_id: number; generation: number | null }>(
    `SELECT DISTINCT v.compiled_truth, v.timeline, v.body_storage, v.page_id, v.body_generation AS generation FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = $1 AND p.slug = $2`, [sourceId, slug]);
  const wanted = new Set(extra.map(tupleKey));
  const produced = new Set<string>();
  // #6226: rows the older citation reading filed for this text or a stored version.
  const superseded = new Set(typeof current === 'string' ? supersededCitationTimeline(current).map(tupleKey)
    : [...wanted].filter(key => current.superseded.has(key)));
  const addText = (text: string) => {
    for (const key of markdownTimelineKeys(text, slug)) if (wanted.has(key)) produced.add(key);
    for (const entry of supersededCitationTimeline(text)) if (wanted.has(tupleKey(entry))) superseded.add(tupleKey(entry));
  };
  const seen = new Set(typeof current === 'string' ? [] : current.runs ?? []);
  for (const version of versions) {
    if (version.body_storage !== 'segmented') { addText(`${version.compiled_truth}\n${version.timeline ?? ''}`); continue; }
    for await (const block of retainedGenerationBlocks(engine, { id: Number(version.page_id), slug, sourceId }, Number(version.generation),
      { seen, ...(opts.stop ? { stop: opts.stop } : {}) })) addText(block);
  }
  const found = extra.filter(row => produced.has(tupleKey(row)) || (superseded.has(tupleKey(row)) && hasExtractorDetail(row)))
    .map(({ detail: _detail, ...row }) => row);
  if (!found.length) return [];
  // W1 #6783 §12 (a): a row more trusted than the page's restatement, or held by an open contest, stays; the owner decides.
  const [{ contestHeldRows, heldRows }, { derivedWriteTrust }, { storedTrustTier }] = await Promise.all([
    import('./trust/fence-guard.ts'), import('./trust/taint.ts'), import('./trust/tier.ts')]);
  const [page] = await engine.executeRaw<{ id: number; trust_tier: string | null }>('SELECT id, trust_tier FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  const writer = derivedWriteTrust({ channel: 'derive:timeline', inputs: page ? [{ table: 'pages', id: Number(page.id), tier: storedTrustTier(page.trust_tier) }] : [], projection: true }).tier;
  const held = await heldRows(engine as BrainEngine, 'timeline_entries', found.map(row => Number(row.id)), { writer, pending: true });
  const orphans = found.filter(row => !held.has(Number(row.id)));
  if (opts.dryRun) return orphans;
  await contestHeldRows(engine as BrainEngine, { sourceId, slug, table: 'timeline_entries', proposer: 'timeline_reconcile', writer,
    rows: [...held].map(([id, tier]) => ({ id, tier, change: 'removed' as const })) });
  if (!orphans.length) return orphans;
  const remove = (db: Pick<BrainEngine, 'executeRaw'>) => db.executeRaw(
    `DELETE FROM timeline_entries WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)::int)`,
    [JSON.stringify(orphans.map(row => row.id))]);
  if (opts.expectedRevision === undefined) {
    await remove(engine);
    return orphans;
  }
  const expected = opts.expectedRevision;
  return (engine as BrainEngine).transaction(async tx => {
    const [current] = await tx.executeRaw<{ revision: string }>(
      'SELECT knowledge_revision::text AS revision FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR SHARE', [sourceId, slug]);
    if (current?.revision !== expected) return [];
    await remove(tx);
    return orphans;
  });
}

/**
 * Retract a page's removed rows against its stored text: a segmented body is read block by block, keeping only the
 * keys of its stored rows (segmentedTimelineText `within`, a TimelineKeySet), and the rows are streamed, not held.
 */
async function retractStoredPage(engine: BrainEngine, page: { id: number; slug: string; source_id: string; compiled_truth: string; timeline: string | null; body_storage: string },
  opts: { dryRun?: boolean; expectedRevision?: string }) {
  if (page.body_storage !== 'segmented') return retractRemovedTimelineEntries(engine, page.slug, page.source_id, `${page.compiled_truth}\n${page.timeline ?? ''}`, opts);
  const within = new TimelineKeySet();
  await eachStoredTimelineRow(engine, page.id, row => within.add(tupleKey(row)));
  if (!within.size) return [];
  const keys = await segmentedTimelineText(engine, page, { within, entries: false });
  return retractRemovedTimelineEntries(engine, page.slug, page.source_id, keys, { ...opts, storedRows: await unkeptTimelineRows(engine, page.id, keys) });
}

export interface TimelineOrphanPruneResult {
  pagesScanned: number;
  orphans: number;
  removed: number;
  examples: Array<{ source_id: string; slug: string; date: string; summary: string }>;
}

/**
 * Managed brains guard `timeline_entries`: the retraction runs as a coordinated
 * write under the page lock, against the text read inside that transaction.
 */
async function retractCoordinated(engine: BrainEngine, pageId: number, slug: string, sourceId: string) {
  const { withCoordinatedWrite } = await import('./persistence/context.ts');
  const { maintenanceAttribution } = await import('./persistence/attribution.ts');
  const attribution = await maintenanceAttribution(engine);
  return engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const [page] = await tx.executeRaw<{ compiled_truth: string; timeline: string | null; body_storage: string }>(
      'SELECT compiled_truth, timeline, body_storage FROM pages WHERE id = $1 AND deleted_at IS NULL', [pageId]);
    if (!page) return [];
    return retractStoredPage(tx, { ...page, id: pageId, slug, source_id: sourceId }, {});
  }, attribution));
}

/**
 * One-time prune of timeline rows orphaned before extraction reconciled them
 * (#4649): runs the reconciliation above against each page's stored text for
 * every live page that holds timeline rows, optionally scoped to one source
 * and capped at `limit` pages (the doctor check samples; the CLI prunes all).
 */
export async function pruneTimelineOrphans(
  engine: BrainEngine,
  opts: { sourceId?: string; dryRun: boolean; limit?: number; coordinated?: boolean },
): Promise<TimelineOrphanPruneResult> {
  const result: TimelineOrphanPruneResult = { pagesScanned: 0, orphans: 0, removed: 0, examples: [] };
  let afterId = 0;
  for (;;) {
    const pageSize = Math.min(200, (opts.limit ?? Infinity) - result.pagesScanned);
    if (pageSize <= 0) break;
    const params: unknown[] = [afterId, pageSize];
    if (opts.sourceId) params.push(opts.sourceId);
    const pages = await engine.executeRaw<{ id: number; slug: string; source_id: string; compiled_truth: string; timeline: string | null; body_storage: string; revision: string }>(
      `SELECT p.id, p.slug, p.source_id, p.compiled_truth, p.timeline, p.body_storage, p.knowledge_revision::text AS revision FROM pages p
        WHERE p.id > $1 AND p.deleted_at IS NULL${opts.sourceId ? ' AND p.source_id = $3' : ''}
          AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = p.id AND t.event_page_id IS NULL)
        ORDER BY p.id LIMIT $2`, params);
    if (!pages.length) break;
    for (const page of pages) {
      const orphans = opts.coordinated && !opts.dryRun
        ? await retractCoordinated(engine, page.id, page.slug, page.source_id)
        : await retractStoredPage(engine, page, { dryRun: opts.dryRun, expectedRevision: page.revision });
      result.orphans += orphans.length;
      if (!opts.dryRun) result.removed += orphans.length;
      for (const row of orphans.slice(0, Math.max(0, 5 - result.examples.length))) {
        result.examples.push({ source_id: page.source_id, slug: page.slug, date: row.date, summary: row.summary });
      }
    }
    result.pagesScanned += pages.length;
    afterId = pages[pages.length - 1]!.id;
  }
  return result;
}
