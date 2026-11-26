/**
 * Whole operations a client of a Rust brain's owner sends as one request. A write path that opens its own
 * transaction (the file and content imports) cannot run in a client, because transactions do not cross the owner
 * socket (routes.ts). Its entry point calls `forwardWholeOperation` before it touches the engine; on a client engine
 * the whole operation runs inside the owner, transaction included, and its result or error comes back as the
 * in-process call would give it.
 * `snapshotStore` and `snapshotStatus` are the whole operations that are not imports: one copy of the whole brain at one
 * committed generation, and what became of it (store-snapshot.ts). Their caller is the shadow drill and `gbrain backup`.
 *
 * Only data crosses: an option that is a function (a coordinator `prepare` seam) refuses with
 * `engine_capability_missing`, and so does a caller that is not the trusted local CLI (a remote MCP caller of a second
 * `gbrain serve`), whose authority the owner would not see. File paths are sent absolute, because the owner has its own
 * working directory.
 *
 * Whole operations write through the brain's persistence journal, so they are sent only to an owner whose hello
 * reports `persistence_journal`. A client of an owner without it refuses at once with `engine_capability_missing`
 * (reason `persistence_journal`) and sends nothing.
 *
 * Page-write operations of the operation registry (OWNER_FORWARDED_OPERATIONS, put_page today) go the same way through
 * `forwardOwnerOperation`: the owner runs the operation's own handler on its engine, so the caller gets the receipt (or
 * the error) the same handler gives in the owner's process, and through the persistence socket of a `gbrain serve`.
 *
 * When the owner has gone and the engine registered an election rerun (client.ts `rejoin`), the operation waits for
 * it and goes to the new owner; when this process became the owner it ends `owner_unavailable` (`not_sent`) and the
 * caller's retry runs it in process. An election that fails ends it with the election's own error (`rust_store_unreadable`
 * stays permanent), and a cancel or deadline during the election ends it at once. A registry operation sent through
 * `forwardOwnerOperation` waits the same way, and when this process became the owner its caller runs the handler in
 * process, since nothing of it was sent.
 *
 * The owner side table is owner-ops.ts; it is kept apart so the import modules can call this one without a cycle.
 */
import { resolve } from 'node:path';
import type { Notice } from '../../agent-output.ts';
import { OperationError, type OperationContext } from '../../ops/contract.ts';
import { capabilityMissing } from '../errors.ts';
import {
  callEndCheck, callerIsRemote, ownerConnectionFor, ownerRejoinFor, rustOwnerServesPersistence, untilCallEnds, untilOwnerClosed, type OwnerConnection,
} from './client.ts';
import { isOwnerHandoff, ownerGone, ownerIpcRefusal } from './routes.ts';
import { rustMultiuserFromEnv } from '../multiuser-switch.ts';
import { IMPORT_CLIENT_FILE, readClientFile, type ClientFilePayload } from '../served/client-files.ts';

export type WholeOperationName =
  | 'importFromContent' | 'importFromFile' | 'importImageFile' | 'importManagedFiles' | 'snapshotStore' | 'snapshotStatus';

/** The owner's entry for a registry operation sent whole (owner-ops.ts runs it). */
export const OWNER_RUN_OPERATION = 'runOperation';

/** Registry operations a client sends whole to an owner that reports persistence_journal. */
export const OWNER_FORWARDED_OPERATIONS: ReadonlySet<string> = new Set(['put_page']);

/**
 * The context fields a forwarded operation carries to the owner: plain data of a trusted local caller. Engine, config,
 * logger and notice sinks are the owner's own; notices and log lines come back with the result.
 */
export interface ForwardedOperationContext {
  sourceId?: string;
  admissionOrigin?: OperationContext['admissionOrigin'];
  writeWaitMs?: number;
  localSourceImplicit?: boolean;
  localFederatedSourceIds?: string[];
  agentLabel?: string;
  deferEmbeds?: boolean;
}

