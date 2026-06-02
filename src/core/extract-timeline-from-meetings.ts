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
}

interface MeetingRow {
  slug: string;
  source_id: string;
  title: string;
  effective_date: string | null;
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
    `SELECT slug, source_id, title, effective_date, updated_at,
            compiled_truth, COALESCE(timeline, '') AS timeline
       FROM pages
      WHERE type = 'meeting'
        AND deleted_at IS NULL
        ${sourceFilter}
      ORDER BY effective_date DESC NULLS LAST, slug`,
    meetingParams,
  );

  if (meetings.length === 0) {
    return { meetings_scanned: 0, entries_created: 0, entities_touched: 0 };
  }

  // 2. Fetch all 'attended' edges (one round-trip, scoped to the loaded
  // meeting source_ids). Build a Map<meetingSlug → attendees[]> for O(1)
  // attendee lookup per meeting.
  const meetingKeys = new Set(meetings.map((m) => `${m.source_id}::${m.slug}`));
  const attendedEdges = await engine.executeRaw<AttendedEdgeRow>(
    `SELECT pf.slug AS from_slug, pf.source_id AS from_source_id,
            pt.slug AS to_slug, pt.source_id AS to_source_id
       FROM links l
       JOIN pages pf ON pf.id = l.from_page_id
       JOIN pages pt ON pt.id = l.to_page_id
      WHERE l.link_type = 'attended'
        AND pf.type = 'meeting'
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

  const batch: TimelineBatchInput[] = [];
  let entriesCreated = 0;
  const entitiesTouched = new Set<string>();
  let meetingsScanned = 0;

  async function flush() {
    if (batch.length === 0) return;
    if (!dryRun) {
      try {
        entriesCreated += await engine.addTimelineEntriesBatch(batch);
      } catch {
        // batch error — drop; per-meeting progress continues
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
    if (!meeting.effective_date) continue; // can't write a timeline entry without a date

    meetingsScanned++;
    opts.onProgress?.(meetingsScanned, meetings.length, entriesCreated);

    const meetingKey = `${meeting.source_id}::${meeting.slug}`;
    const summary = `Discussed in ${meeting.title}`;
    const sourceKey = `extract-timeline-from-meetings:${meeting.slug}`;

    // Attendees (from 'attended' links).
    const attendees = attendeesByMeeting.get(meetingKey) ?? [];
    const targets = new Map<string, { slug: string; source_id: string }>();
    for (const e of attendees) {
      targets.set(`${e.to_source_id}::${e.to_slug}`, {
        slug: e.to_slug,
        source_id: e.to_source_id,
      });
    }

    // Body mentions (gazetteer-based). Skip self-mention (meeting page
    // referencing itself by title). The cross-source guard in
    // findMentionedEntities already drops mentions targeting a different
    // source than the gazetteer entry was built from.
    const body = meeting.compiled_truth + '\n\n' + meeting.timeline;
    if (body.trim()) {
      const mentions = findMentionedEntities(body, gazetteer, {
        fromSlug: meeting.slug,
        fromSourceId: meeting.source_id,
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
        date: meeting.effective_date,
        source: sourceKey,
        summary,
      });
      entitiesTouched.add(`${t.source_id}::${t.slug}`);
      if (batch.length >= BATCH_SIZE) await flush();
    }
  }

  await flush();
  return {
    meetings_scanned: meetingsScanned,
    entries_created: entriesCreated,
    entities_touched: entitiesTouched.size,
  };
}
