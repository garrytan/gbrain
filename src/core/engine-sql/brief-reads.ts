/**
 * The proactive brief's calendar, loop and page-edit reads (context/proactive-brief.ts `upcomingMeetings`,
 * `meetingCounterparties`, `loopItems` and `editItem`), which ran raw SQL through `engine.executeRaw`. One SQL
 * implementation for both engines, so the brief names typed engine members and a Rust brain can answer them. Each
 * statement is the text its call site sent at 0ea77f47bd, with the same parameters in the same order, except that
 * placeholders are numbered in the order they appear (renderFragment): the edit page and the revision read bind the
 * byte ceiling first, and the timeline read binds its start time twice. The privacy predicate renders inside the
 * engine call, in the caller's async context, as it did. The call sites keep their own fallbacks.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { ReflexPrivacy } from './reflex-reads.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import {
  privateFactFilterForCaller, privatePagesFilterForCaller, privateTimelineEventFilterForCaller,
  privateTimelineEventFilterFragment, remoteReadFloorSql,
} from '../search/private-visibility.ts';
import { pageEligibleSql, projectionEligibleSql } from '../eligibility/sql.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';

/** The read eligibility a brief read applies (absent admits every row). */
export type BriefReadEligibility = ReadEligibility;

/** A meeting page the calendar trigger may use: `start` and `account` as frontmatter text, `attendees` as JSON. */
export interface BriefMeetingPageRow { slug: string; source_id: string; start: string | null; attendees: unknown; account: string | null }

/** A live page an email alias names: the alias, and the page's slug, title and type. */
export interface BriefEmailAliasPageRow { alias_norm: string; slug: string; title: string | null; type: string | null }

/** An active world fact that backs an open loop, with its trust fields. */
export interface BriefWorldFactRow { id: number; fact: string; trust_tier: unknown; write_origin: unknown }

/** The counterparty page for the edit arm. `compiled_truth` is null when the body and timeline pass the byte ceiling. */
export interface BriefEditPageRow { id: number; compiled_truth: string | null; timeline: string | null; trust_tier: unknown; write_origin: unknown }

/** The newest timeline entry of a page (`date` as YYYY-MM-DD text). */
export interface BriefTimelineEntryRow { id: number; date: string; summary: string; detail: string; created_at: Date }

/** A page revision. `compiled_truth` is null when the revision passes the byte ceiling (or is a segmented shell). */
export interface BriefPageVersionRow { id: number; compiled_truth: string | null; timeline: string | null; snapshot_at: Date; is_deleted: boolean }

/** Options of the edit-arm reads: the privacy and the read eligibility (absent admits every row). */
export interface BriefEditReadOpts { privacy: ReflexPrivacy; eligibility?: ReadEligibility }

/**
 * The live, world-visible, eligible meeting pages of `sourceIds` whose frontmatter `start` text lies in
 * [`startFrom`, `startTo`] (text comparison, the caller's day-wide prefilter). No set order.
 */
export async function readBriefMeetingPages(raw: EngineRawRead, sourceIds: readonly string[], startFrom: string, startTo: string,
  eligibility?: ReadEligibility): Promise<BriefMeetingPageRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug, p.source_id, p.frontmatter->>'start' AS start, p.frontmatter->'attendees' AS attendees, p.frontmatter->>'account' AS account
       FROM pages p
      WHERE p.deleted_at IS NULL AND p.type = 'meeting' AND p.source_id = ANY(${[...sourceIds]}::text[])
        AND p.frontmatter->>'start' >= ${startFrom} AND p.frontmatter->>'start' <= ${startTo}
        AND ${trustedSql(remoteReadFloorSql('p'))} AND ${trustedSql(pageEligibleSql('p', eligibility))}`);
  return raw<BriefMeetingPageRow>(text, params);
}

/** One row per alias row of the source whose `alias_norm` is in `emails` and whose live page the read floor and eligibility admit. */
export async function readBriefEmailAliasPages(raw: EngineRawRead, sourceId: string, emails: readonly string[],
  eligibility?: ReadEligibility): Promise<BriefEmailAliasPageRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT a.alias_norm, p.slug, p.title, p.type FROM page_aliases a
       JOIN pages p ON p.source_id = a.source_id AND p.slug = a.slug AND p.deleted_at IS NULL
      WHERE a.source_id = ${sourceId} AND a.alias_norm = ANY(${[...emails]}::text[])
        AND ${trustedSql(remoteReadFloorSql('p'))} AND ${trustedSql(pageEligibleSql('p', eligibility))}`);
  return raw<BriefEmailAliasPageRow>(text, params);
}

