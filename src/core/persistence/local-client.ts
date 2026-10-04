/** Engine-free CLI routing to the process that already owns a PGLite brain. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, type GBrainConfig } from '../config.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { getCliOptions } from '../cli-options.ts';
import { loadMounts, type MountEntry } from '../brain-registry.ts';
import { inspectLockHolder, type LockHolderInfo } from '../pglite-lock.ts';
import { resolveSourceIdEngineFree } from '../source-resolver.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import { parseWriteRequestId } from './preconditions.ts';
import {
  isPersistenceIpcMutation, isPersistenceIpcOperation, isPersistenceIpcRegistration,
  persistenceSocketPathForConfig, requestPersistenceCapabilities, requestPersistenceOperation,
  PersistenceIpcTransportError, type PersistenceIpcCapabilities, type PersistenceIpcRegistration,
  requestPersistenceAdministration,
} from './ipc.ts';
import type { PersistenceAdminOperation } from './admin-contract.ts';
import { currentCliWriteWait, replayWhilePending, writeExchangeBudget } from './write-wait.ts';

function noDiscoveryPath(message: string, holder: LockHolderInfo, brainId?: string): OperationError {
  const who = holder.pid ? `process ${holder.pid}${holder.subcommand ? ` (gbrain ${holder.subcommand})` : ''}` : 'another process';
  return opError('owner_unavailable', message,
    `${who} holds ${brainId ? `brain ${brainId}'s` : 'this brain\'s'} PGLite lock but publishes no persistence socket, usually an older gbrain serve. Ask the user to stop or upgrade that process, then run the command again; nothing was sent to it.`,
    { fix: readFix('Shows the brain\'s lock holder and persistence state, read-only.', { argv: ['gbrain', 'doctor', ...(brainId ? ['--brain', brainId] : []), '--json'] }) });
}

/** The brain axis must be resolved before inspecting any host lock/socket. */
export function persistenceConfigForBrain(
  hostConfig: GBrainConfig | null,
  brainId: string,
  mounts: readonly MountEntry[],
): GBrainConfig | null {
  if (brainId === 'host') return hostConfig;
  const mount = mounts.find(candidate => candidate.id === brainId || candidate.alias === brainId);
  if (!mount || mount.enabled === false) {
    throw opError('invalid_params', `Brain '${brainId}' is not an enabled mount.`,
      'Pass --brain host or the id or alias of an enabled mount (`gbrain mounts list --json` shows them); re-enabling a disabled mount is the user\'s call.',
      { fix: readFix('Lists mounted brains with their ids, aliases and enabled state.', { argv: ['gbrain', 'mounts', 'list', '--json'] }) });
  }
  return { engine: mount.engine, database_path: mount.database_path, database_url: mount.database_url } as GBrainConfig;
}

/**
 * The persistence config of the brain a resident serve's engine opened, resolved
 * exactly as the CLI resolves it (--brain, GBRAIN_BRAIN_ID, .gbrain-mount, mount
 * path), so a mounted serve binds the owner socket the CLI probes (#5237).
 * Host-level settings stay; only the datastore identity follows the mount.
 */
export function residentPersistenceConfig(hostConfig: GBrainConfig | null, cwd = process.cwd()): GBrainConfig | null {
  const brainId = resolveBrainId(getCliOptions().brain, cwd);
  if (brainId === 'host') return hostConfig;
  const brain = persistenceConfigForBrain(hostConfig, brainId, loadMounts())!;
  return { ...hostConfig, engine: brain.engine, database_path: brain.database_path, database_url: brain.database_url } as GBrainConfig;
}

/** Reads an existing registration only. Revocation/missing credentials never create a new principal. */
export function readPersistenceCliRegistration(brainId: string): PersistenceIpcRegistration {
  // Capability validation has already constrained this filename component to a UUID.
  const id = parseWriteRequestId(brainId);
  if (!id) {
    throw opError('permission_denied', 'Missing durable brain identity.',
      'The resident owner reported no durable brain identity, so this CLI cannot select its writer registration. Check the brain\'s persistence state; if an older owner is running, the user restarts it after upgrading.',
      { fix: readFix('Shows the brain\'s persistence identity and lock holder, read-only.', { argv: ['gbrain', 'doctor', '--json'] }) });
  }
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(configDir(), 'persistence', `${id}.cli.json`), 'utf8')); }
  catch { throw new OperationError('permission_denied', 'This CLI has no readable durable writer registration for the selected brain.',
    'Register or explicitly regrant the CLI writer on this brain, then retry the same request ID.'); }
  if (!isPersistenceIpcRegistration(value) || value.lane !== 'cli') {
    throw trustedCliRequired('The local CLI writer registration is invalid.');
  }
  return value;
}

