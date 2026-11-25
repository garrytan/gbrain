/**
 * What the serving process answers when the shadow child asks (`ask` lines; supervisor.ts `onAsk`). Three questions, all
 * about the primary, which only this process can read. The child names the sample by its OPAQUE sample id (samples.ts); the
 * read's arguments and the caller's access record stay in this process, and a failure goes back as an allowlisted code.
 *
 *   privacy  The child sends the identities of the Rust rows (page, chunk, digests: no content). This process compares them with
 *            the primary's own answer, which it kept under the sample id: a row byte-equal to a primary row in every field but
 *            the ranking ones is held; a row that has a primary row's page and chunk but another payload, or claims a chunk
 *            it does not identify, is unexplained; any other row is judged here, in one read-only snapshot, with the existing
 *            policy fragment (private-visibility.ts `privatePagesFilterForCaller`) under the captured `CallerAccess`, the
 *            primary's safe-chunk fence when its read asked for it, and the chunk visibility the primary used; a ranked vector search's extra row clears
 *            only when it is also the primary's own stored row (the same read, widened, same filters) in every field but the ranking ones. The answer is a
 *            verdict (`clean` with `complete`, `violation`, `moved`), never content. It is `moved` unless this process can PROVE
 *            nothing was written since the primary read started: the primary's freshness token (`createLsnWatch`: the snapshot's xmax and the transactions in progress),
 *            known before that read started, must still hold at the end of the check (a commit to any table, the catalog, or a change
 *            undone again moves it; a read pruning dead rows, a checkpoint or a vacuum does not); its own write generation (follower.published, read live before and after the check) must
 *            equal the one captured with the sample, no page or access row may carry a time later than the read, and the access
 *            tables' generation must hold across the check. The child then runs both engines again from a new position, up to 3 times. Without proof the child calls the sample inconclusive, never clean.
 *   rerun    The stable-generation barrier for a mismatch that nothing explains (plan decision 7). When everything published
 *            has been read and sent, a `barrier` call goes down the follow stream behind the last batch; the child acks
 *            only when it applied everything before it and its watermark is valid. The primary read runs next, and the
 *            rerun is refused if any batch was published, or a send was shed, since the barrier. The child then runs the
 *            Rust read holding its follow lock (follow-child.ts `exclusive`). Any race, restart, invalid watermark or the
 *            30 s deadline throws and leaves the sample inconclusive. It never spins: an invalidation that cannot progress
 *            refuses at once, and every wait yields to the event loop. The answer is the epoch, the barrier stamp and a digest
 *            of the primary's rerun answer (kept here for the privacy question), never the answer itself.
 *   vector   The exact reference of a vector sample (recall.ts), at most one a minute: the engine's own exact statement
 *            (`exactSql`: no candidate window, `ORDER BY (distance) + 0`) with its filters, scoring, per-page collapse and
 *            tie-break, run here on a reference-only path. The engine's search itself is not touched. The reference is refused
 *            (`moved`) unless the freshness token and the write generation are the ones the sample was held to, at the end of the run
 *            (the same proof as the privacy question); the child then runs both engines and the reference again, up to 3 times.
 */
import type { BrainEngine } from '../core/engine.ts';
import { hasCapability } from '../core/engine-capabilities.ts';
import { privatePagesFilterForCaller, withCallerAccess, withoutCallerAccess, type CallerAccess } from '../core/search/private-visibility.ts';
import { chunkVisibleFilter, requiresSafeChunks, safeChunksFilter } from '../core/search/safe-chunks.ts';
import { buildVectorSearchStatement } from '../core/search/vector-statement.ts';
import type { SearchOpts } from '../core/types.ts';
import { decodeValue, encodeValue } from './codec.ts';
import { candidatesOf, extraIds, matchesStored, membersDigest, resultDigest, rowIdentities, storedPayloads, type ExtraRow, type RowIdentity } from './child-checks.ts';
import { readEpoch } from './evidence-epoch.ts';
import type { ShadowFollower } from './follower.ts';
import type { ReadSource } from './read-pool.ts';
import { firstTenKeys, IntervalGate, rankedKeys, RECALL_INTERVAL_MS, RECALL_REFERENCE_LIMIT, type RankedKey } from './recall.ts';
import { isShadowReadMember, SHADOW_READ_MEMBERS, type ShadowReadMember } from './reads.ts';
import { RERUN_ATTEMPTS_KEPT, type RerunAttempt, type Sample, type SampleRegistry } from './samples.ts';

