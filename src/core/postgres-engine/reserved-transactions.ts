import type postgres from '#postgres';
import type { BrainEngine, TransactionOptions } from '../engine.ts';
import { READ_WRITE_BEGIN } from './read-write-transactions.ts';

/**
 * Phase 4.4: what `PostgresEngine.withReservedConnection` adds to its
 * `ReservedConnection`: one transaction at a time on the reserved backend,
 * with `transaction()`'s semantics. Its prepared statements stay on the
 * connection, so a caller that keeps the reservation reuses them. PGLite's
 * reserved connection has none.
 */
export interface ReservedTransactions { transaction<T>(fn: (engine: BrainEngine) => Promise<T>, opts?: TransactionOptions): Promise<T> }

/**
 * Phase 4.4: `begin` for one reserved postgres.js connection, as `sql.begin`
 * runs it on a pooled one: BEGIN READ WRITE (#7183), the callback with a handle whose
 * `savepoint` nests (rolled back to on error, like postgres.js), COMMIT, and
 * ROLLBACK on failure. BEGIN and SAVEPOINT are sent with the statements that
 * follow them instead of a round trip ahead (the server still runs them
 * first). A COMMIT the server answers with ROLLBACK (an earlier statement
 * failed unobserved) is an error, never a silent success.
 *
 * Not BEGIN on a pool that does not pipeline (`max_pipeline` 0, a
 * transaction-mode pooler, #6543): there the body starts after BEGIN's answer.
 * A pooler can refuse a BEGIN (no server connection in time) and answer the
 * statements behind it in autocommit, so a body sent with it could commit its
 * writes outside the transaction; #6930's in-transaction pipelining would
 * otherwise send them.
 *
 * GBRA-156: `begin({ first }, fn)` makes the one exception the driver's
 * `sql.begin({ first })` makes. There the body starts at once, but only its
 * first statement goes out before BEGIN's answer, and only when `first`
 * accepts its text and every argument is a plain value
 * (`isPersistenceDeclaration`: transaction-local settings, a no-op in
 * autocommit). Every other statement, savepoints included, waits for the
 * answer in order, and a refused BEGIN rejects them unsent. The hold sits on
 * each query's `handler`, which postgres.js calls when the query is executed.
 */
export function reservedTransactions(reserved: postgres.ReservedSql): ReturnType<typeof postgres> {
  const settle = async <T>(marker: Promise<unknown>, body: Promise<T>): Promise<T> => {
    const [opened, ran] = await Promise.allSettled([marker, body]);
    if (opened.status === 'rejected') throw opened.reason;
    if (ran.status === 'rejected') throw ran.reason;
    return ran.value;
  };
  const begin = async (options: BeginOptions | Body, body?: Body) => {
    const fn = typeof options === 'function' ? options : body!;
    const first = typeof options === 'function' ? undefined : options.first;
    const pipelines = Number((reserved.options as { max_pipeline?: number } | undefined)?.max_pipeline) > 0;
    let savepoints = 0;
    let gate: ((query: HeldQuery) => HeldQuery) | null = null;
    const handle = Object.assign(reserved, {
      savepoint: async (inner: (child: unknown) => Promise<unknown>) => {
        const name = `s${savepoints++}`;
        const scope = gate ? gated(handle, gate) as typeof handle : handle;
        const marker = scope.unsafe(`savepoint ${name}`).execute();
        try { return await settle(marker, Promise.resolve().then(() => inner(scope))); }
        catch (error) { if (await marker.then(() => true, () => false)) await reserved.unsafe(`rollback to ${name}`); throw error; }
      },
    });
    const opened = reserved.unsafe(READ_WRITE_BEGIN).execute();
    if (!pipelines && first) gate = holdBehind(opened, first);
    const afterBegin = pipelines || gate ? Promise.resolve() : opened;
    let result: unknown;
    try { result = await settle(opened, afterBegin.then(() => fn(gate ? gated(handle, gate) : handle))); }
    catch (error) { await reserved.unsafe('rollback').catch(() => reserved.discard()); throw error; }
    const done = await reserved.unsafe('commit') as unknown as { command?: string };
    if (done.command !== 'COMMIT') throw Object.assign(new Error('The transaction was rolled back at commit.'), { code: '25P02' });
    return result;
  };
  return { begin } as unknown as ReturnType<typeof postgres>;
}

type Body = (handle: unknown) => Promise<unknown>;
type BeginOptions = { first?: (statement: string) => boolean };
/** The parts of a postgres.js query the hold reads and replaces. */
type HeldQuery = { strings: unknown; args: unknown[]; handler: (query: HeldQuery) => unknown; reject(error: unknown): void };

const plainValue = (x: unknown): boolean => x === null || x === undefined || ['string', 'number', 'bigint', 'boolean'].includes(typeof x)
  || x instanceof Date || x instanceof Uint8Array || (Array.isArray(x) && x.every(plainValue));

/** GBRA-156: each query's send waits for `opened`, except a first one `first` accepts with only plain-value arguments. */
function holdBehind(opened: Promise<unknown>, first: (statement: string) => boolean): (query: HeldQuery) => HeldQuery {
  let answered = false;
  let firstSeen = false;
  opened.then(() => { answered = true; }, () => undefined);
  return query => {
    const send = query.handler;
    query.handler = q => {
      if (answered) return send(q);
      const strings = Array.isArray(q.strings) ? q.strings as string[] : [String(q.strings)];
      const early = !firstSeen && strings.length > 0 && q.args.every(plainValue) && first(strings.reduce((a, s, i) => a + '$' + i + s));
      firstSeen = true;
      if (early) return send(q);
      opened.then(() => send(q), error => q.reject(error));
    };
    return query;
  };
}

/** The handle a held body sees: its statements (tagged, `unsafe`, `file`) pass through `gate`; everything else is the reserved connection's. */
function gated(handle: object, gate: (query: HeldQuery) => HeldQuery): unknown {
  return new Proxy(handle as (...args: unknown[]) => unknown, {
    apply: (target, self, args) => gate(Reflect.apply(target, self, args) as HeldQuery),
    get: (target, key) => {
      const value = Reflect.get(target, key, target);
      return key === 'unsafe' || key === 'file' ? (...args: unknown[]) => gate((value as (...a: unknown[]) => HeldQuery)(...args)) : value;
    },
  });
}