export type LocalDelegationResult = { handled: false } | { handled: true; result: unknown };

/** Administration uses a separate CLI-only envelope and never manufactures a new credential. */
export async function maybeDelegateLocalAdministration(
  operation: PersistenceAdminOperation, params: Record<string, unknown>, config: GBrainConfig,
  options: { timeoutMs?: number } = {},
): Promise<LocalDelegationResult> {
  if (config.engine !== 'pglite' || !config.database_path || config.database_url) return { handled: false };
  const holder = inspectLockHolder(config.database_path);
  if (!holder.held) return { handled: false };
  const socketPath = persistenceSocketPathForConfig(config);
  if (!socketPath) throw noDiscoveryPath('The PGLite owner has no persistence discovery path.', holder);
  const capability = await requestPersistenceCapabilities(socketPath);
  if (!capability.administration?.includes(operation)) throw new OperationError('owner_unavailable',
    'The running owner does not support this local administration command.', 'Upgrade and restart the owner before administering this brain.');
  const registration = readPersistenceCliRegistration(capability.brain_id);
  const result = await requestPersistenceAdministration(socketPath, {
    version: 1, kind: 'administration', brain_id: capability.brain_id, operation, params, registration,
  }, options.timeoutMs);
  return { handled: true, result };
}

/**
 * Mutates params only to retain a generated request ID across local/IPC paths.
 * False means no resident process owns this selected brain; the normal engine path
 * may connect. Once a resident owner is observed (a serve holder, or a socket
 * that answered), every failure is final here: never fall through after an
 * unavailable owner socket or a lost acknowledgment.
 */
export async function maybeDelegateLocalOperation(
  operation: string,
  params: Record<string, unknown>,
  hostConfig: GBrainConfig | null,
  options: { brain?: string | null; source?: string | null; cwd?: string; timeoutMs?: number; writeWaitMs?: number } = {},
): Promise<LocalDelegationResult> {
  if (!isPersistenceIpcOperation(operation)) return { handled: false };
  if (isPersistenceIpcMutation(operation)) {
    params.request_id = parseWriteRequestId(params.request_id) ?? randomUUID();
  }
  const cwd = options.cwd ?? process.cwd();
  const brainId = resolveBrainId(options.brain, cwd);
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url) return { handled: false };
  const holder = inspectLockHolder(config.database_path);
  if (!holder.held) return { handled: false };
  const socketPath = persistenceSocketPathForConfig(config);
  if (!socketPath) throw noDiscoveryPath('The selected PGLite owner has no persistence discovery path.', holder, brainId);

  // Takes' source is claim provenance, independent of the CLI source routing axis.
  const sourceInParams = options.source === undefined && !operation.startsWith('takes_');
  const explicit = options.source ?? (sourceInParams && typeof params.source === 'string' ? params.source : null);
  const source = resolveSourceIdEngineFree(explicit, cwd);
  const wireParams = { ...params };
  // These belong to the CLI context/renderer, not the operation schema.
  if (sourceInParams) delete wireParams.source;
  delete wireParams.json;
  let capability: PersistenceIpcCapabilities;
  try { capability = await requestPersistenceCapabilities(socketPath); }
  catch (error) {
    // A holder that is not a serve and answers no owner socket is another
    // command, such as a concurrent CLI call: the engine path waits for its lock.
    if (error instanceof PersistenceIpcTransportError && holder.serve === false) return { handled: false };
    throw error;
  }
  if (!capability.operations.includes(operation)) {
    throw new OperationError('owner_unavailable', `The running persistence owner does not support '${operation}'.`,
      'Upgrade and restart the owner, then retry with the same request ID.');
  }
  const registration = readPersistenceCliRegistration(capability.brain_id);
  const request = { version: 1 as const, kind: 'operation' as const, brain_id: capability.brain_id,
    operation, params: wireParams, registration, routing: { source, cwd } };
  if (!isPersistenceIpcMutation(operation)) return { handled: true, result: await requestPersistenceOperation(socketPath, request, options.timeoutMs) };
  // #5232: the owner waits the caller's wait within one transport deadline; an
  // owner without `write_wait` waits its own bound and the replay keeps the rest.
  const waitMs = options.writeWaitMs ?? currentCliWriteWait().waitMs;
  const deadline = Date.now() + waitMs;
  const result = await replayWhilePending(() => {
    const budget = writeExchangeBudget(Math.max(0, deadline - Date.now()), options.timeoutMs);
    return requestPersistenceOperation(socketPath,
      capability.write_wait ? { ...request, write_wait_ms: budget.waitMs } : request, budget.timeoutMs);
  }, waitMs);
  return { handled: true, result };
}
