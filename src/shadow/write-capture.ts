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
import { MAX_DROPPED, MAX_PRE_LINKS, MAX_PRE_PAGES, movedOutsideFootprint, PILOT_WRITES, pageRefs, pageSet, readBack, readBackText, writeFamily, type PageRef, type PreImage, type WriteEvent } from './write-compare.ts';
import { sqlWrites } from './sql-writes.ts';
import { memberKind } from './write-map.ts';
import { COMPLETE_WRITE_PURGE_PROBE_SQL, COMPLETE_WRITE_SQL, ENSURE_COUNTERS_SQL, LOCK_COUNTERS_SQL, PUBLICATION_EFFECTS_SQL } from '../core/engine-sql/persistence-journal.ts';
import { COMPLETE_EFFECT_SQL, EFFECT_GUARD_BRAIN_SQL, EFFECT_GUARD_WORKTREE_SQL } from '../core/engine-sql/persistence-effect-worker.ts';
import { EFFECT_TRANSACTION_LIMITS_SQL } from '../core/engine-sql/remote-links.ts';
import { persistenceDeclarationStatement } from '../core/engine-sql/persistence-declaration.ts';
import { EFFECT_CLAIM_ROW_LOCK_SQL } from '../core/engine-sql/embedding-install.ts';

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
  /** The serving process's count of writes that can change a compared row (follower.pageLinkWrites): a move beyond the sampled write's own marks the sample `moved`. Only an in-transaction putPage with a completed data fence and a pre-commit pin of its page is exempt from it (see `readBackAndSend`). */
  generation?: () => number | undefined;
  active: () => boolean;
  /** Records a sample that will never reach the child (`send_shed`, `readback_abandoned`) for the child to count uncomparable; false when it could not be recorded, and the count then rides on the next accepted line. */
  lost?: (reason: string) => boolean;
  /** Makes `n` samples the sampler could not send owed in the serving process's durable record (supervisor.ts `owe`), so the worker books them and status cannot read measured past them; false when it could not (no running worker), and they then wait in the sampler as a refused send's do. */
  owe?: (n: number) => boolean;
  /** Makes `n` samples whose count `lost` could not write down owed in a kept record (supervisor.ts `oweRefused`: with or without a running worker), so none lives only in this sampler's memory; false when it could not, and they then stay in `unsaid`. */
  refuse?: (n: number) => boolean;
  /** How long the preimage read may hold a write; default PREIMAGE_TIMEOUT_MS (a seam for tests). */
  preimageTimeoutMs?: number;
}
/** What the sampler keeps of one outermost transaction (wrapper.ts hands it to every engine proxy of it): the writes it makes, in order, and the putPage samples it took. */
export interface TxScope {
  /** Set while a sampled write waits for the calls ahead of it and reads its preimage on the transaction's connection: the wrapper holds other members until it is open again, and resolves when it opens. */
  gate: Promise<void> | null;
  /** Calls held while the gate is closed, in call order (the wrapper queues them): when it opens they start one by one, and a call that closes it again leaves the rest queued. */
  waiters: Array<() => void>;
  /** Member calls on the transaction that have started and not yet settled, queued ones included (the wrapper counts them). */
  inflight: number;
  /** Member calls the wrapper let run (held by neither gate) that have not settled yet, in the order they ran: the ones a sampled write waits for. A call held by either gate (this scope's or the follower's lane) is not in it until it starts, so a sampled write waits only for calls that started before it. `callback`: the call took a function (a nested transaction, a bounded read), which may be waiting for a call held behind the gate. */
  running: Set<{ name: string; callback: boolean; done: Promise<void> }>;
  /** A member that may write is about to run, inside the nested transactions `path` names (none: the outermost). */
  note(name: string, args: unknown[], path?: number[]): void;
  /** A nested transaction (savepoint) opened: its id. */
  open(): number;
  /** The nested transaction `id` rolled back: the writes it noted are not in the final state, so they are forgotten. */
  drop(id: number): void;
  /** The transaction's callback is done and the commit is next, still inside the transaction: each sampled page write pins its page as the transaction will commit it (the revision and the compared fields, after every later write of the transaction), read on `tx`, the transaction's own connection. Never throws. */
  beforeCommit(tx: BrainEngine): Promise<void>;
  /** The transaction committed: the samples are judged against the writes it made, read back and sent. A rolled-back transaction never calls this. */
  commit(): void;
  /** The transaction ends while calls it started are still running (the wrapper's drain gave up waiting): every sample whose write has not finished is uncomparable with `reason`. */
  unsettled(reason: string): void;
}
export interface WriteSampler {
  wrap(name: string, fn: Function, ctx: { engine: any; inTransaction: boolean; mayWrite: (name: string, args: unknown[]) => boolean; scope?: TxScope; nested?: boolean }): Function;
  /** The scope of an outermost transaction opened on `engine`. `followed` false: the transaction's writes are not published to the follower (the warm single-write lane), so they do not move the write counter. */
  scope(engine: BrainEngine, opts?: { followed?: boolean }): TxScope;
  /** At disconnect: waits up to `ms` for the read-backs still running; any left are counted `readback_abandoned` and send nothing later. */
  settle(ms: number): Promise<void>;
  /** A sampler with the same options and read-backs of its own, for a worker engine of the same brain (it settles when that worker disconnects); losses it could not record are shared with this one, so none is left behind when the worker goes. */
  fork(): WriteSampler;
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

/**
 * The data fence's verdict: `moved` when it finds the rows moved, `failed` when it cannot be read (never a quiet pass), else `clear`. The copied pages and links are read again and compared, and putPage's
 * revision must be the one read back: the revision the write returned, or (a sample whose transaction wrote the page again, so the tags trigger rewrote it) the one the page was about to commit with.
 */
async function fenced(engine: BrainEngine, op: string, args: unknown[], targets: PageRef[], pre: PreImage, result: unknown, back: { pages: unknown[] }, committedRevision?: string): Promise<'clear' | 'moved' | 'failed'> {
  try {
    if (op === 'putPage') {
      const wrote = committedRevision ?? (result as { knowledge_revision?: unknown } | null)?.knowledge_revision;
      if (typeof wrote !== 'string' || (back.pages[0] as { knowledge_revision?: unknown } | null)?.knowledge_revision !== wrote) return 'moved';
    }
    const again = await readPreimage(engine, op, [...targets, ...pre.pages.map((p) => ({ source: p.source_id ?? 'default', slug: p.slug ?? '' }))]);
    return movedOutsideFootprint(op, args, pre, again) ? 'moved' : 'clear';
  } catch { return 'failed'; }
}

/** The options the Rust putPage takes (store-members/pages.ts `takeOptions`; `inline` it ignores). The whole options object is sent with the write, and any other key (`contextualRetrieval`, which the store refuses) is one the replay does not carry: the sample is uncomparable. */
export const PUT_PAGE_OPTIONS: ReadonlySet<string> = new Set(['sourceId', 'allowEmptyOverwrite', 'expectedRevision', 'force', 'inline', 'contextualRetrieval']);
const knownOptions = (name: string, args: unknown[]): boolean => name !== 'putPage' || Object.keys((args[2] as object | undefined) ?? {}).every((k) => PUT_PAGE_OPTIONS.has(k));
const STAMP = 'updatePageContextualRetrievalState'; // changes a compared page column (contextual_retrieval_mode) after the page write: the replay runs the same call (WriteEvent.then)
/** Writes after a sampled putPage in its transaction that leave the compared page row and links as the write made them (chunks are not compared). */
const LATER_WRITES: ReadonlySet<string> = new Set(['upsertChunks', 'deleteChunks', 'deleteChunksExcept', 'moveChunkIndexes', 'setPageAliases', 'replaceDerivedAliases', 'pruneFrontmatterTags', 'addPageTagsById', 'writeTextProjectionSeal', STAMP]);
/**
 * Tables only the writer's own bookkeeping touches; nothing the comparison reads. A raw write is benign when every table it writes is one of these. `timeline_entries`, `takes`
 * and `content_chunks` are not compared, nor is `wanted_links` (the links effect's rows for mention targets that do not exist yet): the read-back's getPage and getLinks never read it.
 */
const BOOKKEEPING: ReadonlySet<string> = new Set(['persistence_counters', 'persistence_effects', 'persistence_requests', 'op_checkpoints', 'write_gate_receipts', 'sources', 'timeline_entries', 'takes', 'content_chunks', 'page_projection_jobs', 'config', 'wanted_links']);
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
/** A single `LOCK TABLE <names> IN <mode> MODE [NOWAIT]` statement: no `;` inside, so no second statement can ride behind it. (The write parser reads `SHARE UPDATE EXCLUSIVE` as an UPDATE, so a lock is never left to it.) */
const PURE_LOCK = /^\s*LOCK\s+TABLE\s+(ONLY\s+)?[\w."]+(\s*,\s*(ONLY\s+)?[\w."]+)*\s+IN\s+[A-Za-z ]+\s+MODE(\s+NOWAIT)?\s*;?\s*$/i;
function rawKind(args: unknown[]): 'bookkeeping' | 'seal' | undefined {
  const sql = args[0];
  if (typeof sql !== 'string') return undefined;
  if (AFTER_PAGE_WRITE.has(squash(sql))) return 'seal';
  if (PURE_LOCK.test(sql)) return 'bookkeeping'; // one table lock and nothing else changes no row; a batch that holds more goes through the table check below, whole
  try { const writes = sqlWrites(sql); return writes.length > 0 && writes.every((w) => w.kind === 'relation' && BOOKKEEPING.has(w.relation)) ? 'bookkeeping' : undefined; } catch { return undefined; }
}
/**
 * True when every statement is read-only or writes only bookkeeping tables (the raw rule above) and, unless `readOnly` allows none, at least one writes; a statement the parser
 * cannot read, or one that writes any other table, makes it false. A read-only statement here takes locks or sets transaction-local settings (the typed members below).
 */
