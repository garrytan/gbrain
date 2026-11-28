/**
 * The exact count of this process's own committed row changes, per relation, on Postgres.
 *
 * The shadow seal (src/shadow/seal.ts) proves that nobody else wrote a copied relation since the follower's verified
 * point: the database's write counters (`pg_stat_user_tables.n_tup_ins/upd/del`) must have moved by exactly this
 * process's own writes. This module produces that own count. Every write-looking statement this engine sends through
 * its pools runs inside a transaction that reads the transaction's own counters
 * (`pg_stat_get_xact_tuples_inserted/updated/deleted`) once before its first write (START) and once after its last
 * (END). END - START is what the transaction adds to the global counters when it commits:
 *
 * - The transaction-level counters also hold the counts earlier transactions on the same backend left unflushed; they
 *   do not change inside a transaction (stats flush only between transactions), so the difference cancels them.
 * - Rows written by a savepoint that rolled back, `ON CONFLICT DO UPDATE` (an update), cascaded deletes and trigger
 *   writes on other relations are in both the transaction counters and the global ones.
 * - END runs `SET CONSTRAINTS ALL IMMEDIATE` first, so deferred triggers fire before it, not at COMMIT.
 * - END asks for the next stats flush to be forced (`pg_stat_force_next_flush`, Postgres 15+); the backend flushes it
 *   before it answers COMMIT, so a count enters the ledger only once the global counters already hold it.
 *
 * A count enters the ledger only when START, every statement, END and COMMIT succeeded on one backend in one transaction
 * (same pid and `now()` at START and END) and no difference is negative. Everything else is left out: a rolled-back
 * transaction, a prepared one, a write this module does not recognize, the cases `reserved` names. The
 * ledger can therefore only fall short of the real own count, never exceed it, and the seal compares for equality:
 * any write the ledger lacks, ours or another client's, leaves the counters ahead and the seal refuses.
 *
 * Off by default: `PostgresEngine.countOwnWrites` turns it on for one engine; until then this module is never entered.
 */
import type postgres from '#postgres';

type Sql = ReturnType<typeof postgres>;
type Counts = [ins: bigint, upd: bigint, del: bigint];

/** The marker a counting pool answers with its physical pool, for state kept per physical pool (pool-budget.ts). */
export const PHYSICAL_POOL: unique symbol = Symbol('gbrain.ownWrites.physicalPool');

/** The physical pool behind a counting pool; any other value is returned unchanged. */
export function physicalPool<T extends object>(pool: T): T {
  return ((pool as { [PHYSICAL_POOL]?: T })[PHYSICAL_POOL]) ?? pool;
}

/**
 * Own committed counts in buckets. A bucket is the mark count when its transaction opened (before BEGIN was sent), so
 * `since(k)` holds only transactions that opened after the `mark()` that returned `k`: each of them wrote after
 * whatever the caller read before calling `mark()`.
 */
export class OwnWriteLedger {
  private marks = 0;
  private readonly buckets = new Map<number, Map<string, Counts>>();

  /** The bucket a transaction opening now belongs to. */
  open(): number { return this.marks; }

  /** A new mark; call it right after the read the later counts are measured from returned. */
  mark(): number { return ++this.marks; }

  commit(bucket: number, counts: ReadonlyMap<string, Counts>): void {
    let into = this.buckets.get(bucket);
    for (const [name, c] of counts) {
      if (c[0] === 0n && c[1] === 0n && c[2] === 0n) continue;
      if (!into) this.buckets.set(bucket, into = new Map());
      const was = into.get(name) ?? [0n, 0n, 0n];
      into.set(name, [was[0] + c[0], was[1] + c[1], was[2] + c[2]]);
    }
  }

  /** The own counts of every transaction that opened after mark `k`, by relation name; a relation with none is absent. */
  since(k: number): Map<string, Counts> {
    const out = new Map<string, Counts>();
    for (const [bucket, counts] of this.buckets) {
      if (bucket < k) continue;
      for (const [name, c] of counts) {
        const was = out.get(name) ?? [0n, 0n, 0n];
        out.set(name, [was[0] + c[0], was[1] + c[1], was[2] + c[2]]);
      }
    }
    return out;
  }