export const RERUN_DEADLINE_MS = 30_000;

/** Pages a Rust answer named that the primary's own answer did not: by id, by (source, slug) and by chunk id. */
export interface PageCandidates { ids: number[]; keys: string[]; chunks: number[] }
/** The serving process's verdict on a sample's Rust rows (never content). `complete`: every extra row was identified and judged. */
export interface PrivacyAnswer { verdict: 'clean' | 'violation' | 'privacy_check_moved'; complete: boolean }
/** `digest`: the whole answer; `members`: the same rows with scores and order taken out, for a ranked read (reads.ts), else absent. */
export interface RerunAnswer { stamp: number; epoch_id: string; digest: string; members?: string; /** A vector read's rerun answer as ranked keys (chunk ids and scores, no content), for the recall score of the rerun. */ keys?: Array<RankedKey | null>; /** The attempt id the follow-up privacy and reference asks name. */ attempt?: string }

/** Runs `fn` as the captured caller, or outside any caller record when the read had none (a record changes the page policy text). */
const asCaller = <T>(access: Partial<CallerAccess> | undefined, fn: () => T): T => (access ? withCallerAccess(access, fn) : withoutCallerAccess(fn));
const coded = (code: string): Error => Object.assign(new Error(code), { code });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
/** One turn of the event loop for I/O and timers (a resolved promise only yields to microtasks). */
const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** The access tables' revisions and counts: it changes whenever a member, group, folder rule or pending prefix does. */
const POLICY_GENERATION_SQL = `SELECT concat_ws('|',
  (SELECT count(*) || ':' || COALESCE(max(revision), 0) FROM access_policy_revisions),
  (SELECT count(*) FROM access_rules), (SELECT count(*) FROM access_pending_coverage),
  (SELECT count(*) || ':' || COALESCE(max(updated_at)::text, '') FROM access_members), (SELECT count(*) FROM access_group_members)) AS generation`;

/** Whether any page or access row carries a time later than `$1` (epoch ms): a lineage origin widened after the read shows here, not on the returned page. */
const CHANGED_AFTER_SQL = `SELECT (EXISTS (SELECT 1 FROM pages WHERE updated_at > to_timestamp($1::double precision / 1000.0))
  OR EXISTS (SELECT 1 FROM access_members WHERE updated_at > to_timestamp($1::double precision / 1000.0))
  OR EXISTS (SELECT 1 FROM access_rules WHERE created_at > to_timestamp($1::double precision / 1000.0))
  OR EXISTS (SELECT 1 FROM access_pending_coverage WHERE created_at > to_timestamp($1::double precision / 1000.0))
  OR EXISTS (SELECT 1 FROM access_policy_revisions WHERE created_at > to_timestamp($1::double precision / 1000.0) OR applied_at > to_timestamp($1::double precision / 1000.0))) AS changed`;

