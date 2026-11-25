/**
 * Write comparisons, the serving process's part (write-compare.ts has the design). For a sampled write the wrapper's member goes
 * through `wrap`: a write outside the pilot is sent as a bare `capability_missing` count by family; a pilot write outside a
 * transaction first copies the rows it touches from the primary in one snapshot (an awaited read, sampled writes only, bounded
 * and fail-open like the follower's own pre-read), runs untouched, and then, off the request path, reads the changed rows back
 * and sends the sample. Nothing here changes a write's outcome or fails it.
 */
import type { BrainEngine } from '../core/engine.ts';
import { hasCapability } from '../core/engine-capabilities.ts';
import { DIGEST_SESSION_SETTINGS, digestQuery } from '../core/persistence/graduation-digest.ts';
import { CAPTURE_BUDGET_BYTES, encodeArgs, encodeValue } from './codec.ts';
import { relationRead } from './seed.ts';
import { MAX_PRE_LINKS, MAX_PRE_PAGES, PILOT_WRITES, pageRefs, pageSet, readBack, writeFamily, type PageRef, type PreImage, type WriteEvent } from './write-compare.ts';
import { memberKind } from './write-map.ts';

/** How long the preimage read may hold a sampled write. */
export const PREIMAGE_TIMEOUT_MS = 2_000;
/** Largest line one sample may send. */
const MAX_SAMPLE_BYTES = 512 * 1024;

export interface WriteSamplerOptions {
  /** Share of writes sampled, 0..1 (the state file's `sample_rate`). */
  rate: number;
  random?: () => number;
  /** The supervisor's `send`: false when the line was not accepted (the sample is then unobserved). */
  send: (line: string) => boolean;
  /** The serving process's write count (follower.published): a move beyond the sampled write's own marks the sample `moved`. */
  generation?: () => number | undefined;
  active: () => boolean;
  /** How long the preimage read may hold a write; default PREIMAGE_TIMEOUT_MS (a seam for tests). */
  preimageTimeoutMs?: number;
}
export interface WriteSampler { wrap(name: string, fn: Function, ctx: { engine: any; inTransaction: boolean; mayWrite: (name: string, args: unknown[]) => boolean }): Function }

type Row = Record<string, string | null>;
const strings = (rows: Row[], key: string): string[] => [...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === 'string'))];

/** The rows of the pages `targets` name, the links among them (all links touching them, for a delete) and the pages and sources those need. Throws `preimage_too_large`. */
export async function readPreimage(engine: BrainEngine, op: string, targets: PageRef[]): Promise<PreImage> {
  return engine.transaction(async (tx) => {
    const query = digestQuery(tx);
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); // the first statement fixes the snapshot, as in the seed
    await query(DIGEST_SESSION_SETTINGS);
    if (hasCapability(engine, 'postgres_admin')) await query(`SET LOCAL statement_timeout = ${PREIMAGE_TIMEOUT_MS}`); // the wait below only abandons a read: this stops it
    const rowsOf = async (relation: string, where: string, params: unknown[], limit: number): Promise<Row[]> => {
      const read = await relationRead(tx, relation, ['id']);
      const rows = await tx.executeRaw<Record<string, string | null>>(`/* shadow write preimage */ ${read.select} WHERE ${where} LIMIT ${limit + 1}`, params);
      if (rows.length > limit) throw new Error('preimage_too_large');
      return rows.map((r) => ({ ...Object.fromEntries(read.columns.map((c, i) => [c.name, r[`c${i}`] ?? null])), k0: r.k0 ?? null }));
    };
    const pages = await rowsOf('pages', '(t.source_id::text, t.slug::text) IN (SELECT * FROM unnest($1::text[], $2::text[]))', [targets.map((t) => t.source), targets.map((t) => t.slug)], MAX_PRE_PAGES);
    const ids = pages.map((p) => p.k0!);
    const links = ids.length ? await rowsOf('links', `t.from_page_id::text = ANY($1::text[]) ${op === 'deletePage' ? 'OR' : 'AND'} t.to_page_id::text = ANY($1::text[])`, [ids], MAX_PRE_LINKS) : [];
    const more = strings(links, 'from_page_id').concat(strings(links, 'to_page_id'), strings(links, 'origin_page_id')).filter((id) => !ids.includes(id));
    if (more.length) pages.push(...await rowsOf('pages', 't.id::text = ANY($1::text[])', [[...new Set(more)]], MAX_PRE_PAGES));
    if (pages.length > MAX_PRE_PAGES) throw new Error('preimage_too_large');
    const named = strings(pages, 'source_id').filter((id) => id !== 'default');
    const sources = named.length ? await rowsOf('sources', 't.id::text = ANY($1::text[])', [named], MAX_PRE_PAGES) : [];
    const bare = (rows: Row[]): Row[] => rows.map(({ k0: _key, ...rest }) => rest);
    return { sources: bare(sources), pages: bare(pages), links: bare(links) };
  }, { readOnly: true });
}

