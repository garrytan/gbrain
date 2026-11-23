/**
 * What the serving process answers when the shadow child asks (`ask` lines; supervisor.ts `onAsk`). Three questions, all
 * about the primary, which only this process can read. The child names the sample by its OPAQUE sample id (samples.ts); the
 * read's arguments and the caller's access record stay in this process, and a failure goes back as an allowlisted code.
 *
 *   privacy  Is each of these pages (ids and chunk ids only) readable by the captured caller under the primary's read policy,
 *            and is each returned chunk that page's, with the text the primary stores? One read-only snapshot judges them with
 *            the existing policy fragment (private-visibility.ts `privatePagesFilterForCaller`) under the captured
 *            `CallerAccess`. The answer is `moved` unless this process can PROVE nothing the policy reads changed since the
 *            read: its own write generation (follower.published) must equal the one captured with the sample, and no page or
 *            access row (lineage origins included) may carry a time later than the read; the access tables' generation must
 *            hold across the check too. Without proof the child calls the sample inconclusive, never clean.
 *   rerun    The stable-generation barrier for a mismatch that nothing explains (plan decision 7). When everything published
 *            has been read and sent, a `barrier` call goes down the follow stream behind the last batch; the child acks
 *            only when it applied everything before it and its watermark is valid. The primary read runs next, and the
 *            rerun is refused if any batch was published, or a send was shed, since the barrier. The child then runs the
 *            Rust read holding its follow lock (follow-child.ts `exclusive`). Any race, restart, invalid watermark or the
 *            30 s deadline throws and leaves the sample inconclusive. It never spins: an invalidation that cannot progress
 *            refuses at once, and every wait yields to the event loop.
 *   vector   The exact reference of a vector sample (recall.ts), at most one a minute: the engine's own exact statement
 *            (`exactSql`: no candidate window, `ORDER BY (distance) + 0`) with its filters, scoring, per-page collapse and
 *            tie-break, run here on a reference-only path. The engine's search itself is not touched.
 */
import type { BrainEngine } from '../core/engine.ts';
import { hasCapability } from '../core/engine-capabilities.ts';
import { privatePagesFilterForCaller, withCallerAccess, withoutCallerAccess, type CallerAccess } from '../core/search/private-visibility.ts';
import { chunkVisibleFilter } from '../core/search/safe-chunks.ts';
import { buildVectorSearchStatement } from '../core/search/vector-statement.ts';
import type { SearchOpts } from '../core/types.ts';
import { decodeValue, encodeValue } from './codec.ts';
import { readEpoch } from './evidence-epoch.ts';
import type { ShadowFollower } from './follower.ts';
import type { ReadSource } from './read-pool.ts';
import { IntervalGate, rankedKeys, RECALL_INTERVAL_MS, RECALL_REFERENCE_LIMIT, type RankedKey } from './recall.ts';
import { isShadowReadMember } from './reads.ts';
import type { Sample, SampleRegistry } from './samples.ts';

export const RERUN_DEADLINE_MS = 30_000;

