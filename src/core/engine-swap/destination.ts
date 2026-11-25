/**
 * The swap destination, read from the destination itself (never from the engine the brain runs on today).
 *
 * `gbrain engine swap --to rust --plan` refuses `multiple_writer_hosts` unless the multi-user switch is on
 * (`GBRAIN_RUST_MULTIUSER=1`, src/core/rust-engine/multiuser-switch.ts) AND this evidence says the target is a served
 * Rust brain in multi-user mode for the brain being swapped (docs/designs/rust-engine/multi-user-server.md, I-0 and
 * the `served` capability of I-8). Anything missing, embedded, mismatched or switched off keeps refusing.
 *
 * Until the server lane (L3) lands nothing in production reports `served`, so the default resolver answers "no
 * destination evidence" and the plan keeps refusing; callers and tests inject a stand-in probe.
 */
import { rustMultiuserFromEnv } from '../rust-engine/multiuser-switch.ts';

export interface SwapDestinationEvidence {
  /** The destination's engine kind. Only `rust` can ever qualify. */
  engine: string;
  /** The brain the destination serves, when it says; null is "unknown", which never qualifies. */
  brain_id: string | null;
  /** The destination reports the `served` capability: it is a client of a server, not an embedded store. */
  served: boolean;
  /** The destination runs multi-user mode. */
  multiuser: boolean;
  /** `probe`: read from the destination. `none`: nothing was read, so nothing counts. */
  source: 'probe' | 'none';
}

/** What a destination probe reports (the facts only; the resolver adds the source). */
export type SwapDestinationProbe = (brainId: string) => Promise<Pick<SwapDestinationEvidence, 'engine' | 'brain_id' | 'served' | 'multiuser'> | null>;

/** The evidence of a destination nobody probed. */
export const NO_DESTINATION: SwapDestinationEvidence = { engine: 'rust', brain_id: null, served: false, multiuser: false, source: 'none' };

/**
 * Resolves the destination for `brainId`. The default has no probe (the server lands in lane L3), so it reports no
 * evidence and the plan refuses exactly as before. A probe that throws or answers null is also no evidence.
 */
export async function resolveSwapDestination(brainId: string, probe?: SwapDestinationProbe): Promise<SwapDestinationEvidence> {
  if (!probe) return { ...NO_DESTINATION };
  let seen: Awaited<ReturnType<SwapDestinationProbe>>;
  try { seen = await probe(brainId); } catch { return { ...NO_DESTINATION }; }
  if (!seen) return { ...NO_DESTINATION };
  return { engine: seen.engine, brain_id: seen.brain_id, served: seen.served === true, multiuser: seen.multiuser === true, source: 'probe' };
}

export interface DestinationOptions {
  /** The destination evidence; absent or `source: 'none'` counts as no evidence. */
  destination?: SwapDestinationEvidence | null;
  /** The brain being swapped; the destination must serve this one. Missing refuses. */
  expectedBrainId?: string;
  /** The resolved switch; default: the environment's `GBRAIN_RUST_MULTIUSER`. Off forces every destination to "no". */
  multiuser?: boolean;
}

/** The evidence that counts: present, read from a probe, and only while the switch is on. */
export function usableDestination(opts: DestinationOptions | undefined): SwapDestinationEvidence | null {
  const d = opts?.destination;
  if (!d || d.source !== 'probe') return null;
  if (!(opts.multiuser ?? rustMultiuserFromEnv())) return null;
  return d;
}

/** True only for a served multi-user Rust destination that serves the brain being swapped, with the switch on. */
export function destinationAllowsManyWriters(opts: DestinationOptions | undefined): boolean {
  const d = usableDestination(opts);
  if (!d) return false;
  return d.engine === 'rust' && d.served === true && d.multiuser === true
    && d.brain_id !== null && opts!.expectedBrainId !== undefined && d.brain_id === opts!.expectedBrainId;
}
