/**
 * The whole operations the owner of a Rust brain runs for its clients (whole-op.ts). Each entry runs the same entry
 * point the client called, on the owner's engine, so its transaction opens inside the owner.
 *
 * `runOperation` runs a registry operation (whole-op.ts OWNER_FORWARDED_OPERATIONS) with the operation's own handler
 * as a trusted local caller: the owner's engine and config, the client's plain context fields. Notices and log lines go
 * back with the result, so the client shows them as the in-process call would.
 */
import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { Notice } from '../../agent-output.ts';
import { OperationError, type AuthInfo, type OperationContext } from '../../ops/contract.ts';
import { importFromContent, importFromFile, importImageFile } from '../../import-file.ts';
import { importManagedFiles } from '../../persistence/import-mutations.ts';
import { ownerHandoff, ownerIpcRefusal } from './routes.ts';
import { isRemoteCaller } from '../../remote-caller.ts';
import { remoteOperationContext, remoteWholeOperationForm } from '../served/remote-whole-ops.ts';
import { verifyRemoteClaim } from '../served/remote-claim.ts';
import { PERSISTENCE_CLOSING_MESSAGE } from '../../persistence/service.ts';
import { snapshotStatus, snapshotStore, type SnapshotStoreOptions } from '../store-snapshot.ts';
import type { OwnerWholeOperation } from './server.ts';
import { IMPORT_CLIENT_FILE, importClientFile } from '../served/client-files.ts';
import { SERVED_BRAIN_CALL, SERVED_STORE_CALL, SERVED_STORE_KEYS, STORE_RETURNING_MEMBERS, servedBrainMethod } from '../served/store-returning.ts';
import {
  forwardsWhole, OWNER_RUN_OPERATION, type ForwardedOperationContext, type ForwardedOperationResult,
  type WholeOperationName,
} from './whole-op.ts';

type Args<F> = F extends (engine: BrainEngine, ...rest: infer A) => unknown ? A : never;

const CONTEXT_KEYS: ReadonlySet<string> = new Set(['sourceId', 'admissionOrigin', 'writeWaitMs', 'localSourceImplicit',
  'localFederatedSourceIds', 'agentLabel', 'deferEmbeds'] satisfies Array<keyof ForwardedOperationContext>);

async function runOperation(engine: BrainEngine, config: GBrainConfig | undefined, name: unknown, params: unknown,
  context: unknown, remoteClaim?: unknown): Promise<ForwardedOperationResult> {
  const multiuser = (engine as { openStoreIfOpen?: (m: string) => { multiuser?: boolean } | null }).openStoreIfOpen?.('runOperation')?.multiuser === true;
  // A remote caller's whole operation of the closed list (served wire only; K let it through) runs too.
  if (typeof name !== 'string' || !(forwardsWhole(name, multiuser)
    || (multiuser && isRemoteCaller() && remoteWholeOperationForm(name, params, (remoteClaim as { auth?: unknown } | null | undefined)?.auth)))) {
    throw ownerIpcRefusal(String(name), 'the brain owner runs only page writes and imports whole');
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw ownerIpcRefusal(name, 'its parameters are not an object');
  const { operationsByName } = await import('../../operations.ts');
  const notices: Notice[] = [];
  const logs: ForwardedOperationResult['logs'] = [];
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context && typeof context === 'object' ? context : {})) {
    if (CONTEXT_KEYS.has(key) && value !== undefined) carried[key] = value;
  }
  // A remote caller's whole operation (served wire only, closed list; served/remote-whole-ops.ts) runs as the in-process
  // remote call does: ctx.remote true, under the caller's grant as a narrowing claim, its scope checked again here.
  const remote = isRemoteCaller() ? remoteOperationContext(name, operationsByName[name]!, context, remoteClaim) : null;
  // A claimed member credential (a principal on the grant) runs only as the store has it: its grant, binding, client id
  // and access record are read back before anything runs (served/remote-claim.ts).
  if (remote?.auth) await verifyRemoteClaim(engine, name, operationsByName[name]!, remote.auth as AuthInfo, remote.transport);
  const ctx = {
    ...carried,
    ...(remote ?? {}),
    engine,
    config: config ?? ({ engine: engine.kind } as GBrainConfig),
    remote: remote !== null,
    dryRun: false,
    logger: { info: (m: string) => { logs.push(['info', m]); }, warn: (m: string) => { logs.push(['warn', m]); }, error: (m: string) => { logs.push(['error', m]); } },
    emitNotice: (notice: Notice) => { notices.push(notice); },
  } as unknown as OperationContext;
  const result = await operationsByName[name]!.handler(ctx, params as Record<string, unknown>);
  return { result, notices, logs };
}

