/**
 * The producer half of shadow follow (plan PR 1): turns the wrapper's view of primary writes into invalidation
 * batches (invalidations.ts), published once the write is durable.
 *
 * A write member is planned from its arguments (write-map.ts) BEFORE the primary call: page refs become page ids and,
 * for a member that can delete or re-key rows, the primary keys of the rows its selector matches are read first, on the
 * same engine object (the transaction engine inside a transaction, in a nested transaction, which is a savepoint, so a failed read cannot abort it). The primary call then runs untouched and its
 * outcome is returned as is. Items go to the innermost open frame: a nested transaction frame merges into its parent
 * when it resolves and is dropped when it rejects, and the outermost frame publishes after the commit. A write outside
 * any transaction publishes right after it resolves; if it rejects it publishes the relation-level answer for the
 * tables it may have touched, because part of its work (a failure receipt) may have committed on its own.
 *
 * Every step here is fail-open: a planning, pre-read or publish failure becomes a relation-level item or nothing, never
 * an error for the caller, and nothing awaits the sink. Outside a transaction the pre-read and the write are not on one
 * connection, so a concurrent writer can slip a delete past the pre-read; reconcile covers that narrow race.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Invalidation, InvalidationSink } from './invalidations.ts';
import { mergeItems, publishItems } from './invalidations.ts';
import { sqlWrites } from './sql-writes.ts';
import { memberKind, PageRef, WRITE_MAP, type Target, type WriteSpec } from './write-map.ts';

export interface FollowOptions {
  sink: InvalidationSink;
}

/** Items collected inside one open transaction (or reserved connection). */
export interface Frame {
  readonly items: Invalidation[];
  readonly parent: Frame | null;
}

export interface FollowContext {
  follow: FollowOptions;
  shadowActive: () => boolean;
  /** The raw engine or transaction engine the wrapped call runs on. */
  engine: any;
  frame: Frame | null;
  inTransaction: boolean;
  /** The outermost transaction's call lane (wrapper.ts): a pre-read inside the transaction takes it, so no other statement of the transaction runs while its savepoint is open. */
  lane?: TxLane;
}

/**
 * The member calls of one outermost transaction, as the wrapper sees them. A savepoint that is rolled back undoes every statement sent on the
 * connection while it was open, whoever sent it, so a pre-read takes the lane: it waits for the calls already running, holds every later call
 * until its own write has been sent, and only then reads.
 */
export interface TxLane {
  /** Calls started and not yet settled; `callback`: the call took a function (a nested transaction, a bounded read), which may be waiting for a call held behind the gate. */
  running: Set<LaneEntry>;
  /** Set while any hold is closed; resolves when one of them opens (a waiter then checks again whether a hold still applies to it). */
  gate: Promise<void> | null;
  /** The closed holds (`holdLane`). */
  holds: LaneHold[];
  /** Calls held while a hold applies to them, in call order, each with the lane call it was made from; opening a hold starts, in order, every one no hold applies to any more. */
  waiters: Array<(() => void) & { entry?: LaneEntry }>;
}

/**
 * One closed hold on a lane. A pre-read's own hold (`except` unset) holds every later call while its savepoint is open. A pre-read that first waits for running
 * nested transactions holds every later call except those made inside one of `except`: those transactions must be able to finish, and the write waiting for them
 * keeps its place ahead of the transaction's later calls, as the driver's queue kept it.
 */
export interface LaneHold { except?: LaneEntry[] }

/** How long a pre-read waits for the calls already running on its transaction before it gives up (the item is then relation-level). */
export const PRE_READ_WAIT_MS = 2_000;

export const newTxLane = (): TxLane => ({ running: new Set(), gate: null, holds: [], waiters: [] });

/** One member call in a lane. `parent`: the lane call it was started from (a call inside a nested transaction's callback has that transaction's entry). */
export interface LaneEntry { callback: boolean; done: Promise<void>; parent?: LaneEntry; /** Set while this call's pre-read waits for these running nested transactions: a call started inside one of them never waits for it. */ waitingFor?: LaneEntry[] }
/** True when `entry` is `of` or was started, at any depth, from inside it. */
export const startedWithin = (entry: LaneEntry | undefined, of: LaneEntry): boolean => { for (let e = entry; e; e = e.parent) if (e === of) return true; return false; };

