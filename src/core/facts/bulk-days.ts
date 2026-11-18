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
import { DATE_TOKEN, EARLIEST } from '../engine-sql/facts-cycle.ts';

export const BULK_DAY_RULE = { min_facts: 200, min_share: 0.25, min_entities: 20 } as const;

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

/**
 * Every bulk day of the active sources (sourceIds narrows them), in (source, day) order. One read-only aggregate
 * over the sources' active facts.
 */
export async function findBulkFactDays(engine: BrainEngine, sourceIds?: string[]): Promise<BulkFactDay[]> {
  const rows = await engine.findBulkFactDays(sourceIds, BULK_DAY_RULE);
  return rows.map(row => {
    const tops = typeof row.top_sources === 'string' ? JSON.parse(row.top_sources) as Array<{ source: string; facts: number | string }> : row.top_sources ?? [];
    return { source_id: row.source_id, day: row.day, facts: Number(row.facts), entities: Number(row.entities), source_facts: Number(row.source_facts),
      top_sources: tops.map(top => ({ source: top.source, facts: Number(top.facts) })), dated_claims: Number(row.dated_claims) };
  });
}
