/**
 * Whole operations a client of a Rust brain's owner sends as one request. A write path that opens its own
 * transaction (the file and content imports) cannot run in a client, because transactions do not cross the owner
 * socket (routes.ts). Its entry point calls `forwardWholeOperation` before it touches the engine; on a client engine
 * the whole operation runs inside the owner, transaction included, and its result or error comes back as the
 * in-process call would give it.
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
 * The owner side table is owner-ops.ts; it is kept apart so the import modules can call this one without a cycle.
 */
import { resolve } from 'node:path';
import { currentSubmissionAuthority } from '../../minions/submission-authority.ts';
import { currentVerifiedLocalWriter } from '../../persistence/identity.ts';
import type { Notice } from '../../agent-output.ts';
import type { OperationContext } from '../../ops/contract.ts';
import { capabilityMissing } from '../errors.ts';
import { ownerConnectionFor, ownerRecoveryFor, rustOwnerServesPersistence, type OwnerConnection } from './client.ts';
import { ownerIpcRefusal } from './routes.ts';

export type WholeOperationName = 'importFromContent' | 'importFromFile' | 'importImageFile' | 'importManagedFiles';

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
  const caller = currentSubmissionAuthority();
  if (caller && caller.kind !== 'application' || currentVerifiedLocalWriter()?.remote) {
    throw ownerIpcRefusal(name, 'a remote caller\'s whole operation is not sent to the brain owner');
  }
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
};

/**
 * Sends a whole operation to the owner, or returns undefined when `engine` is not an owner client (the caller then
 * runs it in process). The arguments are the operation's own, without the engine.
 */
export function forwardWholeOperation<T>(engine: object, name: WholeOperationName, args: unknown[]): Promise<T> | undefined {
  const connection = ownerConnectionFor(engine);
  if (!connection) return undefined;
  const recover = connection.closed ? ownerRecoveryFor(engine) : undefined;
  // The owner went away before this operation was sent: elect again, then send it to the new owner, or run it here
  // when this process won (owner-ops.ts holds the entry points; it is loaded late to keep the import cycle open).
  if (recover) {
    return recover().then(async () => {
      const again = ownerConnectionFor(engine) === connection ? undefined : forwardWholeOperation<T>(engine, name, args);
      if (again) return again;
      if (ownerConnectionFor(engine) === connection) throw ownerIpcRefusal(name, 'the brain owner went away and no new owner took over');
      const { ownerWholeOperations } = await import('./owner-ops.ts');
      return ownerWholeOperations()[name](engine as never, ...args) as Promise<T>;
    });
  }
  try { refuseUntrustedCaller(name); requireOwnerJournal(connection, name); }
  catch (error) { return Promise.reject(error); }
  const sent = args.slice();
  for (const at of PATH_ARGS[name]) if (typeof sent[at] === 'string') sent[at] = resolve(sent[at] as string);
  if (name === 'importManagedFiles' && Array.isArray(sent[0])) {
    sent[0] = (sent[0] as Array<{ filePath: string }>).map(file => ({ ...file, filePath: resolve(file.filePath) }));
  }
  return connection.request('fn', name, sent) as Promise<T>;
}

/**
 * Sends a registry operation (OWNER_FORWARDED_OPERATIONS) to the owner and returns its result, or returns undefined
 * when `ctx.engine` is not an owner client, or this process became the owner after the old one went away (the caller
 * then runs the handler in process). Notices and log lines the handler gave in the owner are given to `ctx` here.
 */
export async function forwardOwnerOperation(ctx: OperationContext, name: string, params: Record<string, unknown>): Promise<{ result: unknown } | undefined> {
  const connection = ownerConnectionFor(ctx.engine);
  if (!connection || !OWNER_FORWARDED_OPERATIONS.has(name)) return undefined;
  if (connection.closed) {
    const recover = ownerRecoveryFor(ctx.engine);
    if (!recover) return undefined; // the engine's own members give the owner_unavailable refusal
    await recover();
    if (ownerConnectionFor(ctx.engine) === connection) throw ownerIpcRefusal(name, 'the brain owner went away and no new owner took over');
    return forwardOwnerOperation(ctx, name, params);
  }
  const record = ctx as unknown as Record<string, unknown>;
  if (ctx.remote !== false || UNFORWARDED_AUTHORITY_KEYS.some(key => record[key] !== undefined)) {
    throw ownerIpcRefusal(name, 'only the trusted local CLI\'s operations are sent to the brain owner');
  }
  refuseUntrustedCaller(name);
  requireOwnerJournal(connection, name);
  const context: ForwardedOperationContext = {};
  for (const key of FORWARDED_CONTEXT_KEYS) if (ctx[key] !== undefined) (context as Record<string, unknown>)[key] = ctx[key];
  const answer = await connection.request('fn', OWNER_RUN_OPERATION, [name, params, context]) as ForwardedOperationResult;
  for (const notice of answer.notices) ctx.emitNotice?.(notice);
  for (const [level, message] of answer.logs) ctx.logger?.[level]?.(message);
  return { result: answer.result };
}
