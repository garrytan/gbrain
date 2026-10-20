/**
 * #6712 PR 4b (design v3.2 §3.1): the in-memory round batch of a live pass and its request identity. Kept free of heavy
 * imports: sync-run.ts, sync-waivers.ts and the pass (sync-pass-run.ts) all read it.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SyncEntry } from './sync-discovery.ts';
import { assertDrainLease } from './sync-lease.ts';
import { admissionAllows, readSyncAdmission, type SyncAdmission } from './sync-admission.ts';
import { reservePassCost, type PricedIntent } from './sync-pass-episode.ts';

/**
 * #6712 PR 4b (design v3.2 §3.1): a live pass admits each round batch through the cursor machinery of sync-run.ts with no
 * persisted cursor behind it. The batch lives in this process under a key with this prefix, held only while the pass
 * holds the source's drain lease; every step that would compare-and-swap a cursor row asserts the lease instead
 * (`passBatchStep`).
 */
export const PASS_BATCH_KEY_PREFIX = 'pass:';
export const isPassBatchKey = (key: string | null | undefined): key is string => typeof key === 'string' && key.startsWith(PASS_BATCH_KEY_PREFIX);
type BatchHead = { sourceId: string; runId: string; index: number; pending?: { requestId: string } | null };
const passBatches = new Map<string, { value: BatchHead; header: string }>();
/** The in-memory batch under `key` (null: none, or the pass ended). */
export function readPassBatch<T>(key: string): T | null { return (passBatches.get(key)?.value as T | undefined) ?? null; }
/** Replaces (or, with null, drops) the in-memory batch under `key`; `header` is its serialized header, the compare-and-swap's operand. */
export function setPassBatch(key: string, value: BatchHead | null, header = ''): void {
  if (value) passBatches.set(key, { value, header }); else passBatches.delete(key);
}
/**
 * GBRA-130: whether this pass already passed over the refused receipt of `requestId` (a file changed after admission).
 * A pass's request ID is its path at its level, so reading the same receipt again means the committed level did not move:
 * an uncommitted edit, which the settle path holds `worktree_dirty` instead of the pass using its rounds on it.
 * Records the receipt otherwise. Only the newest passes of this process are kept.
 */
export function passedOverBefore(passId: string, requestId: string): boolean {
  const seen = passedOver.get(passId) ?? new Set<string>();
  if (seen.has(requestId)) return true;
  passedOver.delete(passId); passedOver.set(passId, seen.add(requestId));
  for (const old of passedOver.keys()) if (passedOver.size > 8) passedOver.delete(old);
  return false;
}
const passedOver = new Map<string, Set<string>>();
/**
 * One step of an in-memory batch inside `tx`: the drain lease fences it (the pass that holds the lease is the batch's only
 * writer), and it lands only while the batch's header still is `beforeHeader` (the cursor row's compare-and-swap contract).
 * Returns false when it did not land.
 */
export async function passBatchStep<T extends Pick<BrainEngine, 'executeRaw'>>(tx: T, key: string, beforeHeader: string | null, next: BatchHead, nextHeader: string,
  inTx?: (tx: T) => Promise<unknown>): Promise<boolean> {
  await assertDrainLease(tx, next.sourceId);
  const holds = () => (passBatches.get(key)?.header ?? null) === beforeHeader;
  if (!holds()) return false;
  // What rides the step (a hold write or clear) commits in its transaction; the batch moves only after it ran.
  await inTx?.(tx);
  if (!holds()) return false;
  passBatches.set(key, { value: next, header: nextHeader });
  return true;
}
/** The batch's head as the waivers' cursor-row read returns it, fenced by the drain lease. */
export async function passBatchHead(tx: Pick<BrainEngine, 'executeRaw'>, key: string, sourceId: string): Promise<{ run_id: string | null; index: number | null; request_id: string | null } | undefined> {
  await assertDrainLease(tx, sourceId);
  const batch = passBatches.get(key)?.value;
  return batch ? { run_id: batch.runId, index: batch.index, request_id: batch.pending?.requestId ?? null } : undefined;
}

