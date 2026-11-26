/**
 * Open loops: the upsert, list and close members (BrainEngine upsertOpenLoop, listOpenLoops, closeOpenLoop), the entity
 * card's open-loop read (readEntityOpenLoops, over the list read), over
 * `rust/crates/gbrain-store/src/facts/loops.rs`. The store returns times as ISO text; these members turn them into
 * Dates, as the SQL engines return them, and loops-store.ts normalizes the rows the same way on every engine.
 *
 * Times sent to the store: ISO text ending in `Z` with at most 6 fractional digits passes as written. An ISO time
 * with an offset (`+02:00`) and at most 3 fractional digits is rewritten through `Date#toISOString`, unless its date
 * names a day the calendar lacks (`02-30`): that goes as written and the store refuses it, as PGLite does (Postgres,
 * through postgres.js, reads it as the next valid day: TODOS.md). Any other
 * spelling (a bare date, a time with no zone) refuses with `invalid_argument`, where Postgres would read it in the
 * session time zone (rust/docs/store/facts.md).
 */
import type { BrainEngine } from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const LOOP_DATES = ['due_at', 'opened_at', 'last_activity_at', 'closed_at', 'created_at', 'updated_at'];
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?[+-]\d{2}:\d{2}$/;

/** The time as the store reads it. A spelling neither form covers goes as written, and the store refuses it. */
function storeTime(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (UTC_ISO.test(value) || !OFFSET_ISO.test(value)) return value;
  if (!calendarExists(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

/** True when the date of an offset time is a day the calendar has: `Date.parse` carries 02-30 over to 03-02, where Postgres refuses it. */
function calendarExists(value: string): boolean {
  const [, y, mo, d] = /^(\d{4})-(\d{2})-(\d{2})/.exec(value) ?? [];
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return day.getUTCFullYear() === Number(y) && day.getUTCMonth() === Number(mo) - 1 && day.getUTCDate() === Number(d);
}

/** `string_to_array($1, ',')` over the joined ids: null reads every source, an empty string matches none. */
function sourceIdList(ids: readonly string[] | undefined): string[] | null {
  if (!ids || ids.length === 0) return null;
  const joined = ids.join(',');
  return joined === '' ? [] : joined.split(',');
}

const toRow = (row: Record<string, unknown>) => withDates(row, LOOP_DATES);

export const upsertOpenLoop: Member<'upsertOpenLoop'> = (brain, loop) => {
  const m = 'upsertOpenLoop';
  const input = {
    sourceId: loop.sourceId,
    dedupKey: loop.dedupKey,
    loopType: loop.loopType,
    counterpartySlug: loop.counterpartySlug ?? null,
    counterpartySourceId: loop.counterpartySlug ? (loop.counterpartySourceId ?? null) : null,
    counterpartyEmail: loop.counterpartyEmail ?? null,
    summary: loop.summary,
    // The jsonb value the SQL engines store: what JSON.stringify writes, read back.
    evidence: JSON.parse(JSON.stringify(loop.evidence)) as unknown,
    threadId: loop.threadId ?? null,
    pageSlug: loop.pageSlug ?? null,
    dueAt: storeTime(loop.dueAt),
    detector: loop.detector,
    confidence: loop.confidence ?? 1.0,
    factId: loop.factId ?? null,
    lastActivityAt: storeTime(loop.lastActivityAt),
    openedAt: storeTime(loop.openedAt),
  };
  return storeCall({ member: m, sourceId: loop.sourceId }, () => brain.upsertOpenLoop(input));
};

export const closeOpenLoop: Member<'closeOpenLoop'> = async (brain, sourceId, id, status, closedBy) => {
  const row: Record<string, unknown> | null = await storeCall({ member: 'closeOpenLoop', sourceId: sourceId ?? undefined },
    () => brain.closeOpenLoop(sourceId, id, status, closedBy));
  return row ? toRow(row) : null;
};

export const listOpenLoops: Member<'listOpenLoops'> = async (brain, opts = {}) => {
  const query = {
    sourceIds: sourceIdList(opts.sourceIds),
    status: opts.status ?? null,
    loopType: opts.loopType ?? null,
    counterparty: opts.counterparty ?? null,
    counterpartySourceId: opts.counterpartySourceId ?? null,
    loopId: opts.loopId ?? null,
    limit: Math.min(Math.max(opts.limit ?? 200, 1), 1000),
  };
  const rows: Record<string, unknown>[] = await storeCall({ member: 'listOpenLoops' }, () => brain.listOpenLoops(query));
  return rows.map(toRow);
};

/** `countOpenLoopsByCounterpartyEmail`: the store's per-email count of the source's open loops of that type, with no limit. */
export const countOpenLoopsByCounterpartyEmail: Member<'countOpenLoopsByCounterpartyEmail'> = async (brain, sourceId, emails, loopType) => {
  if (emails.length === 0) return [];
  const rows: Array<{ email: string; n: number }> = await storeCall({ member: 'countOpenLoopsByCounterpartyEmail' },
    () => brain.countOpenLoopsByCounterpartyEmail(sourceId, [...emails], loopType));
  return rows.map(r => ({ email: r.email, n: Number(r.n) }));
};

/**
 * `readEntityOpenLoops` over the store's list read: the open loops whose counterparty page is the slug in the source.
 * The list read also matches a counterparty email equal to the slug, in any source, so the shim keeps only rows whose
 * counterparty slug and counterparty source (the loop's own source when unset) both match, before the limit. The list
 * read returns at most 1,000 rows; when it is full and the kept rows do not reach the limit, an older matching loop may
 * lie past it, so the member refuses rather than return a short card. Ties on activity order by id descending.
 */
export const readEntityOpenLoops: Member<'readEntityOpenLoops'> = async (brain, slug, sourceId, limit) => {
  const m = 'readEntityOpenLoops';
  if (!Number.isSafeInteger(limit) || limit < 1) refuseMember(m, 'a limit that is not a positive integer');
  const query = { sourceIds: null, status: 'open', loopType: null, counterparty: slug, counterpartySourceId: sourceId, loopId: null, limit: 1000 };
  const rows: Record<string, unknown>[] = await storeCall({ member: m, sourceId }, () => brain.listOpenLoops(query));
  const kept = rows.filter(r => r.counterparty_slug === slug && (r.counterparty_source_id ?? r.source_id) === sourceId);
  if (rows.length >= query.limit && kept.length < limit) refuseMember(m, 'more than 1,000 open loops match the slug as a page or an email');
  return kept.slice(0, limit).map(toRow).map(r => ({
    id: r.id as number, loop_type: r.loop_type as string, summary: r.summary as string,
    due_at: r.due_at as Date | null, last_activity_at: r.last_activity_at as Date, fact_id: r.fact_id as number | null,
  }));
};
