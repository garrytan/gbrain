/**
 * A refused engine capability is not a database miss.
 *
 * An engine without a capability (the optional Rust engine serves some
 * storage domains only) refuses the typed method with the operator-protocol
 * code `engine_capability_missing`. Fail-open readers (ranking stages,
 * coaching counts) catch errors so a missing table or a transient failure
 * never breaks the caller; they must let this refusal through, or a search
 * on such an engine would silently rank without the stage and look healthy.
 */

const CODE = 'engine_capability_missing';

/** Whether `err` is an `engine_capability_missing` refusal (on the error or its operator envelope). */
export function isEngineCapabilityRefusal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code === CODE) return true;
  const envelope = (err as { envelope?: unknown }).envelope;
  return typeof envelope === 'object' && envelope !== null && (envelope as { code?: unknown }).code === CODE;
}

/** Rethrow `err` when it is a capability refusal; otherwise return so the caller's fail-open path runs. */
export function rethrowCapabilityRefusal(err: unknown): void {
  if (isEngineCapabilityRefusal(err)) throw err;
}

/** A `.catch` handler for a fail-open read whose fallback is `null`: a capability refusal still throws. */
export function nullUnlessCapabilityRefusal(err: unknown): null {
  rethrowCapabilityRefusal(err);
  return null;
}
