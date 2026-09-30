/**
 * Recording fake for a postgres.js `sql` handle (W0 refactor-wave-1 goldens).
 *
 * Statements are rendered with postgres.js's OWN vendored `stringify` /
 * `handleValue` (the exact code `connection.js#build` runs before a query hits
 * the wire), so nested `sql\`\`` fragments, `sql.unsafe()` fragments,
 * `sql.json()` parameters and `sql(array)` builders produce the byte-exact text
 * and `$N` numbering a real connection would send. Nothing connects.
 *
 * Every statement is recorded with the lane it ran on:
 *   - `pool`          the engine's shared handle
 *   - `tx`            inside `sql.begin()`
 *   - `<lane>>sp`     inside a savepoint opened on `<lane>`
 *   - `reserved`      a `sql.reserve()` connection
 * and transaction boundaries are recorded as `event` entries, so RLS-scope and
 * pool-hold behavior (#1794) is observable without a database.
 */

// @ts-expect-error vendored postgres.js internals ship without type declarations
import { Query } from '../../vendor/postgres/src/query.js';
// @ts-expect-error vendored postgres.js internals ship without type declarations
import { stringify, handleValue, Parameter, Builder, Identifier } from '../../vendor/postgres/src/types.js';

export type ParamShape = string;

export interface RecordedStatement {
  kind: 'query';
  lane: string;
  via: 'tagged' | 'unsafe';
  /** Exact text postgres.js would send (placeholders `$1..$n`). */
  text: string;
  /** Bound values in `$N` order (values are NOT pinned by goldens, only shapes). */
  params: unknown[];
  /** postgres.js inferred / declared type OIDs, parallel to `params`. */
  types: number[];
  /** `unsafe()` call options that affect the wire protocol (prepare / simple / cancelFence). */
  unsafeOptions?: Record<string, unknown>;
}

export interface RecordedEvent {
  kind: 'event';
  lane: string;
  event: 'begin' | 'commit' | 'rollback' | 'savepoint' | 'savepoint-release' | 'savepoint-rollback' | 'reserve' | 'reserve-release';
}

export type TraceEntry = RecordedStatement | RecordedEvent;

/** Returns canned rows (or an Error to reject, or a Promise of either). `undefined` means `[]`. */
export type Responder = (stmt: RecordedStatement) => unknown[] | Error | undefined | Promise<unknown[] | Error | undefined>;

const RENDER_OPTIONS = { transform: { undefined: undefined, column: {} } };

function makeResult(rows: unknown[]): unknown[] {
  const out = [...rows] as unknown[] & { count?: number; command?: string };
  out.count = rows.length;
  return out;
}

export interface FakeSql {
  /** The callable handle to install as the engine's `_sql`. */
  sql: any;
  trace: TraceEntry[];
  statements(): RecordedStatement[];
}

/**
 * Build a fake handle. `responder` supplies rows per statement; the default is
 * an empty result. Unsupported postgres.js surfaces throw loudly so a capture
 * can never silently skip a statement.
 */
