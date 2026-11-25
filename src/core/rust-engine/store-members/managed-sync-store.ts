/**
 * The managed sync's named statements (BrainEngine `runSyncStatement`; the text PGLite and Postgres run is in
 * engine-sql/managed-sync-store.ts), served from the store's source, page, request, effect, config and checkpoint records
 * (gbrain-store `persistence::managed_sync_store`).
 *
 * Each statement is one `syncStoreRows(name, params)` call (a read) or one `syncStoreWrite(name, params)` call (a write), with the rows
 * the SQL returns. The row locks the SQL takes become stated guarantees (the module doc of managed_sync_store.rs): an explicit
 * transaction is Serialized (it holds the store's writer, so no other commit interleaves with what it read), and under optimistic
 * transactions the rows read are in the transaction's read set, so a racing change aborts the commit with `write_conflict`.
 */
import { SYNC_STATEMENTS, type SyncStatementName, type SyncStatementOptions } from '../../engine-sql/managed-sync-store.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';
import { heldRefusal, managedServed } from './managed-hold.ts';

/** While the managed hold is on (a user's Rust brain) the statement refuses as the `executeRaw` it replaced did (managed-hold.ts). */
export const runSyncStatement = async function runSyncStatement(this: RustEngine, brain: StoreBrain, name: SyncStatementName, params: readonly unknown[] = [], _opts?: SyncStatementOptions): Promise<unknown[]> {
  if (!managedServed(this)) throw heldRefusal();
  return storeCall({ member: 'runSyncStatement' }, () =>
    (SYNC_STATEMENTS[name].kind === 'write' ? brain.syncStoreWrite(name, [...params]) : brain.syncStoreRows(name, [...params])) as Promise<unknown[]>);
};
