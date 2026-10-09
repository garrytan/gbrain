// src/core/extract-timeline-from-meetings.ts
// v0.41.18.0 (A11, T8). Walk meeting pages, identify discussed entities via
// (a) existing `attended` links (attendees) + (b) body-mention scan, and
// write a timeline entry on each entity page with a meeting-specific source
// key that survives v99's widened dedup.
//
// Codex finding #11 dependency: requires v99 dedup widening from
// (page_id, date, summary) to (page_id, date, summary, source). Without v99,
// two meetings on the same date with the same summary on the same entity
// page would silently drop the second one.
//
// #6273: `timeline_entries` is a guarded table. A managed brain publishes
// each entity page's new rows as database-only maintenance requests
// (`managed_maintenance_meeting_timeline`, 200 rows at most per request) under
// that page's key; a page with no new row admits no request. Unmanaged brains
// keep the batched raw insert.

import type { BrainEngine } from './engine.ts';
import type { TimelineBatchInput } from './engine.ts';
import { buildGazetteer, findMentionedEntities, type Gazetteer } from './by-mention.ts';
import { isCrossSourceLinksEnabled } from './link-extraction.ts';
import { computeEffectiveDate } from './effective-date.ts';
import { parseFrontmatter } from './backfill-effective-date.ts';
import { isPrivatePage } from './search/private-visibility.ts';
import { quarantineFilterFragment } from './quarantine.ts';
import { OperationError, opError } from './ops/contract.ts';
import { managedPersistenceEnabled } from './persistence/ownership.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent, type MaintenanceAuthority } from './persistence/prepared-maintenance.ts';
import { authorizeWrite } from './persistence/authority.ts';
import { getWriteRequest } from './persistence/journal.ts';
import { isTerminal, type WriteRequest } from './persistence/model.ts';
import { digest } from './persistence/digest.ts';
import type { PreparedMutation } from './persistence/coordinator.ts';
import { timelineKey } from './timeline-marker.ts';

export interface ExtractTimelineFromMeetingsOpts {
  dryRun?: boolean;
  sourceIdFilter?: string;
  /** Only scan meetings with updated_at after this ISO date. */
  since?: string;
  /** Optional pre-built gazetteer (for shared-walk callers). */
  gazetteer?: Gazetteer;
  onProgress?: (done: number, total: number, created: number) => void;
}

export interface ExtractTimelineFromMeetingsResult {
  meetings_scanned: number;
  entries_created: number;
  /** Distinct entity pages that received at least one new timeline entry. */
  entities_touched: number;
  /**
   * #2057: batches that failed to insert. Previously swallowed by a bare
   * `catch {}`, which let a brain-wide timeline-write failure read as a clean
   * "0 entries" run. Non-zero here means inserts are failing — surfaced on
   * stderr too. On a managed brain each refused page counts as one.
   */
  batch_errors: number;
  /** First batch-insert error message, when batch_errors > 0. */
  first_batch_error?: string;
  /**
   * Managed: pages not confirmed written because the writer was busy. The
   * first one's request was accepted and commits later; the rest of that
   * source were not submitted. A rerun writes or confirms them.
   */
  pages_pending?: number;
  /** Managed: pages that kept changing while their rows were submitted; the next run writes them. */
  pages_skipped?: number;
}

export const MEETING_TIMELINE_INTENT = 'managed_maintenance_meeting_timeline';
const SOURCE_KEY_PREFIX = 'extract-timeline-from-meetings:';
/** The fields a meeting row carries; the target page is the request's own key. */
type MeetingTimelineRow = Pick<TimelineBatchInput, 'date' | 'source' | 'summary'>;

interface MeetingRow {
  slug: string;
  source_id: string;
  title: string;
  effective_date: string | Date | null;
  frontmatter: unknown;
  import_filename: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  compiled_truth: string;
  timeline: string;
}

interface AttendedEdgeRow {
  meeting_slug: string;
  meeting_source_id: string;
  attendee_slug: string;
  attendee_source_id: string;
}

const BATCH_SIZE = 200;
// gbrain-base-v2 catch-all retypes old meeting pages to note while
// preserving legacy_type, so this extractor treats those rows as meetings.
const MEETING_PAGE_PREDICATE =
  `(type = 'meeting' OR (type = 'note' AND frontmatter ->> 'legacy_type' = 'meeting'))`;
