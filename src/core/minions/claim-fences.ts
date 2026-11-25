/**
 * The host fence each job claim of a queue was taken under (lane L5, review G11; persistence/host-fence.ts).
 *
 * On a multi-user Rust brain a claim records the fence it was taken under, and every later write on it must carry a fence
 * of the same lease name and epoch. The queue therefore keeps the fence of each claim it takes, by job id, and uses that one
 * for the claim's renewals, results, releases, progress, token and inbox writes, never whichever registration is current
 * when they run: a host that registered again under a new epoch cannot finish the claims of the old one. New claims and the
 * timeout sweeps use the queue's own registration (a worker passes its lease), else the engine's. With the switch off, or on
 * any other engine, there is no fence: nothing is stored and every call's arguments are what they always were.
 */
import type { BrainEngine } from '../engine.ts';
import type { FenceOpts, LeaseToken } from '../engine-sql/lease-token.ts';
import { fenceFor } from '../persistence/host-fence.ts';

/** How many job claims one queue remembers the fence of at once. */
const MAX_BOUND_CLAIMS = 4096;

export class ClaimFences {
  private readonly bound = new Map<number, { lockToken: string; fence: LeaseToken }>();

  constructor(private readonly engine: BrainEngine, private readonly source?: () => LeaseToken | null) {}

  /** The registration a new claim or a sweep runs under: the queue's own, else the engine's; none off multi-user. */
  registration(): LeaseToken | null {
    return this.source?.() ?? fenceFor(this.engine);
  }

  /** `{ fence }` for a new claim or a sweep, or `{}`. */
  registrationOpts(): FenceOpts {
    const fence = this.registration();
    return fence ? { fence } : {};
  }

  /**
   * The fence for a write on job `id` under `lockToken`: the one its claim was taken under. A job this queue did not claim
   * (another instance in the process, a test) falls back to the current registration, which the store checks against the
   * claim's own epoch.
   */
  optsFor(id: number, lockToken: string): FenceOpts {
    const claim = this.bound.get(id);
    return claim && claim.lockToken === lockToken ? { fence: claim.fence } : this.registrationOpts();
  }

  /** The trailing fence argument of a claim's call, present only with a fence so an unfenced call's arguments are unchanged. */
  claimArgs(id: number, lockToken: string): [] | [FenceOpts] {
    const opts = this.optsFor(id, lockToken);
    return opts.fence ? [opts] : [];
  }

  /** The trailing fence argument of a sweep. */
  sweepArgs(): [] | [FenceOpts] {
    const opts = this.registrationOpts();
    return opts.fence ? [opts] : [];
  }

  remember(id: number, lockToken: string, fence: LeaseToken): void {
    this.bound.delete(id);
    this.bound.set(id, { lockToken, fence });
    // A claim that is never finished here (the process lost it) must not grow the map without bound.
    for (const oldest of this.bound.keys()) {
      if (this.bound.size <= MAX_BOUND_CLAIMS) break;
      this.bound.delete(oldest);
    }
  }

  /** Runs a call that ends the claim under the claim's own fence, then forgets the claim. */
  async ending<T>(id: number, lockToken: string, run: (opts: FenceOpts) => Promise<T>): Promise<T> {
    const result = await run(this.optsFor(id, lockToken));
    if (this.bound.get(id)?.lockToken === lockToken) this.bound.delete(id);
    return result;
  }
}