export function bookkeepingStatements(sqls: readonly string[], readOnly = false): boolean {
  let wrote = false;
  for (const sql of sqls) {
    let writes; try { writes = sqlWrites(sql); } catch { return false; }
    if (writes.some((w) => w.kind !== 'relation' || !BOOKKEEPING.has(w.relation))) return false;
    if (writes.length) wrote = true;
  }
  return wrote || readOnly;
}
/**
 * Typed journal members and every statement each one sends (engine-sql/persistence-journal.ts): the counter rows' create-and-lock before a journaled page write, and the
 * request's completion after it, and the publication's effects insert (insertPublicationEffects, which writes only persistence_effects: judged bookkeeping by its statement text,
 * pinned by test/helpers/shadow-write-compare-scenarios.ts; a change that makes it write another table drops it back to an ordinary write). They were raw statements the rule above judged bookkeeping; as members their text is hidden from rawKind, so each is judged here by the
 * same rule on the statements it sends. A member whose statements stop passing that rule is an ordinary write again. (upsertWriteGateReceipt is not listed: it stays an
 * ordinary write, which fails closed.)
 */
export const JOURNAL_MEMBER_STATEMENTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['lockPersistenceCounters', [ENSURE_COUNTERS_SQL, LOCK_COUNTERS_SQL]],
  ['completeWriteRow', [COMPLETE_WRITE_SQL, COMPLETE_WRITE_PURGE_PROBE_SQL]],
  // The publication's effects insert (persistence_effects only): a raw statement the rule judged bookkeeping until the journal moved onto this member.
  ['insertPublicationEffects', [PUBLICATION_EFFECTS_SQL]],
  // The links effect's own transaction around its addLinksBatch (persistence/effect-links.ts): the effect row's completion (persistence_effects only) and the members that
  // only lock rows or set transaction-local settings (EFFECT_LOCK_MEMBERS: their statements write nothing).
  ['completeEffectRow', [COMPLETE_EFFECT_SQL]],
  ['setEffectTransactionLimits', [EFFECT_TRANSACTION_LIMITS_SQL]],
  ['declarePersistence', [persistenceDeclarationStatement().sql, persistenceDeclarationStatement({ lockTimeout: '1s', statementTimeout: '1s' }).sql, persistenceDeclarationStatement({ lockTimeout: '1s', statementTimeout: '1s', idleInTransaction: '1s' }).sql]],
  ['lockEffectGuard', [EFFECT_GUARD_BRAIN_SQL, EFFECT_GUARD_WORKTREE_SQL]],
  ['lockEffectClaimRow', [EFFECT_CLAIM_ROW_LOCK_SQL]],
]);
/** The members above whose statements only lock rows or set transaction-local settings: judged by the same rule with no write required. */
export const EFFECT_LOCK_MEMBERS: ReadonlySet<string> = new Set(['setEffectTransactionLimits', 'declarePersistence', 'lockEffectGuard', 'lockEffectClaimRow']);
/** The closing text seal of an imported page (engine-sql/write-guards.ts sealImportedPage): the statement AFTER_PAGE_WRITE matched by text while it was raw, pinned by test/shadow-follow-producer.test.ts. */
const SEAL_MEMBER = 'sealImportedPage';
const BOOKKEEPING_MEMBERS: ReadonlySet<string> = new Set([...JOURNAL_MEMBER_STATEMENTS].filter(([name, sqls]) => bookkeepingStatements(sqls, EFFECT_LOCK_MEMBERS.has(name))).map(([name]) => name));
/**
 * True for a typed journal member above whose statements pass the bookkeeping rule. The follower reports these members as unmapped writes, and its
 * page/link write count (follower.ts `pageLinkWrites`, this sampler's `generation`) skips a batch only when it holds no page or link item and every invalid item is
 * `unmapped_write:<member>` for one of these members: the effect worker's next claim or a receipt true-up committing during a sample's read-back is not another writer.
 */
