/**
 * Keeps a consumer's write claim (or a publication group's claims) alive
 * while it prepares, and turns every way of losing it into one signal.
 *
 * A claim is renewed on a fixed cadence. Each renewal runs under its own
 * deadline; the claim counts as lost the first time a renewal reports it no
 * longer holds the claim, rejects, or outlives that deadline (the renewal is
 * then cancelled through its signal). Callers race their preparation against
 * `lost` so a claim another consumer has taken over (or one whose renewal
 * hangs on a row lock) never keeps them waiting on that preparation.
 *
 * `end()` stops renewing and never waits. It returns the renewal still in
 * flight, if any, so the owner can keep it tracked until it settles (the
 * consumer drains such work in `stop()` before the engine closes).
 */

export interface ClaimLeaseTiming {
  /** Gap between renewals. */
  everyMs: number;
  /** How long one renewal may take before the claim is treated as lost. */
  deadlineMs: number;
}

export const DEFAULT_CLAIM_LEASE_TIMING: Readonly<ClaimLeaseTiming> = { everyMs: 10_000, deadlineMs: 5_000 };

/** What `whileHeld` yields when the claim is lost before the work finishes. */
export const CLAIM_LOST: unique symbol = Symbol('claim_lost');

export interface ClaimLease {
  /** Resolves (it never rejects) when the claim is first found lost. */
  readonly lost: Promise<void>;
  /** False from the moment the claim is found lost. */
  readonly held: boolean;
  /**
   * Settles with `work`'s own outcome (a rejection propagates), or with
   * CLAIM_LOST if the claim is lost first. `work` keeps running either way;
   * after CLAIM_LOST the caller owns it and must never publish its result.
   */
  whileHeld<T>(work: Promise<T>): Promise<T | typeof CLAIM_LOST>;
  /** Stops renewing; returns the in-flight renewal (settles, never rejects) for the owner to track. */
  end(): Promise<void> | undefined;
}

/**
 * Starts renewing. `renew` resolves true while every claim it covers is still
 * ours. `onLost` runs synchronously before `lost` resolves, so a caller can
 * abort its preparation ahead of anything awaiting `lost`.
 */
export function startClaimLease(renew: (signal: AbortSignal) => Promise<boolean>, timing: ClaimLeaseTiming, onLost?: () => void): ClaimLease {
  let held = true;
  let ended = false;
  let inFlight: Promise<void> | undefined;
  const signal = Promise.withResolvers<void>();
  const markLost = () => {
    if (!held) return;
    held = false;
    onLost?.();
    signal.resolve();
  };
  const renewOnce = () => {
    if (ended || inFlight) return;
    const cancel = new AbortController();
    const overrun = setTimeout(() => { markLost(); cancel.abort(); }, timing.deadlineMs);
    const attempt: Promise<void> = renew(cancel.signal)
      .then(stillOurs => { if (!stillOurs) markLost(); }, markLost)
      .finally(() => {
        clearTimeout(overrun);
        if (inFlight === attempt) inFlight = undefined;
      });
    inFlight = attempt;
  };
  const cadence = setInterval(renewOnce, timing.everyMs);
  cadence.unref?.();
  return {
    lost: signal.promise,
    get held() { return held; },
    whileHeld: <T>(work: Promise<T>) => Promise.race([work, signal.promise.then((): typeof CLAIM_LOST => CLAIM_LOST)]),
    end() {
      ended = true;
      clearInterval(cadence);
      return inFlight;
    },
  };
}

/**
 * After a lost claim: stop renewing and give the cancelled in-flight renewal up
 * to `boundMs` to settle, so its server-side statement is gone before the
 * caller queues the release behind the same row lock. Never rejects.
 */
export async function endLostLease(lease: ClaimLease, boundMs = 1_000): Promise<void> {
  const renewal = lease.end();
  if (!renewal) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([renewal, new Promise<void>(resolve => { timer = setTimeout(resolve, boundMs); })]);
  if (timer) clearTimeout(timer);
}

