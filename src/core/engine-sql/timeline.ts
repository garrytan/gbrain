/**
 * Timeline and Life Chronicle reads: one SQL implementation for both engines
 * (refactor wave 1, W1-extended). Statement text is PostgresEngine's master
 * text (SQL-text golden `sql-text/timeline.json`); PGLite runs the same
 * statements (docs/designs/refactor-wave-1/w1-inventory.md, "timeline").
 *
 * The JSONB batch insert keeps master's executeRaw path (executeRawJsonb over
 * the executor); the engine re-resolves the executor on each batchRetry
 * attempt. Every read was unscoped on master (EO4 inventory):
 * `LegacyUnscopedRead`.
 */
import type { TimelineBatchInput } from '../engine.ts';
import type {
  PageReadScope,
  TimelineEntry, TimelineInput, TimelineOpts,
  ChronicleTimelineRow, ChronicleTimelineOpts, LastSeenResult,
} from '../types.ts';
import { executeRawJsonb } from '../sql-query.ts';
import { sanitizeForJsonb, buildTimelineRows } from '../batch-rows.ts';
import { finalizeLastSeen } from '../chronicle/last-seen.ts';
import { privatePagesFilterForCaller, privateTimelineEventFilterForCaller } from '../search/private-visibility.ts';
import { PageMissingError } from '../engine-errors.ts';
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

export async function addTimelineEntry(
  exec: SqlExecutor,
    slug: string,
    entry: TimelineInput,
    opts?: { skipExistenceCheck?: boolean; sourceId?: string },
  ): Promise<boolean> {
    const sourceId = opts?.sourceId ?? 'default';
    // #4109: page resolution and insertion share ONE statement snapshot, so a
    // concurrent hard delete linearizes before the lookup (missing) or after
    // the insert (success) instead of surfacing a raw FK violation; FOR KEY
    // SHARE holds the referenced row through the insert. ON CONFLICT DO
    // NOTHING via the (page_id, date, md5(summary), source) unique index
    // (#3737: md5-keyed so long summaries fit the btree row cap).
    // #3827: the `inserted` flag makes the outcome observable — with the
    // page_exists throw below (default) a false return unambiguously means
    // "deduplicated", and under skipExistenceCheck the caller asserts the
    // page exists. Source-qualify the page-id lookup so multi-source brains
    // don't fan timeline rows out across every source containing the slug.
    // Free-text body fields are NUL + lone-surrogate sanitized (#2011) so a
    // surrogate from sliced/imported content can't reach the (later) ::jsonb
    // batch path or corrupt the row; identity fields (slug, date) are left raw.
    const [result] = (await exec.run(sqlFragment`
      WITH page_state AS (
        SELECT id FROM pages WHERE slug = ${slug} AND source_id = ${sourceId} FOR KEY SHARE
      ), inserted AS (
        INSERT INTO timeline_entries (page_id, date, source, summary, detail)
        SELECT id, ${entry.date}::date, ${sanitizeForJsonb(entry.source || '')}, ${sanitizeForJsonb(entry.summary)}, ${sanitizeForJsonb(entry.detail || '')}
        FROM page_state
        ON CONFLICT (page_id, date, md5(summary), source) DO NOTHING
        RETURNING 1
      )
      SELECT
        EXISTS(SELECT 1 FROM page_state) AS page_exists,
        EXISTS(SELECT 1 FROM inserted) AS inserted
    `)).rows;
    if (!result?.page_exists && !opts?.skipExistenceCheck) {
      throw new PageMissingError('addTimelineEntry', 'page', slug, sourceId);
    }
    return result?.inserted === true;
  }