/** RFC 4122 namespace of pass request ids (fixed forever: changing it re-admits a same-pass replay). */
const NS_SYNC_PASS = Buffer.from('5f0c6712b4a84e0b9d1a2c3e4f5a6712', 'hex');
/** `request_id = uuidv5(NS_SYNC_PASS, passId‖path‖level)` (design v3.2 §3.1): a same-pass replay reads the existing receipt. */
export function passRequestId(passId: string, path: string, level: string | null): string {
  const hash = createHash('sha1').update(NS_SYNC_PASS).update(`sync_pass:v1:${passId.toLowerCase()}\0${path}\0${level ?? ''}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The converged watermark a pass records (design v3.2 §2.2): the worktree's highest request `sequence`, and the requests
 * (`r:<id>`) and Git effects (`e:<id>`) still open, at most `cap` (null above it: no idle until a full round re-reads).
 */
export async function readConvergedWatermark(tx: Pick<BrainEngine, 'executeRaw'>, scope: { worktreeId: string; sourceId: string; incarnation: string }, selfRequestId: string | null, cap: number,
  /** `converged.writeback` (sync-pass-row.ts): a folded writeback stamp's own write, and the prior stamp's list, of which the uncommitted stay. */
  writeback?: { own?: string; prior?: readonly string[] }): Promise<{ request_hwm: string; open_at_stamp: string[] | null; writeback?: string[] }> {
  // The worktree's requests and the incarnation's worktree-less ones (writes admitted with sync.write_through=false).
  const [hwm] = await tx.executeRaw<{ hwm: string | null }>(`SELECT GREATEST((SELECT max(sequence) FROM persistence_requests WHERE worktree_id=$1::uuid),
    (SELECT max(sequence) FROM persistence_requests WHERE worktree_id IS NULL AND source_id=$2 AND source_incarnation=$3::uuid))::text AS hwm`, [scope.worktreeId, scope.sourceId, scope.incarnation]);
  const open = await tx.executeRaw<{ id: string }>(`(SELECT 'r:'||request_id::text AS id FROM persistence_requests
      WHERE state IN ('queued','running','recovering') AND (worktree_id=$1::uuid OR worktree_id IS NULL AND source_id=$4 AND source_incarnation=$5::uuid)
        AND request_id IS DISTINCT FROM $2::uuid LIMIT $3)
    UNION ALL (SELECT 'e:'||e.id::text FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
      WHERE r.worktree_id=$1::uuid AND e.kind='git' AND e.state IN ('queued','running') LIMIT $3)`, [scope.worktreeId, selfRequestId, cap + 1, scope.sourceId, scope.incarnation]);
  // The prior list's writebacks whose Git effect has not committed (queued, running, failed or parked) stay listed.
  const carried = writeback?.prior?.length ? (await tx.executeRaw<{ id: string }>(`SELECT DISTINCT e.request_id::text AS id FROM persistence_effects e
      WHERE e.request_id = ANY($1::uuid[]) AND e.kind='git' AND e.state<>'committed'`, [writeback.prior])).map(row => row.id) : [];
  const listed = [...new Set([...(writeback?.own ? [writeback.own] : []), ...carried])];
  return { request_hwm: hwm?.hwm ?? '0', open_at_stamp: open.length > cap ? null : open.map(row => row.id), ...(listed.length ? { writeback: listed } : {}) };
}

/** A round batch's entry: the discovery shape plus the level `L` it was classified at (the request identity's third part). */
export interface PassEntry extends SyncEntry { level: string | null }

/** `sync.admission` no longer admits what a pass froze (design v3.2 §8.1): the pass stops `resumable`, `admission_paused`. */
export class SyncAdmissionPaused extends Error {
  constructor(readonly admission: SyncAdmission) { super(`sync.admission is ${admission}, so this sync admits no more writes of that kind.`); this.name = 'SyncAdmissionPaused'; }
}
/**
 * Fencing 1 (design v3.2 §8): a pass's admission transaction re-reads `sync.admission` and admits nothing it no longer
 * allows (a delete needs `normal`; an import or the stamp needs `normal` or `imports_only`). Cursor intents are unaffected.
 */
export async function assertPassAdmission(tx: Pick<BrainEngine, 'executeRaw'>, intents: ReadonlyArray<PricedIntent>): Promise<void> {
  if (!intents.some(intent => intent.passId)) return;
  const admission = await readSyncAdmission(tx);
  for (const intent of intents) {
    if (intent.passId && !admissionAllows(admission, intent.kind === 'managed_sync_delete' ? 'destructive' : 'import')) throw new SyncAdmissionPaused(admission);
  }
  // Design v3.2 §7: the group's cost reservation commits with its admission.
  await reservePassCost(tx, intents);
}
