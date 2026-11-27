/**
 * The host-fence refusal of the Rust engine's member dispatch (lane L5, decision A; docs/designs/rust-engine/
 * multi-user-server.md, "I-5, host fence table"). On a multi-user brain a process that holds a host registration and
 * calls a claim or lease member (persistence/fenced-members.ts) with no fence is refused `host_fence_required` before
 * the store runs it: the store alone cannot tell such a call from a one-shot command with no host, so a caller that
 * forgot `fenceOpts` would let a host that lost its lease write again.
 *
 * Not refused: a call with the fence or the TAKEN_UNFENCED mark (a claim or handle taken before the registration); a
 * process with no registration; a client's call the owner runs for it over the owner socket (`runAsOwnerClientCall`:
 * the owner's registration is the owner's, not the client's); every engine with the mode off.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { opError } from '../ops/contract.ts';
import { HOST_FENCED_MEMBERS, argsCarryFence } from '../persistence/fenced-members.ts';
import { fenceFor } from '../persistence/host-fence.ts';

const ownerClientCalls = new AsyncLocalStorage<true>();

/** Runs `fn` as a call the owner runs for a client over the owner socket: the dispatch refusal does not apply to it. */
export function runAsOwnerClientCall<T>(fn: () => T): T {
  return ownerClientCalls.run(true, fn);
}

/** Throws `host_fence_required` when `engine` (multi-user, registered) calls a fenced `member` with no fence in `args`. */
export function refuseUnfencedLeaseCall(engine: { readonly multiuser?: boolean }, member: string, args: readonly unknown[]): void {
  if (!HOST_FENCED_MEMBERS.has(member) || engine.multiuser !== true || ownerClientCalls.getStore() === true) return;
  if (argsCarryFence(args)) return;
  const fence = fenceFor(engine);
  if (!fence) return;
  throw opError('host_fence_required',
    `${member} was called without the host fence while this process holds host registration ${fence.name} (epoch ${fence.epoch}), so nothing was written.`,
    `Report ${member}: its caller must pass the host fence (fenceOpts, claimFenceOpts or the queue fences).`,
    { detail: `member=${member} registration=${fence.name} epoch=${fence.epoch}` });
}
