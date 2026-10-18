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
import { quarantineFilterFragment } from './quarantine.ts';
import { maintenanceTransaction } from './persistence/attribution.ts';
import { derivedWriteTrust } from './trust/taint.ts';
import { derivedGateConfig, derivedGateInput, recordTimelineFlag, timelineRowAllowed } from './trust/derived-gate.ts';
import { assessTimelineForGate } from './write-gate.ts';
import { storedTrustTier, type TaintInput } from './trust/tier.ts';
import { managedPersistenceEnabled } from './persistence/ownership.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent, type MaintenanceAuthority } from './persistence/prepared-maintenance.ts';
import { authorizeWrite } from './persistence/authority.ts';
import { getWriteRequest } from './persistence/journal.ts';
import { isTerminal, type WriteRequest } from './persistence/model.ts';
import { digest } from './persistence/digest.ts';
import type { PreparedMutation } from './persistence/coordinator.ts';
import { withWriteTrust } from './persistence/context.ts';
import { OperationError, opError } from './ops/contract.ts';

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
  /** #5575 B3: rows the write gate quarantined or rejected (timeline rows are skipped, not held). */
  write_gate_skipped?: number;
  /** #6273, managed brains: entity pages whose request is still pending (the rest of that source waits for a rerun). */
  pages_pending?: number;
  /** #6273, managed brains: entity pages that changed under every retry; they are extracted again next run. */
  pages_skipped?: number;
}

/** #6273: one entity page's meeting rows, published through the coordinator on a managed brain. */
export const MEETING_TIMELINE_INTENT = 'managed_maintenance_meeting_timeline';
const MEETING_SOURCE_PREFIX = 'extract-timeline-from-meetings:';
interface MeetingTimelineRow { date: string; summary: string; source: string; meeting_id: number }

interface MeetingRow {
  id: number;
  trust_tier: string | null;
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
  // #6273: timeline_entries is guarded on a managed brain; its rows go through one coordinated request per entity page.
  const managed = !dryRun && await managedPersistenceEnabled(engine);
  const perPage = new Map<string, { slug: string; source_id: string; rows: MeetingTimelineRow[] }>();
  const sinceMs = opts.since ? new Date(opts.since).getTime() : null;