/**
 * What the freshness token is made of. A committed change to any table or to the catalog (a policy altered in place) needs a transaction
 * that commits, and a commit is the one step that makes data visible to a later read: it moves `xmax` of the primary's transaction
 * snapshot (`pg_snapshot_xmax(pg_current_snapshot())`, one more than the newest transaction that has finished, in the whole cluster) when its
 * xid is at or above the captured one, and a transaction that was already running at the capture (below `xmax`, or not yet visible) is
 * listed by its xid and asked about at the end. Writes that carry no xid and change no data a read could see (a read pruning dead rows,
 * a checkpoint, a standby snapshot, a vacuum of another database, a hint bit) move the WAL position but never the snapshot's xmax, and so move nothing here.
 * The snapshot's xids are xid8 (an epoch and a 32-bit xid): they are kept and compared whole, as BigInt, never as 32-bit values.
 * Primary only: a server in recovery (a hot standby) replays writers that are in neither list (no `xip` entry, no local `backend_xid`), so
 * its xmax proves nothing; the token is blind there and the end of a check refuses.
 */
const XIP_SQL = `WITH s AS (SELECT pg_current_snapshot() AS snap)
  SELECT
    (SELECT pg_snapshot_xmax(snap)::text FROM s) AS xmax,
    (SELECT string_agg(x::text, ',') FROM s, pg_snapshot_xip(s.snap) x) AS xip,
    (SELECT string_agg(a.backend_xid::text, ',') FROM pg_stat_activity a WHERE a.backend_xid IS NOT NULL AND a.pid <> pg_backend_pid()) AS backend,
    (SELECT count(*) FROM pg_stat_activity WHERE backend_type IS NULL AND pid <> pg_backend_pid())::int AS blind,
    (SELECT count(*) FROM pg_prepared_xacts)::int AS prepared,
    pg_is_in_recovery() AS recovery`; // a row this role may not see has every column NULL, its backend type too; a server in recovery (a hot standby) never proves fresh

const XID_RANGE = 4294967296n;

/**
 * A running session's 32-bit xid (pg_stat_activity.backend_xid) as an xid8: it takes the epoch of `xmax` (an in-progress xid is within
 * half a range of it), the one before or the one after when that puts it more than half a range away.
 */
export function widenXid(xid: bigint, xmax: bigint): bigint {
  const c = (xmax / XID_RANGE) * XID_RANGE + (xid % XID_RANGE);
  return c > xmax + XID_RANGE / 2n ? c - XID_RANGE : c < xmax - XID_RANGE / 2n ? c + XID_RANGE : c;
}

/** The token text: `<xmax>|<xid>,<xid>...`, or `<xmax>|!` when it is blind (never proven). */
export function composeToken(xmax: bigint, xids: bigint[], blind: boolean): string {
  return `${xmax}|${blind ? '!' : [...new Set(xids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',')}`;
}

/** The parts of a token, or null for text that is not one (never proven). */
export function parseToken(token: string | undefined): { xmax: bigint; xids: bigint[]; blind: boolean } | null {
  if (token === undefined) return null;
  const cut = token.indexOf('|');
  if (cut < 0 || !/^[0-9]+$/.test(token.slice(0, cut))) return null;
  const rest = token.slice(cut + 1);
  if (rest === '!') return { xmax: BigInt(token.slice(0, cut)), xids: [], blind: true };
  const parts = rest === '' ? [] : rest.split(',');
  if (!parts.every((x) => /^[0-9]+$/.test(x))) return null;
  return { xmax: BigInt(token.slice(0, cut)), xids: parts.map((x) => BigInt(x)), blind: false };
}

/** The snapshot has moved past the captured one when its xmax is anything but the captured xmax (it only grows). */
export const xmaxMoved = (captured: bigint, now: bigint): boolean => now !== captured;

/**
 * The freshness token (see XIP_SQL), taken in ONE statement so the xmax and the xids in progress come from the same snapshot: the xids of
 * the snapshot, the xids the sessions are running (pg_stat_activity.backend_xid: the top-level xid, the one whose commit makes a
 * subtransaction's writes visible), and whether a prepared (two-phase) transaction exists or a session cannot be seen into (blind, `!`: never proven).
 */