/** The lane entry of the member call running now (wrapper.ts `laned` runs each call inside it), so a pre-read never counts its own call among the calls ahead of it. */
export const laneCall = new AsyncLocalStorage<LaneEntry>();

/** True when a closed hold of `lane` applies to a call made from `entry` (the lane call running where it is made; none at the transaction's own level). */
export const laneHeld = (lane: TxLane, entry: LaneEntry | undefined): boolean => lane.holds.some((h) => !h.except?.some((n) => startedWithin(entry, n)));

const gateSignals = new WeakMap<TxLane, () => void>();
const resetGate = (lane: TxLane): void => {
  gateSignals.get(lane)?.();
  if (!lane.holds.length) { lane.gate = null; gateSignals.delete(lane); return; }
  lane.gate = new Promise<void>((r) => { gateSignals.set(lane, r); });
};

/**
 * Closes a hold on `lane` (every later call, or every later call made outside `except`); the returned function opens it (once) and starts, in call order, each
 * held call no other hold applies to, so a call one of them starts that closes a hold again keeps the calls after it waiting.
 */
export function holdLane(lane: TxLane, except?: LaneEntry[]): () => void {
  const hold: LaneHold = except ? { except } : {};
  lane.holds.push(hold);
  resetGate(lane);
  let opened = false;
  return () => {
    if (opened) return;
    opened = true;
    lane.holds.splice(lane.holds.indexOf(hold), 1);
    resetGate(lane);
    for (let i = 0; i < lane.waiters.length;) {
      const waiter = lane.waiters[i]!;
      if (laneHeld(lane, waiter.entry)) { i++; continue; }
      lane.waiters.splice(i, 1);
      waiter();
    }
  };
}

/** True when every call settles within `ms`. */
async function settledWithin(calls: Promise<void>[], ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.all(calls).then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); } finally { clearTimeout(timer); }
}

/** Selector-targeted rows beyond this many become one relation item. */
const MAX_TARGETS = 200;
/** Primary-key columns by relation (seed plan order); every other copied relation is keyed by `id`. */
const KEY_COLUMNS: Record<string, string[]> = {
  config: ['key'], synthesis_evidence: ['synthesis_page_id', 'take_page_id', 'take_row_num'],
  link_relationships: ['from_page_id', 'to_page_id', 'link_type', 'scope'],
  fact_purges: ['source_id', 'visibility', 'subject', 'fact_hash'],
};

const isThenable = (value: unknown): value is Promise<unknown> => !!value && typeof (value as { then?: unknown }).then === 'function';
const quote = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
const relationItems = (relations: readonly string[], reason: string): Invalidation[] => relations.map((relation) => ({ kind: 'relation', relation, reason }));

export const isFollowActive = (ctx: FollowContext): boolean => {
  try { return ctx.shadowActive(); } catch { return false; }
};

/** Whether a call on this context may collect (a transaction engine without a frame was opened while follow was off). */
const collecting = (ctx: FollowContext): boolean => isFollowActive(ctx) && (!ctx.inTransaction || ctx.frame !== null);

function collect(ctx: FollowContext, items: Invalidation[]): void {
  try {
    if (items.length === 0) return;
    if (ctx.frame) ctx.frame.items.push(...items);
    else publishItems(ctx.follow.sink, items);
  } catch { /* fail open */ }
}

