/**
 * The whole operations the owner of a Rust brain runs for its clients (whole-op.ts). Each entry runs the same entry
 * point the client called, on the owner's engine, so its transaction opens inside the owner.
 */
import type { BrainEngine } from '../../engine.ts';
import { importFromContent, importFromFile, importImageFile } from '../../import-file.ts';
import { importManagedFiles } from '../../persistence/import-mutations.ts';
import { snapshotStatus, snapshotStore, type SnapshotStoreOptions } from '../store-snapshot.ts';
import type { OwnerWholeOperation } from './server.ts';
import type { WholeOperationName } from './whole-op.ts';

type Args<F> = F extends (engine: BrainEngine, ...rest: infer A) => unknown ? A : never;

export function ownerWholeOperations(): Readonly<Record<WholeOperationName, OwnerWholeOperation>> {
  return {
    importFromContent: (engine, ...args) => importFromContent(engine, ...(args as Args<typeof importFromContent>)),
    importFromFile: (engine, ...args) => importFromFile(engine, ...(args as Args<typeof importFromFile>)),
    importImageFile: (engine, ...args) => importImageFile(engine, ...(args as Args<typeof importImageFile>)),
    importManagedFiles: (engine, ...args) => importManagedFiles(engine, ...(args as Args<typeof importManagedFiles>)),
    snapshotStore: (engine, target, options) => snapshotStore(engine, String(target), options as SnapshotStoreOptions),
    snapshotStatus: (_engine, opId) => Promise.resolve(snapshotStatus(String(opId))),
  };
}
