/**
 * The capability refusal of the optional Rust engine (docs/designs/RUST_ENGINE.md, "Error contract for the Rust
 * engine", decision D2): `engine_capability_missing` means the engine opened but does not implement what the caller
 * asked for. The check runs before any work, so nothing was written. Addon states (missing, mismatched) are not
 * refused here: the addon loader owns them and refuses before an engine exists.
 *
 * `detail` is caller-safe key=value text: the member, the capability, the outcome and what was written.
 */
import { opError, type OperationError } from '../ops/contract.ts';
import type { Capability } from '../engine-capabilities.ts';

/** What a refusal left behind: `none` when the check ran before any work. */
export type CapabilityOutcome = 'none' | 'partial' | 'unknown';

/**
 * The engine does not implement `capability`, which `member` (a BrainEngine member, operation or command name) needs.
 * With the default `outcome: 'none'` nothing ran; the raw-SQL backstop passes `partial` or `unknown` when it is reached
 * after earlier steps of a caller already ran.
 */
export function capabilityMissing(capability: Capability, member: string, outcome: CapabilityOutcome = 'none'): OperationError {
  const nothingRan = outcome === 'none';
  return opError('engine_capability_missing',
    `This brain's engine does not support ${member} yet (it needs the ${capability} capability)${nothingRan ? ', so nothing ran.' : '.'}`,
    'Run it on a pglite or postgres brain, or wait for a gbrain release whose Rust engine supports it.',
    { reason: capability, detail: `member=${member} capability=${capability} outcome=${outcome} written=${nothingRan ? 'nothing' : outcome}` });
}
