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
 *            primary's safe-chunk fence when its read asked for it, and the chunk visibility the primary used. The answer is a
 *            verdict (`clean` with `complete`, `violation`, `moved`), never content. It is `moved` unless this process can PROVE
 *            nothing the policy reads changed since the read: its own write generation (follower.published, read live before
 *            and after the check) must equal the one captured with the sample, the policy fingerprint (a hash of every row of every
 *            table the predicates read, `FINGERPRINT_TABLES`; `createPolicyWatch`) must equal the one captured, before the
 *            primary read started, with the sample, no page or access row may carry a time later than the read, and the access tables' generation must hold
 *            across the check. Without proof the child calls the sample inconclusive, never clean.
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
 *            tie-break, run here on a reference-only path. The engine's search itself is not touched. The sample is dropped
 *            (`moved`) unless nothing the corpus or the policy reads changed between its capture and the end of the reference
 *            (the same generation and fingerprint proof as the privacy question).
 */
import type { BrainEngine } from '../core/engine.ts';
import { hasCapability } from '../core/engine-capabilities.ts';
import { privatePagesFilterForCaller, withCallerAccess, withoutCallerAccess, type CallerAccess } from '../core/search/private-visibility.ts';
import { chunkVisibleFilter, requiresSafeChunks, safeChunksFilter } from '../core/search/safe-chunks.ts';
import { buildVectorSearchStatement } from '../core/search/vector-statement.ts';
import type { SearchOpts } from '../core/types.ts';
import { decodeValue, encodeValue } from './codec.ts';
import { candidatesOf, extraIds, membersDigest, resultDigest, rowIdentities, type ExtraRow, type RowIdentity } from './child-checks.ts';
import { readEpoch } from './evidence-epoch.ts';
import type { ShadowFollower } from './follower.ts';
import type { ReadSource } from './read-pool.ts';
import { IntervalGate, rankedKeys, RECALL_INTERVAL_MS, RECALL_REFERENCE_LIMIT, type RankedKey } from './recall.ts';
import { isShadowReadMember, SHADOW_READ_MEMBERS, type ShadowReadMember } from './reads.ts';
import type { Sample, SampleRegistry } from './samples.ts';

export const RERUN_DEADLINE_MS = 30_000;

/** Pages a Rust answer named that the primary's own answer did not: by id, by (source, slug) and by chunk id. */
export interface PageCandidates { ids: number[]; keys: string[]; chunks: number[] }
/** The serving process's verdict on a sample's Rust rows (never content). `complete`: every extra row was identified and judged. */
export interface PrivacyAnswer { verdict: 'clean' | 'violation' | 'privacy_check_moved'; complete: boolean }
/** `digest`: the whole answer; `members`: the same rows with scores and order taken out, for a ranked read (reads.ts), else absent. */
export interface RerunAnswer { stamp: number; epoch_id: string; digest: string; members?: string }

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
 * The tables whose rows the read policy, the safe-chunk fence, the chunk visibility and the vector corpus filters read, the
 * lineage functions they call (privatePagesFilterForCaller, gbrain_owner_only_lineage_strict and every function those read) included,
 * and the access, source and config tables. The fingerprint hashes every row of every one of them whole: a change to a column no
 * predicate reads today moves it too, and so does a column a predicate starts to read. A guard test
 * (test/helpers/shadow-checks-scenarios.ts, "the freshness proof covers every table the predicates read") extracts the tables
 * those SQL builders and function bodies reference and fails when one is missing from this list.
 */
export const FINGERPRINT_TABLES: readonly string[] = [
  'access_group_members', 'access_members', 'access_pending_coverage', 'access_policy_revisions', 'access_policy_state', 'access_rules',
  'config', 'content_chunks', 'derivation_inputs', 'facts', 'links', 'owner_only_marks', 'pages', 'slug_aliases', 'slug_rename_history',
  'sources', 'takes', 'timeline_entries', 'write_gate_receipts',
];
const VECTOR_TYPES = ['vector', 'halfvec', 'sparsevec'];

/**
 * The fingerprint statement for the columns the tables have now: per table, the row count and the sum of a 64-bit hash of each
 * whole row as jsonb text, with only a vector column's bytes replaced by whether it is set (a row's `embedded_text_hash` stays in
 * the row). Built from the catalog, so a column added later is covered without a change here. Another process's write to any
 * of these tables moves it; it does not tell which. Not covered, and so a known limit: a table no predicate reads today.
 */