/** Pages a Rust answer named that the primary's own answer did not: by id, by (source, slug) and by chunk id. */
export interface PageCandidates { ids: number[]; keys: string[]; chunks: number[] }
export interface PrivacyAnswer {
  checked: number;
  violations: number;
  moved: boolean;
  /** What the primary has of the candidates (ids, keys and a digest of each chunk's text; no content): a candidate not here was not checked. */
  found: { pages: Array<{ id: number; key: string }>; chunks: Array<{ id: number; page_id: number; sum: string }> };
}
export interface RerunAnswer { result: unknown; stamp: number; epoch_id: string }

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
 * Judges the candidates for `sample`, held to the generation of the read that produced them (`base`: the sample's own, or the
 * stable rerun's). `generation` is this process's write generation now (follower.published), when it has a follower.
 */
export async function policyCheck(reads: ReadSource, access: Partial<CallerAccess> | undefined, cand: PageCandidates, base: { at: number; gen?: number } | undefined, generation: number | undefined, hasFollower: boolean): Promise<PrivacyAnswer> {
  const accessGeneration = (): Promise<string> => reads.read(async (tx) => String((await tx.executeRaw<{ generation: string }>(POLICY_GENERATION_SQL))[0]?.generation));
  const before = await accessGeneration();
  const { rows, chunks, changed } = await reads.read(async (tx) => ({
    rows: await asCaller(access, () => tx.executeRaw<{ id: number | string; key: string; allowed: boolean }>(
      `SELECT p.id, p.source_id || E'\\x1f' || p.slug AS key, (${privatePagesFilterForCaller('p')}) AS allowed FROM pages p
        WHERE p.id = ANY($1::bigint[]) OR (p.source_id || E'\\x1f' || p.slug) = ANY($2::text[])`, [cand.ids, cand.keys])),
    chunks: await tx.executeRaw<{ id: number | string; page_id: number | string; sum: string }>(
      `SELECT c.id, c.page_id, md5(c.chunk_text) AS sum FROM content_chunks c JOIN pages p ON p.id = c.page_id
        WHERE c.id = ANY($1::bigint[]) AND ${chunkVisibleFilter('p', 'c')}`, [cand.chunks]), // a staged or retired chunk is not one the primary can return
    // 1 ms of slack: a write that finished before the read can carry a microsecond time past the read's millisecond.
    changed: base ? (await tx.executeRaw<{ changed: boolean }>(CHANGED_AFTER_SQL, [base.at + 1]))[0]?.changed === true : true,
  }));
  const unproven = !base || (hasFollower && (base.gen === undefined || base.gen !== generation));
  const moved = unproven || changed || before !== await accessGeneration();
  return {
    checked: rows.length, violations: rows.filter((r) => r.allowed !== true).length, moved,
    found: { pages: rows.map((r) => ({ id: Number(r.id), key: r.key })), chunks: chunks.map((c) => ({ id: Number(c.id), page_id: Number(c.page_id), sum: c.sum })) },
  };
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
}

async function stableRerun(d: AskDeps, sample: Sample, ask: { epoch_id: unknown }): Promise<RerunAnswer> {
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
  sample.rerun = { at: now(), gen: published }; // the privacy check of the rerun is held to this read
  const read = asCaller(sample.access, () => (d.engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[sample.op]!(...args));
  const result = await Promise.race([read, sleep(left()).then(() => { throw coded('timeout'); })]);
  if (!f.idle() || f.published !== published || f.lastInvalidatedAt !== invalidated) throw coded('write_after_barrier');
  return { result: encodeValue(result), stamp: ack.stamp, epoch_id: epoch };
}

/**
 * The primary's exact top rows for the sample's `searchVector`: ids and scores only. The engine's own exact statement
 * (`exactSql`, bound with no candidate window) keeps the caller's filters, the source boosts, the per-page collapse and the
 * tie-break; asked for `RECALL_REFERENCE_LIMIT` rows so a tie at the cutoff is visible.
 */
async function vectorReference(d: AskDeps, sample: Sample): Promise<RankedKey[]> {
  const [embedding, opts] = decodeValue(sample.args) as [Float32Array, SearchOpts | undefined];
  const dialect = hasCapability(d.engine, 'postgres_admin') ? 'postgres' : 'pglite';
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
  return rankedKeys(encodeValue(rows.filter((r) => r.chunk_id !== null && r.chunk_id !== undefined)));
}

export function makeAskHandler(d: AskDeps): (ask: { id: number; kind: string; [key: string]: unknown }) => Promise<unknown> {
  const gate = new IntervalGate(RECALL_INTERVAL_MS, d.now);
  return async (ask) => {
    const sample = d.samples.get(ask.sid);
    if (!sample) throw coded('sample_unknown'); // evicted, or from another process: the sample stays unresolved
    switch (ask.kind) {
      case 'privacy': {
        const base = ask.phase === 'rerun' ? sample.rerun : { at: sample.at, gen: sample.gen };
        const c = ask.candidates as Partial<PageCandidates> | undefined;
        const bound = <T>(list: unknown, ok: (v: unknown) => v is T): T[] => (Array.isArray(list) ? list.filter(ok).slice(0, 2000) : []);
        const cand: PageCandidates = { ids: bound(c?.ids, Number.isFinite as (v: unknown) => v is number), keys: bound(c?.keys, (v): v is string => typeof v === 'string'), chunks: bound(c?.chunks, Number.isFinite as (v: unknown) => v is number) };
        return policyCheck(d.reads, sample.access, cand, base, d.follower?.published, d.follower !== undefined);
      }
      case 'rerun': return stableRerun(d, sample, { epoch_id: ask.epoch_id });
      case 'vector':
        if (!gate.take()) throw coded('rate_limited');
        return vectorReference(d, sample);
      default: throw coded('unsupported');
    }
  };
}