export const bookkeepingMember = (name: string): boolean => BOOKKEEPING_MEMBERS.has(name);
const pageKey = (name: string, args: unknown[]): string => { const r = pageRefs(name === STAMP ? 'putPage' : name, name === STAMP ? [args[0], undefined, { sourceId: args[1] }] : args)[0]; return r ? `${r.source}\0${r.slug}` : ''; };

/** The target page as the transaction commits it (beforeCommit): its revision, and its compared fields as `readBackText` writes them. */
interface Pin { revision: string; text: string }
interface TxSample { at: number; key: string; op: string; bad?: string; pin?: Pin; read?: (then: unknown[][]) => void }
interface Scope extends TxScope { root: BrainEngine; followed: boolean; log: Array<{ name: string; key: string; args?: unknown[]; path: number[]; kind?: 'bookkeeping' | 'seal' }>; samples: TxSample[]; nested: number }

const PREIMAGE_REASONS: ReadonlySet<string> = new Set(['preimage_too_large', 'preimage_timeout', 'soft_deleted_page', 'fact_overlay']);
/**
 * Closes the gate of `scope`: until the returned function runs, the wrapper holds every new member call of the transaction. Opening it starts the held calls in order, each
 * at once, until one closes the gate again (a held sampled write); the rest stay queued for that one. Each call is woken once, however many writes are queued.
 */