/** The facts among `factIds` that are active, world-visible, not of private provenance for the caller, and eligible. No set order. */
export async function readBriefWorldFacts(raw: EngineRawRead, factIds: readonly number[], eligibility?: ReadEligibility): Promise<BriefWorldFactRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT facts.id, facts.fact, facts.trust_tier, facts.write_origin FROM facts
        WHERE facts.id = ANY(${[...factIds]}::bigint[]) AND facts.expired_at IS NULL AND facts.visibility = 'world'
          AND ${trustedSql(privateFactFilterForCaller('facts'))}
          AND ${trustedSql(projectionEligibleSql('facts', 'facts', eligibility))}`);
  const rows = await raw<BriefWorldFactRow & { id: number | string }>(text, params);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

/** The live page at (source, slug) under the privacy and eligibility, or null; its body is null past `maxBytes`. */
export async function readBriefEditPage(raw: EngineRawRead, sourceId: string, slug: string, maxBytes: number,
  opts: BriefEditReadOpts): Promise<BriefEditPageRow | null> {
  const privacy = opts.privacy === 'none' ? 'TRUE' : opts.privacy === 'caller' ? privatePagesFilterForCaller('p') : remoteReadFloorSql('p');
  const { text, params } = renderFragment(sqlFragment`SELECT p.id, CASE WHEN octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) <= ${maxBytes} THEN p.compiled_truth END AS compiled_truth,
            p.timeline, p.trust_tier, p.write_origin
       FROM pages p
      WHERE p.source_id = ${sourceId} AND p.slug = ${slug} AND p.deleted_at IS NULL
        AND ${trustedSql(privacy)}
        AND ${trustedSql(pageEligibleSql('p', opts.eligibility))}`);
  const [row] = await raw<BriefEditPageRow & { id: number | string }>(text, params);
  return row ? { ...row, id: Number(row.id) } : null;
}

/**
 * The page's newest timeline entry recorded at or after `since` (ISO) and dated on or after its date, under the
 * event-page privacy and the projection eligibility, or null. Newest by created_at, then date, then id.
 */
export async function readBriefTimelineEntry(raw: EngineRawRead, pageId: number, since: string,
  opts: BriefEditReadOpts): Promise<BriefTimelineEntryRow | null> {
  const privacy = opts.privacy === 'none' ? 'TRUE' : opts.privacy === 'caller' ? privateTimelineEventFilterForCaller('te') : privateTimelineEventFilterFragment('te');
  const { text, params } = renderFragment(sqlFragment`SELECT te.id, te.date::text AS date, te.summary, te.detail, te.created_at FROM timeline_entries te
        WHERE te.page_id = ${pageId} AND te.created_at >= ${since}::timestamptz AND te.date >= ${since}::timestamptz::date
          AND ${trustedSql(privacy)}
          AND ${trustedSql(projectionEligibleSql('timeline_entries', 'te', opts.eligibility))}
        ORDER BY te.created_at DESC, te.date DESC, te.id DESC LIMIT 1`);
  const [row] = await raw<Omit<BriefTimelineEntryRow, 'id' | 'created_at'> & { id: number | string; created_at: string | Date }>(text, params);
  return row ? { ...row, id: Number(row.id), created_at: new Date(row.created_at) } : null;
}

/** The page's newest `limit` revisions snapshotted at or after `since` (ISO), newest first; a body is null past `maxBytes`. */
export async function readBriefPageVersions(raw: EngineRawRead, pageId: number, since: string, maxBytes: number,
  limit: number): Promise<BriefPageVersionRow[]> {
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) throw new RangeError(`readBriefPageVersions: limit must be a positive integer, got ${limit}`);
  const { text, params } = renderFragment(sqlFragment`SELECT v.id, CASE WHEN octet_length(v.compiled_truth) + octet_length(COALESCE(v.timeline, '')) <= ${maxBytes} THEN v.compiled_truth END AS compiled_truth,
              v.timeline, v.snapshot_at, v.is_deleted
         FROM page_versions v WHERE v.page_id = ${pageId} AND v.snapshot_at >= ${since}::timestamptz
        ORDER BY v.id DESC LIMIT ${trustedSql(`${limit}`)}`);
  const rows = await raw<Omit<BriefPageVersionRow, 'id' | 'snapshot_at'> & { id: number | string; snapshot_at: string | Date }>(text, params);
  return rows.map(r => ({ ...r, id: Number(r.id), snapshot_at: new Date(r.snapshot_at) }));
}
