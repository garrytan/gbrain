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
import type { OperationContext } from '../../ops/contract.ts';
import { importFromContent, importFromFile, importImageFile } from '../../import-file.ts';
import { importManagedFiles } from '../../persistence/import-mutations.ts';
import { ownerIpcRefusal } from './routes.ts';
import { snapshotStatus, snapshotStore, type SnapshotStoreOptions } from '../store-snapshot.ts';
import type { OwnerWholeOperation } from './server.ts';
import {
  OWNER_FORWARDED_OPERATIONS, OWNER_RUN_OPERATION, type ForwardedOperationContext, type ForwardedOperationResult,
  type WholeOperationName,
} from './whole-op.ts';

type Args<F> = F extends (engine: BrainEngine, ...rest: infer A) => unknown ? A : never;

const CONTEXT_KEYS: ReadonlySet<string> = new Set(['sourceId', 'admissionOrigin', 'writeWaitMs', 'localSourceImplicit',
  'localFederatedSourceIds', 'agentLabel', 'deferEmbeds'] satisfies Array<keyof ForwardedOperationContext>);

async function runOperation(engine: BrainEngine, config: GBrainConfig | undefined, name: unknown, params: unknown,
  context: unknown): Promise<ForwardedOperationResult> {
  if (typeof name !== 'string' || !OWNER_FORWARDED_OPERATIONS.has(name)) {
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
  const ctx = {
    ...carried,
    engine,
    config: config ?? ({ engine: engine.kind } as GBrainConfig),
    remote: false,
    dryRun: false,
    logger: { info: (m: string) => { logs.push(['info', m]); }, warn: (m: string) => { logs.push(['warn', m]); }, error: (m: string) => { logs.push(['error', m]); } },
    emitNotice: (notice: Notice) => { notices.push(notice); },
  } as unknown as OperationContext;
  const result = await operationsByName[name]!.handler(ctx, params as Record<string, unknown>);
  return { result, notices, logs };
}

/** `config` is the owner's own (the engine's connect config); a registry operation runs with it. */
export function ownerWholeOperations(opts: { config?: GBrainConfig } = {}): Readonly<Record<WholeOperationName | typeof OWNER_RUN_OPERATION, OwnerWholeOperation>> {
  return {
    importFromContent: (engine, ...args) => importFromContent(engine, ...(args as Args<typeof importFromContent>)),
    importFromFile: (engine, ...args) => importFromFile(engine, ...(args as Args<typeof importFromFile>)),
    importImageFile: (engine, ...args) => importImageFile(engine, ...(args as Args<typeof importImageFile>)),
    importManagedFiles: (engine, ...args) => importManagedFiles(engine, ...(args as Args<typeof importManagedFiles>)),
    [OWNER_RUN_OPERATION]: (engine, name, params, context) => runOperation(engine, opts.config, name, params, context),
    snapshotStore: (engine, target, options) => snapshotStore(engine, String(target), options as SnapshotStoreOptions),
    snapshotStatus: (_engine, opId) => Promise.resolve(snapshotStatus(String(opId))),
  };
}