  /** Drops the buckets below mark `k`; `since` of an older mark then falls short, which only makes a seal refuse. */
  forget(k: number): void {
    for (const bucket of [...this.buckets.keys()]) if (bucket < k) this.buckets.delete(bucket);
  }
}

/** The parts of a postgres.js Query this module touches (vendor/postgres/src/query.js). */
interface PendingQuery extends Promise<unknown> {
  handler: (q: PendingQuery) => unknown;
  strings: readonly string[];
  args: unknown[];
  options: { simple?: boolean };
  executed?: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cursorFn?: unknown;
  forEachFn?: unknown;
  onlyDescribe?: boolean;
  streaming?: unknown;
}

function isQuery(x: unknown): x is PendingQuery {
  return typeof x === 'object' && x !== null && typeof (x as PendingQuery).handler === 'function'
    && Array.isArray((x as PendingQuery).strings) && typeof (x as PendingQuery).then === 'function';
}

const LEAD = /^(?:\s+|\(|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*([a-z]+)/i;
const DML = /\b(?:insert|update|delete|merge)\b/i;

/** Whether a statement may change rows: it starts with INSERT, UPDATE, DELETE, MERGE or CALL, or WITH and names one of the first four. */
export function writeLooking(text: string): boolean {
  const lead = LEAD.exec(text)?.[1]?.toLowerCase();
  if (lead === 'insert' || lead === 'update' || lead === 'delete' || lead === 'merge' || lead === 'call') return true;
  return lead === 'with' && DML.test(text);
}

/**
 * A statement the counting can wrap: a write-looking statement whose rows come back whole. A simple-protocol text may
 * hold several statements; they all run between START and END, so they are all counted. One that ends the transaction
 * itself (an embedded COMMIT) leaves END in another transaction, and the pair is dropped.
 */
function countable(q: PendingQuery): boolean {
  return !q.cursorFn && !q.forEachFn && !q.onlyDescribe && !q.streaming && writeLooking(q.strings[0] ?? '');
}

const CONTROL = /\b(?:begin|commit|rollback|abort|end|start\s+transaction|prepare\s+transaction|savepoint|release)\b/i;

/**
 * How a raw statement moves a reserved connection's transaction: opens it, ends it with COMMIT, ends it otherwise
 * (ROLLBACK, ABORT, PREPARE TRANSACTION: nothing is booked), leaves it alone, or cannot be told (several statements
 * with transaction control among them, COMMIT AND CHAIN).
 */
function control(text: string): 'begin' | 'commit' | 'rollback' | 'other' | 'mixed' {
  const body = text.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g, ' ').replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''").trim().replace(/;\s*$/, '');
  if (body.includes(';')) return CONTROL.test(body) ? 'mixed' : 'other';
  const words = body.toLowerCase().split(/\s+/);
  const lead = words[0] ?? '';
  if (lead === 'begin' || (lead === 'start' && words[1] === 'transaction')) return 'begin';
  if (lead === 'commit' || lead === 'end') return /\band\s+chain\b/i.test(body) ? 'mixed' : (lead === 'commit' && words[1] === 'prepared' ? 'other' : 'commit');
  if (lead === 'rollback' || lead === 'abort') {
    if (/\band\s+chain\b/i.test(body)) return 'mixed';
    if (words[1] === 'prepared') return 'other';
    return words.includes('to') ? 'other' : 'rollback';
  }
  if (lead === 'prepare' && words[1] === 'transaction') return 'rollback';
  return 'other';
}

// engine-sql-ok: Postgres statistics reads for the own-write count; PGLite keeps no write counters and never counts
const COUNTS_SELECT = `SELECT pg_catalog.pg_backend_pid()::text AS pid, pg_catalog.now()::text AS at,
  pg_catalog.string_agg(pg_catalog.pg_stat_get_xact_tuples_inserted(u.r)::text || ',' || pg_catalog.pg_stat_get_xact_tuples_updated(u.r)::text
    || ',' || pg_catalog.pg_stat_get_xact_tuples_deleted(u.r)::text, ';' ORDER BY u.o) AS c`;
const COUNTS_FROM = ' FROM pg_catalog.unnest(';
const COUNTS_TAIL = '::text::oid[]) WITH ORDINALITY AS u(r, o)';
const START_STRINGS = template([`${COUNTS_SELECT}${COUNTS_FROM}`, COUNTS_TAIL]);
const END_STRINGS = template([`${COUNTS_SELECT}, pg_catalog.pg_stat_force_next_flush()::text AS f${COUNTS_FROM}`, COUNTS_TAIL]);
const IMMEDIATE_STRINGS = template(['SET CONSTRAINTS ALL IMMEDIATE']);

function template(strings: string[]): TemplateStringsArray {
  return Object.assign([...strings], { raw: [...strings] }) as unknown as TemplateStringsArray;
}

/** The text postgres.js hands an `early`/`first` test (vendor/postgres/src/index.js: `$n` for each argument). */
function statementText(strings: readonly string[]): string {
  return strings.reduce((a, s, i) => a + '$' + i + s);
}
const OWN_TEXTS = new Set([statementText(START_STRINGS), statementText(END_STRINGS), statementText(IMMEDIATE_STRINGS)]);

interface Reading { pid: string; at: string; c: string | null }
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function sameTransaction(start: unknown, end: unknown): boolean {
  const a = (start as Reading[] | undefined)?.[0], b = (end as Reading[] | undefined)?.[0];
  return !!a && !!b && a.pid === b.pid && a.at === b.at;
}

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

type Begin = (options: unknown, fn?: (tx: Sql) => unknown) => Promise<unknown>;

/** One transaction's START/END state, shared by the transaction handle and its savepoint handles. */
interface TxCount {
  /** The handle that opened the transaction: START and END go through its own statement queue. */
  top: Sql;
  start?: Promise<unknown>;
  /** SET CONSTRAINTS ALL IMMEDIATE: a deferred check that fails, fails here, and END only says the transaction aborted. */
  immediate?: Promise<unknown>;
  end?: Promise<unknown>;
  prepared: boolean;
}

/** END's rows, or the first failure of IMMEDIATE and END (a deferred check's own error, not END's 25P02). */
async function endOf(st: TxCount): Promise<unknown> {
  if (!st.end || !st.immediate) throw new Error('own-write count: no END');
  const immediate = await settle(st.immediate);
  if (!immediate.ok) throw immediate.error;
  return st.end;
}

/** Enqueues `q` on `via`'s statement queue now, ahead of anything enqueued later (postgres.js defers its own call one microtask). */
function enqueueNow(via: Sql, strings: TemplateStringsArray, args: unknown[]): PendingQuery {
  const q = (via as unknown as (s: TemplateStringsArray, ...a: unknown[]) => PendingQuery)(strings, ...args);
  q.executed = true;
  q.handler(q);
  q.catch(() => { /* read through settle() by the owner */ });
  return q;
}

/**
 * Counts this process's own writes on the pools it wraps. Instance state only: one counter per engine.
 */
export class OwnWriteCounter {
  readonly ledger = new OwnWriteLedger();
  /** Diagnostics: transactions whose counts entered the ledger, and ones that wrote but were left out. */
  counted = 0;
  dropped = 0;
  /** Diagnostics: told the backend pid and transaction start (`now()`) of each transaction that entered the ledger. */
  onBooked: ((pid: string, at: string) => void) | null = null;
  private readonly pools = new WeakMap<object, Sql>();
  private readonly oidList: string;

  /** `relations`: the relations to count, as `[name, oid]`. */
  constructor(private readonly relations: ReadonlyArray<readonly [name: string, oid: string]>) {
    this.oidList = `{${relations.map(([, oid]) => oid).join(',')}}`;
  }

  /** The counting pool over `pool` (cached; the same pool object always gets the same counting pool). */
  pool(pool: Sql): Sql {
    const known = this.pools.get(pool);
    if (known) return known;
    const counter = this;
    const wrapped = new Proxy(pool, {
      apply(target, thisArg, args) {
        return counter.autocommit(target, Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args));
      },
      get(target, key) {
        if (key === PHYSICAL_POOL) return target;
        if (key === 'unsafe') return (...args: unknown[]) => counter.autocommit(target, (target.unsafe as (...a: unknown[]) => unknown)(...args));
        if (key === 'begin') return (options: unknown, fn?: (tx: Sql) => unknown) => counter.begin(target, options, fn);
        return Reflect.get(target, key, target);
      },
    }) as Sql;
    this.pools.set(pool, wrapped);
    return wrapped;
  }

  private parse(r: Reading | undefined): Map<string, Counts> | null {
    if (!r || typeof r.pid !== 'string' || typeof r.at !== 'string') return null;
    const parts = (r.c ?? '').split(';');
    if (parts.length !== this.relations.length) return null;
    const out = new Map<string, Counts>();
    for (let i = 0; i < parts.length; i++) {
      const n = parts[i]!.split(',');
      if (n.length !== 3 || !n.every(x => /^\d+$/.test(x))) return null;
      out.set(this.relations[i]![0], [BigInt(n[0]!), BigInt(n[1]!), BigInt(n[2]!)]);
    }
    return out;
  }

  /** Books one committed transaction from its START and END rows, or drops it. */
  private book(bucket: number, start: unknown, end: unknown): void {
    const a = (start as Reading[] | undefined)?.[0], b = (end as Reading[] | undefined)?.[0];
    const from = this.parse(a), to = this.parse(b);
    if (!from || !to || !sameTransaction(start, end)) { this.dropped++; return; }
    const diff = new Map<string, Counts>();
    for (const [name, x] of to) {
      const y = from.get(name)!;
      const d: Counts = [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
      if (d.some(n => n < 0n)) { this.dropped++; return; }
      diff.set(name, d);
    }
    this.ledger.commit(bucket, diff);
    this.counted++;
    this.onBooked?.(a!.pid, a!.at);
  }

  private startOn(st: TxCount): void {
    if (st.start) return;
    st.start = enqueueNow(st.top, START_STRINGS, [this.oidList]);
  }

  private endOn(st: TxCount): void {
    if (!st.start || st.end) return;
    st.immediate = enqueueNow(st.top, IMMEDIATE_STRINGS, []);
    st.end = enqueueNow(st.top, END_STRINGS, [this.oidList]);
  }

  /** A pool statement: a countable write runs in its own counted transaction, everything else as it was. */
  private autocommit(pool: Sql, made: unknown): unknown {
    if (!isQuery(made)) return made;
    const q = made;
    const send = q.handler;
    q.handler = (self) => {
      if (!countable(self)) return send(self);
      this.wrapStatement(pool, self, send);
      return undefined;
    };
    return q;
  }

  /**
   * Runs `q` as BEGIN, START, q, END, COMMIT, pipelined where the pool allows (`early` accepts every statement). Plain
   * BEGIN, as an autocommit statement had: a read-only session default still refuses the write (25006), which
   * retryReadOnlyAutocommit answers with a counted read-write transaction. `q` settles as it would have alone, after
   * the transaction settles; it is booked only when the whole transaction committed.
   */
  private wrapStatement(pool: Sql, q: PendingQuery, send: (q: PendingQuery) => unknown): void {
    const resolve = q.resolve, reject = q.reject;
    let answered!: (s: Settled<unknown>) => void;
    const own = new Promise<Settled<unknown>>(r => answered = r);
    q.resolve = (value) => answered({ ok: true, value });
    q.reject = (error) => answered({ ok: false, error });
    const st: TxCount = { top: pool, prepared: false };
    let entered = false;
    const bucket = this.ledger.open();
    const run = (tx: Sql) => {
      entered = true;
      st.top = tx;
      this.startOn(st);
      const h = (tx.unsafe('') as unknown as PendingQuery).handler;
      q.handler = h;
      h(q);
      this.endOn(st);
      return undefined;
    };
    void (async () => {
      const opened = await settle((pool.begin as unknown as Begin)({ early: () => true }, run));
      if (!entered) {
        // The transaction never opened, so `q` was never sent: it runs alone, as it would have without the count.
        q.resolve = resolve; q.reject = reject; q.handler = send;
        send(q);
        return;
      }
      const mine = await own;
      const start = await settle(st.start!), end = await settle(endOf(st));
      if (!opened.ok) {
        // BEGIN or COMMIT failed, or the connection closed: nothing proves `q` committed, so a `q` that succeeded
        // settles with the transaction's error, as a statement whose connection broke before its answer would.
        return reject(mine.ok ? opened.error : mine.error);
      }
      // COMMIT after a failed statement is a silent ROLLBACK: report the first failure.
      if (!start.ok) return reject(start.error);
      if (!mine.ok) return reject(mine.error);
      if (!end.ok) return reject(end.error);
      this.book(bucket, start.value, end.value);
      resolve(mine.value);
    })().catch(reject);
  }

  /** The counting handle for a transaction or savepoint body: START goes ahead of its first countable write. */
  private handle(tx: Sql, st: TxCount): Sql {
    const counter = this;
    const hook = (made: unknown): unknown => {
      if (!isQuery(made) || st.start) return made;
      const send = made.handler;
      made.handler = (self) => {
        if (!st.start && countable(self)) counter.startOn(st);
        return send(self);
      };
      return made;
    };
    return new Proxy(tx, {
      apply(target, thisArg, args) { return hook(Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args)); },
      get(target, key) {
        if (key === 'unsafe') return (...args: unknown[]) => hook((target.unsafe as (...a: unknown[]) => unknown)(...args));
        if (key === 'prepare') return (name: string) => { st.prepared = true; return (target as unknown as { prepare: (n: string) => unknown }).prepare(name); };
        if (key === 'savepoint') return (...args: unknown[]) => {
          const save = (target as unknown as { savepoint: (...a: unknown[]) => Promise<unknown> }).savepoint;
          const fn = args[args.length - 1];
          if (typeof fn === 'function') return save(...args.slice(0, -1), (inner: Sql) => fn(counter.handle(inner, st)));
          // savepoint`...`: one statement in a savepoint.
          return save((inner: Sql) => (counter.handle(inner, st) as unknown as (...a: unknown[]) => unknown)(...args));
        };
        return Reflect.get(target, key, target);
      },
    }) as Sql;
  }

  /** A read-write transaction on a counting pool: counted when it wrote; a read-only one runs as it was. */
  private async begin(pool: Sql, options: unknown, fn?: (tx: Sql) => unknown): Promise<unknown> {
    if (!fn) { fn = options as (tx: Sql) => unknown; options = ''; }
    const mode = typeof options === 'string' ? options : typeof options === 'object' && options ? String((options as { mode?: unknown }).mode ?? '') : '';
    const begin = pool.begin as unknown as Begin;
    if (/read\s+only/i.test(mode)) return begin(options, fn);
    const st: TxCount = { top: pool, prepared: false };
    const bucket = this.ledger.open();
    const body = fn;
    const run = (tx: Sql) => {
      st.top = tx;
      const x = body(this.handle(tx, st));
      return Promise.resolve(Array.isArray(x) ? Promise.all(x) : x).then(value => { this.endOn(st); return value; });
    };
    const result = await begin(this.pipelined(pool, options), run).catch(async (error: unknown) => {
      // A COMMIT the server turned into ROLLBACK is reported by its cause: START's or a deferred check's own error.
      if (st.start && st.immediate) {
        const start = await settle(st.start), immediate = await settle(st.immediate);
        if (!start.ok) throw start.error;
        if (!immediate.ok) throw immediate.error;
      }
      throw error;
    });
    if (!st.start) return result;
    const start = await settle(st.start), end = await settle(endOf(st));
    // COMMIT after a failed statement is a silent ROLLBACK: a failed START or END means nothing was written.
    if (!start.ok) throw start.error;
    if (!end.ok) throw end.error;
    if (!st.prepared) this.book(bucket, start.value, end.value);
    return result;
  }

  /**
   * Raw statements on one reserved connection (`ReservedConnection.executeRaw`), counted. The caller drives the
   * transaction there with plain BEGIN/COMMIT text (backfill batches, bounded read sessions), so this follows that
   * text in call order: inside the caller's transaction START goes ahead of the first write and IMMEDIATE and END
   * ahead of its COMMIT; an autocommit write runs as BEGIN, START, write, IMMEDIATE, END, COMMIT. Every statement is
   * enqueued at once, so nothing the caller sends later lands among them. Left out (uncounted, so a seal refuses):
   * a connection that does not pipeline (a transaction-mode pooler can refuse BEGIN and run the rest in autocommit),
   * and everything after a text that mixes transaction control with other statements.
   */
  reserved(reserved: Sql, pool: Sql): (query: string, params?: unknown[], prepare?: boolean) => Promise<unknown> {
    const counter = this;
    // A reserved handle has no options of its own: the pool it came from says whether its connections pipeline.
    const pipelines = Number((pool.options as { max_pipeline?: number } | undefined)?.max_pipeline) > 0;
    let state: 'idle' | 'tx' | 'unknown' = 'idle';
    let st: TxCount | null = null;
    let bucket = 0;
    const now = (q: unknown): PendingQuery => { const p = q as PendingQuery; p.executed = true; p.handler(p); p.catch(() => { /* the caller reads it */ }); return p; };
    return (query, params, prepare) => {
      const make = () => now(params === undefined ? reserved.unsafe(query) : reserved.unsafe(query, params as never, { prepare: prepare === true }));
      if (state === 'unknown') return make();
      const kind = control(query);
      if (kind === 'mixed') { state = 'unknown'; st = null; return make(); }
      if (kind === 'begin') {
        if (state === 'idle') { state = 'tx'; st = { top: reserved, prepared: false }; bucket = counter.ledger.open(); }
        return make();
      }
      if (kind === 'rollback') { state = 'idle'; st = null; return make(); }
      if (kind === 'commit') {
        const mine = st, at = bucket;
        state = 'idle'; st = null;
        if (!mine?.start) return make();
        counter.endOn(mine);
        const done = make();
        return (async () => {
          const c = await settle(done as Promise<unknown>);
          const committed = c.ok && (c.value as { command?: string }).command === 'COMMIT';
          const start = await settle(mine.start!), end = await settle(endOf(mine));
          // A deferred check that fails makes COMMIT answer ROLLBACK here; the caller saw its error at COMMIT before.
          if (c.ok && !committed && !end.ok) throw end.error;
          if (!c.ok) throw c.error;
          if (committed && start.ok && end.ok) counter.book(at, start.value, end.value);
          else if (committed) counter.dropped++;
          return c.value;
        })();
      }
      if (!writeLooking(query)) return make();
      if (state === 'tx') { counter.startOn(st!); return make(); }
      if (!pipelines) return make();
      const q = (params === undefined ? reserved.unsafe(query) : reserved.unsafe(query, params as never, { prepare: prepare === true })) as unknown as PendingQuery;
      q.executed = true;
      counter.alone(reserved, q, q.handler);
      q.catch(() => { /* the caller reads it */ });
      return q;
    };
  }

  /**
   * One statement on a connection a caller reserved for it alone, outside any transaction (`runUnsafe`'s cancellable
   * statement): a countable write runs as BEGIN, START, write, IMMEDIATE, END, COMMIT on that connection, everything
   * else as it was. Uncounted where the pool does not pipeline, as `reserved` says.
   */
  reservedStatement<T>(reserved: Sql, pool: Sql, made: T): T {
    if (!isQuery(made) || !(Number((pool.options as { max_pipeline?: number } | undefined)?.max_pipeline) > 0)) return made;
    const send = made.handler;
    made.handler = (self) => {
      if (!countable(self)) return send(self);
      this.alone(reserved, self, send);
      return undefined;
    };
    return made;
  }

  /**
   * Sends `q` as BEGIN, START, q, IMMEDIATE, END, COMMIT on `conn`'s statement queue now, in that order. `q` settles
   * as it would have alone, after COMMIT; it is booked only when the whole transaction committed.
   */
  private alone(conn: Sql, q: PendingQuery, send: (q: PendingQuery) => unknown): void {
    const resolve = q.resolve, reject = q.reject;
    let answered!: (s: Settled<unknown>) => void;
    const own = new Promise<Settled<unknown>>(r => answered = r);
    q.resolve = (value) => answered({ ok: true, value });
    q.reject = (error) => answered({ ok: false, error });
    const now = (made: unknown): Promise<unknown> => { const p = made as PendingQuery; p.executed = true; p.handler(p); p.catch(() => { /* read below */ }); return p; };
    const at = this.ledger.open();
    const one: TxCount = { top: conn, prepared: false };
    const begun = now(conn.unsafe('BEGIN'));
    this.startOn(one);
    send(q);
    this.endOn(one);
    const done = now(conn.unsafe('COMMIT'));
    void (async () => {
      const [b, mine, c] = [await settle(begun), await own, await settle(done)];
      const start = await settle(one.start!), end = await settle(endOf(one));
      // BEGIN or COMMIT failed, or the connection closed: nothing proves the write committed.
      if (!b.ok) return reject(mine.ok ? b.error : mine.error);
      if (!c.ok) return reject(mine.ok ? c.error : mine.error);
      // COMMIT after a failed statement is a silent ROLLBACK: report the first failure.
      if (!start.ok) return reject(start.error);
      if (!mine.ok) return reject(mine.error);
      if (!end.ok) return reject(end.error);
      if ((c.value as { command?: string }).command !== 'COMMIT') return reject(Object.assign(new Error('The transaction was rolled back at commit.'), { code: '25P02' }));
      this.book(at, start.value, end.value);
      resolve(mine.value);
    })().catch(reject);
  }

  /**
   * The caller's pipelining options with the count's own reads accepted too. `first` admits one statement and START
   * may take its place, so where `first` is active (vendor/postgres/src/index.js) it becomes an `early` test that
   * accepts START and then the one statement `first` accepts.
   */
  private pipelined(pool: Sql, options: unknown): unknown {
    if (typeof options !== 'object' || !options) return options;
    const o = options as { first?: (text: string) => boolean; early?: (text: string) => boolean; [k: string]: unknown };
    if (o.early) {
      const early = o.early;
      return { ...o, early: (text: string) => OWN_TEXTS.has(text) || early(text) };
    }
    if (o.first) {
      const opts = (pool.options ?? {}) as unknown as { transaction_pipeline?: number; max_pipeline?: number };
      if (!((opts.transaction_pipeline ?? 0) > (opts.max_pipeline ?? 0))) return o;
      const first = o.first;
      let seen = false;
      const { first: _dropped, ...rest } = o;
      return { ...rest, early: (text: string) => {
        if (OWN_TEXTS.has(text)) return true;
        if (seen) return false;
        seen = true;
        return first(text);
      } };
    }
    return options;
  }
}