const timeout = <T>(promise: Promise<T>, ms: number): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('preimage_timeout')), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

export function createWriteSampler(o: WriteSamplerOptions): WriteSampler {
  const random = o.random ?? Math.random;
  const rate = Math.min(1, Math.max(0, o.rate));
  /** Samples the pipe refused since the last one it took: the next line carries the count, so a shed sample is counted `uncomparable`, never lost as if it were not sampled. */
  let dropped = 0;
  const send = (event: WriteEvent): void => {
    try {
      let line = JSON.stringify({ ...event, ...(dropped ? { dropped } : {}) }) + '\n';
      if (Buffer.byteLength(line) > MAX_SAMPLE_BYTES) line = JSON.stringify({ t: 'write', op: event.op, outcome: 'uncomparable', reason: 'sample_too_large', ...(dropped ? { dropped } : {}) }) + '\n';
      if (o.send(line)) dropped = 0; else dropped++;
    } catch { /* the shadow never fails a write */ }
  };
  const uncomparable = (op: string, reason: string): void => send({ t: 'write', op, outcome: 'uncomparable', reason });
  return {
    wrap(name, fn, ctx) {
      const kind = memberKind(name);
      if (kind !== 'mapped' && kind !== 'unmapped' && kind !== 'raw') return fn;
      return function sampledWrite(this: unknown, ...args: unknown[]) {
        const run = (): unknown => fn.apply(this, args);
        let sampled = false;
        try { sampled = o.active() && random() < rate && ctx.mayWrite(name, args); } catch { /* not sampled */ }
        if (!sampled) return run();
        if (!PILOT_WRITES.has(name)) { send({ t: 'write', op: name, outcome: 'capability_missing', family: writeFamily(name) }); return run(); }
        if (ctx.inTransaction) { uncomparable(name, 'in_transaction'); return run(); }
        return (async () => {
          let encoded: unknown[]; let pre: PreImage; let targets: PageRef[];
          const before = o.generation?.();
          try {
            encoded = encodeArgs(args, { left: CAPTURE_BUDGET_BYTES });
            targets = pageRefs(name, args);
            pre = await timeout(readPreimage(ctx.engine, name, targets), o.preimageTimeoutMs ?? PREIMAGE_TIMEOUT_MS);
          } catch (error) {
            const why = (error as Error)?.message;
            uncomparable(name, why === 'preimage_too_large' || why === 'preimage_timeout' ? why : 'preimage_unreadable');
            return run();
          }
          let result: unknown;
          try { result = await run(); } catch (error) { uncomparable(name, 'primary_write_failed'); throw error; }
          void readBack(ctx.engine, targets, pageSet(targets, pre)).then((post) => {
            const after = o.generation?.();
            send({ t: 'write', op: name, args: encoded, pre, post: encodeValue(post), moved: before !== undefined && after !== undefined && after - before > 1 });
          }, () => uncomparable(name, 'readback_failed'));
          return result;
        })();
      };
    },
  };
}
