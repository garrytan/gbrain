/**
 * What the serving process answers when the shadow child asks (`ask` lines; supervisor.ts `onAsk`). Three questions, all
 * about the primary, which only this process can read:
 *
 *   privacy  Is each of these pages (ids only) readable by the captured caller under the primary's read policy? One read-only
 *            snapshot judges them with the existing policy fragment (private-visibility.ts `privatePagesFilterForCaller`)
 *            under the captured `CallerAccess`. The answer is `moved` when the policy generation (the access tables'
 *            revisions and counts, read before and after) changed during the check, or a page changed after the read: the
 *            child then calls the sample inconclusive, never clean. Nothing but counts goes back.
 *   rerun    The stable-generation barrier for a mismatch that nothing explains (plan decision 7). When everything published
 *            has been read and sent, a `barrier` call goes down the follow stream behind the last batch; the child acks
 *            only when it applied everything before it and its watermark is valid. The primary read runs next, and the
 *            rerun is refused if any batch was published, or a send was shed, since the barrier. The child then runs the
 *            Rust read holding its follow lock (follow-child.ts `exclusive`). Any race, restart, invalid watermark or the
 *            30 s deadline throws and leaves the sample inconclusive.
 *   vector   The exact reference of a vector sample (recall.ts), at most one a minute.
 */
import type { BrainEngine } from '../core/engine.ts';
import { privatePagesFilterForCaller, withCallerAccess, type CallerAccess } from '../core/search/private-visibility.ts';
import { decodeValue, encodeValue } from './codec.ts';
import { readEpoch } from './evidence-epoch.ts';
import type { ShadowFollower } from './follower.ts';
import type { ReadSource } from './read-pool.ts';
import { IntervalGate, rankedKeys, RECALL_INTERVAL_MS, referenceArgs } from './recall.ts';
import { isShadowReadMember } from './reads.ts';

export const RERUN_DEADLINE_MS = 30_000;

/** Pages a Rust answer named that the primary's own answer did not: by id and by (source, slug). */
export interface PageCandidates { ids: number[]; keys: string[] }
export interface PrivacyAnswer { checked: number; violations: number; moved: boolean }
export interface RerunAnswer { result: unknown; stamp: number; epoch_id: string }

const coded = (code: string): Error => Object.assign(new Error(code), { code });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/** The access tables' revisions and counts: it changes whenever a member, group, folder rule or pending prefix does. */
const POLICY_GENERATION_SQL = `SELECT concat_ws('|',
  (SELECT count(*) || ':' || COALESCE(max(revision), 0) FROM access_policy_revisions),
  (SELECT count(*) FROM access_rules), (SELECT count(*) FROM access_pending_coverage),
  (SELECT count(*) || ':' || COALESCE(max(updated_at)::text, '') FROM access_members), (SELECT count(*) FROM access_group_members)) AS generation`;

export async function policyCheck(reads: ReadSource, access: Partial<CallerAccess>, cand: PageCandidates, at: number): Promise<PrivacyAnswer> {
  const generation = (): Promise<string> => reads.read(async (tx) => String((await tx.executeRaw<{ generation: string }>(POLICY_GENERATION_SQL))[0]?.generation));
  const before = await generation();
  const rows = await reads.read((tx) => withCallerAccess(access, () => tx.executeRaw<{ allowed: boolean; changed: boolean }>(
    `SELECT (${privatePagesFilterForCaller('p')}) AS allowed, p.updated_at > to_timestamp($3::double precision / 1000.0) AS changed FROM pages p
      WHERE p.id = ANY($1::bigint[]) OR (p.source_id || E'\\x1f' || p.slug) = ANY($2::text[])`, [cand.ids, cand.keys, at])));
  const moved = before !== await generation() || rows.some((r) => r.changed === true);
  return { checked: rows.length, violations: rows.filter((r) => r.allowed !== true).length, moved };
}

export interface AskDeps {
  engine: BrainEngine;
  reads: ReadSource;
  dir: string;
  follower?: ShadowFollower;
  /** The supervisor's `request`. */
  rpc: <T>(method: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  now?: () => number;
}

async function stableRerun(d: AskDeps, ask: { op: string; args: unknown; access: Partial<CallerAccess>; epoch_id: string }): Promise<RerunAnswer> {
  const now = d.now ?? Date.now;
  const deadline = now() + RERUN_DEADLINE_MS;
  const left = (): number => Math.max(1, deadline - now());
  const f = d.follower;
  const epoch = readEpoch(d.dir)?.epoch_id;
  if (!epoch || epoch !== ask.epoch_id) throw coded('epoch_changed');
  if (!f) throw coded('no_follower');
  if (!isShadowReadMember(ask.op)) throw coded('not_a_read');
  while (!f.idle()) {
    if (now() >= deadline) throw coded('busy');
    await Promise.race([f.settle(), sleep(left())]);
  }
  const published = f.published;
  const invalidated = f.lastInvalidatedAt;
  const ack = await d.rpc<{ stamp: number }>('barrier', {}, left());
  const args = decodeValue(ask.args) as unknown[];
  const read = withCallerAccess(ask.access, () => (d.engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[ask.op]!(...args));
  const result = await Promise.race([read, sleep(left()).then(() => { throw coded('timeout'); })]);
  if (!f.idle() || f.published !== published || f.lastInvalidatedAt !== invalidated) throw coded('write_after_barrier');
  return { result: encodeValue(result), stamp: ack.stamp, epoch_id: epoch };
}

/** The primary's exact top rows for `args`: ids and scores only. */
async function vectorReference(reads: ReadSource, args: unknown[], access: Partial<CallerAccess>): Promise<unknown> {
  const [embedding, opts] = referenceArgs(args) as [Float32Array, object];
  const rows = await reads.read(async (tx) => {
    await tx.executeRaw('SET LOCAL enable_indexscan = off');
    await tx.executeRaw('SET LOCAL enable_bitmapscan = off');
    return withCallerAccess(access, () => tx.searchVector(embedding, opts));
  });
  return rankedKeys(encodeValue(rows));
}

export function makeAskHandler(d: AskDeps): (ask: { id: number; kind: string; [key: string]: unknown }) => Promise<unknown> {
  const gate = new IntervalGate(RECALL_INTERVAL_MS, d.now);
  return async (ask) => {
    const access = (ask.access ?? {}) as Partial<CallerAccess>;
    switch (ask.kind) {
      case 'privacy': return policyCheck(d.reads, access, ask.candidates as PageCandidates, Number(ask.at));
      case 'rerun': return stableRerun(d, ask as never);
      case 'vector':
        if (!gate.take()) throw coded('rate_limited');
        return vectorReference(d.reads, decodeValue(ask.args) as unknown[], access);
      default: throw coded('unsupported');
    }
  };
}