// engine-sql-ok: Postgres statistics reads for the own-write count; PGLite keeps no write counters and never counts
const ACTIVATION_SQL = `SELECT current_setting('server_version_num')::int AS version,
  pg_catalog.has_function_privilege(pg_catalog.to_regprocedure('pg_catalog.pg_stat_force_next_flush()')::oid, 'EXECUTE') AS flush`;
// engine-sql-ok: Postgres statistics reads for the own-write count; PGLite keeps no write counters and never counts
const RELATIONS_SQL = `SELECT c.relname::text AS name, c.oid::text AS oid
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname::text = ANY($1::text[]) ORDER BY 1`;

/**
 * A counter for the named relations of the current schema (the relations the seal reads, matched as its RELS_SQL
 * does), or null where the count cannot be exact: before Postgres 15 (no `pg_stat_force_next_flush`) or when this role
 * may not call it.
 */
// engine-sql-ok: transaction write counters and forced stats flushes are Postgres-only
export async function ownWriteCounter(pool: Sql, names: readonly string[]): Promise<OwnWriteCounter | null> {
  const [facts] = await pool.unsafe(ACTIVATION_SQL) as unknown as Array<{ version?: unknown; flush?: unknown }>;
  if (!facts || typeof facts.version !== 'number' || facts.version < 150_000 || facts.flush !== true) return null;
  const rels = await pool.unsafe(RELATIONS_SQL, [[...names]] as never) as unknown as Array<{ name: string; oid: string }>;
  return new OwnWriteCounter(rels.map(r => [r.name, r.oid] as const));
}
