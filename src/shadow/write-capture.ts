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
import { MAX_PRE_LINKS, MAX_PRE_PAGES, movedOutsideFootprint, PILOT_WRITES, pageRefs, pageSet, readBack, writeFamily, type PageRef, type PreImage, type WriteEvent } from './write-compare.ts';
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
  /** Records a sample that will never reach the child (`send_shed`, `readback_abandoned`) for the child to count uncomparable; false when it could not be recorded, and the count then rides on the next accepted line. */
  lost?: (reason: string) => boolean;
  /** How long the preimage read may hold a write; default PREIMAGE_TIMEOUT_MS (a seam for tests). */
  preimageTimeoutMs?: number;
}
export interface WriteSampler {
  wrap(name: string, fn: Function, ctx: { engine: any; inTransaction: boolean; mayWrite: (name: string, args: unknown[]) => boolean }): Function;
  /** At disconnect: waits up to `ms` for the read-backs still running; any left are counted `readback_abandoned` and send nothing later. */
  settle(ms: number): Promise<void>;
}

type Row = Record<string, string | null>;
const strings = (rows: Row[], key: string): string[] => [...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === 'string'))];

/** The rows of the pages `targets` name, the links among them (all links touching them, for a delete) and the pages and sources those need. Throws `preimage_too_large`. */
export async function readPreimage(engine: BrainEngine, op: string, targets: PageRef[], signal: { aborted: boolean } = { aborted: false }): Promise<PreImage> {
  // The caller's deadline cannot stop a transaction that is queued or running, so each step looks at `signal` first: an abandoned read ends at its next
  // statement (and releases the connection a primary write waits behind) instead of finishing its work.
  const live = (): void => { if (signal.aborted) throw new Error('preimage_aborted'); };
  live();
  return engine.transaction(async (tx) => {
    live();
    const query = digestQuery(tx);
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); // the first statement fixes the snapshot, as in the seed
    live(); await query(DIGEST_SESSION_SETTINGS);
    live(); if (hasCapability(engine, 'postgres_admin')) await query(`SET LOCAL statement_timeout = ${PREIMAGE_TIMEOUT_MS}`); // the wait below only abandons a read: this stops it
    const rowsOf = async (relation: string, where: string, params: unknown[], limit: number): Promise<Row[]> => {
      live();
      const read = await relationRead(tx, relation, ['id']); live(); // the catalog read above is a statement too
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
    // Not comparable, and said before anything is copied further: a soft-deleted page hides its links from the typed read on both engines, and a withdrawn
    // or purged fact changes the body the primary serves (page-state/snapshot.ts) by an overlay the scratch store does not have.
    if (pages.some((p) => p.deleted_at)) throw new Error('soft_deleted_page');
    live();
    const [overlay] = await tx.executeRaw<{ n: string }>(`/* shadow write preimage */ SELECT (SELECT count(*) FROM fact_withdrawals WHERE source_id = ANY($1::text[]) AND (subject = '*' OR subject = ANY($2::text[])))
      + (SELECT count(*) FROM fact_purges WHERE source_id = ANY($1::text[]) AND (subject = '*' OR subject = ANY($2::text[]))) AS n`, [[...strings(pages, 'source_id'), ...targets.map((t) => t.source)], [...strings(pages, 'slug'), ...targets.map((t) => t.slug)]]); // a target not there yet counts too
    if (Number(overlay?.n ?? 0) > 0) throw new Error('fact_overlay');
    const named = [...new Set([...strings(pages, 'source_id'), ...targets.map((t) => t.source)])].filter((id) => id !== 'default'); // a page not there yet still needs its source in the scratch store
    const sources = named.length ? await rowsOf('sources', 't.id::text = ANY($1::text[])', [named], MAX_PRE_PAGES) : [];
    const bare = (rows: Row[]): Row[] => rows.map(({ k0: _key, ...rest }) => rest);
    return { sources: bare(sources), pages: bare(pages), links: bare(links) };
  }, { readOnly: true });
}

/** True when the data fence finds the rows moved, or cannot be read (never a quiet pass): the copied pages and links are read again and compared, and putPage's returned revision must be the one read back. */
async function fenced(engine: BrainEngine, op: string, args: unknown[], targets: PageRef[], pre: PreImage, result: unknown, back: { pages: unknown[] }): Promise<boolean> {
  try {
    if (op === 'putPage') {
      const wrote = (result as { knowledge_revision?: unknown } | null)?.knowledge_revision;
      if (typeof wrote !== 'string' || (back.pages[0] as { knowledge_revision?: unknown } | null)?.knowledge_revision !== wrote) return true;
    }
    const again = await readPreimage(engine, op, [...targets, ...pre.pages.map((p) => ({ source: p.source_id ?? 'default', slug: p.slug ?? '' }))]);
    return movedOutsideFootprint(op, args, pre, again);
  } catch { return true; }
}

