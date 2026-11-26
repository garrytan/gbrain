/**
 * Whole operations a client of a Rust brain's owner sends as one request. A write path that opens its own
 * transaction (the file and content imports) cannot run in a client, because transactions do not cross the owner
 * socket (routes.ts). An entry point that calls `forwardWholeOperation` first has the whole operation run inside the
 * owner, transaction included, and gets its result or error back as the in-process call would give it. No entry point
 * calls it yet for the imports, so a client's page and memory writes still stop at write admission
 * (persistence/admission-retry.ts), which opens a transaction, on `engine_capability_missing` reason `transactions`.
 * `snapshotStore` and `snapshotStatus` are the whole operations that are not imports: one copy of the whole brain at one
 * committed generation, and what became of it (store-snapshot.ts). Their caller is the shadow drill and `gbrain backup`.
 *
 * Only data crosses: an option that is a function (a coordinator `prepare` seam) refuses with
 * `engine_capability_missing`, and so does a caller that is not the trusted local CLI (a remote MCP caller of a second
 * `gbrain serve`), whose authority the owner would not see. File paths are sent absolute, because the owner has its own
 * working directory.
 *
 * When the owner has gone and the engine registered an election rerun (client.ts `rejoin`), the operation waits for
 * it and goes to the new owner; when this process became the owner it ends `owner_unavailable` (`not_sent`) and the
 * caller's retry runs it in process. An election that fails ends it with the election's own error (`rust_store_unreadable`
 * stays permanent), and a cancel or deadline during the election ends it at once.
 *
 * The owner side table is owner-ops.ts; it is kept apart so the import modules can call this one without a cycle.
 */
import { resolve } from 'node:path';
import { OperationError } from '../../ops/contract.ts';
import { callerIsRemote, ownerConnectionFor, ownerRejoinFor, untilCallEnds, type OwnerConnection } from './client.ts';
import { ownerGone, ownerIpcRefusal } from './routes.ts';

export type WholeOperationName =
  | 'importFromContent' | 'importFromFile' | 'importImageFile' | 'importManagedFiles' | 'snapshotStore' | 'snapshotStatus';

/** True when `engine` reaches its brain through another process (a client of the Rust brain's owner). */
export function isOwnerClient(engine: object): boolean {
  const connection = ownerConnectionFor(engine);
  return connection !== undefined && !connection.closed;
}

/** The argument positions (after the engine) that are file paths, made absolute before they are sent. */
const PATH_ARGS: Readonly<Record<WholeOperationName, readonly number[]>> = {
  importFromContent: [],
  importFromFile: [0],
  importImageFile: [0],
  importManagedFiles: [],
  snapshotStore: [0],
  snapshotStatus: [],
};

/**
 * Sends a whole operation to the owner, or returns undefined when `engine` is not an owner client (the caller then
 * runs it in process). The arguments are the operation's own, without the engine.
 */
export function forwardWholeOperation<T>(engine: object, name: WholeOperationName, args: unknown[]): Promise<T> | undefined {
  const connection = ownerConnectionFor(engine);
  if (!connection) return undefined;
  if (callerIsRemote()) {
    return Promise.reject(ownerIpcRefusal(name, 'a remote caller\'s whole operation is not sent to the brain owner'));
  }
  const sent = args.slice();
  for (const at of PATH_ARGS[name]) if (typeof sent[at] === 'string') sent[at] = resolve(sent[at] as string);
  if (name === 'importManagedFiles' && Array.isArray(sent[0])) {
    sent[0] = (sent[0] as Array<{ filePath: string }>).map(file => ({ ...file, filePath: resolve(file.filePath) }));
  }
  const rejoin = connection.closed ? ownerRejoinFor(connection) : undefined;
  if (!rejoin) return connection.request('fn', name, sent) as Promise<T>;
  // The owner has gone: run the election again. A new owner elsewhere takes the operation; when this process became
  // the owner it cannot run it from here, so it is not sent and the caller's retry runs it in process. An election
  // that fails for its own reason (a store that will not open, a disconnect that won) ends the operation with that
  // error, and a caller that cancels or passes its deadline during the election stops waiting at once.
  const elected = untilCallEnds(name, args, rejoin()).catch((error: unknown) => {
    if (!(error instanceof OperationError && error.code === 'owner_unavailable')) throw error;
  });
  return elected.then(() => {
    const next: OwnerConnection | undefined = ownerConnectionFor(engine);
    if (next && !next.closed) return next.request('fn', name, sent) as Promise<T>;
    throw ownerGone(name, connection.hello.pid, false);
  });
}