/** `config` is the owner's own (the engine's connect config); a registry operation runs with it. */
/**
 * Multi-user mode: an owner whose persistence service is closing refuses a forwarded write as "nothing accepted"
 * (persistence/service.ts). Over the owner socket that is a handoff: the client sends it, with its request id, to the
 * next owner (client side: whole-op.ts forwardOwnerOperation). Off, every error passes unchanged.
 */
export function handedOverIfClosing(engine: BrainEngine, name: unknown, error: unknown): unknown {
  const store = (engine as { openStoreIfOpen?: (m: string) => { multiuser?: boolean } | null }).openStoreIfOpen?.('runOperation');
  const closing = error instanceof OperationError && error.code === 'unavailable' && error.message.startsWith(PERSISTENCE_CLOSING_MESSAGE);
  return closing && store?.multiuser === true ? ownerHandoff(String(name), process.pid) : error;
}

export function ownerWholeOperations(opts: { config?: GBrainConfig } = {}): Readonly<Record<string, OwnerWholeOperation>> {
  return {
    importFromContent: (engine, ...args) => importFromContent(engine, ...(args as Args<typeof importFromContent>)),
    importFromFile: (engine, ...args) => importFromFile(engine, ...(args as Args<typeof importFromFile>)),
    importImageFile: (engine, ...args) => importImageFile(engine, ...(args as Args<typeof importImageFile>)),
    importManagedFiles: (engine, ...args) => importManagedFiles(engine, ...(args as Args<typeof importManagedFiles>)),
    [OWNER_RUN_OPERATION]: (engine, name, params, context, remoteClaim) => runOperation(engine, opts.config, name, params, context, remoteClaim)
      .catch((error: unknown) => { throw handedOverIfClosing(engine, name, error); }),
    snapshotStore: (engine, target, options) => snapshotStore(engine, String(target), options as SnapshotStoreOptions),
    snapshotStatus: (_engine, opId) => Promise.resolve(snapshotStatus(String(opId))),
    // Protocol v3 only: a network client's file import, sent as bytes (served/client-files.ts). The owner dispatcher
    // refuses it on v2 as any operation it does not run (owner-ipc/server.ts V3_ONLY_OPERATIONS).
    [IMPORT_CLIENT_FILE]: (engine: BrainEngine, ...args: unknown[]) => importClientFile(engine, args[0], args[1], args[2], args[3], args[4]),
    // Protocol v3 only: one store method of the shared-skill publication path (served/store-returning.ts).
    [SERVED_BRAIN_CALL]: async (engine: BrainEngine, method: unknown, args: unknown) => {
      if (!servedBrainMethod(method)) throw ownerIpcRefusal(String(method), 'it is not a store method a client may call');
      const rust = engine as unknown as { _admit?(m: string): Promise<void>; storeFor?(m: string): Promise<{ brain: Record<string, unknown> }> };
      if (typeof rust.storeFor !== 'function') throw ownerIpcRefusal(method, 'the brain server has no store');
      await rust._admit?.(method);
      const brain = (await rust.storeFor(method)).brain;
      return (brain[method] as (...a: unknown[]) => Promise<unknown>).apply(brain, Array.isArray(args) ? args : []);
    },
    // Protocol v3 only: the method names of a store a member returns (served/engine.ts servedStore).
    [SERVED_STORE_KEYS]: async (engine: BrainEngine, member: unknown) => {
      if (typeof member !== 'string' || !STORE_RETURNING_MEMBERS.has(member)) throw ownerIpcRefusal(String(member), 'it does not return a store');
      const store = await (engine as unknown as Record<string, () => Promise<Record<string, unknown>>>)[member]();
      return Object.keys(store).filter(key => typeof store[key] === 'function');
    },
    // Protocol v3 only: one method of a store a member returns (served/engine.ts STORE_RETURNING_MEMBERS).
    [SERVED_STORE_CALL]: async (engine: BrainEngine, member: unknown, method: unknown, args: unknown) => {
      if (typeof member !== 'string' || !STORE_RETURNING_MEMBERS.has(member)) throw ownerIpcRefusal(String(member), 'it does not return a store');
      const store = await (engine as unknown as Record<string, () => Promise<Record<string, unknown>>>)[member]();
      const fn = typeof method === 'string' && Object.hasOwn(store, method) ? store[method] : undefined;
      if (typeof fn !== 'function') throw ownerIpcRefusal(`${member}.${String(method)}`, 'its store has no such method');
      return (fn as (...a: unknown[]) => Promise<unknown>).apply(store, Array.isArray(args) ? args : []);
    },
  };
}
