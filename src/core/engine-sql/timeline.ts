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
import { privatePagesFilterFragment, privateTimelineEventFilterFragment } from '../search/private-visibility.ts';
import { PageMissingError } from '../engine-errors.ts';
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
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
        ${opts?.excludePrivate ? trustedSql(`AND ${privatePagesFilterFragment('p')}
          AND ${privateTimelineEventFilterFragment('te')}`) : sqlFragment``}
      ORDER BY te.date DESC, te.id DESC LIMIT ${limit}`)).rows;
    return rows as unknown as TimelineEntry[];
  }


  // ── v0.42.x Life Chronicle (#2390) timeline reads ───────────────────────
  // Shared shape: timeline_entries JOIN depth page (deleted_at IS NULL) LEFT
  // JOIN event page; hide soft-deleted event projections (read-time, not just
  // doctor); order by COALESCE(event effective_date, date) for intra-day
  // sequence. Source scope: federated sourceIds[] > scalar sourceId > unscoped.
  // ep=true: the ep LEFT JOIN carries the same scope so out-of-scope event fields null out (#2200 origin-join shape).
function chronicleSourceCond(opts?: PageReadScope, ep = false) {
    const privacy = opts?.excludePrivate && !ep
      ? trustedSql(`AND ${privatePagesFilterFragment('p')} AND ${privateTimelineEventFilterFragment('te')}`)
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
      SELECT te.date::text AS date, te.summary, te.detail, te.source,
             te.page_id, p.slug AS page_slug,
             te.event_page_id, ep.slug AS event_slug,
             ep.effective_date::text AS effective_date,
             ep.frontmatter->'event'->>'kind' AS kind
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
      LEFT JOIN pages ep ON ep.id = te.event_page_id ${chronicleSourceCond(opts, true)}
      WHERE te.date >= ${lower} AND te.date <= ${upper}
        AND (te.event_page_id IS NULL OR ep.deleted_at IS NULL)
        ${chronicleSourceCond(opts)}
      ORDER BY COALESCE(ep.effective_date, te.date::timestamptz) ASC, te.id ASC
      LIMIT ${limit}`)).rows;
    return rows as unknown as ChronicleTimelineRow[];
  }


export async function getSince(exec: LegacyUnscopedRead, date: string, opts?: ChronicleTimelineOpts): Promise<ChronicleTimelineRow[]> {
    const limit = opts?.limit ?? 200;
    const kindCond = opts?.kind ? sqlFragment`AND ep.frontmatter->'event'->>'kind' = ${opts.kind}` : sqlFragment``;
    const rows = (await exec.run(sqlFragment`
      SELECT te.date::text AS date, te.summary, te.detail, te.source,
             te.page_id, p.slug AS page_slug,
             te.event_page_id, ep.slug AS event_slug,
             ep.effective_date::text AS effective_date,
             ep.frontmatter->'event'->>'kind' AS kind
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
      LEFT JOIN pages ep ON ep.id = te.event_page_id ${chronicleSourceCond(opts, true)}
      WHERE te.date >= ${date}::date
        AND (te.event_page_id IS NULL OR ep.deleted_at IS NULL)
        ${kindCond}
        ${chronicleSourceCond(opts)}
      ORDER BY COALESCE(ep.effective_date, te.date::timestamptz) ASC, te.id ASC
      LIMIT ${limit}`)).rows;
    return rows as unknown as ChronicleTimelineRow[];
  }


export async function getOnThisDay(exec: LegacyUnscopedRead, opts?: PageReadScope & { date?: string; limit?: number }): Promise<ChronicleTimelineRow[]> {
    const limit = opts?.limit ?? 50;
    const target = opts?.date ? sqlFragment`${opts.date}::date` : sqlFragment`current_date`;
    const rows = (await exec.run(sqlFragment`
      SELECT te.date::text AS date, te.summary, te.detail, te.source,
             te.page_id, p.slug AS page_slug,
             te.event_page_id, ep.slug AS event_slug,
             ep.effective_date::text AS effective_date,
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
    const seenThrough = opts?.asof ? sqlFragment`${opts.asof}::date` : sqlFragment`current_date`;
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
      ORDER BY te.date DESC, COALESCE(ep.effective_date, te.date::timestamptz) DESC, te.id DESC
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