export function policyFingerprintSql(columns: Array<{ table_name: string; column_name: string; udt_name: string }>): string {
  const parts = FINGERPRINT_TABLES.filter((t) => columns.some((c) => c.table_name === t)).map((t) => {
    const vectors = columns.filter((c) => c.table_name === t && VECTOR_TYPES.includes(c.udt_name)).map((c) => c.column_name);
    const row = vectors.length === 0 ? `to_jsonb(r)::text`
      : `(to_jsonb(r) - ARRAY[${vectors.map((v) => `'${v}'`).join(',')}]::text[] || jsonb_build_object(${vectors.map((v) => `'${v}_set', r."${v}" IS NOT NULL`).join(', ')}))::text`;
    return `(SELECT count(*) || ':' || COALESCE(sum(hashtextextended(${row}, 0)::numeric), 0) FROM "${t}" r)`;
  });
  return `SELECT concat_ws('|', ${parts.join(',\n  ')}) AS fp`;
}

const fingerprintOf = async (tx: BrainEngine): Promise<string> => {
  const columns = await tx.executeRaw<{ table_name: string; column_name: string; udt_name: string }>(
    `SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`, [[...FINGERPRINT_TABLES]]);
  return String((await tx.executeRaw<{ fp: string }>(policyFingerprintSql(columns)))[0]?.fp);
};

/**
 * The policy fingerprint, kept fresh off the request path. `current()` is synchronous (a read is captured on the request path):
 * it returns the latest fingerprint a refresh completed BEFORE this moment, so it is never newer than the read it is stored
 * with, and starts a refresh when the one it holds is older than `ttlMs`. Unchanged data compares equal later; changed data
 * does not, and neither does an older fingerprint than the change: a stale value only makes the proof fail, never pass.
 * `undefined` until the first refresh completes (a sample captured before then is never proven).
 */
export interface PolicyWatch { current(): string | undefined; live(): Promise<string>; ready(): Promise<void> }
export function createPolicyWatch(reads: ReadSource, now: () => number = Date.now, ttlMs = 5000): PolicyWatch {
  let value: string | undefined;
  let at = -Infinity;
  let inflight: Promise<void> | null = null;
  const refresh = (): Promise<void> => (inflight ??= (async () => {
    try { const v = await reads.read(fingerprintOf); value = v; at = now(); } catch { /* the value stays older: the proof fails, never passes */ }
    inflight = null;
  })());
  return {
    current: () => { if (now() - at >= ttlMs) void refresh(); return value; },
    live: () => reads.read(fingerprintOf),
    ready: () => refresh(),
  };
}

/** Does the read's own scope ask for the safe-chunk fence (`requireSafeChunks`, else `excludePrivate`)? Any argument that does, does. */
const safeFenceApplies = (args: unknown[]): boolean => args.some((a) => !!a && typeof a === 'object' && requiresSafeChunks(a as { requireSafeChunks?: boolean; excludePrivate?: boolean }))
  || args.some((a) => { const o = a as { remote?: unknown; untrusted?: unknown } | null; return !!o && typeof o === 'object' && [o.remote, o.untrusted].some((x) => !!x && typeof x === 'object' && requiresSafeChunks(x as { requireSafeChunks?: boolean; excludePrivate?: boolean })); });

/** The most Rust row identities one privacy question holds; a longer list is never complete. */
export const IDENTITY_LIMIT = 2000;

interface Base { at: number; gen?: number; fp?: string }

/**
 * What the primary's policy says about the candidates, held to the generation of the read that produced the rows (`base`: the
 * sample's own, or the stable rerun's). `generation` reads this process's write generation NOW (follower.published), before and
 * after the snapshot, when it has a follower. `moved` is true unless everything the policy reads is proven unchanged.
 */
