/**
 * Open loops: the upsert, list and close members (BrainEngine upsertOpenLoop, listOpenLoops, closeOpenLoop), the entity
 * card's open-loop read (readEntityOpenLoops, over the list read), and the
 * `loops_close` retry read closedLoopWithActiveFact and the loop-fact retirement scan loopFactDrift (engine-sql/facts-repair.ts), over
 * `rust/crates/gbrain-store/src/facts/loops.rs`. The store returns times as ISO text; these members turn them into
 * Dates, as the SQL engines return them, and loops-store.ts normalizes the rows the same way on every engine.
 *
 * Times sent to the store: ISO text ending in `Z` with at most 6 fractional digits passes as written. An ISO time
 * with an offset (`+02:00`) and at most 3 fractional digits is rewritten through `Date#toISOString`. Any other
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
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
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
 * `readEntityOpenLoops` over the store's list read: the open loops for the counterparty slug in the source. The list
 * read also matches a counterparty email equal to the slug, so the shim keeps only slug matches before the limit, and
 * it orders ties on activity by id descending where the SQL engines leave them unordered.
 */
export const readEntityOpenLoops: Member<'readEntityOpenLoops'> = async (brain, slug, sourceId, limit) => {
  const m = 'readEntityOpenLoops';
  if (!Number.isSafeInteger(limit) || limit < 1) refuseMember(m, 'a limit that is not a positive integer');
  const query = { sourceIds: null, status: 'open', loopType: null, counterparty: slug, counterpartySourceId: sourceId, loopId: null, limit: 1000 };
  const rows: Record<string, unknown>[] = await storeCall({ member: m, sourceId }, () => brain.listOpenLoops(query));
  return rows.filter(r => r.counterparty_slug === slug).slice(0, limit).map(toRow).map(r => ({
    id: r.id as number, loop_type: r.loop_type as string, summary: r.summary as string,
    due_at: r.due_at as Date | null, last_activity_at: r.last_activity_at as Date, fact_id: r.fact_id as number | null,
  }));
};

/** `closedLoopWithActiveFact`: the closed loop whose commitment fact is still active, or null. The id binds as `bigint`. */
export const closedLoopWithActiveFact: Member<'closedLoopWithActiveFact'> = (brain, sourceId, loopId) => {
  const m = 'closedLoopWithActiveFact';
  if (!Number.isSafeInteger(loopId)) refuseMember(m, 'a loop id that is not an integer');
  return storeCall({ member: m, sourceId: sourceId ?? undefined }, () => brain.closedLoopWithActiveFact(sourceId, loopId));
};

/** `loopFactDrift`: the closed loops whose commitment fact is still active and held by no open loop, in id order. The id binds as `bigint`. */
export const loopFactDrift: Member<'loopFactDrift'> = (brain, sourceIds, loopId) => {
  const m = 'loopFactDrift';
  if (loopId !== null && !Number.isSafeInteger(loopId)) refuseMember(m, 'a loop id that is not an integer');
  return storeCall({ member: m }, () => brain.loopFactDrift(sourceIds, loopId));
};
