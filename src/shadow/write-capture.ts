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
import { pageSearchVectorSql } from '../core/fts-language.ts';
import { relationRead } from './seed.ts';
import { MAX_PRE_LINKS, MAX_PRE_PAGES, movedOutsideFootprint, PILOT_WRITES, pageRefs, pageSet, readBack, writeFamily, type PageRef, type PreImage, type WriteEvent } from './write-compare.ts';
import { sqlWrites } from './sql-writes.ts';
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
/** What the sampler keeps of one outermost transaction (wrapper.ts hands it to every engine proxy of it): the writes it makes, in order, and the putPage samples it took. */
export interface TxScope {
  /** Set while a sampled write reads its preimage on the transaction's connection: the wrapper holds other members until it is open again. */
  gate: Promise<void> | null;
  /** Member calls on the transaction that have started and not yet settled, queued ones included (the wrapper counts them). */
  inflight: number;
  /** A member that may write is about to run, inside the nested transactions `path` names (none: the outermost). */
  note(name: string, args: unknown[], path?: number[]): void;
  /** A nested transaction (savepoint) opened: its id. */
  open(): number;
  /** The nested transaction `id` rolled back: the writes it noted are not in the final state, so they are forgotten. */
  drop(id: number): void;
  /** The transaction committed: the samples are judged against the writes it made, read back and sent. A rolled-back transaction never calls this. */
  commit(): void;
}
export interface WriteSampler {
  wrap(name: string, fn: Function, ctx: { engine: any; inTransaction: boolean; mayWrite: (name: string, args: unknown[]) => boolean; scope?: TxScope; nested?: boolean }): Function;
  /** The scope of an outermost transaction opened on `engine`. */
  scope(engine: BrainEngine): TxScope;
  /** At disconnect: waits up to `ms` for the read-backs still running; any left are counted `readback_abandoned` and send nothing later. */
  settle(ms: number): Promise<void>;
}

type Row = Record<string, string | null>;
const strings = (rows: Row[], key: string): string[] => [...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === 'string'))];

/** The rows of the pages `targets` name, the links among them (all links touching them, for a delete) and the pages and sources those need. Throws `preimage_too_large`. */
export async function readPreimage(engine: BrainEngine, op: string, targets: PageRef[], signal: { aborted: boolean } = { aborted: false }, within?: BrainEngine): Promise<PreImage> {
  // The caller's deadline cannot stop a transaction that is queued or running, so each step looks at `signal` first: an abandoned read ends at its next
  // statement (and releases the connection a primary write waits behind) instead of finishing its work.
  const live = (): void => { if (signal.aborted) throw new Error('preimage_aborted'); };
  live();
  const read = async (tx: BrainEngine): Promise<PreImage> => {
    live();
    const query = digestQuery(tx);
    if (!within) await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); // the first statement fixes the snapshot, as in the seed
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
  };
  return within ? inSavepoint(within, read) : engine.transaction(read, { readOnly: true });
}

/**
 * Runs a read inside a savepoint of a transaction the caller is running (`within`, a sampled write's own): the transaction's own nested transaction, so a statement
 * that fails here is undone with the savepoint (the driver would otherwise fail the whole transaction at its end), and the savepoint is always rolled back, so the
 * session settings the read sets leave nothing behind. The caller waits for it (each statement is bound by the 2 s timeout on Postgres): a write sent while the savepoint
 * is open could be rolled back with it.
 */