async function policySnapshot(reads: ReadSource, access: Partial<CallerAccess> | undefined, cand: PageCandidates, safe: boolean, base: Base | undefined, generation: () => number | undefined, hasFollower: boolean) {
  const accessGeneration = (): Promise<string> => reads.read(async (tx) => String((await tx.executeRaw<{ generation: string }>(POLICY_GENERATION_SQL))[0]?.generation));
  const gen0 = generation();
  const before = await accessGeneration();
  const { rows, chunks, changed, fp } = await reads.read(async (tx) => ({
    rows: await asCaller(access, () => tx.executeRaw<{ id: number | string; key: string; allowed: boolean }>(
      `SELECT p.id, p.source_id || E'\\x1f' || p.slug AS key, (${privatePagesFilterForCaller('p')}) AS allowed FROM pages p
        WHERE p.id = ANY($1::bigint[]) OR (p.source_id || E'\\x1f' || p.slug) = ANY($2::text[])`, [cand.ids, cand.keys])),
    chunks: await tx.executeRaw<{ id: number | string; page_id: number | string; sum: string }>(
      `SELECT c.id, c.page_id, md5(c.chunk_text) AS sum FROM content_chunks c JOIN pages p ON p.id = c.page_id
        WHERE c.id = ANY($1::bigint[]) AND ${chunkVisibleFilter('p', 'c')}${safe ? ` AND ${safeChunksFilter('p')}` : ''}`, [cand.chunks]), // a staged, retired or unsealed chunk is not one the primary can return
    // 1 ms of slack: a write that finished before the read can carry a microsecond time past the read's millisecond.
    changed: base ? (await tx.executeRaw<{ changed: boolean }>(CHANGED_AFTER_SQL, [base.at + 1]))[0]?.changed === true : true,
    fp: await fingerprintOf(tx),
  }));
  const gen1 = generation();
  const unproven = !base || base.fp === undefined || (hasFollower && base.gen === undefined);
  const moved = unproven || changed || fp !== base?.fp || (hasFollower && (gen0 !== base?.gen || gen1 !== base?.gen)) || before !== await accessGeneration();
  return {
    moved, violations: rows.filter((r) => r.allowed !== true).length,
    pages: rows.map((r) => ({ id: Number(r.id), key: r.key })), chunks: chunks.map((c) => ({ id: Number(c.id), page_id: Number(c.page_id), sum: c.sum })),
  };
}

const isRowIdentity = (v: unknown): v is RowIdentity => {
  const r = v as Record<string, unknown> | null;
  const c = r?.chunk as Record<string, unknown> | 'invalid' | undefined;
  return !!r && typeof r === 'object' && typeof r.payload === 'string' && (r.id === undefined || typeof r.id === 'number') && (r.key === undefined || typeof r.key === 'string')
    && (c === undefined || c === 'invalid' || (!!c && typeof c === 'object' && typeof c.id === 'number' && (c.sum === null || typeof c.sum === 'string')));
};

/** The verdict on the child's Rust rows for `sample`: compared with the primary's own answer, the extra rows judged, nothing but a verdict going back. */
async function privacyAnswer(d: AskDeps, sample: Sample, ask: { phase?: unknown; rows?: unknown }): Promise<PrivacyAnswer> {
  const rerun = ask.phase === 'rerun';
  const base: Base | undefined = rerun ? sample.rerun : { at: sample.at, gen: sample.gen, fp: sample.fp };
  const primary = rerun ? sample.rerun?.result : sample.result;
  if (primary === undefined) throw coded('failed'); // what the primary answered is not known: nothing can be held against it
  // Only a whole, valid list of at most IDENTITY_LIMIT rows can complete a check: a list that is cut or holds anything invalid is judged as far as it goes
  // (a violation in it still pauses) and is never complete, so a row beyond the limit is never cleared by its absence.
  const list = Array.isArray(ask.rows) ? ask.rows : null;
  const rows = (list ?? []).filter(isRowIdentity).slice(0, IDENTITY_LIMIT);
  const whole = list !== null && list.length <= IDENTITY_LIMIT && rows.length === list.length;
  const extra = extraIds(rowIdentities(primary), rows);
  if (extra.rows.length === 0) return { verdict: 'clean', complete: whole && extra.unidentified === 0 };
  const args = decodeValue(sample.args) as unknown[];
  const snap = await policySnapshot(d.reads, sample.access, candidatesOf(extra.rows), safeFenceApplies(args), base, () => d.follower?.published, d.follower !== undefined);
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
  return { verdict: 'clean', complete: whole && extra.unidentified === 0 && extra.rows.every(judged) };
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
  /** The policy fingerprint (`createPolicyWatch`); the same one the mirror queue captures with each sample. Default: one over `reads`. */
  watch?: PolicyWatch;
}