/** Rows of `relation` whose `cols` equal one of `tuples` (all text), as `{ sel, out }` with `out` the `outCols` as text. */
async function selectWhere(engine: any, relation: string, cols: string[], tuples: string[][], outCols: string[]): Promise<Array<{ sel: string[]; out: string[] }>> {
  const select = [...cols.map((c, i) => `t.${quote(c)}::text AS s${i}`), ...outCols.map((c, i) => `t.${quote(c)}::text AS o${i}`)].join(', ');
  const arrays = cols.map((_, i) => `$${i + 1}::text[]`).join(', ');
  const join = cols.map((c, i) => `t.${quote(c)}::text = u.c${i}`).join(' AND ');
  const sql = `/* shadow-follow pre-read */ SELECT ${select} FROM ${quote(relation)} t JOIN unnest(${arrays}) AS u(${cols.map((_, i) => `c${i}`).join(', ')}) ON ${join}`;
  const rows = (await engine.executeRaw(sql, cols.map((_, c) => tuples.map((tuple) => tuple[c]!)))) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ sel: cols.map((_, i) => String(row[`s${i}`])), out: outCols.map((_, i) => String(row[`o${i}`])) }));
}

const pageKey = (ref: PageRef): string => `${ref.source_id}\u0000${ref.slug}`;

/** Resolves a plan's targets to row items; reads page ids and before-keys on `engine`. Throws on a query failure. */
async function resolveTargets(engine: any, targets: Target[]): Promise<Invalidation[]> {
  const refs = new Map<string, PageRef>();
  for (const target of targets) for (const value of Object.values(target.sel ?? {})) if (value instanceof PageRef) refs.set(pageKey(value), value);
  const ids = new Map<string, string>();
  if (refs.size > 0) {
    const list = [...refs.values()];
    for (const row of await selectWhere(engine, 'pages', ['source_id', 'slug'], list.map((r) => [r.source_id, r.slug]), ['id'])) ids.set(`${row.sel[0]}\u0000${row.sel[1]}`, row.out[0]!);
  }
  const items: Invalidation[] = [];
  const keyed = new Map<string, { relation: string; cols: string[]; targets: Array<{ sel: Record<string, string>; at: number }> }>();
  for (const target of targets) {
    if (!target.sel) { items.push({ kind: 'relation', relation: target.relation, reason: 'relation_level' }); continue; }
    const sel: Record<string, string> = {};
    let resolved = true;
    for (const [column, value] of Object.entries(target.sel)) {
      const text = value instanceof PageRef ? ids.get(pageKey(value)) : value;
      if (text === undefined || text === null) { resolved = false; break; }
      sel[column] = String(text);
    }
    if (!resolved) { items.push({ kind: 'relation', relation: target.relation, reason: 'page_unresolved' }); continue; }
    items.push({ kind: 'rows', relation: target.relation, selector: sel, before_keys: null });
    if (target.del) {
      const cols = Object.keys(sel).sort();
      const group = keyed.get(`${target.relation}\u0000${cols.join(',')}`) ?? { relation: target.relation, cols, targets: [] };
      group.targets.push({ sel, at: items.length - 1 });
      keyed.set(`${target.relation}\u0000${cols.join(',')}`, group);
    }
  }
  for (const group of keyed.values()) {
    const keyCols = KEY_COLUMNS[group.relation] ?? ['id'];
    const tuples = group.targets.map((t) => group.cols.map((c) => t.sel[c]!));
    const found = new Map<string, string[][]>();
    for (const row of await selectWhere(engine, group.relation, group.cols, tuples, keyCols)) {
      const key = row.sel.join('\u0000');
      found.set(key, [...(found.get(key) ?? []), row.out]);
    }
    for (const t of group.targets) (items[t.at] as Extract<Invalidation, { kind: 'rows' }>).before_keys = found.get(group.cols.map((c) => t.sel[c]!).join('\u0000')) ?? [];
  }
  return items;
}

/**
 * Plans a non-late write before its call. Never rejects: any failure is the relation-level answer. Inside a transaction the pre-read runs in a savepoint
 * while it holds the transaction's lane (`hold`, opened by the caller once the write is sent): it waits for the calls already running (at most PRE_READ_WAIT_MS),
 * and a call that runs a callback, or does not settle in time, leaves the write unread (`pre_read_busy`), because the savepoint's rollback would undo its statements.
 */