export async function addTimelineEntriesBatch(exec: SqlExecutor, entries: TimelineBatchInput[]): Promise<number> {
    // #1861: JSONB jsonb_to_recordset instead of unnest(${arr}::text[]). Meeting
    // summary/detail/source are free text with the same array-literal crash
    // hazard as link context. See links.ts addLinksBatch for the full rationale.
    // `date` stays text in the recordset and is cast v.date::date in the SELECT,
    // exactly as the old unnest shape did.
    const rows = buildTimelineRows(entries);
    const result = await executeRawJsonb(
      exec,
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       SELECT p.id, v.date::date, v.source, v.summary, v.detail
       FROM jsonb_to_recordset(($1::jsonb)->'rows')
         AS v(slug text, date text, source text, summary text, detail text, source_id text)
       JOIN pages p ON p.slug = v.slug AND p.source_id = v.source_id AND p.deleted_at IS NULL
       ON CONFLICT (page_id, date, md5(summary), source) DO NOTHING
       RETURNING 1`,
      [],
      [{ rows }],
    );
    return result.length;
  }


export async function getTimeline(exec: LegacyUnscopedRead, slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    const limit = opts?.limit || 100;
    // #2200 (D5A): collapse the former 8-branch (sourceId × after × before)
    // cartesian tree into ONE query built from composed WHERE fragments — the
    // same postgres.js `sqlFragment`` idiom getPage/getBacklinks/listLinkSources use.
    // Scope precedence: federated sourceIds[] > scalar sourceId > unscoped. The
    // federated arm unions entries across every same-slug page in the grant.
    // (PGLite builds the equivalent via its dynamic where[]/params[] array —
    // different idiom by design, same behavior; lockstep is on result, not builder.)
    const sourceCond =
      opts?.sourceIds && opts.sourceIds.length > 0
        ? sqlFragment`AND p.source_id = ANY(${opts.sourceIds}::text[])`
        : opts?.sourceId
          ? sqlFragment`AND p.source_id = ${opts.sourceId}`
          : sqlFragment``;
    const afterCond = opts?.after ? sqlFragment`AND te.date >= ${opts.after}::date` : sqlFragment``;
    const beforeCond = opts?.before ? sqlFragment`AND te.date <= ${opts.before}::date` : sqlFragment``;
    // Cat7-1: no index leads with slug, so an unscoped `p.slug = $1` scans all
    // of pages_source_slug_key whenever statistics steer the planner to drive
    // from pages. The unscoped arm probes (source_id, slug) once per source
    // instead, in a LATERAL fenced with OFFSET 0 so no plan can reorder it.
    const pagesJoin = opts?.sourceIds?.length || opts?.sourceId
      ? sqlFragment`timeline_entries te JOIN pages p ON p.id = te.page_id`
      : sqlFragment`sources s
      CROSS JOIN LATERAL (SELECT * FROM pages WHERE source_id = s.id AND slug = ${slug} OFFSET 0) p
      JOIN timeline_entries te ON te.page_id = p.id`;
    const rows = (await exec.run(sqlFragment`
      SELECT te.* FROM ${pagesJoin}
      WHERE p.slug = ${slug} ${sourceCond} ${afterCond} ${beforeCond}
        ${opts?.excludePrivate ? trustedSql(`AND ${privatePagesFilterForCaller('p')}
          AND ${privateTimelineEventFilterForCaller('te')}`) : sqlFragment``}${opts?.eligibility ? sqlFragment` AND ${trustedSql(projectionEligibleSql('timeline_entries', 'te', opts.eligibility))}` : sqlFragment``}
      ORDER BY te.date DESC, te.id DESC LIMIT ${limit}`)).rows;
    return rows as unknown as TimelineEntry[];
  }


  // ── v0.42.x Life Chronicle (#2390) timeline reads ───────────────────────
  // Shared shape: timeline_entries JOIN depth page (deleted_at IS NULL) LEFT
  // JOIN event page; hide soft-deleted event projections (read-time, not just
  // doctor); order by COALESCE(event effective_date, UTC midnight of date)
  // for intra-day sequence. Source scope: federated sourceIds[] > scalar sourceId > unscoped.
  // ep=true: the ep LEFT JOIN carries the same scope so out-of-scope event fields null out (#2200 origin-join shape).
  // UTC pin: these four reads never follow the session TimeZone. An event's
  // effective_date prints as its UTC instant ('YYYY-MM-DD HH:MM:SS[.ffffff]+00'),
  // a plain row orders at UTC midnight of its day, and the no-date default of
  // getOnThisDay / getLastSeen is the UTC day (finalizeLastSeen counts days_ago
  // from the UTC day too). PGLite opens in the host zone; Postgres and the Rust
  // store open in theirs, so a session-zone read printed different text per engine.
const UTC_EFFECTIVE_DATE = sqlFragment`CASE WHEN isfinite(ep.effective_date)
               THEN regexp_replace((ep.effective_date AT TIME ZONE 'UTC')::text, '( BC)?$', '+00\\1')
               ELSE ep.effective_date::text END`;
const UTC_DAY_START = sqlFragment`(te.date::timestamp AT TIME ZONE 'UTC')`;
const UTC_TODAY = sqlFragment`(now() AT TIME ZONE 'UTC')::date`;
function chronicleSourceCond(opts?: PageReadScope, ep = false) {
    const privacy = opts?.excludePrivate && !ep
      ? trustedSql(`AND ${privatePagesFilterForCaller('p')} AND ${privateTimelineEventFilterForCaller('te')}`)
      : sqlFragment``;
    if (opts?.sourceIds && opts.sourceIds.length > 0)
      return ep ? sqlFragment`AND ep.source_id = ANY(${opts.sourceIds}::text[])` : sqlFragment`AND p.source_id = ANY(${opts.sourceIds}::text[]) ${privacy}`;
    if (opts?.sourceId) return ep ? sqlFragment`AND ep.source_id = ${opts.sourceId}` : sqlFragment`AND p.source_id = ${opts.sourceId} ${privacy}`;
    return privacy;
  }


export async function getTimelineForDate(exec: LegacyUnscopedRead, date: string, opts?: ChronicleTimelineOpts): Promise<ChronicleTimelineRow[]> {
    const limit = opts?.limit ?? 200;
    // ISO week (date_trunc('week') → Monday) or the single day.
    const lower = opts?.week ? sqlFragment`date_trunc('week', ${date}::date)::date` : sqlFragment`${date}::date`;
    const upper = opts?.week ? sqlFragment`(date_trunc('week', ${date}::date) + interval '6 days')::date` : sqlFragment`${date}::date`;
    const rows = (await exec.run(sqlFragment`
      SELECT te.date::text AS date, te.summary, te.detail, te.source, te.trust_tier,
             te.page_id, p.slug AS page_slug,
             te.event_page_id, ep.slug AS event_slug,
             ${UTC_EFFECTIVE_DATE} AS effective_date,
             ep.frontmatter->'event'->>'kind' AS kind
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
      LEFT JOIN pages ep ON ep.id = te.event_page_id ${chronicleSourceCond(opts, true)}
      WHERE te.date >= ${lower} AND te.date <= ${upper}
        AND (te.event_page_id IS NULL OR ep.deleted_at IS NULL)
        ${chronicleSourceCond(opts)}
      ORDER BY COALESCE(ep.effective_date, ${UTC_DAY_START}) ASC, te.id ASC
      LIMIT ${limit}`)).rows;
    return rows as unknown as ChronicleTimelineRow[];
  }


export async function getSince(exec: LegacyUnscopedRead, date: string, opts?: ChronicleTimelineOpts): Promise<ChronicleTimelineRow[]> {
    const limit = opts?.limit ?? 200;
    const kindCond = opts?.kind ? sqlFragment`AND ep.frontmatter->'event'->>'kind' = ${opts.kind}` : sqlFragment``;
    const rows = (await exec.run(sqlFragment`
      SELECT te.date::text AS date, te.summary, te.detail, te.source, te.trust_tier,
             te.page_id, p.slug AS page_slug,
             te.event_page_id, ep.slug AS event_slug,
             ${UTC_EFFECTIVE_DATE} AS effective_date,
             ep.frontmatter->'event'->>'kind' AS kind
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
      LEFT JOIN pages ep ON ep.id = te.event_page_id ${chronicleSourceCond(opts, true)}
      WHERE te.date >= ${date}::date
        AND (te.event_page_id IS NULL OR ep.deleted_at IS NULL)
        ${kindCond}
        ${chronicleSourceCond(opts)}
      ORDER BY COALESCE(ep.effective_date, ${UTC_DAY_START}) ASC, te.id ASC
      LIMIT ${limit}`)).rows;
    return rows as unknown as ChronicleTimelineRow[];
  }


export async function getOnThisDay(exec: LegacyUnscopedRead, opts?: PageReadScope & { date?: string; limit?: number }): Promise<ChronicleTimelineRow[]> {
    const limit = opts?.limit ?? 50;
    const target = opts?.date ? sqlFragment`${opts.date}::date` : UTC_TODAY;
    const rows = (await exec.run(sqlFragment`
      SELECT te.date::text AS date, te.summary, te.detail, te.source, te.trust_tier,
             te.page_id, p.slug AS page_slug,
             te.event_page_id, ep.slug AS event_slug,
             ${UTC_EFFECTIVE_DATE} AS effective_date,
             ep.frontmatter->'event'->>'kind' AS kind
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
      LEFT JOIN pages ep ON ep.id = te.event_page_id ${chronicleSourceCond(opts, true)}
      WHERE EXTRACT(MONTH FROM te.date) = EXTRACT(MONTH FROM ${target})
        AND EXTRACT(DAY FROM te.date) = EXTRACT(DAY FROM ${target})
        AND te.date < ${target}
        AND (te.event_page_id IS NULL OR ep.deleted_at IS NULL)
        ${chronicleSourceCond(opts)}
      ORDER BY te.date DESC, te.id ASC
      LIMIT ${limit}`)).rows;
    return rows as unknown as ChronicleTimelineRow[];
  }


export async function getLastSeen(exec: LegacyUnscopedRead, entitySlug: string, opts?: PageReadScope & { asof?: string }): Promise<LastSeenResult> {
    // "Seen" = the entity's own page has a timeline row, OR an event's `who`
    // array references the entity: the exact slug, or a wikilink to exactly
    // that slug ([[slug]] / [[slug|label]]). Never a substring — a slug that
    // prefixes another slug must not inherit its sightings — and LIKE
    // metacharacters in the slug are escaped.
    // "Last seen" is a PAST relation: the chronicle legitimately stores
    // future events (calendar-event is eligibility-eligible), so bound to
    // <= asof/today or a scheduled event reads as "seen today". Mirrors
    // getOnThisDay's `te.date < target` bound.
    // The newest sighting is the newest projected day (te.date is already the
    // chronicle.tz local day); the event instant only orders within a day, so
    // a late-evening event never outranks a plain row dated the next day.
    const seenThrough = opts?.asof ? sqlFragment`${opts.asof}::date` : UTC_TODAY;
    const likeSlug = entitySlug.replace(/[\\%_]/g, (c) => '\\' + c);
    const rows = (await exec.run(sqlFragment`
      SELECT te.date::text AS last_date, ep.slug AS last_event_slug
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
      LEFT JOIN pages ep ON ep.id = te.event_page_id ${chronicleSourceCond(opts, true)}
      WHERE (te.event_page_id IS NULL OR ep.deleted_at IS NULL)
        AND te.date <= ${seenThrough}
        AND (
          p.slug = ${entitySlug}
          OR (ep.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(ep.frontmatter->'event'->'who') = 'array'
                   THEN ep.frontmatter->'event'->'who' ELSE '[]'::jsonb END
            ) AS w(name)
            WHERE w.name = ${entitySlug}
               OR w.name LIKE ${'%[[' + likeSlug + ']]%'} ESCAPE '\\'
               OR w.name LIKE ${'%[[' + likeSlug + '|%'} ESCAPE '\\'
          ))
        )
        ${chronicleSourceCond(opts)}
      ORDER BY te.date DESC, COALESCE(ep.effective_date, ${UTC_DAY_START}) DESC, te.id DESC
      LIMIT 1`)).rows;
    const row = rows[0] as { last_date?: string; last_event_slug?: string } | undefined;
    return finalizeLastSeen(entitySlug, row?.last_date ?? null, row?.last_event_slug ?? null, opts?.asof);
  }


export async function upsertEventProjection(exec: SqlExecutor, opts: { depthSlug: string; eventSlug: string; date: string; summary: string; detail?: string; sourceId?: string }): Promise<{ projected: boolean }> {
    const sourceId = opts.sourceId ?? 'default';
    const rows = (await exec.run(sqlFragment`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id)
      SELECT dp.id, ${opts.date}::date, ${'life-chronicle:event:' + opts.eventSlug}, ${opts.summary}, ${opts.detail ?? ''}, ep.id
      FROM pages dp, pages ep
      WHERE dp.slug = ${opts.depthSlug} AND dp.source_id = ${sourceId}
        AND ep.slug = ${opts.eventSlug} AND ep.source_id = ${sourceId}
      ON CONFLICT (event_page_id, date) WHERE event_page_id IS NOT NULL
      DO UPDATE SET summary = EXCLUDED.summary, detail = EXCLUDED.detail,
                    page_id = EXCLUDED.page_id, source = EXCLUDED.source
      RETURNING id`)).rows;
    return { projected: rows.length > 0 };
  }


/** One stored non-event timeline row a write removes, as it was read: the row goes only while every field still matches. `removed` marks a bullet the writer dropped (a row a heal replaces is not one). */
export interface TimelineRowRemoval { id: number; date: string; source: string; summary: string; detail: string; removed: boolean }

/** One stored non-event timeline row whose detail a write refreshes: `detail` is the preimage, `next` the new text. */
export interface TimelineDetailRefresh { id: number; detail: string; next: string | undefined }

/** One timeline bullet of a page body the fence projection inserts as the page's own row (`date` is `YYYY-MM-DD`). */
export interface CanonicalTimelineRow { date: string; source: string; summary: string; detail: string }

export const REMOVE_TIMELINE_ROWS_SQL = `DELETE FROM timeline_entries t USING jsonb_to_recordset($2::text::jsonb) AS d(id integer,date date,source text,summary text,detail text,removed boolean)
        WHERE t.page_id=$1 AND t.event_page_id IS NULL AND t.id=d.id AND t.date=d.date AND t.source=d.source
          AND t.summary=d.summary AND t.detail=d.detail RETURNING t.date::text AS date, d.removed`;

export const UPDATE_TIMELINE_DETAILS_SQL = `UPDATE timeline_entries t SET detail=r.next FROM jsonb_to_recordset($2::text::jsonb) AS r(id integer,detail text,next text)
        WHERE t.page_id=$1 AND t.event_page_id IS NULL AND t.id=r.id AND t.detail=r.detail`;

/**
 * Deletes the page's own (non-event) timeline rows that `rows` name and that still match them field for field, and
 * returns each deleted row's date and `removed` mark (`BrainEngine.removeTimelineRows`). Event projections
 * (`event_page_id` set) are never touched, and a row changed since it was read stays.
 */
export async function removeTimelineRows(exec: SqlExecutor, pageId: number, rows: readonly TimelineRowRemoval[]): Promise<Array<{ date: string; removed: boolean }>> {
  return exec.executeRaw<{ date: string; removed: boolean }>(REMOVE_TIMELINE_ROWS_SQL, [pageId, JSON.stringify(rows)]);
}

const INSERT_CANONICAL_TIMELINE_SQL = `INSERT INTO timeline_entries (page_id,date,source,summary,detail)
    SELECT $1,r.date::date,r.source,r.summary,r.detail FROM jsonb_to_recordset($2::text::jsonb) AS r(ord integer,date text,source text,summary text,detail text)
    ORDER BY r.ord
    ON CONFLICT (page_id,date,md5(summary),source) DO NOTHING`;

/**
 * Inserts the page's own timeline rows in `rows` order; a row equal on (date, summary, source) to a stored row of the
 * page is skipped (`BrainEngine.insertCanonicalTimelineRows`). The page id is not checked for soft deletion.
 */
export async function insertCanonicalTimelineRows(exec: SqlExecutor, pageId: number, rows: readonly CanonicalTimelineRow[]): Promise<void> {
  await exec.executeRaw(INSERT_CANONICAL_TIMELINE_SQL, [pageId, JSON.stringify(rows.map((row, ord) => ({ ord, ...row })))]);
}

/**
 * The id of the newest timeline row of the page (deleted or not) at `slug` in `sourceId` on `date` whose summary is
 * `summary`, event rows included, or null (`BrainEngine.readNewestTimelineEntryId`): the row add_timeline_entry just
 * wrote, whose write-gate receipt it records (persistence/semantic-pages.ts). Runs in the caller's transaction.
 */
export async function readNewestTimelineEntryId(exec: SqlExecutor, sourceId: string, slug: string, date: string, summary: string): Promise<number | null> {
  const [row] = await exec.executeRaw<{ id: number | string }>(`SELECT t.id FROM timeline_entries t JOIN pages p ON p.id = t.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND t.date = $3::date AND t.summary = $4 ORDER BY t.id DESC LIMIT 1`, [sourceId, slug, date, summary]);
  return row ? Number(row.id) : null;
}

/** Replaces the detail of the page's own (non-event) rows named in `rows` with `next` when the stored detail still equals `detail` (`BrainEngine.updateTimelineDetails`). */
export async function updateTimelineDetails(exec: SqlExecutor, pageId: number, rows: readonly TimelineDetailRefresh[]): Promise<void> {
  await exec.executeRaw(UPDATE_TIMELINE_DETAILS_SQL, [pageId, JSON.stringify(rows)]);
}