export function holdGate(scope: TxScope): () => void {
  let resolve!: () => void;
  scope.gate = new Promise<void>((r) => { resolve = r; });
  let opened = false;
  return () => {
    if (opened) return;
    opened = true; scope.gate = null; resolve();
    while (!scope.gate && scope.waiters.length) scope.waiters.shift()!();
  };
}

/** True when every call in `calls` settles within `ms`. */
const settledWithin = async (calls: Promise<void>[], ms: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.all(calls).then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); } finally { clearTimeout(timer); }
};

const timeout = <T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { onTimeout(); reject(new Error('preimage_timeout')); }, ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

/**
 * Why a sample cannot be compared given the writes its transaction made, or null. A putPage: an earlier write to anything the comparison reads (a version row is not read),
 * a later one that is not a chunk write, or another putPage of the same page. A link write or a page delete: any other write of the transaction but a version row and the
 * writer's own bookkeeping (locks, the effect journal), since its read-back reads the pages it names and every link among them.
 */
function judge(sc: Scope, s: TxSample): string | null {
  const page = s.op === 'putPage';
  for (const [i, w] of sc.log.entries()) {
    if (i === s.at || w.name === 'createVersion' || w.kind === 'bookkeeping') continue;
    if (page && ((i > s.at && w.kind === 'seal') || (w.name === 'putPage' && w.key !== s.key) || (i > s.at && LATER_WRITES.has(w.name)))) continue;
    return page && w.name === 'putPage' ? 'in_transaction_same_page' : i < s.at ? 'in_transaction_prior_write' : 'in_transaction_later_write';
  }
  return null;
}