function plan(ctx: FollowContext, spec: WriteSpec, args: unknown[], hold: { open?: () => void } = {}): Invalidation[] | Promise<Invalidation[]> {
  const fallback = (reason: string): Invalidation[] => relationItems(spec.tables, reason);
  try {
    if (spec.late) return [];
    const targets = spec.plan ? spec.plan(args) : null;
    if (targets === null) return fallback('relation_level');
    if (targets.length > MAX_TARGETS) return fallback('too_many_rows');
    const needsQuery = targets.some((t) => t.del || Object.values(t.sel ?? {}).some((v) => v instanceof PageRef));
    if (!needsQuery) {
      return targets.map((t): Invalidation => t.sel
        ? { kind: 'rows', relation: t.relation, selector: t.sel as Record<string, string>, before_keys: null }
        : { kind: 'relation', relation: t.relation, reason: 'relation_level' });
    }
    if (!ctx.inTransaction) return resolveTargets(ctx.engine, targets).catch(() => fallback('pre_read_failed'));
    // Inside a transaction a failed pre-read would abort it and fail the caller's write: it runs in a nested transaction (a savepoint), alone on the connection.
    const lane = ctx.lane;
    const inSavepoint = () => (ctx.engine.transaction((savepoint: unknown) => resolveTargets(savepoint, targets)) as Promise<Invalidation[]>).catch(() => fallback('pre_read_failed'));
    if (!lane) return inSavepoint(); // a transaction the wrapper did not open (none today): as before
    const self = laneCall.getStore();
    // Never the call itself nor a transaction it runs inside: those cannot finish before it does.
    // ... nor a call whose pre-read is waiting for a nested transaction this call runs inside (they would wait for each other until the bound).
    const others = () => [...lane.running].filter((c) => !(self && startedWithin(self, c)) && !(self && c.waitingFor?.some((n) => startedWithin(self, n))));
    // Takes the lane and reads, once no call that runs a callback is ahead (one could be waiting for a call the lane would hold).
    const take = (): Invalidation[] | Promise<Invalidation[]> => {
      const ahead = others();
      if (ahead.some((c) => c.callback)) return fallback('pre_read_busy');
      const waited = hold.open; // the hold taken while waiting for a nested transaction: closed only once the full one is, so no later call slips in between
      hold.open = holdLane(lane);
      waited?.();
      return (async () => {
        try {
          if (ahead.length && !await settledWithin(ahead.map((c) => c.done), PRE_READ_WAIT_MS)) return fallback('pre_read_busy');
          return await inSavepoint();
        } catch { return fallback('plan_failed'); }
      })();
    };
    const nested = others().filter((c) => c.callback);
    if (!nested.length) return take();
    // A nested transaction is running: wait for it first, as the driver's nested-transaction queue made the savepoint read wait before. Its own calls are never
    // held, so it can finish; the transaction's later calls are, so none is sent ahead of this write (the driver queued them behind it too). A nested
    // transaction still running after the bound may be waiting for one of those later calls: the hold opens, and this write waits one more bound with the
    // lane open, as it did before the hold existed (sent now, it would run inside the nested savepoint, whose rollback would undo it). Only a nested
    // transaction still running after that leaves this write relation-level, sent at once.
    return (async () => {
      if (self) self.waitingFor = nested;
      hold.open = holdLane(lane, nested);
      try {
        const finished = () => settledWithin(nested.map((c) => c.done), PRE_READ_WAIT_MS);
        let settled = await finished();
        if (!settled) { hold.open?.(); hold.open = undefined; settled = await finished(); }
        if (self) self.waitingFor = undefined;
        return settled ? await take() : fallback('pre_read_busy');
      }
      catch { return fallback('plan_failed'); }
      finally { if (self) self.waitingFor = undefined; }
    })();
  } catch {
    return fallback('plan_failed');
  }
}

/** Items a `late` plan derives from the call's result. */
function lateItems(spec: WriteSpec, args: unknown[], result: unknown): Invalidation[] {
  try {
    if (!spec.late) return [];
    const targets = spec.plan ? spec.plan(args, result) : null;
    if (targets === null || targets.length > MAX_TARGETS) return relationItems(spec.tables, 'relation_level');
    return targets.map((t): Invalidation => ({ kind: 'rows', relation: t.relation, selector: t.sel as Record<string, string>, before_keys: null }));
  } catch {
    return relationItems(spec.tables, 'plan_failed');
  }
}

