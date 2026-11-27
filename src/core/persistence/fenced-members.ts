/**
 * The claim and lease members a multi-user Rust store fences with the host registration (lane L5;
 * docs/designs/rust-engine/multi-user-server.md, "I-5, host fence table"), by family. One list for two readers:
 *
 * - the Rust engine's member dispatch (rust-engine/fence-dispatch.ts) refuses `host_fence_required` when a process
 *   that holds a host registration calls one of them with no fence, so a caller that forgets `fenceOpts` cannot let a
 *   stale host write again;
 * - the caller census (test/rust-multiuser-lease-fence-callers-inventory.test.ts) checks that every call under src/
 *   sends the fence, so the refusal never fires on a shipped path.
 */
import { TAKEN_UNFENCED, type LeaseToken } from '../engine-sql/lease-token.ts';

/** The members of each family, by their BrainEngine name. */
export const FENCED_MEMBERS = {
  write_claims: ['stampWriteClaim', 'renewWriteClaim', 'releaseUnpublishedClaim', 'expireStaleWriteClaims', 'completeWriteRow'],
  job_claims: ['claimNextJob', 'renewJobLease', 'completeJob', 'failJob', 'releaseWatchdogClaim', 'reclaimStalledJobs', 'killTimedOutJobs', 'killWallClockJobs'],
  effect_claims: ['renewEffectClaim', 'advanceEffectRow', 'completeEffectRow', 'retryEffectRow', 'retryBusyEffectRow', 'requeueEffectRow', 'parkEffectRow', 'failEffectRow'],
  cycle_lock: ['acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'deleteCycleLock', 'deleteCycleLockIfStale'],
  drain_lease: ['writeDrainLeaseHolder', 'refreshDrainLeaseHolder', 'releaseDrainLeaseHolder'],
  consumer_rows: ['renewConsumerRow'],
  notifier_lease: ['writeNotifierState', 'writeNotifierCoverage'],
  housekeeping_turn: ['claimHousekeepingTurn', 'completeHousekeepingTurn'],
  private_queue_lease: ['renewPrivateQueueLease'],
  segmented_projection: ['claimSegmentedProjection', 'renewSegmentedProjectionClaim', 'releaseSegmentedProjectionClaim'],
  deferred_replacement: ['renewDeferredReplacementClaim', 'releaseDeferredReplacementClaim'],
  wake_leases: ['claimWakeWatch', 'settleWakeWatch', 'claimWakeForgets', 'settleWakeForget'],
  page_embedding_lease: ['takePageEmbeddingLease', 'renewPageEmbeddingLease', 'releasePageEmbeddingLease'],
} as const satisfies Record<string, readonly string[]>;

export type FencedFamily = keyof typeof FENCED_MEMBERS;

/**
 * Other names a family is called through in src/: the commit notifier writes through its NotifierStore, whose
 * `store.writeState` / `store.writeCoverage` forward to the notifier members. The census counts these calls too.
 */
export const FENCED_CALL_ALIASES: Partial<Record<FencedFamily, readonly string[]>> = {
  notifier_lease: ['store.writeState', 'store.writeCoverage'],
};

/**
 * Families whose fence is a lease of their own, not the host registration, so the dispatch refusal skips them: the
 * notifier's writes carry the notifier lease (host, owner, fence), which the store checks whenever it is sent, and a
 * host registration does not mean this process holds the notifier lease. The census still checks their callers.
 */
export const OWN_LEASE_FAMILIES: ReadonlySet<FencedFamily> = new Set<FencedFamily>(['notifier_lease']);

/** The members the dispatch refusal covers: every family but the own-lease ones. */
export const HOST_FENCED_MEMBERS: ReadonlySet<string> = new Set(
  (Object.entries(FENCED_MEMBERS) as Array<[FencedFamily, readonly string[]]>)
    .filter(([family]) => !OWN_LEASE_FAMILIES.has(family)).flatMap(([, members]) => members));

function isLeaseToken(value: unknown): value is LeaseToken {
  const v = value as Partial<LeaseToken> | null;
  return typeof v === 'object' && v !== null && typeof v.name === 'string' && typeof v.epoch === 'number' && typeof v.token === 'string';
}

/**
 * Whether a call's arguments carry a host fence, or say it was left out on purpose: an argument that is a lease token,
 * or options with `fence` set or the `TAKEN_UNFENCED` mark (a claim or handle taken before any registration).
 */
export function argsCarryFence(args: readonly unknown[]): boolean {
  return args.some(arg => {
    if (isLeaseToken(arg)) return true;
    if (typeof arg !== 'object' || arg === null) return false;
    const opts = arg as { fence?: unknown; [TAKEN_UNFENCED]?: unknown };
    return isLeaseToken(opts.fence) || opts[TAKEN_UNFENCED] === true;
  });
}
