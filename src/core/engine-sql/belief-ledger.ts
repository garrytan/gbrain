
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
/** One open or moved page lifetime (`belief_page_lifetimes`); `page_id` is a hint only. */
export interface BeliefLifetimeRow { page_lifetime: string; source_incarnation: string; slug: string; page_id: number | null }

/**
 * One `belief_events` row as the append builds it: text and JSON columns are strings (`value` and `cause` canonical
 * JSON, `event_key` hex), times are ISO strings, and `ord` is the row's position in the publication.
 */
export interface BeliefEventInsertRow {
  event_key: string; source_id: string; source_incarnation: string; page_lifetime: string | null; slug: string; subject_kind: string;
  subject_key: string; event_type: string; origin: string; trust_tier: string; writer_tier: string | null; tier_basis: string; visibility: string;
  publication_id: string; ord: number; source_time: string | null; valid_from: string | null; valid_until: string | null; value: string | null;
  value_hash: string | null; prior_hash: string | null; state_hash: string; cause: string; claim_fp: string | null; purged: boolean;
  redacted_fields: string[] | null;
}

/** Inserts the rows in `ord` order, skipping an event key already recorded; returns how many were inserted. */
export async function insertBeliefEvents(exec: SqlExecutor, rows: readonly BeliefEventInsertRow[]): Promise<number> {
  const inserted = await exec.executeRaw<{ id: number }>(`INSERT INTO belief_events (event_key, source_id, source_incarnation, page_lifetime, slug, subject_kind,
      subject_key, event_type, origin, trust_tier, writer_tier, tier_basis, visibility, publication_id, ord, source_time, valid_from, valid_until,
      value, value_hash, prior_hash, state_hash, cause, claim_fp, purged, redacted_fields)
    SELECT decode(r.event_key, 'hex'), r.source_id, r.source_incarnation::uuid, r.page_lifetime::uuid, r.slug, r.subject_kind, r.subject_key, r.event_type,
      r.origin, r.trust_tier, r.writer_tier, r.tier_basis, r.visibility, r.publication_id::uuid, r.ord, r.source_time::timestamptz,
      r.valid_from::timestamptz, r.valid_until::timestamptz, r.value::jsonb, r.value_hash, r.prior_hash, r.state_hash, r.cause::jsonb, r.claim_fp,
      r.purged, r.redacted_fields
    FROM jsonb_to_recordset($1::text::jsonb) AS r(event_key text, source_id text, source_incarnation text, page_lifetime text, slug text,
      subject_kind text, subject_key text, event_type text, origin text, trust_tier text, writer_tier text, tier_basis text, visibility text,
      publication_id text, ord integer, source_time text, valid_from text, valid_until text, value text, value_hash text, prior_hash text,
      state_hash text, cause text, claim_fp text, purged boolean, redacted_fields text[])
    ORDER BY r.ord
    ON CONFLICT (event_key) DO NOTHING RETURNING id`, [JSON.stringify(rows)]);
  return inserted.length;
}

/**
 * The post-commit observation of each publication with a committed event: one clock_timestamp() for the statement, never
 * below the publication's newest recorded_at, and never replacing a mark already written.
 */
export async function markBeliefCommits(exec: SqlExecutor, publicationIds: readonly string[]): Promise<void> {
  await exec.executeRaw(`WITH t AS MATERIALIZED (SELECT clock_timestamp() AS at)
    INSERT INTO belief_commit_marks (publication_id, observed_at)
    SELECT e.publication_id, t.at FROM t, belief_events e
    WHERE e.publication_id = ANY($1::uuid[])
    GROUP BY e.publication_id, t.at HAVING max(e.recorded_at) <= t.at
    ON CONFLICT (publication_id) DO NOTHING`, [[...publicationIds]]);
}

/** The open lifetime at each (incarnation, slug) pair that has one. No set order. */
export async function readOpenBeliefLifetimes(exec: LegacyUnscopedRead, pairs: readonly { incarnation: string; slug: string }[]): Promise<BeliefLifetimeRow[]> {
  const rows = await exec.executeRaw<BeliefLifetimeRow>(`SELECT l.page_lifetime::text AS page_lifetime, l.source_incarnation::text AS source_incarnation, l.slug, l.page_id
    FROM belief_page_lifetimes l JOIN unnest($1::uuid[], $2::text[]) AS n(i, s) ON l.source_incarnation = n.i AND l.slug = n.s
    WHERE l.ended_at IS NULL`, [pairs.map(n => n.incarnation), pairs.map(n => n.slug)]);
  return rows.map(row => ({ ...row, page_id: row.page_id == null ? null : Number(row.page_id) }));
}

/** Ends the lifetime if it is still open. */
export async function endBeliefLifetime(exec: SqlExecutor, lifetime: string): Promise<void> {
  await exec.executeRaw('UPDATE belief_page_lifetimes SET ended_at = clock_timestamp() WHERE page_lifetime = $1::uuid AND ended_at IS NULL', [lifetime]);
}
