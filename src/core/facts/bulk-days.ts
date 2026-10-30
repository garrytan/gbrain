/**
 * #7247: calendar days that a bulk load stamped onto a large share of a
 * source's facts as their valid_from. A one-time backfill that wrote the day
 * it ran into every row's valid_from cell makes those facts look as if they
 * all happened that day; the dates record when the facts were loaded, not when
 * they happened. Doctor fact_bulk_dates reports such days and
 * `gbrain repair fact-claim-dates` moves the facts whose claim states its own
 * date; both detect days with findBulkFactDays, so they apply one rule.
 *
 * A bulk day of a source: a UTC calendar day of active facts' valid_from
 * holding at least min_facts facts and at least min_share of the source's
 * active facts, spread over at least min_entities distinct entity slugs.
 *
 * A claim date: the claim's only YYYY-MM-DD token (not adjacent to another
 * digit), when it is a real calendar date from 1900-01-01 up to the day before
 * the bulk day. claimDate (TypeScript) and claimDateSql (the aggregate the
 * doctor counts with) read the same token and apply the same bounds.
 */
import type { BrainEngine } from '../engine.ts';

export const BULK_DAY_RULE = { min_facts: 200, min_share: 0.25, min_entities: 20 } as const;

/** How many source tags a bulk day reports, most frequent first. */
const TOP_SOURCES = 5;

const DATE_TOKEN = '(^|[^0-9])([0-9]{4}-[0-9]{2}-[0-9]{2})(?![0-9])';
const EARLIEST = '1900-01-01';

export interface BulkFactDay {
  source_id: string;
  /** The UTC calendar day, YYYY-MM-DD. */
  day: string;
  facts: number;
  entities: number;
  /** The source's active facts, the share's denominator. */
  source_facts: number;
  top_sources: Array<{ source: string; facts: number }>;
  /** Facts of the day whose claim states exactly one ISO date earlier than the day (the date claimDate returns). */
  dated_claims: number;
}

export type ClaimDate = { date: string } | { skip: 'no_date' | 'several_dates' | 'date_not_earlier' };

/** The date a claim states for itself, judged against the bulk day it was loaded on. */
export function claimDate(claim: string, day: string): ClaimDate {
  const tokens = [...claim.matchAll(new RegExp(DATE_TOKEN, 'g'))].map(match => match[2]!);
  if (!tokens.length) return { skip: 'no_date' };
  if (tokens.length > 1) return { skip: 'several_dates' };
  const token = tokens[0]!;
  const [year, month, date] = token.split('-').map(Number) as [number, number, number];
  const real = new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) === token;
  return real && token >= EARLIEST && token < day ? { date: token } : { skip: 'date_not_earlier' };
}

/** SQL truth of claimDate(claim, day) returning a date, for a text expression claim and a date expression day. */
function claimDateSql(claim: string, day: string): string {
  const d = 'x.dates[1]';
  return `(SELECT CASE WHEN cardinality(x.dates) = 1 AND ${d} >= '${EARLIEST}' AND ${d} < to_char(${day}, 'YYYY-MM-DD')
                          AND substr(${d}, 6, 2) BETWEEN '01' AND '12' AND substr(${d}, 9, 2) BETWEEN '01' AND '31'
                     THEN to_char(make_date(substr(${d}, 1, 4)::int, substr(${d}, 6, 2)::int, 1) + (substr(${d}, 9, 2)::int - 1), 'YYYY-MM-DD') = ${d}
                     ELSE false END
               FROM (SELECT array_agg(m[2]) AS dates FROM regexp_matches(${claim}, '${DATE_TOKEN}', 'g') AS m) x)`;
}

/**
 * Every bulk day of the active sources (sourceIds narrows them), in (source, day) order. One read-only aggregate
 * over the sources' active facts.
 */
export async function findBulkFactDays(engine: BrainEngine, sourceIds?: string[]): Promise<BulkFactDay[]> {
  const rows = await engine.executeRaw<{ source_id: string; day: string; facts: number | string; entities: number | string; source_facts: number | string;
    top_sources: Array<{ source: string; facts: number | string }> | string | null; dated_claims: number | string }>(`
    WITH active AS MATERIALIZED (
      SELECT f.source_id, f.entity_slug, f.source, f.fact, (f.valid_from AT TIME ZONE 'UTC')::date AS day
        FROM facts f
       WHERE f.expired_at IS NULL
         AND f.source_id IN (SELECT id FROM sources WHERE archived IS NOT TRUE AND ($1::text[] IS NULL OR id = ANY($1::text[])))
    ), totals AS (
      SELECT source_id, count(*) AS n FROM active GROUP BY source_id
    ), bulk AS (
      SELECT a.source_id, a.day, count(*) AS n, count(DISTINCT a.entity_slug) AS entities, t.n AS source_facts
        FROM active a JOIN totals t ON t.source_id = a.source_id
       GROUP BY a.source_id, a.day, t.n
      HAVING count(*) >= $2::int AND count(*) >= t.n * $3::float8 AND count(DISTINCT a.entity_slug) >= $4::int
    )
    SELECT b.source_id, to_char(b.day, 'YYYY-MM-DD') AS day, b.n::int AS facts, b.entities::int AS entities, b.source_facts::int AS source_facts,
           (SELECT json_agg(json_build_object('source', s.source, 'facts', s.n) ORDER BY s.n DESC, s.source)
              FROM (SELECT a.source, count(*)::int AS n FROM active a WHERE a.source_id = b.source_id AND a.day = b.day
                     GROUP BY a.source ORDER BY count(*) DESC, a.source LIMIT ${TOP_SOURCES}) s) AS top_sources,
           (SELECT count(*)::int FROM active a WHERE a.source_id = b.source_id AND a.day = b.day AND ${claimDateSql('a.fact', 'b.day')}) AS dated_claims
      FROM bulk b
     ORDER BY b.source_id, b.day`, [sourceIds ?? null, BULK_DAY_RULE.min_facts, BULK_DAY_RULE.min_share, BULK_DAY_RULE.min_entities]);
  return rows.map(row => {
    const tops = typeof row.top_sources === 'string' ? JSON.parse(row.top_sources) as Array<{ source: string; facts: number | string }> : row.top_sources ?? [];
    return { source_id: row.source_id, day: row.day, facts: Number(row.facts), entities: Number(row.entities), source_facts: Number(row.source_facts),
      top_sources: tops.map(top => ({ source: top.source, facts: Number(top.facts) })), dated_claims: Number(row.dated_claims) };
  });
}
