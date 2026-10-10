import { currentVerifiedLocalWriter, existingLocalHostId, readLocalWriter } from './identity.ts';
import type { Principal, SqlEngine, WriteRequest } from './model.ts';
import type { BrainEngine } from '../engine.ts';
import { withWriteAttribution } from './context.ts';
import type { WriteTrust } from '../trust/tier.ts';
import { requestChannelTrust } from '../trust/channel.ts';
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
export async function maintenanceAttribution(engine: SqlEngine): Promise<WriteAttribution> {
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
    return principalAttribution({ kind: 'application', id: `host:${existingLocalHostId() ?? 'unregistered'}` });
  }
}
const installationRegistration = new WeakMap<SqlEngine, Promise<string>>();

/**
 * One unmanaged legacy transaction (direct import, extract_facts, extract-takes,
 * stale-atom retirement) whose rows carry the maintenance principal. A managed
 * brain's guard still refuses these writes: this sets no coordinator capability.
 */
export async function maintenanceTransaction<T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>, trust?: WriteTrust): Promise<T> {
  const attribution = await maintenanceAttribution(engine);
  return engine.transaction(tx => withWriteAttribution(tx, trust ? { ...attribution, trust } : attribution, () => fn(tx)));
}
