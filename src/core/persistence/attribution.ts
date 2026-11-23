import { currentVerifiedLocalWriter, existingHostIdFor, readLocalWriter, type LocalWriterEngine } from './identity.ts';
import type { Principal, SqlEngine, WriteRequest } from './model.ts';
import type { BrainEngine } from '../engine.ts';
import { withWriteAttribution } from './context.ts';
import type { WriteTrust } from '../trust/tier.ts';
import { requestChannelTrust } from '../trust/channel.ts';
import { hasScope } from '../scope.ts';
import { opError, type AuthInfo } from '../ops/contract.ts';
import { scopeDeniedError } from '../ops/op-fix.ts';
export { ownerSourceGateInput, suppliedTrustMarkerView, trustMarkerChanged, writeTrustOfGate } from '../trust/channel.ts';

/**
 * The actor the database stamps on rows written inside withCoordinatedWrite
 * or withWriteAttribution. `requestId` is persistence_requests.id (globally
 * unique), or null for a maintenance write with no journal request.
 */
export interface WriteAttribution {
  requestId: string | null;
  principal: Principal;
  /** The tier and origin of the rows written (trust/tier.ts). Undeclared: rows are stamped `unknown` unless an enclosing scope declared one. */
  trust?: WriteTrust;
}

export { withWriteAttribution };

/**
 * The HTTP MCP request header a caller uses to say which AI made a write ("Claude Code", "Codex", a job name). The
 * host knows which agent is calling through one credential; gbrain does not. It is a label the caller declares and
 * gbrain never verifies: it is stored on the write request and shown as `agent_label` by attribution reads, and
 * nothing that authorizes (grants, access rules, trust tiers) reads it. Not "writer": that word names the principal
 * and the write owner (persistence_local_writers, `gbrain sources writer`). Stdio and the local CLI have no request
 * headers and record none; their principal already names the lane.
 */
export const AGENT_LABEL_HEADER = 'X-Gbrain-Agent-Label';
/** A label safe to store and render, or undefined: 1-120 printable ASCII characters after trimming, else dropped. */
export function parseAgentLabel(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text && /^[\x20-\x7e]{1,120}$/.test(text) ? text : undefined;
}

/**
 * The HTTP MCP request header a trusted service (a multi-user MCP gateway in front of a shared brain) uses to say
 * which person a request's writes are for: an opaque id such as an email or `oidc:<subject>`. Unlike the agent label,
 * only a credential the operator granted the `declare_end_user` scope may send it; any other credential's request is
 * refused before any work (`insufficient_scope`), and a malformed value is refused too (`invalid_params`), so a
 * caller never believes a write was attributed when it was not. It is attribution only: stored on the request's
 * authority, shown as `end_user` by attribution reads, and read by no grant, access rule, audience or trust tier, so
 * it never widens or narrows what the request may do and needs no member per person. Stdio and the local CLI have no
 * request headers and record none.
 */
export const END_USER_HEADER = 'X-Gbrain-End-User';
export const END_USER_SCOPE = 'declare_end_user';
/** 1-256 visible ASCII characters after trimming (no spaces, controls, bidi or non-ASCII bytes). */
const END_USER_RE = /^[\x21-\x7e]{1,256}$/;

/**
 * The end user a request declares, checked against the credential: undefined when no header was sent, the trimmed id
 * when the credential holds `declare_end_user` and the value is well formed, else an OperationError the transport
 * returns before any work.
 */
export function resolveEndUser(raw: string | null | undefined, auth: Pick<AuthInfo, 'clientId' | 'scopes' | 'principal' | 'clientName'> | undefined,
  op: string, transport: 'stdio' | 'http'): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!auth || !hasScope(auth.scopes ?? [], END_USER_SCOPE)) {
    throw scopeDeniedError({ op, required: [END_USER_SCOPE], auth, transport,
      message: `This connection may not declare the end user (${END_USER_HEADER}) without the '${END_USER_SCOPE}' scope; nothing was read or written.` });
  }
  const id = raw.trim();
  if (!END_USER_RE.test(id)) {
    throw opError('invalid_params', `${END_USER_HEADER} must be 1-256 visible ASCII characters (an email or an opaque id such as oidc:<subject>); nothing was read or written.`,
      `Send the person's canonical id in ${END_USER_HEADER}, or leave the header out.`);
  }
  return id;
}

/** A journaled request publishes as itself. */
export function requestAttribution(row: Pick<WriteRequest, 'id' | 'principal_kind' | 'principal_id'>): WriteAttribution {
  return { requestId: row.id, principal: { kind: row.principal_kind, id: row.principal_id } };
}

/** A journaled publication: the request's actor, and the tier its preparer declared or its channel earns (#5575 A3). */
export function publicationAttribution(row: Pick<WriteRequest, 'id' | 'principal_kind' | 'principal_id' | 'operation' | 'authority' | 'intent'>, trust?: WriteTrust): WriteAttribution {
  const declared = trust ?? requestChannelTrust(row);
  return { ...requestAttribution(row), ...(declared ? { trust: declared } : {}) };
}

/** A write by a known principal that has no journal request (manual links, source lifecycle). */
export function principalAttribution(principal: Principal): WriteAttribution {
  return { requestId: null, principal };
}

/**
 * The executing maintenance principal: the verified local writer of this call
 * (server-side owner work), else this installation's local CLI registration,
 * else the host itself when the installation has no usable registration.
 * Attribution records the actor and never authorizes, so an unreadable
 * registration falls back to the host instead of failing the write, and it
 * never mints an identity file: an installation without one (an ephemeral
 * demo brain, a first direct import) is recorded as `host:unregistered`. The
 * registration found is memoized per engine (an in-process rotation keeps
 * naming the registration this process started with): per-page maintenance
 * loops would otherwise repeat a file read and two queries for every page.
 */
export async function maintenanceAttribution(engine: LocalWriterEngine): Promise<WriteAttribution> {
  const verified = currentVerifiedLocalWriter();
  if (verified) return principalAttribution(verified.principal);
  let registration = installationRegistration.get(engine);
  if (!registration) {
    registration = readLocalWriter(engine, 'cli').then(local => local.id);
    installationRegistration.set(engine, registration);
  }
  try { return principalAttribution({ kind: 'local_cli', id: await registration }); }
  catch {
    installationRegistration.delete(engine);
    return principalAttribution({ kind: 'application', id: `host:${existingHostIdFor(engine) ?? 'unregistered'}` });
  }
}
const installationRegistration = new WeakMap<object, Promise<string>>();

/**
 * One unmanaged legacy transaction (direct import, extract_facts, extract-takes,
 * stale-atom retirement) whose rows carry the maintenance principal. A managed
 * brain's guard still refuses these writes: this sets no coordinator capability.
 */
export async function maintenanceTransaction<T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>, trust?: WriteTrust): Promise<T> {
  const attribution = await maintenanceAttribution(engine);
  return engine.transaction(tx => withWriteAttribution(tx, trust ? { ...attribution, trust } : attribution, () => fn(tx)));
}