const MEETING_EDGE_PREDICATE =
  `(meeting.type = 'meeting' OR (meeting.type = 'note' AND meeting.frontmatter ->> 'legacy_type' = 'meeting'))`;

export async function extractTimelineFromMeetings(
  engine: BrainEngine,
  opts: ExtractTimelineFromMeetingsOpts = {},
): Promise<ExtractTimelineFromMeetingsResult> {
  const dryRun = opts.dryRun ?? false;
  const sinceMs = opts.since ? new Date(opts.since).getTime() : null;

  // 1. Fetch all meeting pages (one round-trip).
  const sourceFilter = opts.sourceIdFilter ? `AND source_id = $1` : '';
  const meetingParams = opts.sourceIdFilter ? [opts.sourceIdFilter] : [];
  const meetings = await engine.executeRaw<MeetingRow>(
    `SELECT slug, source_id, title, effective_date, frontmatter, import_filename,
            created_at, updated_at, compiled_truth, COALESCE(timeline, '') AS timeline
       FROM pages
      WHERE ${MEETING_PAGE_PREDICATE}
        AND deleted_at IS NULL
        AND ${quarantineFilterFragment('pages')}
        ${sourceFilter}
      ORDER BY effective_date DESC NULLS LAST, slug`,
    meetingParams,
  );

  if (meetings.length === 0) {
    return { meetings_scanned: 0, entries_created: 0, entities_touched: 0, batch_errors: 0 };
  }

  // 2. Fetch all 'attended' edges (one brain-wide round-trip — the SQL is NOT
  // source-scoped; rows are filtered in JS to the loaded meetings below).
  // Build a Map<meetingKey → attendees[]> for O(1) attendee lookup per meeting.
  const meetingKeys = new Set(meetings.map((m) => `${m.source_id}::${m.slug}`));
  const attendedEdges = await engine.executeRaw<AttendedEdgeRow>(
    `SELECT meeting.slug AS meeting_slug, meeting.source_id AS meeting_source_id,
            attendee.slug AS attendee_slug, attendee.source_id AS attendee_source_id
       FROM links l
       JOIN pages meeting ON meeting.id IN (l.from_page_id, l.to_page_id)
       JOIN pages attendee ON attendee.id = CASE WHEN meeting.id = l.from_page_id
         THEN l.to_page_id ELSE l.from_page_id END
      WHERE l.link_type = 'attended'
        AND ${MEETING_EDGE_PREDICATE}
        AND attendee.type = 'person'
        AND meeting.deleted_at IS NULL
        AND attendee.deleted_at IS NULL`,
  );
  const attendeesByMeeting = new Map<string, AttendedEdgeRow[]>();
  for (const e of attendedEdges) {
    const key = `${e.meeting_source_id}::${e.meeting_slug}`;
    if (!meetingKeys.has(key)) continue;
    const list = attendeesByMeeting.get(key);
    if (list) list.push(e);
    else attendeesByMeeting.set(key, [e]);
  }

  // 3. For each meeting, derive entity mentions (gazetteer-based) + merge
  // with attendee edges. Each (meeting, entity) produces ONE timeline row.
  const gazetteer = opts.gazetteer ?? await buildGazetteer(engine);
  const allowCrossSource = await isCrossSourceLinksEnabled(engine);

  const batch: TimelineBatchInput[] = [];
  let entriesCreated = 0;
  const entitiesTouched = new Set<string>();
  let meetingsScanned = 0;
  let dateFallbacks = 0;
  let undated = 0;
  let privateSkipped = 0;
  let batchErrors = 0;
  let firstBatchError: string | undefined;
  // Managed: the walk collects each entity page's rows and publishes them once at the end.
  const pageRows = !dryRun && await managedPersistenceEnabled(engine) ? new Map<string, TimelineBatchInput[]>() : null;

  async function flush() {
    if (batch.length === 0) return;
    if (pageRows) {
      for (const row of batch) {
        const key = `${row.source_id}::${row.slug}`;
        const rows = pageRows.get(key);
        if (rows) rows.push(row);
        else pageRows.set(key, [row]);
      }
    } else if (!dryRun) {
      try {
        entriesCreated += await engine.addTimelineEntriesBatch(batch);
      } catch (e) {
        // #2057: do NOT swallow. A bare `catch {}` here hid a brain-wide
        // timeline-write failure (the run reported 0 entries with no error).
        // Count + surface it on stderr; the per-meeting loop still continues so
        // one bad batch isn't fatal to the rest.
        batchErrors += 1;
        const msg = e instanceof Error ? e.message : String(e);
        if (!firstBatchError) firstBatchError = msg;
        console.error(`[extract timeline] batch insert failed (${batch.length} row(s)): ${msg}`);
      }
    } else {
      entriesCreated += batch.length;
    }
    batch.length = 0;
  }

  for (const meeting of meetings) {
    if (sinceMs !== null) {
      const updatedMs = new Date(meeting.updated_at).getTime();
      if (Number.isFinite(updatedMs) && updatedMs <= sinceMs) continue;
    }
    const frontmatter = parseFrontmatter(meeting.frontmatter);
    // A private meeting must not fan its title/slug/date out onto other pages'
    // timelines: the row carries no event_page_id (the (event_page_id, date)
    // unique index allows one row per event, not one per attendee), so the
    // remote private-event filter could never hide it. Fail closed: skip.
    if (isPrivatePage({ frontmatter })) { privateSkipped++; continue; }
    // put_page-written pages never get effective_date computed (column stays
    // NULL); derive it exactly as `gbrain backfill effective_date` would —
    // same filename recipe (import_filename, else the slug tail) — so a later
    // backfill + re-run dedups against this row instead of doubling it. The
    // 'fallback' source is updated_at/created_at: an import timestamp, never
    // the meeting's date. A row dated from it would survive dedup as a twin of
    // the correctly dated row, so such meetings are skipped, not dated.
    // The column reads back as a Date, which the batch insert stored as its UTC day
    // (JSON text cast to date); keep that day as YYYY-MM-DD so managed requests carry it too.
    let date = meeting.effective_date
      ? (meeting.effective_date instanceof Date ? meeting.effective_date.toISOString() : String(meeting.effective_date)).slice(0, 10)
      : null;
    if (!date) {
      const { date: computed, source } = computeEffectiveDate({
        slug: meeting.slug,
        frontmatter,
        filename: meeting.import_filename || meeting.slug.split('/').pop()!,
        createdAt: new Date(meeting.created_at),
        updatedAt: new Date(meeting.updated_at),
      });
      if (!computed || source === 'fallback') { undated++; continue; }
      date = computed.toISOString().slice(0, 10);
      dateFallbacks++;
    }

    meetingsScanned++;
    opts.onProgress?.(meetingsScanned, meetings.length, entriesCreated);

    const meetingKey = `${meeting.source_id}::${meeting.slug}`;
    const summary = `Discussed in ${meeting.title}`;
    const sourceKey = `${SOURCE_KEY_PREFIX}${meeting.slug}`;

    // Attendees (from 'attended' links). An edge into ANOTHER source fans out
    // only under `link_resolution.cross_source` — the same gate the mention
    // lane below applies (the edge fetch above is brain-wide, not scoped).
    const attendees = attendeesByMeeting.get(meetingKey) ?? [];
    const targets = new Map<string, { slug: string; source_id: string }>();
    for (const e of attendees) {
      if (!allowCrossSource && e.attendee_source_id !== meeting.source_id) continue;
      targets.set(`${e.attendee_source_id}::${e.attendee_slug}`, {
        slug: e.attendee_slug,
        source_id: e.attendee_source_id,
      });
    }

    // Body mentions (gazetteer-based). Skip self-mention (meeting page
    // referencing itself by title). Mentions of entities in ANOTHER source
    // are dropped by findMentionedEntities unless the operator opted in via
    // `link_resolution.cross_source` (same switch as wikilink resolution).
    const body = meeting.compiled_truth + '\n\n' + meeting.timeline;
    if (body.trim()) {
      const mentions = findMentionedEntities(body, gazetteer, {
        fromSlug: meeting.slug,
        fromSourceId: meeting.source_id,
        allowCrossSource,
      });
      for (const m of mentions) {
        targets.set(`${m.source_id}::${m.slug}`, {
          slug: m.slug,
          source_id: m.source_id,
        });
      }
    }

    // Emit one timeline row per (entity, this meeting).
    for (const t of targets.values()) {
      batch.push({
        slug: t.slug,
        source_id: t.source_id,
        date,
        source: sourceKey,
        summary,
      });
      entitiesTouched.add(`${t.source_id}::${t.slug}`);
      if (batch.length >= BATCH_SIZE) await flush();
    }
  }

  await flush();
  const published = pageRows ? await publishMeetingTimeline(engine, pageRows) : null;
  if (published) {
    entriesCreated += published.created;
    batchErrors += published.refused;
    firstBatchError ??= published.firstError;
  }
  if (published?.pending) {
    console.error(`[extract timeline] ${published.pending} page(s) not confirmed written (writer busy); rerun the same command to write or confirm them.`);
  }
  if (published?.skipped) {
    console.error(`[extract timeline] ${published.skipped} page(s) kept changing during the run and were left for the next run.`);
  }
  if (dateFallbacks > 0) {
    console.error(
      `[extract timeline] ${dateFallbacks} meeting(s) have no effective_date column value; dated from their frontmatter date or filename instead. ` +
      `Run \`gbrain backfill effective_date\` to persist it.`,
    );
  }
  if (undated > 0) {
    console.error(
      `[extract timeline] ${undated} meeting(s) skipped: no date in frontmatter or filename (import timestamps are never used as the meeting date). ` +
      `Add a \`date:\` field or a YYYY-MM-DD filename prefix.`,
    );
  }
  if (privateSkipped > 0) {
    console.error(
      `[extract timeline] ${privateSkipped} visibility: private meeting(s) skipped: a timeline row on another page cannot be hidden from remote readers.`,
    );
  }
  return {
    meetings_scanned: meetingsScanned,
    entries_created: entriesCreated,
    entities_touched: entitiesTouched.size,
    batch_errors: batchErrors,
    first_batch_error: firstBatchError,
    ...(published?.pending ? { pages_pending: published.pending } : {}),
    ...(published?.skipped ? { pages_skipped: published.skipped } : {}),
  };
}

