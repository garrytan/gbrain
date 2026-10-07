/**
 * Attempt claims and the attempt memo for paid (Tier 3) fence repairs.
 *
 * One row per repair candidate (source, incarnation, path or slug) in
 * `op_checkpoints` op `fence-repair-attempt`; `completed_keys[0]` holds the
 * record. Every change is a compare-and-swap on the record's version `v`, so
 * two appliers (the maintenance cycle and the CLI) can never both hold a
 * candidate, and an applier whose claim was taken over cannot publish.
 *
 * States: `claimed` → `dispatched` → `settled` → `published` | `rejected`
 * (gate or unusable answer) | `transient`; a corrective re-ask goes
 * `settled` → `dispatched` again, at most MAX_DISPATCHES_PER_CLAIM calls per
 * claim. The memo key is (content sha256, model, fence rules version, prompt
 * version): a `rejected` or `published` memo is never claimed again until one
 * of them changes; `transient` (provider unavailable) does not consume it.
 *
 * Crash recovery is lease-based: an in-flight claim whose lease expired is
 * taken over. A stale `claimed` claim spent nothing; a stale `dispatched` or
 * `settled` claim lost its answer after the money was committed (the daily
 * ledger settles an expired dispatched reservation at its reserved maximum),
 * so it counts a crash, and MAX_CRASHES_PER_MEMO crashes reject the memo.
 *
 * Records carry location and reason codes only (gate letter, row numbers),
 * never claim text, holder names or cell values. The record carries
 * `source_id` and `incarnation`, so the 7-day op_checkpoints purge
 * (`purgeStaleCheckpoints`) keeps it while its source incarnation lives.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { sha256, stableJson } from '../persistence/digest.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

export const FENCE_REPAIR_ATTEMPT_OP = 'fence-repair-attempt';
/** One paid attempt plus at most one corrective re-ask. */
export const MAX_DISPATCHES_PER_CLAIM = 2;
export const MAX_CRASHES_PER_MEMO = 2;
export const DEFAULT_ATTEMPT_LEASE_MS = 10 * 60_000;

export type AttemptState = 'claimed' | 'dispatched' | 'settled' | 'published' | 'rejected' | 'transient';
const IN_FLIGHT: ReadonlySet<AttemptState> = new Set(['claimed', 'dispatched', 'settled']);

export interface AttemptCandidate { sourceId: string; incarnation: string; key: string }
export interface AttemptMemoParts { contentSha256: string; model: string; fenceVersion: string | number; promptVersion: string | number }

export interface AttemptRecord {
  v: number;
  source_id: string;
  incarnation: string;
  candidate: string;
  memo: string;
  state: AttemptState;
  owner: string;
  lease_until: string;
  dispatches: number;
  reservations: string[];
  crashes: number;
  reason?: string;
  gate?: string;
  rows?: number[];
  at: string;
}

export interface AttemptClaim { fingerprint: string; record: AttemptRecord }

export type ClaimResult =
  | { ok: true; claim: AttemptClaim; recovered?: 'stale_claim' | 'crash_after_dispatch' }
  | { ok: false; reason: 'claimed_elsewhere' | 'rejected' | 'published'; record: AttemptRecord }
  | { ok: false; reason: 'store_unavailable' };

export type TransitionResult =
  | { ok: true; claim: AttemptClaim }
  | { ok: false; reason: 'lost_claim' | 'dispatch_limit' | 'store_unavailable' };

export interface AttemptStore {
  claim(candidate: AttemptCandidate, memo: string): Promise<ClaimResult>;
  dispatched(claim: AttemptClaim, reservationId: string): Promise<TransitionResult>;
  settled(claim: AttemptClaim): Promise<TransitionResult>;
  publish(claim: AttemptClaim): Promise<TransitionResult>;
  reject(claim: AttemptClaim, verdict: { reason: string; gate?: string; rows?: number[] }): Promise<TransitionResult>;
  transient(claim: AttemptClaim, reason: string): Promise<TransitionResult>;
  read(candidate: AttemptCandidate): Promise<AttemptRecord | null>;
}

export function attemptMemoKey(parts: AttemptMemoParts): string {
  return sha256(stableJson({ content: parts.contentSha256, model: parts.model, fence: String(parts.fenceVersion), prompt: String(parts.promptVersion) }));
}

export function attemptFingerprint(candidate: AttemptCandidate): string {
  return sha256(stableJson([candidate.sourceId, candidate.incarnation, candidate.key]));
}

type ClaimPlan =
  | { take: true; crashes: number; recovered?: 'stale_claim' | 'crash_after_dispatch' }
  | { take: false; reason: 'claimed_elsewhere' | 'rejected' | 'published' }
  | { take: false; reason: 'crash_limit'; crashes: number };

/** What a claim of `memo` may do with the candidate's current record. */
export function planClaim(current: AttemptRecord | null, memo: string, at: Date): ClaimPlan {
  if (!current) return { take: true, crashes: 0 };
  const sameMemo = current.memo === memo;
  if (IN_FLIGHT.has(current.state)) {
    if (Date.parse(current.lease_until) > at.getTime()) return { take: false, reason: 'claimed_elsewhere' };
    const recovered = current.state === 'claimed' ? 'stale_claim' : 'crash_after_dispatch';
    const crashes = sameMemo ? current.crashes + (recovered === 'crash_after_dispatch' ? 1 : 0) : 0;
    return crashes >= MAX_CRASHES_PER_MEMO ? { take: false, reason: 'crash_limit', crashes } : { take: true, crashes, recovered };
  }
  if (!sameMemo) return { take: true, crashes: 0 };
  if (current.state === 'published' || current.state === 'rejected') return { take: false, reason: current.state };
  return { take: true, crashes: current.crashes };
}

