/**
 * The job policy `decide` hook over the owner socket (multi-writer conformance C18).
 *
 * `admitJob` and `coalesceOnIdempotencyKey` take a policy whose `decide(tx, row)` the Rust store calls only for a row held
 * under another authority, and only so that it throws its refusal (store-members/jobs.ts `settled`; its `tx` reaches no
 * database). Functions do not cross the socket, so the client keeps the hook: it sends a `heldRow` tag in its place, the
 * owner's stand-in throws the held row back as its error, and the client runs its own hook on that row, which throws the
 * refusal it throws in process. A delegated client's policy (`lock`, `checkCapacity`) needs a transaction and is sent as
 * it is, so it is refused as before. `parentAuthorityKind` is never called by the store and stays on the client.
 */
import type { Wire } from './codec.ts';
import { noDatabase } from '../store-members/common.ts';
import { refuseMember } from '../store-members/common.ts';

/** The members whose policy carries a `decide` hook. */
export const HELD_ROW_MEMBERS: ReadonlySet<string> = new Set(['admitJob', 'coalesceOnIdempotencyKey']);

const HELD_ROW_ERROR = 'OwnerHeldRow';

/** The stand-in the client sends for its `decide` hook; the client codec turns it into the `heldRow` tag. */
export const HELD_ROW_HOOK = async (): Promise<never> => { throw new Error('the held-row stand-in runs only on the brain owner'); };
export const HELD_ROW_TAG: Wire = { $t: 'fn', heldRow: true };

/** The owner's stand-in for a client's `decide` hook: it throws the held row back to the client. */
export function heldRowHook(member: string): (tx: unknown, row: unknown) => Promise<never> {
  return async (_tx, row) => {
    throw Object.assign(new Error(`${member}: the row is held under another authority; the client's policy decides`), { name: HELD_ROW_ERROR, heldRow: row });
  };
}

type Policy = { decide?: unknown; lock?: unknown; checkCapacity?: unknown; parentAuthorityKind?: unknown; [key: string]: unknown };

/** Runs `member` through the owner with the policy's `decide` hook kept here (`send` sends the call). */
export async function withHeldRowHook(member: string, args: unknown[], send: (args: unknown[]) => Promise<unknown>): Promise<unknown> {
  const policy = args[1] as Policy | undefined;
  if (!policy || typeof policy !== 'object' || typeof policy.decide !== 'function' || policy.lock || policy.checkCapacity) return send(args);
  const { decide, parentAuthorityKind: _kept, ...rest } = policy;
  try {
    return await send([args[0], { ...rest, decide: HELD_ROW_HOOK }, ...args.slice(2)]);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== HELD_ROW_ERROR || !('heldRow' in error)) throw error;
    await (decide as (tx: unknown, row: unknown) => Promise<unknown>)(noDatabase(member), (error as { heldRow: unknown }).heldRow);
    return refuseMember(member, 'a coalesce the store and the policy decide differently');
  }
}