const PREIMAGE_REASONS: ReadonlySet<string> = new Set(['preimage_too_large', 'preimage_timeout', 'soft_deleted_page', 'fact_overlay']);

const timeout = <T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { onTimeout(); reject(new Error('preimage_timeout')); }, ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

export function createWriteSampler(o: WriteSamplerOptions): WriteSampler {
  const random = o.random ?? Math.random;
  const rate = Math.min(1, Math.max(0, o.rate));
  /** Samples the pipe refused since the last one it took: the next line carries the count, so a shed sample is counted `uncomparable`, never lost as if it were not sampled. */
  const unsaid: string[] = []; // reasons of losses the journal could not take: the next accepted line carries their count, and settle() retries them
  const send = (event: WriteEvent): void => {
    try {
      let line = JSON.stringify({ ...event, ...(unsaid.length ? { dropped: unsaid.length } : {}) }) + '\n';
      if (Buffer.byteLength(line) > MAX_SAMPLE_BYTES) line = JSON.stringify({ t: 'write', op: event.op, outcome: 'uncomparable', reason: 'sample_too_large', ...(unsaid.length ? { dropped: unsaid.length } : {}) }) + '\n';
      if (o.send(line)) unsaid.length = 0; else if (!o.lost?.('send_shed')) unsaid.push('send_shed');
    } catch { /* the shadow never fails a write */ }
  };
  const uncomparable = (op: string, reason: string): void => send({ t: 'write', op, outcome: 'uncomparable', reason });
  /** Read-backs still running; `abandoned` is set when settle() has counted one, so it sends nothing later (a sample is counted once). */
  const reading = new Set<{ abandoned: boolean; done: Promise<void> }>();
  return {
    async settle(ms) {
      const idle = Promise.all([...reading].map((r) => r.done));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([idle, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
      clearTimeout(timer);
      for (const r of reading) { r.abandoned = true; if (!(o.lost?.('readback_abandoned'))) unsaid.push('readback_abandoned'); } // not sent later
      reading.clear();
      for (const reason of unsaid.splice(0)) if (!o.lost?.(reason)) unsaid.push(reason); // the final handoff, whether or not another sample comes
    },
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
          const signal = { aborted: false };
          try {
            encoded = encodeArgs(args, { left: CAPTURE_BUDGET_BYTES });
            targets = pageRefs(name, args);
            if (targets.length > MAX_PRE_PAGES) throw new Error('preimage_too_large'); // refused before any read: the read-back looks at every named page
            pre = await timeout(readPreimage(ctx.engine, name, targets, signal), o.preimageTimeoutMs ?? PREIMAGE_TIMEOUT_MS, () => { signal.aborted = true; });
          } catch (error) {
            const why = (error as Error)?.message;
            uncomparable(name, why && PREIMAGE_REASONS.has(why) ? why : 'preimage_unreadable');
            return run();
          }
          let result: unknown;
          try { result = await run(); } catch (error) { uncomparable(name, 'primary_write_failed'); throw error; }
          // Off the request path, and nothing in it may escape: an encode that throws (a segmented page's body getters) is one more uncomparable sample.
          const sample = { abandoned: false, done: Promise.resolve() };
          sample.done = (async () => {
            try {
              const back = await readBack(ctx.engine, targets, pageSet(targets, pre));
              const after = o.generation?.();
              let moved = before !== undefined && after !== undefined && after - before > 1;
              // A brain other processes can write (not PGLite, whose single-writer file lock rules them out) needs the data fence (write-compare.ts).
              if (!moved && hasCapability(ctx.engine, 'postgres_admin')) moved = await fenced(ctx.engine, name, args, targets, pre, result, back);
              if (!sample.abandoned) send({ t: 'write', op: name, args: encoded, pre, post: encodeValue(back), moved });
            } catch { if (!sample.abandoned) uncomparable(name, 'readback_failed'); }
          })();
          reading.add(sample); void sample.done.finally(() => reading.delete(sample));
          return result;
        })();
      };
    },
  };
}