/** What the owner sends back for a forwarded operation. */
export interface ForwardedOperationResult {
  result: unknown;
  notices: Notice[];
  logs: Array<['info' | 'warn' | 'error', string]>;
}

const FORWARDED_CONTEXT_KEYS = ['sourceId', 'admissionOrigin', 'writeWaitMs', 'localSourceImplicit', 'localFederatedSourceIds',
  'agentLabel', 'deferEmbeds'] as const satisfies ReadonlyArray<keyof ForwardedOperationContext>;

/** Context fields that carry an authority or a scope the owner would not see; a context with any of them is refused. */
const UNFORWARDED_AUTHORITY_KEYS = ['auth', 'replayAuthority', 'viaSubagent', 'subagentId', 'jobId', 'allowedSlugPrefixes',
  'attestedOp', 'attestedSource', 'accessIdentity', 'stdioMember', 'thinClient'] as const;

/** Refuses a caller other than the trusted local CLI; its authority would not reach the owner. */
function refuseUntrustedCaller(name: string): void {
  if (callerIsRemote()) throw ownerIpcRefusal(name, 'a remote caller\'s whole operation is not sent to the brain owner');
}

/** The owner writes through its persistence journal; without it, a whole operation is refused before it is sent. */
function requireOwnerJournal(connection: OwnerConnection, name: string): void {
  if (!rustOwnerServesPersistence(connection.hello.capabilities)) throw capabilityMissing('persistence_journal', name);
}

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
  const rejoin = connection.closed ? ownerRejoinFor(connection) : undefined;
  // A connection that is still open is checked now; the one the election finds is checked when it is known.
  try { refuseUntrustedCaller(name); if (!rejoin) requireOwnerJournal(connection, name); }
  catch (error) { return Promise.reject(error); }
  // A network client of a brain server (rust-engine/served/): its paths are not the server's, so a file import sends
  // the file's bytes (served/client-files.ts) and an operation that names a server path refuses on the server.
  if ((connection as { network?: boolean }).network === true && (name === 'importFromFile' || name === 'importImageFile') && !rejoin) {
    let payload: ClientFilePayload;
    try { payload = readClientFile(String(args[0]), String(args[1]), name); } catch (error) { return Promise.reject(error); }
    return connection.request('fn', IMPORT_CLIENT_FILE, [name, String(args[0]), args[1], payload, args[2]]) as Promise<T>;
  }
  const sent = args.slice();
  for (const at of PATH_ARGS[name]) if (typeof sent[at] === 'string') sent[at] = resolve(sent[at] as string);
  if (name === 'importManagedFiles' && Array.isArray(sent[0])) {
    sent[0] = (sent[0] as Array<{ filePath: string }>).map(file => ({ ...file, filePath: resolve(file.filePath) }));
  }
  if (!rejoin) {
    // A whole operation the old owner handed over never ran: it goes to the next owner (multi-user mode only sends
    // `owner_handoff`). A whole operation whose outcome is unknown is not sent again here.
    const handedOver = ownerRejoinFor(connection);
    const send = (via: OwnerConnection, resends: number): Promise<T> => (via.request('fn', name, sent) as Promise<T>).catch(async (error: unknown) => {
      if (!handedOver || !isOwnerHandoff(error) || resends >= HANDOFF_RESENDS) throw error;
      await untilOwnerClosed(via);
      await untilCallEnds(name, args, (ownerRejoinFor(via) ?? handedOver)()).catch((e: unknown) => {
        if (!(e instanceof OperationError && e.code === 'owner_unavailable')) throw e;
      });
      const next = ownerConnectionFor(engine);
      // This process became the owner: nothing was sent, so the caller's retry runs it in process.
      if (!next || next.closed) throw ownerGone(name, via.hello.pid, false);
      requireOwnerJournal(next, name);
      return send(next, resends + 1);
    });
    return send(connection, 0);
  }
  // The owner has gone: run the election again. A new owner elsewhere takes the operation; when this process became
  // the owner it cannot run it from here, so it is not sent and the caller's retry runs it in process. An election
  // that fails for its own reason (a store that will not open, a disconnect that won) ends the operation with that
  // error, and a caller that cancels or passes its deadline during the election stops waiting at once.
  const elected = untilCallEnds(name, args, rejoin()).catch((error: unknown) => {
    if (!(error instanceof OperationError && error.code === 'owner_unavailable')) throw error;
  });
  return elected.then(() => {
    const next: OwnerConnection | undefined = ownerConnectionFor(engine);
    if (next && !next.closed) { requireOwnerJournal(next, name); return next.request('fn', name, sent) as Promise<T>; }
    throw ownerGone(name, connection.hello.pid, false);
  });
}