async function captureToken(reads: ReadSource): Promise<string> {
  const [row] = await reads.read((tx) => tx.executeRaw<{ xmax: string; xip: string | null; backend: string | null; blind: number; prepared: number; recovery: boolean | null }>(XIP_SQL));
  if (!row || !/^[0-9]+$/.test(String(row.xmax))) throw new Error('no snapshot');
  const xmax = BigInt(row.xmax);
  const list = (text: string | null | undefined): bigint[] => (text ? text.split(',').map((x) => BigInt(x)) : []);
  const xids = [...list(row.xip), ...list(row.backend).map((x) => widenXid(x, xmax))];
  return composeToken(xmax, xids, Number(row.blind) > 0 || Number(row.prepared) > 0 || row.recovery !== false); // in recovery, or not known to be a primary: never proven
}

/**
 * True only when nothing was written and nothing became visible since `token` was captured: the snapshot's xmax is the captured one, no
 * transaction listed in it has committed now (one that is no longer known counts as committed) and no prepared transaction exists. Called
 * after the data a check judges has been read, so anything that becomes visible later does not touch what was read. A token that is not one
 * (a sample captured before any was known) is never proven.
 */
async function unchangedSince(reads: ReadSource, token: string | undefined): Promise<boolean> {
  const t = parseToken(token);
  if (!t || t.blind) return false; // sessions of other roles that this one cannot see into, or a prepared transaction at the capture: nothing can be proven
  const [row] = await reads.read((tx) => tx.executeRaw<{ xmax: string; moved: boolean; prepared: boolean; recovery: boolean | null }>(
    `SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS xmax,
      COALESCE((SELECT bool_or(COALESCE(pg_xact_status(x::xid8), 'committed') NOT IN ('in progress', 'aborted')) FROM unnest($1::text[]) x), false) AS moved,
      EXISTS (SELECT 1 FROM pg_prepared_xacts) AS prepared,
      pg_is_in_recovery() AS recovery`, [t.xids.map(String)])); // a prepared transaction at the end of the check: never proven, whatever it was at the capture; nor is a server in recovery
  return !!row && /^[0-9]+$/.test(String(row.xmax)) && !xmaxMoved(t.xmax, BigInt(row.xmax)) && row.moved === false && row.prepared === false && row.recovery === false;
}

/**
 * The freshness token, kept fresh off the request path. `current()` is synchronous (a read is captured on the request path): it
 * returns the latest token a refresh completed BEFORE this moment, so it is never newer than the read it is stored with (the pair
 * is cached together), and starts a refresh when the one it holds is older than `ttlMs`. A stale token only makes the proof fail,
 * never pass. `undefined` until the first refresh completes, or when the engine cannot give the pair (a sample captured then is never
 * proven unchanged: it fails closed).
 */
export interface LsnWatch { current(): string | undefined; live(): Promise<string>; ready(): Promise<void> }
export function createLsnWatch(reads: ReadSource, now: () => number = Date.now, ttlMs = 200): LsnWatch {
  let value: string | undefined;
  let at = -Infinity;
  let inflight: Promise<void> | null = null;
  const refresh = (): Promise<void> => (inflight ??= (async () => {
    try { const v = await captureToken(reads); value = v; at = now(); } catch { /* the value stays older: the proof fails, never passes */ }
    inflight = null;
  })());
  return {
    current: () => { if (now() - at >= ttlMs) void refresh(); return value; },
    live: () => captureToken(reads),
    ready: () => refresh(),
  };
}

/** Does the read's own scope ask for the safe-chunk fence (`requireSafeChunks`, else `excludePrivate`)? Any argument that does, does. */
const safeFenceApplies = (args: unknown[]): boolean => args.some((a) => !!a && typeof a === 'object' && requiresSafeChunks(a as { requireSafeChunks?: boolean; excludePrivate?: boolean }))
  || args.some((a) => { const o = a as { remote?: unknown; untrusted?: unknown } | null; return !!o && typeof o === 'object' && [o.remote, o.untrusted].some((x) => !!x && typeof x === 'object' && requiresSafeChunks(x as { requireSafeChunks?: boolean; excludePrivate?: boolean })); });