/** `unsaid` is shared by a sampler and its forks: a loss one of them could not record rides on the next line any of them sends. */
export function createWriteSampler(o: WriteSamplerOptions, unsaid: string[] = []): WriteSampler {
  const random = o.random ?? Math.random;
  const rate = Math.min(1, Math.max(0, o.rate));
  /** Samples the pipe refused since the last one it took: the next line carries the count, so a shed sample is counted `uncomparable`, never lost as if it were not sampled. */
  // `unsaid`: reasons of losses the journal could not take: the next accepted line carries their count, and settle() retries them
  const send = (event: WriteEvent): void => {
    try {
      const carry = Math.min(unsaid.length, MAX_DROPPED); // a line carries at most what the weight rule counts; the rest waits for later lines, never cleared unsaid
      let line = JSON.stringify({ ...event, ...(carry ? { dropped: carry } : {}) }) + '\n';
      if (Buffer.byteLength(line) > MAX_SAMPLE_BYTES) line = JSON.stringify({ t: 'write', op: event.op, outcome: 'uncomparable', reason: 'sample_too_large', ...(carry ? { dropped: carry } : {}) }) + '\n';
      if (o.send(line)) {
        unsaid.splice(0, carry);
        // What the line could not carry goes out now, in the same flush, as loss-only lines of at most MAX_DROPPED each (each is one more uncomparable sample plus its losses, owed and settled like any line): nothing is left waiting in memory for a later sampled write. A refusal stops it; the rest waits exactly as a refused send's does.
        while (unsaid.length > 0) {
          const more = Math.min(unsaid.length, MAX_DROPPED);
          if (!o.send(JSON.stringify({ t: 'write', op: event.op, outcome: 'uncomparable', reason: 'send_shed', dropped: more }) + '\n')) break;
          unsaid.splice(0, more);
        }
        if (unsaid.length > 0 && o.owe?.(unsaid.length)) unsaid.length = 0; // a refusal ended the drain: what is left is owed durably (the worker books it as lost), never left only in memory
      } else if (!o.lost?.('send_shed') && !o.refuse?.(1)) unsaid.push('send_shed');
    } catch { /* the shadow never fails a write */ }
  };
  const uncomparable = (op: string, reason: string): void => send({ t: 'write', op, outcome: 'uncomparable', reason });
  /** Read-backs still running; `abandoned` is set when settle() has counted one, so it sends nothing later (a sample is counted once). */
  const reading = new Set<{ abandoned: boolean; done: Promise<void> }>();
  /** Off the request path, and nothing in it may escape: an encode that throws (a segmented page's body getters) is one more uncomparable sample. */
  /** `own`: how much the sampled write itself moves the write counter (one follow batch; none in a transaction the follower does not see), so only a move beyond it is another write. */
  const readBackAndSend = (engine: BrainEngine, name: string, args: unknown[], encoded: unknown[], targets: PageRef[], pre: PreImage, result: unknown, before: number | undefined, then: unknown[][] = [], pin?: Pin, own = 1): void => {
    const sample = { abandoned: false, done: Promise.resolve() };
    sample.done = (async () => {
      try {
        const back = await readBack(engine, targets, pageSet(targets, pre));
        const after = o.generation?.();
        // A brain other processes can write (not PGLite, whose single-writer file lock rules them out) needs the data fence (write-compare.ts). The counter (this process's writes to pages or links, whichever rows) keeps deciding
        // too, because the fence exempts the write's own target rows, which a concurrent same-process write can change (a link's context, a page's contextual-retrieval mode). The one exemption: an in-transaction putPage
        // whose fence completed and whose page was pinned just before the commit: the fence and the pin (the revision and every compared field of the page, read again here) cover its target rows, so the counter does not also decide.
        // A fence that failed marks the sample moved. Without a completed fence the counter decides, as it always did.
        const counterMoved = before !== undefined && after !== undefined && after - before > own;
        const fence = hasCapability(engine, 'postgres_admin') ? await fenced(engine, name, args, targets, pre, result, back, pin?.revision) : undefined;
        const pinMoved = pin !== undefined && readBackText(encodeValue({ pages: [back.pages[0]], links: [] })) !== pin.text;
        const moved = fence === undefined ? counterMoved : fence !== 'clear' || pinMoved || (pin === undefined && counterMoved);
        if (!sample.abandoned) send({ t: 'write', op: name, args: encoded, pre, post: encodeValue(back), moved, ...(then.length ? { then: then.map((a) => encodeArgs(a, { left: CAPTURE_BUDGET_BYTES })) } : {}) });
      } catch { if (!sample.abandoned) uncomparable(name, 'readback_failed'); }
    })();
    reading.add(sample); void sample.done.finally(() => reading.delete(sample));
  };
  /**
   * A pilot write inside a transaction: the preimage is read on the transaction's own connection before the write is sent, the write runs untouched, and the sample waits for
   * the commit (TxScope.commit). A rolled-back transaction drops it. Calls that started before it and have not settled (a pipelined version row beside an edit) could send
   * statements inside the preimage savepoint and be rolled back with it, so the write first waits for them, with every later call held behind the gate; one that does not
   * settle in time, or that runs a callback (a nested transaction), leaves the write unsampled through the savepoint (`in_transaction_busy`).
   */
  const inTransaction = (scope: Scope, tx: BrainEngine, name: string, args: unknown[], run: () => unknown): Promise<unknown> => {
    const s: TxSample = { at: scope.log.length, key: pageKey(name, args), op: name };
    scope.samples.push(s);
    const ahead = [...scope.running];
    if (ahead.some((c) => c.callback)) { s.bad = 'in_transaction_busy'; return Promise.resolve(run()); }
    const before = o.generation?.();
    const open = holdGate(scope);
    return (async () => {
      let encoded: unknown[] = []; let pre: PreImage | undefined; let targets: PageRef[] = [];
      try {
        if (ahead.length && !await settledWithin(ahead.map((c) => c.done), o.preimageTimeoutMs ?? PREIMAGE_TIMEOUT_MS)) s.bad = 'in_transaction_busy';
        s.bad ??= (knownOptions(name, args) ? judge(scope, s) : 'unknown_option') ?? undefined;
        encoded = encodeArgs(args, { left: CAPTURE_BUDGET_BYTES });
        targets = pageRefs(name, args);
        if (targets.length > MAX_PRE_PAGES) throw new Error('preimage_too_large');
        if (!s.bad) pre = await readPreimage(scope.root, name, targets, undefined, tx);
      } catch (error) { const why = (error as Error)?.message; s.bad ??= why && PREIMAGE_REASONS.has(why) ? why : 'preimage_unreadable'; }
      let sent: unknown;
      try { sent = run(); } finally { open(); } // sent before other members are let go: they keep their order behind it
      let result: unknown;
      try { result = await sent; } catch (error) { s.bad ??= 'primary_write_failed'; throw error; }
      if (pre) s.read = (then) => readBackAndSend(scope.root, name, args, encoded, targets, pre!, result, before, then, s.pin, scope.followed ? 1 : 0);
      return result;
    })();
  };
  return {
    fork: () => createWriteSampler(o, unsaid),
    async settle(ms) {
      const idle = Promise.all([...reading].map((r) => r.done));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([idle, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
      clearTimeout(timer);
      for (const r of reading) { r.abandoned = true; if (!(o.lost?.('readback_abandoned'))) unsaid.push('readback_abandoned'); } // not sent later
      reading.clear();
      for (const reason of unsaid.splice(0)) if (!o.lost?.(reason) && !o.refuse?.(1)) unsaid.push(reason); // the final handoff, whether or not another sample comes
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
        const scope = ctx.inTransaction && !ctx.nested ? ctx.scope as Scope | undefined : undefined; // every pilot write of an outermost transaction is compared after its commit
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
    scope(root, opts) {
      const followed = opts?.followed !== false;
      const sc: Scope = {
        root, log: [], samples: [], gate: null, waiters: [], inflight: 0, running: new Set(), nested: 0, followed,
        note: (name, args, path = []) => { sc.log.push({ name, key: name === 'putPage' || name === 'createVersion' || name === STAMP ? pageKey(name, args) : '', path, ...(name === STAMP ? { args } : {}), ...(BOOKKEEPING_MEMBERS.has(name) ? { kind: 'bookkeeping' as const } : name === SEAL_MEMBER ? { kind: 'seal' as const } : {}), ...(name === 'executeRaw' ? { kind: rawKind(args) } : {}) }); },
        beforeCommit: async (tx) => {
          try {
            if (!hasCapability(sc.root, 'postgres_admin')) return; // the fence (and so the pin) runs only where others can write
            const pending = sc.samples.filter((s) => s.read && !s.bad && s.op === 'putPage');
            if (!pending.length) return;
            // A call still running (pipelined, not awaited) may send statements inside the savepoint below, which is rolled back: nothing is read, and the sample is not comparable.
            if (sc.inflight > 0) { for (const s of pending) s.bad ??= 'in_transaction_busy'; return; }
            const open = holdGate(sc);
            try {
              for (const s of pending) {
                const [source, slug] = s.key.split('\0');
                try {
                  s.pin = await inSavepoint(tx, async (inner) => {
                    await digestQuery(inner)(`SET LOCAL statement_timeout = ${PREIMAGE_TIMEOUT_MS}`); // bounds the read; the savepoint's rollback takes it away
                    const page = await inner.getPage(slug!, { sourceId: source!, includeDeleted: true }) as { knowledge_revision?: unknown } | null; // the typed read the read-back makes, on the transaction's own connection
                    if (!page || typeof page.knowledge_revision !== 'string') throw new Error('pin_missing');
                    return { revision: page.knowledge_revision, text: readBackText(encodeValue({ pages: [page], links: [] })) };
                  });
                } catch { s.bad ??= 'preimage_unreadable'; } // silent-read-ok: an unreadable pin leaves the sample uncomparable (s.bad), never a pass // capability-refusal-ok: a refusal here is a read the sampler could not make, and the sample is then not compared
              }
            } finally { open(); }
          } catch { /* the shadow never fails a write */ } // silent-read-ok: nothing is read or sent here, and a sample without its pin keeps the counter and the write's returned revision // capability-refusal-ok: the sampler never fails or changes a primary write
        },
        unsettled: (reason) => { for (const s of sc.samples) if (!s.read) s.bad ??= reason; },
        open: () => ++sc.nested,
        drop: (id) => { for (let i = sc.log.length - 1; i >= 0; i--) if (sc.log[i]!.path.includes(id)) { sc.log.splice(i, 1); for (const s of sc.samples) if (s.at > i) s.at--; } },
        commit: () => { for (const s of sc.samples) { const bad = s.bad ?? judge(sc, s); if (bad || !s.read) uncomparable(s.op, bad ?? 'in_transaction'); else s.read(s.op === 'putPage' ? sc.log.filter((w, i) => i > s.at && w.name === STAMP && w.key === s.key).map((w) => w.args!) : []); } },
      };
      return sc;
    },
  };
}
