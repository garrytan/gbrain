/**
 * The identity a remote caller's side write acts for, carried beside its engine member call.
 *
 * A remote-serving gbrain process talks to the brain owner over one connection that many OAuth clients share. A side
 * write that is attributed to a client (the retrieval event a remote search records, keyed by `client_id`) therefore
 * needs to say which client it is for. The process names it here, per call: `withMemberClaim` sets it, the served
 * client puts it on the call frame (served/client.ts), the brain server parses it strictly (`parseMemberClaim`) and sets
 * it again around the call (owner-ipc/server.ts, served/session-calls.ts), and the member policy
 * (served/remote-member-policy.ts) refuses a write that names any other client.
 *
 * Neutral location, like remote-caller.ts: it imports nothing from the engine layers. A claim is an assertion by the
 * connected process, not a credential: it narrows what a write may name, it does not prove who the end user is.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface MemberClaim {
  /** The OAuth client (or `local`) the write is attributed to. */
  clientId: string;
  /** The source the caller acts in. */
  sourceId: string;
  /** The caller's source allowlist, or null when it names none. */
  allowedSources: readonly string[] | null;
}

const MAX_ID = 256;
const MAX_SOURCES = 256;
const store = new AsyncLocalStorage<MemberClaim | null>();

/** Runs `fn` with `claim` as the ambient claim; null clears any outer claim, so a call never inherits another's. */
export function withMemberClaim<T>(claim: MemberClaim | null, fn: () => T): T {
  return store.run(claim, fn);
}

/** The ambient claim, or null outside one. */
export function currentMemberClaim(): MemberClaim | null {
  return store.getStore() ?? null;
}

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;

/** The claim a frame carries, or null when it is absent or not exactly the claim shape (never partially trusted). */
export function parseMemberClaim(raw: unknown): MemberClaim | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some(k => k !== 'clientId' && k !== 'sourceId' && k !== 'allowedSources')) return null;
  if (!text(o.clientId) || !text(o.sourceId)) return null;
  const sources = o.allowedSources;
  if (sources !== null && sources !== undefined) {
    if (!Array.isArray(sources) || sources.length > MAX_SOURCES || !sources.every(text)) return null;
    return { clientId: o.clientId, sourceId: o.sourceId, allowedSources: Object.freeze([...sources]) };
  }
  return { clientId: o.clientId, sourceId: o.sourceId, allowedSources: null };
}

/** The claim of an operation caller: its client id (`local` without an OAuth client), source and source allowlist. */
export function memberClaimOf(ctx: { auth?: { clientId?: string; allowedSources?: readonly string[] } | undefined; sourceId?: string }): MemberClaim {
  const allowed = ctx.auth?.allowedSources;
  return {
    clientId: ctx.auth?.clientId ?? 'local',
    sourceId: ctx.sourceId ?? 'default',
    allowedSources: allowed && allowed.length > 0 ? allowed : null,
  };
}
