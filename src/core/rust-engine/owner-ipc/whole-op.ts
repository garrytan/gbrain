/**
 * Whole operations a client of a Rust brain's owner sends as one request. A write path that opens its own
 * transaction (the file and content imports) cannot run in a client, because transactions do not cross the owner
 * socket (routes.ts). Its entry point calls `forwardWholeOperation` first; on a client engine the whole operation runs
 * inside the owner, transaction included, and its result or error comes back as the in-process call would give it.
 *
 * Only data crosses: an option that is a function (a coordinator `prepare` seam) refuses with
 * `engine_capability_missing`, and so does a caller that is not the trusted local CLI (a remote MCP caller of a second
 * `gbrain serve`), whose authority the owner would not see. File paths are sent absolute, because the owner has its own
 * working directory.
 *
 * The owner side table is owner-ops.ts; it is kept apart so the import modules can call this one without a cycle.
 */
import { resolve } from 'node:path';
import { currentSubmissionAuthority } from '../../minions/submission-authority.ts';
import { currentVerifiedLocalWriter } from '../../persistence/identity.ts';
import { ownerConnectionFor } from './client.ts';
import { ownerIpcRefusal } from './routes.ts';

export type WholeOperationName = 'importFromContent' | 'importFromFile' | 'importImageFile' | 'importManagedFiles';

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
};

/**
 * Sends a whole operation to the owner, or returns undefined when `engine` is not an owner client (the caller then
 * runs it in process). The arguments are the operation's own, without the engine.
 */
export function forwardWholeOperation<T>(engine: object, name: WholeOperationName, args: unknown[]): Promise<T> | undefined {
  const connection = ownerConnectionFor(engine);
  if (!connection) return undefined;
  const caller = currentSubmissionAuthority();
  if (caller && caller.kind !== 'application' || currentVerifiedLocalWriter()?.remote) {
    return Promise.reject(ownerIpcRefusal(name, 'a remote caller\'s whole operation is not sent to the brain owner'));
  }
  const sent = args.slice();
  for (const at of PATH_ARGS[name]) if (typeof sent[at] === 'string') sent[at] = resolve(sent[at] as string);
  if (name === 'importManagedFiles' && Array.isArray(sent[0])) {
    sent[0] = (sent[0] as Array<{ filePath: string }>).map(file => ({ ...file, filePath: resolve(file.filePath) }));
  }
  return connection.request('fn', name, sent) as Promise<T>;
}
