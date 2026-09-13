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

import type { BrainEngine } from './engine.ts';
import type { TimelineBatchInput } from './engine.ts';
import { buildGazetteer, findMentionedEntities, type Gazetteer } from './by-mention.ts';
import { isCrossSourceLinksEnabled } from './link-extraction.ts';
import { computeEffectiveDate } from './effective-date.ts';
import { parseFrontmatter } from './backfill-effective-date.ts';
import { isPrivatePage } from './search/private-visibility.ts';

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
   * stderr too.
   */
  batch_errors: number;
  /** First batch-insert error message, when batch_errors > 0. */
  first_batch_error?: string;
}

interface MeetingRow {
  slug: string;
  source_id: string;
  title: string;
  effective_date: string | null;
  frontmatter: unknown;
  import_filename: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  compiled_truth: string;
  timeline: string;
}

interface AttendedEdgeRow {
  from_slug: string;
  from_source_id: string;
  to_slug: string;
  to_source_id: string;
}

const BATCH_SIZE = 200;
// gbrain-base-v2 catch-all retypes old meeting pages to note while
// preserving legacy_type, so this extractor treats those rows as meetings.
const MEETING_PAGE_PREDICATE =
  `(type = 'meeting' OR (type = 'note' AND frontmatter ->> 'legacy_type' = 'meeting'))`;
const MEETING_EDGE_PREDICATE =
  `(pf.type = 'meeting' OR (pf.type = 'note' AND pf.frontmatter ->> 'legacy_type' = 'meeting'))`;

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
    `SELECT pf.slug AS from_slug, pf.source_id AS from_source_id,
            pt.slug AS to_slug, pt.source_id AS to_source_id
       FROM links l
       JOIN pages pf ON pf.id = l.from_page_id
       JOIN pages pt ON pt.id = l.to_page_id
      WHERE l.link_type = 'attended'
        AND ${MEETING_EDGE_PREDICATE}
        AND pf.deleted_at IS NULL
        AND pt.deleted_at IS NULL`,
  );
  const attendeesByMeeting = new Map<string, AttendedEdgeRow[]>();
  for (const e of attendedEdges) {
    const key = `${e.from_source_id}::${e.from_slug}`;
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

  async function flush() {
    if (batch.length === 0) return;
    if (!dryRun) {
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
    if (isPrivatePage(frontmatter)) { privateSkipped++; continue; }
    // put_page-written pages never get effective_date computed (column stays
    // NULL); derive it exactly as `gbrain backfill effective_date` would —
    // same filename recipe (import_filename, else the slug tail) — so a later
    // backfill + re-run dedups against this row instead of doubling it. The
    // 'fallback' source is updated_at/created_at: an import timestamp, never
    // the meeting's date. A row dated from it would survive dedup as a twin of
    // the correctly dated row, so such meetings are skipped, not dated.
    let date = meeting.effective_date;
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
    const sourceKey = `extract-timeline-from-meetings:${meeting.slug}`;

    // Attendees (from 'attended' links). An edge into ANOTHER source fans out
    // only under `link_resolution.cross_source` — the same gate the mention
    // lane below applies (the edge fetch above is brain-wide, not scoped).
    const attendees = attendeesByMeeting.get(meetingKey) ?? [];
    const targets = new Map<string, { slug: string; source_id: string }>();
    for (const e of attendees) {
      if (!allowCrossSource && e.to_source_id !== meeting.source_id) continue;
      targets.set(`${e.to_source_id}::${e.to_slug}`, {
        slug: e.to_slug,
        source_id: e.to_source_id,
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
  };
}