/** The most Rust row identities one privacy question holds; a longer list is never complete. */
export const IDENTITY_LIMIT = 2000;

interface Base { at: number; gen?: number; lsn?: string }

/**
 * What the primary's policy says about the candidates, held to the generation of the read that produced the rows (`base`: the
 * sample's own, or the stable rerun's). `generation` reads this process's write generation NOW (follower.published), before and
 * after the snapshot, when it has a follower. `moved` is true unless everything the policy reads is proven unchanged.
 */
async function policySnapshot(reads: ReadSource, access: Partial<CallerAccess> | undefined, cand: PageCandidates, safe: boolean, base: Base | undefined, generation: () => number | undefined, hasFollower: boolean, stored?: () => Promise<Map<string, string>>) {
  const accessGeneration = (): Promise<string> => reads.read(async (tx) => String((await tx.executeRaw<{ generation: string }>(POLICY_GENERATION_SQL))[0]?.generation));
  const gen0 = generation();
  const before = await accessGeneration();
  const { rows, chunks, changed } = await reads.read(async (tx) => ({
    rows: await asCaller(access, () => tx.executeRaw<{ id: number | string; key: string; allowed: boolean }>(
      `SELECT p.id, p.source_id || E'\\x1f' || p.slug AS key, (${privatePagesFilterForCaller('p')}) AS allowed FROM pages p
        WHERE p.id = ANY($1::bigint[]) OR (p.source_id || E'\\x1f' || p.slug) = ANY($2::text[])`, [cand.ids, cand.keys])),
    chunks: await tx.executeRaw<{ id: number | string; page_id: number | string; sum: string }>(
      `SELECT c.id, c.page_id, md5(c.chunk_text) AS sum FROM content_chunks c JOIN pages p ON p.id = c.page_id
        WHERE c.id = ANY($1::bigint[]) AND ${chunkVisibleFilter('p', 'c')}${safe ? ` AND ${safeChunksFilter('p')}` : ''}`, [cand.chunks]), // a staged, retired or unsealed chunk is not one the primary can return
    // 1 ms of slack: a write that finished before the read can carry a microsecond time past the read's millisecond.
    changed: base ? (await tx.executeRaw<{ changed: boolean }>(CHANGED_AFTER_SQL, [base.at + 1]))[0]?.changed === true : true,
  }));
  const payloads = stored ? await stored().catch(() => new Map<string, string>()) : new Map<string, string>(); // read here, before the proof below ends: the proof covers it; a row that cannot be read is not held
  const gen1 = generation();
  // The proof: nothing was committed between the token known before the primary read started and the end of this check (any table, the catalog, or a change undone again).
  const held = await unchangedSince(reads, base?.lsn);
  const unproven = !base || base.lsn === undefined || (hasFollower && base.gen === undefined);
  const moved = unproven || !held || changed || (hasFollower && (gen0 !== base?.gen || gen1 !== base?.gen)) || before !== await accessGeneration();
  return {
    moved, violations: rows.filter((r) => r.allowed !== true).length,
    payloads, pages: rows.map((r) => ({ id: Number(r.id), key: r.key })), chunks: chunks.map((c) => ({ id: Number(c.id), page_id: Number(c.page_id), sum: c.sum })),
  };
}

/** The most rows the primary's stored copy of a ranked vector search holds: the caller's limit widened (never below this many, never above the cap). */
export const STORED_ROWS_FLOOR = 50;
export const STORED_ROWS_CAP = 500;

/**
 * The primary's own stored rows for a ranked vector search, to compare an extra Rust row with: the same read as the sample (the caller's
 * access, filters, scope and ranking) with the limit widened and no offset, so a row the caller's own filters exclude is simply not in it.
 * Row identity (page and chunk) maps to the digest of every field but the ranking ones. A read that fails holds nothing (no extra row clears).
 */