function writeError(error: unknown): string {
  if (error instanceof OperationError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A meeting row's identity on its page: the whitespace-normalized timeline key.
 * A later write of the page files a database-only row back into its body with
 * collapsed whitespace, so an exact comparison would re-add a meeting whose
 * title has doubled spaces after every such write.
 */
function storedKey(sourceId: string, slug: string, row: MeetingTimelineRow): string {
  return `${sourceId}::${slug}::${timelineKey(row)}`;
}

/** Every stored meeting row in the brain, read once per run. */
async function storedMeetingKeys(engine: BrainEngine): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ source_id: string; slug: string; date: string; summary: string; source: string }>(
    `SELECT p.source_id, p.slug, to_char(t.date, 'YYYY-MM-DD') AS date, t.summary, t.source
       FROM timeline_entries t JOIN pages p ON p.id = t.page_id
      WHERE t.source LIKE $1 AND p.deleted_at IS NULL`, [`${SOURCE_KEY_PREFIX}%`]);
  return new Set(rows.map(r => storedKey(r.source_id, r.slug, r)));
}

/**
 * Managed brains: each entity page's rows not yet stored publish under that
 * page's key, BATCH_SIZE rows per request. A refused page is counted and
 * reported, and the other pages still publish. Once a source's writer is busy
 * (a request still pending after its wait), the rest of that source's pages
 * are left for a rerun instead of filling the writer's request queue. Pages of
 * an archived source are skipped: it accepts no maintenance.
 */