/** Runs `call`, then collects `early` (plus `late(result)`) once it resolves; a standalone rejection publishes `onReject`. */
function track(ctx: FollowContext, call: () => unknown, early: Invalidation[], late: (result: unknown) => Invalidation[], onReject: Invalidation[]): unknown {
  const rejected = (): void => { if (!ctx.inTransaction) collect(ctx, onReject); };
  let out: unknown;
  try { out = call(); } catch (error) { rejected(); throw error; }
  if (!isThenable(out)) { collect(ctx, [...early, ...late(out)]); return out; }
  return out.then((result) => { collect(ctx, [...early, ...late(result)]); return result; }, (error) => { rejected(); throw error; });
}

/** The wrapper for a member the write map covers or must report as unmapped. */
export function followWrite(ctx: FollowContext, name: string, fn: Function): Function {
  return function followedWrite(this: unknown, ...args: unknown[]) {
    const call = () => fn.apply(ctx.engine, args);
    if (!collecting(ctx)) return call();
    const kind = memberKind(name);
    if (kind !== 'mapped') {
      const item: Invalidation = { kind: 'invalid', reason: `${kind === 'schema' ? 'schema_change' : 'unmapped_write'}:${name}` };
      return track(ctx, call, [item], () => [], [item]);
    }
    const spec = WRITE_MAP[name]!;
    const rejectItems = relationItems(spec.tables, 'write_rejected');
    const hold: { open?: () => void } = {};
    const early = plan(ctx, spec, args, hold);
    // The lane opens once the write itself is sent, so the calls held behind it keep their order after it.
    const run = (items: Invalidation[]) => { try { return track(ctx, call, items, (result) => lateItems(spec, args, result), rejectItems); } finally { hold.open?.(); } };
    return isThenable(early) ? early.then(run, (error) => { hold.open?.(); throw error; }) : run(early);
  };
}

const rawCache = new Map<string, Invalidation[]>();
function rawItems(sql: unknown): Invalidation[] {
  if (typeof sql !== 'string') return [{ kind: 'invalid', reason: 'unparsable:non_string_sql' }];
  const hit = rawCache.get(sql);
  if (hit) return hit;
  const items = mergeItems(sqlWrites(sql).map((w): Invalidation => (w.kind === 'relation' ? { kind: 'relation', relation: w.relation, reason: 'raw_sql' } : { kind: 'invalid', reason: w.reason })));
  if (rawCache.size >= 256) rawCache.clear();
  rawCache.set(sql, items);
  return items;
}

/** `executeRaw` / `executeRawDirect` on `ctx.engine`: parses the SQL for write targets. */
export function followRaw(ctx: FollowContext, fn: Function): Function {
  return function followedRaw(this: unknown, ...args: unknown[]) {
    const call = () => fn.apply(ctx.engine, args);
    if (!collecting(ctx)) return call();
    let items: Invalidation[];
    try { items = rawItems(args[0]); } catch { items = [{ kind: 'invalid', reason: 'unparsable:error' }]; }
    return track(ctx, call, items, () => [], items);
  };
}

/**
 * Runs `run` with a fresh frame under `ctx.frame`. A transaction drops its items when it rejects; a reserved
 * connection keeps them (its statements may have committed on their own). On success the items go to the parent frame
 * or, for the outermost scope, out as one batch.
 */
export function followScope(ctx: FollowContext, keepOnReject: boolean, run: (frame: Frame | null) => unknown): unknown {
  if (!isFollowActive(ctx)) return run(null);
  const frame: Frame = { items: [], parent: ctx.frame };
  const flush = (): void => {
    try {
      if (frame.parent) frame.parent.items.push(...frame.items);
      else publishItems(ctx.follow.sink, frame.items);
    } catch { /* fail open */ }
  };
  let out: unknown;
  try { out = run(frame); } catch (error) { if (keepOnReject) flush(); throw error; }
  if (!isThenable(out)) { flush(); return out; }
  return out.then((value) => { flush(); return value; }, (error) => { if (keepOnReject) flush(); throw error; });
}