  // 1. Fetch all meeting pages (one round-trip).
  const sourceFilter = opts.sourceIdFilter ? `AND source_id = $1` : '';
  const meetingParams = opts.sourceIdFilter ? [opts.sourceIdFilter] : [];
  const meetings = await engine.executeRaw<MeetingRow>(
    `SELECT id, trust_tier, slug, source_id, title, effective_date, frontmatter, import_filename,
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
  // #5575 I2: the rows restate their meeting (no model), so a batch holds one meeting tier and is stamped with it.
  const batchInputs: TaintInput[] = [];
  const gateCfg = await derivedGateConfig(engine);
  let gateSkipped = 0;
  let entriesCreated = 0;
  const entitiesTouched = new Set<string>();
  let meetingsScanned = 0;
  let dateFallbacks = 0;
  let undated = 0;
  let privateSkipped = 0;
  let batchErrors = 0;
  let firstBatchError: string | undefined;

  async function flush() {
    if (batch.length === 0) { batchInputs.length = 0; return; }
    if (!dryRun) {
      try {
        const trust = derivedWriteTrust({ channel: 'derive:meeting_timeline', inputs: batchInputs, projection: true });
        // #5575 B3: the meeting title lands on other pages, so each row passes the write gate at the meeting's tier.
        const kept = batch.map(row => ({ row, assessment: assessTimelineForGate(row, derivedGateInput(trust), gateCfg) })).filter(r => timelineRowAllowed(r.assessment));
        gateSkipped += batch.length - kept.length;
        entriesCreated += kept.length === 0 ? 0 : await maintenanceTransaction(engine, async tx => {
          const count = await tx.addTimelineEntriesBatch(kept.map(r => r.row));
          for (const r of kept) await recordTimelineFlag(tx, r.assessment, r.row);
          return count;
        }, trust);
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
    batchInputs.length = 0;
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
    const input: TaintInput = { table: 'pages', id: Number(meeting.id), tier: storedTrustTier(meeting.trust_tier) };
    if (managed) {
      // The intent is JSON: the stored day the unmanaged `::date` cast would keep, as YYYY-MM-DD.
      const day = (date as unknown) instanceof Date ? (date as unknown as Date).toISOString().slice(0, 10) : String(date).slice(0, 10);
      for (const t of targets.values()) {
        const key = `${t.source_id}::${t.slug}`;
        const page = perPage.get(key) ?? { ...t, rows: [] };
        page.rows.push({ date: day, summary, source: sourceKey, meeting_id: Number(meeting.id) });
        perPage.set(key, page);
      }
      continue;
    }
    if (targets.size && batchInputs.length && batchInputs[0].tier !== input.tier) await flush();
    if (targets.size) batchInputs.push(input);
    for (const t of targets.values()) {
      batch.push({
        slug: t.slug,
        source_id: t.source_id,
        date,
        source: sourceKey,
        summary,
      });
      entitiesTouched.add(`${t.source_id}::${t.slug}`);
      if (batch.length >= BATCH_SIZE) { await flush(); batchInputs.push(input); }
    }
  }

  await flush();
  const published = managed ? await publishMeetingTimelines(engine, perPage, gateCfg) : null;
  if (published) {
    entriesCreated = published.created;
    gateSkipped += published.gateSkipped;
    for (const key of published.touched) entitiesTouched.add(key);
    batchErrors += published.errors;
    firstBatchError ??= published.firstError;
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
    entities_touched: published ? published.touched.size : entitiesTouched.size,
    batch_errors: batchErrors,
    first_batch_error: firstBatchError,
    ...(gateSkipped ? { write_gate_skipped: gateSkipped } : {}),
    ...(published?.pending ? { pages_pending: published.pending } : {}),
    ...(published?.skipped ? { pages_skipped: published.skipped } : {}),
  };
}

/** The write gate at each row's meeting tier (#5575 B3): kept rows with their assessments, and how many it withheld. */
function gateMeetingRows(rows: Array<MeetingTimelineRow & { slug: string; source_id: string }>, tiers: Map<number, string | null>,
  cfg: Awaited<ReturnType<typeof derivedGateConfig>>) {
  const kept: Array<{ row: TimelineBatchInput; assessment: ReturnType<typeof assessTimelineForGate>; tierKey: string }> = [];
  for (const row of rows) {
    const tier = storedTrustTier(tiers.get(row.meeting_id) ?? null);
    const trust = derivedWriteTrust({ channel: 'derive:meeting_timeline', inputs: [{ table: 'pages', id: row.meeting_id, tier }], projection: true });
    const entry = { slug: row.slug, source_id: row.source_id, date: row.date, source: row.source, summary: row.summary };
    const assessment = assessTimelineForGate(entry, derivedGateInput(trust), cfg);
    if (timelineRowAllowed(assessment)) kept.push({ row: entry, assessment, tierKey: String(tier) });
  }
  return { kept, withheld: rows.length - kept.length };
}

/**
 * #6273: submit each entity page's new rows as one database-only maintenance request (at most BATCH_SIZE rows). Rows
 * already stored are not resubmitted, so a rerun admits nothing; the request id is bound to the page revision and its
 * rows, and a terminal failure moves to the next attempt. A pending request stops that source for this run.
 */
async function publishMeetingTimelines(engine: BrainEngine, perPage: Map<string, { slug: string; source_id: string; rows: MeetingTimelineRow[] }>,
  cfg: Awaited<ReturnType<typeof derivedGateConfig>>) {
  const out = { created: 0, gateSkipped: 0, errors: 0, firstError: undefined as string | undefined, pending: 0, skipped: 0, touched: new Set<string>() };
  if (!perPage.size) return out;
  const stored = new Set((await engine.executeRaw<{ source_id: string; slug: string; date: string; summary: string; source: string }>(
    `SELECT p.source_id, p.slug, to_char(t.date, 'YYYY-MM-DD') AS date, t.summary, t.source FROM timeline_entries t JOIN pages p ON p.id = t.page_id
      WHERE t.source LIKE '${MEETING_SOURCE_PREFIX}%' AND p.deleted_at IS NULL`)).map(r => `${r.source_id}::${r.slug}::${r.date}::${r.summary}::${r.source}`));
  const meetingIds = [...new Set([...perPage.values()].flatMap(page => page.rows.map(row => row.meeting_id)))];
  const tiers = new Map((await engine.executeRaw<{ id: number; trust_tier: string | null }>('SELECT id, trust_tier FROM pages WHERE id = ANY($1::int[])', [meetingIds]))
    .map(r => [Number(r.id), r.trust_tier]));
  const authorities = new Map<string, MaintenanceAuthority | null>();
  const stopped = new Set<string>(), refused = new Set<string>();
  const fail = (error: unknown) => {
    out.errors++;
    const message = error instanceof Error ? error.message : String(error);
    out.firstError ??= message;
    console.error(`[extract timeline] meeting rows refused: ${message}`);
  };
  for (const page of perPage.values()) {
    if (refused.has(page.source_id)) continue;
    if (stopped.has(page.source_id)) { out.pending++; continue; }
    const fresh = [...new Map(page.rows.filter(row => !stored.has(`${page.source_id}::${page.slug}::${row.date}::${row.summary}::${row.source}`))
      .map(row => [`${row.date}::${row.summary}::${row.source}`, row])).values()];
    const gated = gateMeetingRows(fresh.map(row => ({ ...row, slug: page.slug, source_id: page.source_id })), tiers, cfg);
    out.gateSkipped += gated.withheld;
    const rows = fresh.filter(row => gated.kept.some(k => k.row.date === row.date && k.row.summary === row.summary && k.row.source === row.source));
    if (!rows.length) continue;
    let authority = authorities.get(page.source_id);
    if (authority === undefined) {
      try { authority = await maintenancePreflight(engine, page.source_id); } catch (error) { authority = null; fail(error); refused.add(page.source_id); }
      authorities.set(page.source_id, authority);
    }
    if (!authority) continue;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      const outcome = await submitPageRows(engine, authority, page, chunk);
      if (outcome === 'pending') { out.pending++; stopped.add(page.source_id); break; }
      if (outcome === 'skipped') { out.skipped++; break; }
      if (outcome instanceof Error) { fail(outcome); break; }
      out.created += outcome;
      if (outcome > 0) out.touched.add(`${page.source_id}::${page.slug}`);
    }
  }
  return out;
}

async function submitPageRows(engine: BrainEngine, authority: MaintenanceAuthority, page: { slug: string; source_id: string },
  rows: MeetingTimelineRow[]): Promise<number | 'pending' | 'skipped' | Error> {
  for (let retry = 0; retry < 3; retry++) {
    const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
    if (!snapshot) return 'skipped';
    for (let attempt = 0; ; attempt++) {
      const h = digest(['meeting-timeline-v1', page.source_id, page.slug, snapshot.revision, rows, attempt]);
      const requestId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
      const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
      if (prior && isTerminal(prior) && prior.state !== 'committed') continue;
      try {
        const receipt = await submitDatabaseMaintenanceIntent(engine, authority, page.slug,
          { kind: MEETING_TIMELINE_INTENT, expected_revision: snapshot.revision, rows }, requestId);
        return Number(receipt.added ?? 0);
      } catch (error) {
        if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed'].includes(error.code)) break;
        if (error instanceof OperationError && error.code === 'write_pending') return 'pending';
        return error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  return 'skipped';
}

function meetingRowsRefused(row: WriteRequest, message: string): OperationError {
  return opError('invalid_params', message,
    `The queued meeting timeline request for ${row.slug} in source ${row.source_id} carries rows this extractor never builds, so nothing was written. Run gbrain extract timeline --from-meetings --source db again; it rebuilds the rows from the meeting pages.`);
}

/**
 * Preparer for `managed_maintenance_meeting_timeline`: validates the queued rows, then at apply time re-reads every
 * meeting (its tier, title and slug, never the intent's) and runs the #5575 write gate at that tier, exactly as an
 * unmanaged run does. A row whose meeting moved since the walk is not written.
 */
export async function prepareMeetingTimeline(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const rows = (row.intent as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > BATCH_SIZE) throw meetingRowsRefused(row, `A meeting timeline request carries 1 to ${BATCH_SIZE} rows.`);
  for (const r of rows as Array<Partial<MeetingTimelineRow>>) {
    if (typeof r?.source !== 'string' || !r.source.startsWith(MEETING_SOURCE_PREFIX) || typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)
      || typeof r.summary !== 'string' || !r.summary.trim() || !Number.isInteger(r.meeting_id) || Number(r.meeting_id) <= 0) {
      throw meetingRowsRefused(row, 'A meeting timeline row is malformed.');
    }
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== Number(row.page_id)) throw opError('page_identity_changed', 'The page was deleted or replaced before its meeting timeline was written.',
    `Page ${row.slug} in source ${row.source_id} changed before its queued meeting timeline rows ran, so nothing was written. Run gbrain extract timeline --from-meetings --source db again.`);
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  const queued = rows as MeetingTimelineRow[];
  return { observedRevision: snapshot.revision, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => {
      const meetings = new Map((await tx.executeRaw<{ id: number; slug: string; title: string; trust_tier: string | null; frontmatter: unknown }>(
        `SELECT id, slug, title, trust_tier, frontmatter FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL AND ${MEETING_PAGE_PREDICATE}`,
        [[...new Set(queued.map(r => r.meeting_id))]])).map(m => [Number(m.id), m]));
      const current = queued.filter(r => {
        const meeting = meetings.get(r.meeting_id);
        return meeting && !isPrivatePage({ frontmatter: parseFrontmatter(meeting.frontmatter) })
          && r.source === `${MEETING_SOURCE_PREFIX}${meeting.slug}` && r.summary === `Discussed in ${meeting.title}`;
      });
      const tiers = new Map([...meetings.values()].map(m => [Number(m.id), m.trust_tier]));
      const { kept, withheld } = gateMeetingRows(current.map(r => ({ ...r, slug: row.slug, source_id: row.source_id })), tiers, await derivedGateConfig(tx));
      let added = 0;
      for (const tierKey of new Set(kept.map(k => k.tierKey))) {
        const group = kept.filter(k => k.tierKey === tierKey);
        const ids = [...new Set(current.filter(r => group.some(k => k.row.source === r.source && k.row.date === r.date)).map(r => r.meeting_id))];
        const trust = derivedWriteTrust({ channel: 'derive:meeting_timeline', projection: true,
          inputs: ids.map(id => ({ table: 'pages', id, tier: storedTrustTier(tiers.get(id) ?? null) })) });
        added += await withWriteTrust(tx, trust, async () => {
          const count = await tx.addTimelineEntriesBatch(group.map(k => k.row));
          for (const k of group) await recordTimelineFlag(tx, k.assessment, k.row);
          return count;
        });
      }
      return { status: 'completed', added, ...(withheld ? { write_gate_skipped: withheld } : {}), ...(queued.length - current.length ? { stale_rows: queued.length - current.length } : {}) };
    } };
}