async function inSavepoint<T>(within: BrainEngine, read: (tx: BrainEngine) => Promise<T>): Promise<T> {
  const undo = new Error('shadow_preimage_done'); let out: { value: T } | undefined;
  try { await within.transaction(async (tx) => { out = { value: await read(tx) }; throw undo; }); } catch (error) { if (error !== undo) throw error; }
  return out!.value;
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

/** The options the Rust putPage takes (store-members/pages.ts `takeOptions`; `inline` it ignores). The whole options object is sent with the write, and any other key (`contextualRetrieval`, which the store refuses) is one the replay does not carry: the sample is uncomparable. */
export const PUT_PAGE_OPTIONS: ReadonlySet<string> = new Set(['sourceId', 'allowEmptyOverwrite', 'expectedRevision', 'force', 'inline']);
const knownOptions = (name: string, args: unknown[]): boolean => name !== 'putPage' || Object.keys((args[2] as object | undefined) ?? {}).every((k) => PUT_PAGE_OPTIONS.has(k));
const STAMP = 'updatePageContextualRetrievalState'; // changes a compared page column (contextual_retrieval_mode) after the page write: the replay runs the same call (WriteEvent.then)
/** Writes after a sampled putPage in its transaction that leave the compared page row and links as the write made them (chunks are not compared). */
const LATER_WRITES: ReadonlySet<string> = new Set(['upsertChunks', 'deleteChunks', 'deleteChunksExcept', 'moveChunkIndexes', 'setPageAliases', 'replaceDerivedAliases', 'pruneFrontmatterTags', 'addPageTagsById', 'writeTextProjectionSeal', STAMP]);
/** Tables only the writer's own bookkeeping touches; nothing the comparison reads. A raw write is benign when every table it writes is one of these. `timeline_entries`, `takes` and `content_chunks` are not compared. */
const BOOKKEEPING: ReadonlySet<string> = new Set(['persistence_counters', 'persistence_effects', 'persistence_requests', 'op_checkpoints', 'write_gate_receipts', 'sources', 'timeline_entries', 'takes', 'content_chunks', 'page_projection_jobs', 'config']);
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
/** The raw page updates a sync or put_page makes after the page write, matched by their exact text (whitespace aside): the unbound-origin clear, the chunker and text seal, and the chunker-version stamp. Any other text, drifted or new, is an ordinary write. */
const AFTER_PAGE_WRITE: ReadonlySet<string> = new Set([
  squash("UPDATE pages SET database_only_reason=NULL WHERE source_id=$1 AND slug=$2 AND database_only_reason='unbound_source'"),
  squash(`UPDATE pages SET chunker_version=$5,
    text_projection_revision=CASE WHEN knowledge_revision=$4::uuid THEN knowledge_revision ELSE text_projection_revision END,
    search_vector=CASE WHEN knowledge_revision=$4::uuid THEN ${pageSearchVectorSql('title', '$3')} ELSE search_vector END
    WHERE source_id=$1 AND slug=$2 RETURNING id`),
  squash('UPDATE pages SET chunker_version=$3 WHERE source_id=$1 AND slug=$2'),
]);
function rawKind(args: unknown[]): 'bookkeeping' | 'seal' | undefined {
  const sql = args[0];
  if (typeof sql !== 'string') return undefined;
  if (AFTER_PAGE_WRITE.has(squash(sql))) return 'seal';
  if (/^\s*LOCK\s+TABLE\s/i.test(sql)) return 'bookkeeping'; // a table lock changes no row
  try { const writes = sqlWrites(sql); return writes.length > 0 && writes.every((w) => w.kind === 'relation' && BOOKKEEPING.has(w.relation)) ? 'bookkeeping' : undefined; } catch { return undefined; }
}
const pageKey = (name: string, args: unknown[]): string => { const r = pageRefs(name === STAMP ? 'putPage' : name, name === STAMP ? [args[0], undefined, { sourceId: args[1] }] : args)[0]; return r ? `${r.source}\0${r.slug}` : ''; };

interface TxSample { at: number; key: string; op: string; bad?: string; read?: (then: unknown[][]) => void }
interface Scope extends TxScope { root: BrainEngine; log: Array<{ name: string; key: string; args?: unknown[]; path: number[]; kind?: 'bookkeeping' | 'seal' }>; samples: TxSample[]; nested: number }

const PREIMAGE_REASONS: ReadonlySet<string> = new Set(['preimage_too_large', 'preimage_timeout', 'soft_deleted_page', 'fact_overlay']);

const timeout = <T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { onTimeout(); reject(new Error('preimage_timeout')); }, ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

/** Why a putPage sample cannot be compared given the writes its transaction made, or null: an earlier write to anything the comparison reads (a version row is not read), a later one that is not a chunk write, or another putPage of the same page. */
function judge(sc: Scope, s: TxSample): string | null {
  for (const [i, w] of sc.log.entries()) {
    if (i === s.at || w.name === 'createVersion' || w.kind === 'bookkeeping' || (i > s.at && w.kind === 'seal') || (w.name === 'putPage' && w.key !== s.key) || (i > s.at && LATER_WRITES.has(w.name))) continue;
    return w.name === 'putPage' ? 'in_transaction_same_page' : i < s.at ? 'in_transaction_prior_write' : 'in_transaction_later_write';
  }
  return null;
}

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
  /** Off the request path, and nothing in it may escape: an encode that throws (a segmented page's body getters) is one more uncomparable sample. */
  const readBackAndSend = (engine: BrainEngine, name: string, args: unknown[], encoded: unknown[], targets: PageRef[], pre: PreImage, result: unknown, before: number | undefined, then: unknown[][] = []): void => {
    const sample = { abandoned: false, done: Promise.resolve() };
    sample.done = (async () => {
      try {
        const back = await readBack(engine, targets, pageSet(targets, pre));
        const after = o.generation?.();
        let moved = before !== undefined && after !== undefined && after - before > 1;
        // A brain other processes can write (not PGLite, whose single-writer file lock rules them out) needs the data fence (write-compare.ts).
        if (!moved && hasCapability(engine, 'postgres_admin')) moved = await fenced(engine, name, args, targets, pre, result, back);
        if (!sample.abandoned) send({ t: 'write', op: name, args: encoded, pre, post: encodeValue(back), moved, ...(then.length ? { then: then.map((a) => encodeArgs(a, { left: CAPTURE_BUDGET_BYTES })) } : {}) });
      } catch { if (!sample.abandoned) uncomparable(name, 'readback_failed'); }
    })();
    reading.add(sample); void sample.done.finally(() => reading.delete(sample));
  };
  /** A putPage inside a transaction: the preimage is read on the transaction's own connection before the write is sent, the write runs untouched, and the sample waits for the commit (TxScope.commit). A rolled-back transaction drops it. */
  const inTransaction = (scope: Scope, tx: BrainEngine, name: string, args: unknown[], run: () => unknown): Promise<unknown> => {
    const s: TxSample = { at: scope.log.length, key: pageKey(name, args), op: name };
    scope.samples.push(s);
    // Another member call that has started and not settled (a pipelined sibling, a write waiting on a page lock) may still send statements of its own, and they would run inside the
    // preimage savepoint and be rolled back with it. Then nothing is read and nothing is held: the write goes through untouched.
    if (scope.inflight > 1) { s.bad = 'in_transaction_busy'; return Promise.resolve(run()); }
    const before = o.generation?.();
    let open!: () => void;
    scope.gate = new Promise<void>((resolve) => { open = () => { scope.gate = null; resolve(); }; });
    return (async () => {
      let encoded: unknown[] = []; let pre: PreImage | undefined; let targets: PageRef[] = [];
      try {
        s.bad = (knownOptions(name, args) ? judge(scope, s) : 'unknown_option') ?? undefined;
        encoded = encodeArgs(args, { left: CAPTURE_BUDGET_BYTES });
        targets = pageRefs(name, args);
        if (targets.length > MAX_PRE_PAGES) throw new Error('preimage_too_large');
        if (!s.bad) pre = await readPreimage(scope.root, name, targets, undefined, tx);
      } catch (error) { const why = (error as Error)?.message; s.bad ??= why && PREIMAGE_REASONS.has(why) ? why : 'preimage_unreadable'; }
      let sent: unknown;
      try { sent = run(); } finally { open(); } // sent before other members are let go: they keep their order behind it
      let result: unknown;
      try { result = await sent; } catch (error) { s.bad ??= 'primary_write_failed'; throw error; }
      if (pre) s.read = (then) => readBackAndSend(scope.root, name, args, encoded, targets, pre!, result, before, then);
      return result;
    })();
  };
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
        const scope = ctx.inTransaction && name === 'putPage' && !ctx.nested ? ctx.scope as Scope | undefined : undefined;
        if (ctx.inTransaction && !scope) { uncomparable(name, 'in_transaction'); return run(); }
        if (scope) return inTransaction(scope, ctx.engine, name, args, run);
        if (!knownOptions(name, args)) { uncomparable(name, 'unknown_option'); return run(); }
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
          readBackAndSend(ctx.engine, name, args, encoded, targets, pre, result, before);
          return result;
        })();
      };
    },
    scope(root) {
      const sc: Scope = {
        root, log: [], samples: [], gate: null, inflight: 0, nested: 0,
        note: (name, args, path = []) => { sc.log.push({ name, key: name === 'putPage' || name === 'createVersion' || name === STAMP ? pageKey(name, args) : '', path, ...(name === STAMP ? { args } : {}), ...(name === 'executeRaw' ? { kind: rawKind(args) } : {}) }); },
        open: () => ++sc.nested,
        drop: (id) => { for (let i = sc.log.length - 1; i >= 0; i--) if (sc.log[i]!.path.includes(id)) { sc.log.splice(i, 1); for (const s of sc.samples) if (s.at > i) s.at--; } },
        commit: () => { for (const s of sc.samples) { const bad = s.bad ?? judge(sc, s); if (bad || !s.read) uncomparable(s.op, bad ?? 'in_transaction'); else s.read(sc.log.filter((w, i) => i > s.at && w.name === STAMP && w.key === s.key).map((w) => w.args!)); } },
      };
      return sc;
    },
  };
}