async function storedVectorRows(d: AskDeps, sample: Sample, args: unknown[]): Promise<Map<string, string>> {
  const [embedding, opts] = args as [Float32Array, SearchOpts | undefined];
  const asked = Number(opts?.limit ?? 20);
  const limit = Math.min(STORED_ROWS_CAP, Math.max(STORED_ROWS_FLOOR, Number.isFinite(asked) ? asked * 5 : 0));
  const rows = await asCaller(sample.access, () => (d.engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).searchVector!(embedding, { ...opts, limit, offset: 0 }));
  return storedPayloads(rowIdentities(encodeValue(rows)));
}

const isRowIdentity = (v: unknown): v is RowIdentity => {
  const r = v as Record<string, unknown> | null;
  const c = r?.chunk as Record<string, unknown> | 'invalid' | undefined;
  return !!r && typeof r === 'object' && typeof r.payload === 'string' && (r.id === undefined || typeof r.id === 'number') && (r.key === undefined || typeof r.key === 'string')
    && (c === undefined || c === 'invalid' || (!!c && typeof c === 'object' && typeof c.id === 'number' && (c.sum === null || typeof c.sum === 'string')));
};

/** The verdict on the child's Rust rows for `sample`: compared with the primary's own answer, the extra rows judged, nothing but a verdict going back. */
/** The rerun attempt a follow-up ask names, if the sample still holds it. */
const attemptOf = (sample: Sample, id: unknown): RerunAttempt | undefined => (typeof id === 'string' ? sample.reruns?.get(id) : undefined);

async function privacyAnswer(d: AskDeps, sample: Sample, ask: { phase?: unknown; rows?: unknown; attempt?: unknown }): Promise<PrivacyAnswer> {
  const rerun = ask.phase === 'rerun';
  const attempt = rerun ? attemptOf(sample, ask.attempt) : undefined;
  if (rerun && !attempt) return { verdict: 'privacy_check_moved', complete: false }; // an unknown, dropped or replaced attempt is never proven
  const base: Base | undefined = rerun ? attempt : { at: sample.at, gen: sample.gen, lsn: sample.lsn };
  const primary = rerun ? attempt?.result : sample.result;
  if (primary === undefined) throw coded('failed'); // what the primary answered is not known: nothing can be held against it
  // Only a whole, valid list of at most IDENTITY_LIMIT rows can complete a check: a list that is cut or holds anything invalid is judged as far as it goes
  // (a violation in it still pauses) and is never complete, so a row beyond the limit is never cleared by its absence.
  const list = Array.isArray(ask.rows) ? ask.rows : null;
  const rows = (list ?? []).filter(isRowIdentity).slice(0, IDENTITY_LIMIT);
  const whole = list !== null && list.length <= IDENTITY_LIMIT && rows.length === list.length;
  const extra = extraIds(rowIdentities(primary), rows);
  if (extra.rows.length === 0) return { verdict: 'clean', complete: whole && extra.unidentified === 0 };
  const args = decodeValue(sample.args) as unknown[];
  // Only a ranked vector search clears extra rows (exactness.ts): its stored rows are the ones read for the comparison; for any other read none are, so none clears.
  const snap = await policySnapshot(d.reads, sample.access, candidatesOf(extra.rows), safeFenceApplies(args), base, () => d.follower?.published, d.follower !== undefined,
    sample.op === 'searchVector' ? () => storedVectorRows(d, sample, args) : undefined);
  if (snap.moved) return { verdict: 'privacy_check_moved', complete: false };
  if (snap.violations > 0) return { verdict: 'violation', complete: false };
  const pageIds = new Map(snap.pages.map((p) => [p.id, p.key]));
  const pageKeys = new Map(snap.pages.map((p) => [p.key, p.id]));
  const chunks = new Map(snap.chunks.map((c) => [c.id, c]));
  const judged = (r: ExtraRow): boolean => {
    const page = r.id !== undefined ? (pageIds.has(r.id) ? r.id : undefined) : r.key !== undefined ? pageKeys.get(r.key) : undefined;
    if (page === undefined) return false;
    if (!r.chunk) return true;
    const c = chunks.get(r.chunk.id);
    return !!c && c.page_id === page && r.chunk.sum !== null && c.sum === r.chunk.sum; // the chunk is that page's, visible and fenced as the primary served it, with the text the primary stores
  };
  // Every other field too: the row must be the primary's stored row for that page and chunk, field for field (a title, a flag, a field the primary does not have).
  const stored = (r: ExtraRow): boolean => judged(r) && matchesStored(snap.payloads, r);
  return { verdict: 'clean', complete: whole && extra.unidentified === 0 && extra.rows.every(stored) };
}