export function makeFakeSql(responder: Responder = () => undefined, opts: { poolMax?: number } = {}): FakeSql {
  const trace: TraceEntry[] = [];

  function makeHandle(lane: string): any {
    const handler = (q: any) => {
      const parameters: unknown[] = [];
      const types: number[] = [];
      let text: string;
      try {
        text = stringify(q, q.strings[0], q.args[0], parameters, types, RENDER_OPTIONS);
        if (!q.tagged) q.args.forEach((x: unknown) => handleValue(x, parameters, types, RENDER_OPTIONS));
      } catch (e) {
        q.reject(e);
        return;
      }
      const stmt: RecordedStatement = { kind: 'query', lane, via: q.tagged ? 'tagged' : 'unsafe', text, params: parameters, types };
      if (!q.tagged) {
        const o = q.options ?? {};
        stmt.unsafeOptions = {};
        for (const key of ['prepare', 'simple', 'cancelFence']) {
          if (key in o) stmt.unsafeOptions[key] = o[key];
        }
      }
      trace.push(stmt);
      Promise.resolve()
        .then(() => responder(stmt))
        .then(
          (out) => (out instanceof Error ? q.reject(out) : q.resolve(makeResult(out ?? []))),
          (err) => q.reject(err),
        );
    };
    const cancel = () => Promise.resolve();

    function sql(strings: any, ...args: unknown[]): unknown {
      if (strings && Array.isArray(strings.raw)) return new Query(strings, args, handler, cancel);
      if (typeof strings === 'string' && !args.length) return new Identifier(strings);
      return new Builder(strings, args);
    }
    sql.unsafe = function unsafe(string: string, args: unknown[] = [], options: Record<string, unknown> = {}) {
      if (arguments.length === 2 && !Array.isArray(args)) { options = args as unknown as Record<string, unknown>; args = []; }
      return new Query([string], args, handler, cancel, {
        prepare: false,
        ...options,
        simple: 'simple' in options ? options.simple : args.length === 0,
      });
    };
    sql.json = (x: unknown) => new Parameter(x, 3802);
    sql.typed = (x: unknown, type: number) => new Parameter(x, type);
    sql.options = { max: opts.poolMax ?? 10 };
    sql.begin = async (a: unknown, b?: unknown) => {
      const fn = (typeof a === 'function' ? a : b) as (tx: unknown) => Promise<unknown>;
      if (lane !== 'pool' && lane !== 'reserved') {
        throw new Error(`fake-postgres-sql: begin() on non-root lane ${lane} (postgres.js has no nested begin; use savepoint)`);
      }
      trace.push({ kind: 'event', lane: 'tx', event: 'begin' });
      const tx = makeHandle('tx');
      try {
        const result = await fn(tx);
        trace.push({ kind: 'event', lane: 'tx', event: 'commit' });
        return result;
      } catch (e) {
        trace.push({ kind: 'event', lane: 'tx', event: 'rollback' });
        throw e;
      }
    };
    if (lane !== 'pool' && lane !== 'reserved') {
      sql.savepoint = async (a: unknown, b?: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as (tx: unknown) => Promise<unknown>;
        const child = `${lane}>sp`;
        trace.push({ kind: 'event', lane: child, event: 'savepoint' });
        const handle = makeHandle(child);
        try {
          const result = await fn(handle);
          trace.push({ kind: 'event', lane: child, event: 'savepoint-release' });
          return result;
        } catch (e) {
          trace.push({ kind: 'event', lane: child, event: 'savepoint-rollback' });
          throw e;
        }
      };
    }
    if (lane === 'pool') {
      sql.reserve = async () => {
        trace.push({ kind: 'event', lane: 'reserved', event: 'reserve' });
        const r = makeHandle('reserved');
        r.release = () => { trace.push({ kind: 'event', lane: 'reserved', event: 'reserve-release' }); };
        r.discard = () => {};
        return r;
      };
    }
    sql.end = async () => {};
    return sql;
  }

  return {
    sql: makeHandle('pool'),
    trace,
    statements: () => trace.filter((t): t is RecordedStatement => t.kind === 'query'),
  };
}

/**
 * Shape of one bound value, stable across runs (values themselves are volatile:
 * timestamps, generated ids, hashes). `json` marks a `sql.json()` parameter
 * (OID 3802); other declared OIDs are kept as `typed:<oid>`.
 */
export function paramShape(value: unknown, oid = 0): ParamShape {
  if (oid === 3802) return 'json';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return 'Date';
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return 'Buffer';
  if (value instanceof Float32Array) return 'Float32Array';
  if (value instanceof Uint8Array) return 'Uint8Array';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array<>';
    const inner = [...new Set(value.map((v) => paramShape(v)))].sort().join('|');
    return `array<${inner}>`;
  }
  if (typeof value === 'object') return 'object';
  return typeof value;
}