/** The attempt store; `now` and the lease are injectable so tests drive expiry. */
export function attemptStore(engine: Exec, opts: { now?: () => Date; leaseMs?: number } = {}): AttemptStore {
  const now = opts.now ?? (() => new Date());
  const leaseMs = opts.leaseMs ?? DEFAULT_ATTEMPT_LEASE_MS;

  const readRecord = async (fingerprint: string): Promise<AttemptRecord | null> => {
    const [row] = await engine.executeRaw<{ completed_keys: AttemptRecord[] }>(
      'SELECT completed_keys FROM op_checkpoints WHERE op = $1 AND fingerprint = $2', [FENCE_REPAIR_ATTEMPT_OP, fingerprint]);
    return row?.completed_keys?.[0] ?? null;
  };

  /** Compare-and-swap: insert when `expected` is null, else replace only the record at version `expected`. */
  const swap = async (fingerprint: string, expected: number | null, record: AttemptRecord): Promise<boolean> => {
    const value = JSON.stringify([record]);
    const rows = expected === null
      ? await engine.executeRaw(
        'INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ($1, $2, $3::text::jsonb, now()) ON CONFLICT (op, fingerprint) DO NOTHING RETURNING 1',
        [FENCE_REPAIR_ATTEMPT_OP, fingerprint, value])
      : await engine.executeRaw(
        "UPDATE op_checkpoints SET completed_keys = $3::text::jsonb, updated_at = now() WHERE op = $1 AND fingerprint = $2 AND (completed_keys->0->>'v')::int = $4 RETURNING 1",
        [FENCE_REPAIR_ATTEMPT_OP, fingerprint, value, expected]);
    return rows.length === 1;
  };

  const stamp = (at: Date) => ({ at: at.toISOString(), lease_until: new Date(at.getTime() + leaseMs).toISOString() });

  const claim = async (candidate: AttemptCandidate, memo: string): Promise<ClaimResult> => {
    const fingerprint = attemptFingerprint(candidate);
    const at = now();
    try {
      const current = await readRecord(fingerprint);
      const plan = planClaim(current, memo, at);
      if (!plan.take && plan.reason === 'crash_limit') {
        const rejected: AttemptRecord = { ...current!, v: current!.v + 1, state: 'rejected', reason: 'crash_limit', crashes: plan.crashes, ...stamp(at) };
        if (!await swap(fingerprint, current!.v, rejected)) return { ok: false, reason: 'claimed_elsewhere', record: (await readRecord(fingerprint)) ?? current! };
        return { ok: false, reason: 'rejected', record: rejected };
      }
      if (!plan.take) return { ok: false, reason: plan.reason, record: current! };
      const record: AttemptRecord = { v: (current?.v ?? 0) + 1, source_id: candidate.sourceId, incarnation: candidate.incarnation, candidate: candidate.key,
        memo, state: 'claimed', owner: randomUUID(), dispatches: 0, reservations: [], crashes: plan.crashes, ...stamp(at) };
      if (!await swap(fingerprint, current?.v ?? null, record)) {
        const winner = await readRecord(fingerprint);
        return winner ? { ok: false, reason: 'claimed_elsewhere', record: winner } : { ok: false, reason: 'store_unavailable' };
      }
      return { ok: true, claim: { fingerprint, record }, ...(plan.recovered ? { recovered: plan.recovered } : {}) };
    } catch {
      return { ok: false, reason: 'store_unavailable' };
    }
  };

  const transition = async (held: AttemptClaim, from: readonly AttemptState[], change: Partial<AttemptRecord> & { state: AttemptState }): Promise<TransitionResult> => {
    if (!from.includes(held.record.state)) throw new Error(`fence repair attempt cannot move from ${held.record.state} to ${change.state}`);
    const record: AttemptRecord = { ...held.record, ...change, v: held.record.v + 1, ...stamp(now()) };
    try {
      return await swap(held.fingerprint, held.record.v, record) ? { ok: true, claim: { fingerprint: held.fingerprint, record } } : { ok: false, reason: 'lost_claim' };
    } catch {
      return { ok: false, reason: 'store_unavailable' };
    }
  };

  return {
    claim,
    dispatched: async (held, reservationId) => held.record.dispatches >= MAX_DISPATCHES_PER_CLAIM
      ? { ok: false, reason: 'dispatch_limit' }
      : transition(held, ['claimed', 'settled'], { state: 'dispatched', dispatches: held.record.dispatches + 1, reservations: [...held.record.reservations, reservationId] }),
    settled: held => transition(held, ['dispatched'], { state: 'settled' }),
    publish: held => transition(held, ['settled'], { state: 'published' }),
    reject: (held, verdict) => transition(held, ['settled'], { state: 'rejected', reason: verdict.reason,
      ...(verdict.gate ? { gate: verdict.gate } : {}), ...(verdict.rows ? { rows: [...verdict.rows] } : {}) }),
    transient: (held, reason) => transition(held, ['claimed', 'dispatched', 'settled'], { state: 'transient', reason }),
    read: candidate => readRecord(attemptFingerprint(candidate)),
  };
}