/**
 * Sends a registry operation (OWNER_FORWARDED_OPERATIONS) to the owner and returns its result, or returns undefined
 * when `ctx.engine` is not an owner client, or this process became the owner after the old one went away (the caller
 * then runs the handler in process). Notices and log lines the handler gave in the owner are given to `ctx` here.
 */
/** How many times a handed-over operation goes to a next owner before its refusal is the answer. */
const HANDOFF_RESENDS = 5;

export async function forwardOwnerOperation(ctx: OperationContext, name: string, params: Record<string, unknown>, resends = 0): Promise<{ result: unknown } | undefined> {
  const connection = ownerConnectionFor(ctx.engine);
  if (!connection || !OWNER_FORWARDED_OPERATIONS.has(name)) return undefined;
  if (connection.closed) {
    const rejoin = ownerRejoinFor(connection);
    if (!rejoin) return undefined; // the engine's own members give the owner_unavailable refusal
    // The owner went away before this operation was sent: elect again. A new owner elsewhere takes it; when this process
    // won, the caller runs the handler in process. A cancel or deadline during the election ends the call at once, and an
    // election that fails for its own reason ends it with that error.
    const stillWanted = callEndCheck(name, []);
    await untilCallEnds(name, [], rejoin()).catch((error: unknown) => {
      if (!(error instanceof OperationError && error.code === 'owner_unavailable')) throw error;
    });
    stillWanted();
    if (ownerConnectionFor(ctx.engine) === connection) throw ownerGone(name, connection.hello.pid, false);
    return forwardOwnerOperation(ctx, name, params, resends);
  }
  const record = ctx as unknown as Record<string, unknown>;
  if (ctx.remote !== false || UNFORWARDED_AUTHORITY_KEYS.some(key => record[key] !== undefined)) {
    throw ownerIpcRefusal(name, 'only the trusted local CLI\'s operations are sent to the brain owner');
  }
  refuseUntrustedCaller(name);
  requireOwnerJournal(connection, name);
  const context: ForwardedOperationContext = {};
  for (const key of FORWARDED_CONTEXT_KEYS) if (ctx[key] !== undefined) (context as Record<string, unknown>)[key] = ctx[key];
  const answer = await (connection.request('fn', OWNER_RUN_OPERATION, [name, params, context]) as Promise<ForwardedOperationResult>)
    .catch(async (error: unknown): Promise<ForwardedOperationResult | { rerun: true }> => {
      // Multi-user mode: an operation the old owner handed over never ran; a journaled write that carries its request id
      // (put_page) is answered by the write journal when it is sent again with that id, so it never writes twice.
      const journaled = typeof params.request_id === 'string' && params.request_id !== '' && rustMultiuserFromEnv()
        && connection.closed && error instanceof OperationError && error.code === 'owner_unavailable'
        && (error as { reason?: unknown }).reason === 'outcome_unknown';
      if ((!isOwnerHandoff(error) && !journaled) || resends >= HANDOFF_RESENDS) throw error;
      await untilOwnerClosed(connection);
      return { rerun: true };
    });
  if ('rerun' in answer) return forwardOwnerOperation(ctx, name, params, resends + 1);
  for (const notice of answer.notices) ctx.emitNotice?.(notice);
  for (const [level, message] of answer.logs) ctx.logger?.[level]?.(message);
  return { result: answer.result };
}