async function publishMeetingTimeline(engine: BrainEngine, pageRows: Map<string, TimelineBatchInput[]>) {
  const outcome = { created: 0, refused: 0, pending: 0, skipped: 0, firstError: undefined as string | undefined };
  const stored = await storedMeetingKeys(engine);
  const archived = new Set((await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived')).map(r => r.id));
  const busy = new Set<string>();
  const authorities = new Map<string, Promise<MaintenanceAuthority>>();
  const authorityFor = (sourceId: string) => {
    if (!authorities.has(sourceId)) authorities.set(sourceId, maintenancePreflight(engine, sourceId).then(a => a!));
    return authorities.get(sourceId)!;
  };
  for (const rows of pageRows.values()) {
    const { slug, source_id: sourceId = 'default' } = rows[0]!;
    if (archived.has(sourceId)) continue;
    const fresh: MeetingTimelineRow[] = [];
    for (const { date, source = '', summary } of rows) {
      const key = storedKey(sourceId, slug, { date, source, summary });
      if (stored.has(key)) continue;
      stored.add(key);
      fresh.push({ date, source, summary });
    }
    if (!fresh.length) continue;
    if (busy.has(sourceId)) { outcome.pending++; continue; }
    let submitted = 0;
    try {
      const authority = await authorityFor(sourceId);
      let result: number | 'pending' | 'skipped' = 0;
      for (; submitted < fresh.length && typeof result === 'number'; submitted += BATCH_SIZE) {
        result = await publishPageRows(engine, authority, slug, sourceId, fresh.slice(submitted, submitted + BATCH_SIZE));
        if (typeof result === 'number') outcome.created += result;
      }
      if (result === 'pending') { outcome.pending++; busy.add(sourceId); }
      else if (result === 'skipped') outcome.skipped++;
    } catch (e) {
      const message = writeError(e);
      outcome.refused++;
      outcome.firstError ??= message;
      console.error(`[extract timeline] refused for ${sourceId}:${slug}; ${fresh.length - submitted} of its ${fresh.length} new row(s) not written: ${message}`);
    }
  }
  return outcome;
}

/**
 * One request for one page: the rows it adds (0 when the page is gone),
 * 'pending' when the accepted request has not committed yet, 'skipped' when
 * the page kept changing. The request id is bound to the page revision and
 * the rows, so a rerun replays a request that is still pending instead of
 * admitting a second one. A finished request under the same id is not
 * replayed: its rows are missing again (deleted since, or it failed), so the
 * next attempt admits a new one.
 */
async function publishPageRows(engine: BrainEngine, authority: MaintenanceAuthority, slug: string, sourceId: string,
  rows: MeetingTimelineRow[]): Promise<number | 'pending' | 'skipped'> {
  for (let attempt = 0, changed = 0; ; attempt++) {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    if (!snapshot) return 0;
    const h = digest(['extract-timeline-from-meetings-v1', sourceId, slug, snapshot.revision, rows, attempt]);
    const requestId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
    if (prior && isTerminal(prior)) continue;
    try {
      const receipt = await submitDatabaseMaintenanceIntent(engine, authority, slug,
        { kind: MEETING_TIMELINE_INTENT, expected_revision: snapshot.revision, rows }, requestId);
      return Number(receipt.added ?? 0);
    } catch (error) {
      if (error instanceof OperationError && error.code === 'write_pending') return 'pending';
      // The rows do not depend on the entity page's body: re-read it and submit against the new revision.
      if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed'].includes(error.code)) {
        if (++changed >= 3) return 'skipped';
        continue;
      }
      throw error;
    }
  }
}

function meetingPageChanged(row: WriteRequest, message: string): OperationError {
  return opError('page_identity_changed', message,
    `Page ${row.slug} in source ${row.source_id} changed before its meeting timeline rows were written, so nothing was written for it. Run gbrain extract timeline --from-meetings --source db --source-id ${row.source_id} again to write them under a new request.`);
}

/** The intent's rows, refused unless each is a meeting row this pass produces. */
function intentRows(row: WriteRequest): MeetingTimelineRow[] {
  const rows = (row.intent as { rows?: unknown } | null)?.rows;
  const valid = Array.isArray(rows) && rows.length > 0 && rows.length <= BATCH_SIZE && rows.every(r =>
    r !== null && typeof r === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(String((r as MeetingTimelineRow).date))
    && typeof (r as MeetingTimelineRow).source === 'string' && (r as MeetingTimelineRow).source!.startsWith(SOURCE_KEY_PREFIX)
    && typeof (r as MeetingTimelineRow).summary === 'string' && (r as MeetingTimelineRow).summary.trim() !== '');
  if (!valid) {
    throw opError('invalid_params', 'The meeting timeline request carries no valid rows.',
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} must carry 1 to ${BATCH_SIZE} dated meeting rows, so nothing was written. Run gbrain extract timeline --from-meetings --source db again to plan them from the current meetings.`);
  }
  return (rows as MeetingTimelineRow[]).map(({ date, source, summary }) => ({ date, source, summary }));
}

/** Preparer for `managed_maintenance_meeting_timeline`: a database-only publication on the entity page's key. */
export async function prepareMeetingTimeline(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const rows = intentRows(row);
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== Number(row.page_id)) throw meetingPageChanged(row, 'The page was deleted or replaced before its meeting timeline rows were written.');
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  return { observedRevision: snapshot.revision, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => {
      const current = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id });
      if (!current || current.page.id !== Number(row.page_id)) throw meetingPageChanged(row, 'The page disappeared before its meeting timeline rows were written.');
      const added = await tx.addTimelineEntriesBatch(rows.map(r => ({ ...r, slug: row.slug, source_id: row.source_id, detail: '' })));
      return { status: 'completed', added };
    } };
}
