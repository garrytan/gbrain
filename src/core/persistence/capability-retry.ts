/**
 * The retry budget of a write that an engine refuses at publication with its typed capability refusal
 * (`engine_capability_missing`, a member the Rust engine does not serve yet).
 *
 * Nothing has published when that refusal comes, so the writer first returns the claim to queued: a consumer on an
 * engine that serves the member can still publish the write. The same engine refuses the same member on every claim,
 * though, so the claim is returned at most PUBLICATION_CAPABILITY_ATTEMPTS - 1 times; the refusal on the last attempt
 * ends the write `failed` with that typed refusal (coordinator.ts finishUnpublishedFailure). Without the limit the
 * write stayed queued for ever, its waiter got `write_pending`, and every later write to the source waited behind it.
 *
 * The count is kept by this process, per request: it needs no column, and it is the same on every engine. A consumer
 * that restarts counts again from zero, so a write is claimed at most this many times per consumer process. A count is
 * dropped when the write ends in any terminal state (settleCapabilityRefusal), not when it is charged, so a failed
 * completion that rolls back does not start the count again.
 */

/** How many claims of one write may reach a publication-stage capability refusal; the last one ends the write failed. */
export const PUBLICATION_CAPABILITY_ATTEMPTS = 3;

/** The most requests counted at once; the oldest count is dropped first (a dropped write only starts counting again). */
const MAX_COUNTED = 4096;
const counted = new Map<string, number>();

/**
 * One more publication-stage capability refusal of request `id`: the attempt it was, and whether the claim may go back
 * to queued. An exhausted count stays until settleCapabilityRefusal confirms the write ended, so a terminal transaction
 * that rolls back does not start the count again.
 */
export function chargeCapabilityRefusal(id: string): { attempts: number; limit: number; release: boolean } {
  const attempts = (counted.get(id) ?? 0) + 1;
  counted.delete(id);
  counted.set(id, attempts);
  if (counted.size > MAX_COUNTED) counted.delete(counted.keys().next().value!);
  return { attempts, limit: PUBLICATION_CAPABILITY_ATTEMPTS, release: attempts < PUBLICATION_CAPABILITY_ATTEMPTS };
}

/** Forgets request `id`'s count once the write reached a terminal state (or committed). */
export function settleCapabilityRefusal(id: string): void {
  counted.delete(id);
}

/** Test seam: how many requests are counted now. */
export function countedCapabilityRefusalsForTests(): number {
  return counted.size;
}

/** Test seam: forgets every count. */
export function resetCapabilityRefusalsForTests(): void {
  counted.clear();
}