export interface AskDeps {
  engine: BrainEngine;
  reads: ReadSource;
  dir: string;
  samples: SampleRegistry;
  follower?: ShadowFollower;
  /** The supervisor's `request`. */
  rpc: <T>(method: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  now?: () => number;
  /** Seam for tests; default `RERUN_DEADLINE_MS`. */
  deadlineMs?: number;
  /** The freshness token watch (`createLsnWatch`); the same one the mirror queue captures with each sample. Default: one over `reads`. */
  watch?: LsnWatch;
}

let rerunCounter = 0;

async function stableRerun(d: AskDeps, watch: LsnWatch, sid: string, sample: Sample, ask: { epoch_id: unknown }): Promise<RerunAnswer> {
  const now = d.now ?? Date.now;
  const deadline = now() + (d.deadlineMs ?? RERUN_DEADLINE_MS);
  const left = (): number => Math.max(1, deadline - now());
  const f = d.follower;
  const epoch = readEpoch(d.dir)?.epoch_id;
  if (!epoch || epoch !== ask.epoch_id) throw coded('epoch_changed');
  if (!f) throw coded('no_follower');
  if (!isShadowReadMember(sample.op)) throw coded('not_a_read');
  while (!f.idle()) {
    if (f.blocked()) throw coded('invalidation_pending'); // a lost send waits for a batch that may never come: nothing here can make progress
    if (now() >= deadline) throw coded('busy');
    await Promise.race([f.settle(), sleep(left())]);
    await turn(); // whatever settled, give I/O and timers their turn: this loop runs in the serving process
  }
  const published = f.published;
  const invalidated = f.lastInvalidatedAt;
  const ack = await d.rpc<{ stamp: number }>('barrier', {}, left());
  const args = decodeValue(sample.args) as unknown[];
  const lsn = await watch.live().catch(() => undefined); // none known: the rerun's privacy check is unproven, never clean; taken before the primary read below starts
  const attempt: RerunAttempt = { at: now(), gen: published, lsn }; // the privacy check of the rerun is held to this read, and to no other attempt's
  const attemptId = String(++rerunCounter);
  (sample.reruns ??= new Map()).set(attemptId, attempt);
  while (sample.reruns.size > RERUN_ATTEMPTS_KEPT) sample.reruns.delete(sample.reruns.keys().next().value as string);
  const read = asCaller(sample.access, () => (d.engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[sample.op]!(...args));
  const result = await Promise.race([read, sleep(left()).then(() => { throw coded('timeout'); })]);
  if (!f.idle() || f.published !== published || f.lastInvalidatedAt !== invalidated) throw coded('write_after_barrier');
  const encoded = encodeValue(result);
  // The registry's byte cap holds for a rerun's answer too: one that would pass it is not kept, the rerun ends unresolved (counted), and nothing stays in memory.
  if (!d.samples.charge(sid, JSON.stringify(encoded)?.length ?? 0)) { sample.reruns?.delete(attemptId); throw coded('too_large'); }
  attempt.result = encoded; // kept here for the privacy question; only its digest goes back
  const members = SHADOW_READ_MEMBERS[sample.op as ShadowReadMember] === 'ranked' ? membersDigest(encoded) : undefined;
  return { stamp: ack.stamp, epoch_id: epoch, digest: resultDigest(encoded), ...(members === undefined ? {} : { members }), ...(sample.op === 'searchVector' ? { keys: firstTenKeys(encoded) } : {}), attempt: attemptId };
}

/**
 * The primary's exact top rows for the sample's `searchVector`: ids and scores only. The engine's own exact statement
 * (`exactSql`, bound with no candidate window) keeps the caller's filters, the source boosts, the per-page collapse and the
 * tie-break; asked for `RECALL_REFERENCE_LIMIT` rows so a tie at the cutoff is visible. The answers the sample holds were
 * read from the position the sample (or, for `phase: 'rerun'`, its rerun) was held to: the reference is refused (`moved`) unless
 * the primary's freshness token at the end of the run still holds, and this process's write generation is the one captured.
 */
async function vectorReference(d: AskDeps, sample: Sample, phase: 'sample' | 'rerun', attemptId?: unknown): Promise<RankedKey[]> {
  const [embedding, opts] = decodeValue(sample.args) as [Float32Array, SearchOpts | undefined];
  const dialect = hasCapability(d.engine, 'postgres_admin') ? 'postgres' : 'pglite';
  const hasFollower = d.follower !== undefined;
  const base = phase === 'rerun' ? attemptOf(sample, attemptId) : { gen: sample.gen, lsn: sample.lsn };
  if (!base || base.lsn === undefined || (hasFollower && base.gen === undefined)) throw coded('moved'); // nothing was captured to hold the reference to
  const gen0 = d.follower?.published;
  const rows = await d.reads.read(async (tx) => {
    await tx.executeRaw('SET LOCAL enable_indexscan = off');
    await tx.executeRaw('SET LOCAL enable_bitmapscan = off');
    return asCaller(sample.access, async () => {
      const stmt = buildVectorSearchStatement({ dialect, embedding, limit: RECALL_REFERENCE_LIMIT, offset: 0, opts: { ...opts, limit: RECALL_REFERENCE_LIMIT, offset: 0 } });
      const params = [...stmt.params];
      params[stmt.innerLimitIdx] = null; // no candidate window: every eligible chunk is scored
      return tx.executeRaw<Record<string, unknown>>(stmt.exactSql, params);
    });
  });
  if (!(await unchangedSince(d.reads, base.lsn)) || (hasFollower && (gen0 !== base.gen || d.follower?.published !== base.gen))) throw coded('moved');
  return rankedKeys(encodeValue(rows.filter((r) => r.chunk_id !== null && r.chunk_id !== undefined)));
}

export function makeAskHandler(d: AskDeps): (ask: { id: number; kind: string; [key: string]: unknown }) => Promise<unknown> {
  const gate = new IntervalGate(RECALL_INTERVAL_MS, d.now);
  const watch = d.watch ?? createLsnWatch(d.reads, d.now);
  return async (ask) => {
    const sample = d.samples.get(ask.sid);
    if (!sample) throw coded('sample_unknown'); // evicted, or from another process: the sample stays unresolved
    switch (ask.kind) {
      case 'privacy': return privacyAnswer(d, sample, ask as { phase?: unknown; rows?: unknown; attempt?: unknown });
      case 'rerun': return stableRerun(d, watch, ask.sid as string, sample, { epoch_id: ask.epoch_id });
      case 'vector': {
        const phase = ask.phase === 'rerun' ? 'rerun' : 'sample';
        if (phase === 'sample' && !gate.take()) throw coded('rate_limited'); // a rerun of a sample that moved is the same reference run, asked again
        return vectorReference(d, sample, phase, ask.attempt);
      }
      default: throw coded('unsupported');
    }
  };
}