async function stableRerun(d: AskDeps, watch: PolicyWatch, sid: string, sample: Sample, ask: { epoch_id: unknown }): Promise<RerunAnswer> {
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
  const fp = await watch.live().catch(() => undefined); // none known: the rerun's privacy check is unproven, never clean
  sample.rerun = { at: now(), gen: published, fp }; // the privacy check of the rerun is held to this read
  const read = asCaller(sample.access, () => (d.engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[sample.op]!(...args));
  const result = await Promise.race([read, sleep(left()).then(() => { throw coded('timeout'); })]);
  if (!f.idle() || f.published !== published || f.lastInvalidatedAt !== invalidated) throw coded('write_after_barrier');
  const encoded = encodeValue(result);
  sample.rerun.result = encoded; // kept here for the privacy question; only its digest goes back
  d.samples.charge(sid, JSON.stringify(encoded)?.length ?? 0);
  const members = SHADOW_READ_MEMBERS[sample.op as ShadowReadMember] === 'ranked' ? membersDigest(encoded) : undefined;
  return { stamp: ack.stamp, epoch_id: epoch, digest: resultDigest(encoded), ...(members === undefined ? {} : { members }) };
}

/**
 * The primary's exact top rows for the sample's `searchVector`: ids and scores only. The engine's own exact statement
 * (`exactSql`, bound with no candidate window) keeps the caller's filters, the source boosts, the per-page collapse and the
 * tie-break; asked for `RECALL_REFERENCE_LIMIT` rows so a tie at the cutoff is visible. The answers the sample holds were
 * read at its capture; the reference is refused (`moved`) unless nothing the corpus reads changed since then: this process's
 * write generation and the policy fingerprint must equal the ones captured with the sample, before and after the statement.
 */
async function vectorReference(d: AskDeps, sample: Sample): Promise<RankedKey[]> {
  const [embedding, opts] = decodeValue(sample.args) as [Float32Array, SearchOpts | undefined];
  const dialect = hasCapability(d.engine, 'postgres_admin') ? 'postgres' : 'pglite';
  const hasFollower = d.follower !== undefined;
  if (sample.fp === undefined || (hasFollower && sample.gen === undefined)) throw coded('moved'); // nothing was captured to hold the reference to
  const gen0 = d.follower?.published;
  const { rows, fpBefore, fpAfter } = await d.reads.read(async (tx) => {
    await tx.executeRaw('SET LOCAL enable_indexscan = off');
    await tx.executeRaw('SET LOCAL enable_bitmapscan = off');
    const fpBefore = await fingerprintOf(tx);
    const rows = await asCaller(sample.access, async () => {
      const stmt = buildVectorSearchStatement({ dialect, embedding, limit: RECALL_REFERENCE_LIMIT, offset: 0, opts: { ...opts, limit: RECALL_REFERENCE_LIMIT, offset: 0 } });
      const params = [...stmt.params];
      params[stmt.innerLimitIdx] = null; // no candidate window: every eligible chunk is scored
      return tx.executeRaw<Record<string, unknown>>(stmt.exactSql, params);
    });
    return { rows, fpBefore, fpAfter: await fingerprintOf(tx) };
  });
  if (fpBefore !== sample.fp || fpAfter !== sample.fp || (hasFollower && (gen0 !== sample.gen || d.follower?.published !== sample.gen))) throw coded('moved');
  return rankedKeys(encodeValue(rows.filter((r) => r.chunk_id !== null && r.chunk_id !== undefined)));
}

export function makeAskHandler(d: AskDeps): (ask: { id: number; kind: string; [key: string]: unknown }) => Promise<unknown> {
  const gate = new IntervalGate(RECALL_INTERVAL_MS, d.now);
  const watch = d.watch ?? createPolicyWatch(d.reads, d.now);
  return async (ask) => {
    const sample = d.samples.get(ask.sid);
    if (!sample) throw coded('sample_unknown'); // evicted, or from another process: the sample stays unresolved
    switch (ask.kind) {
      case 'privacy': return privacyAnswer(d, sample, ask as { phase?: unknown; rows?: unknown });
      case 'rerun': return stableRerun(d, watch, ask.sid as string, sample, { epoch_id: ask.epoch_id });
      case 'vector':
        if (!gate.take()) throw coded('rate_limited');
        return vectorReference(d, sample);
      default: throw coded('unsupported');
    }
  };
}
