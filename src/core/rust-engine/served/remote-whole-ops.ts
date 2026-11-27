/**
 * Remote writes over the served wire (multi-user lane L3; design docs/designs/rust-engine/multi-user-server.md, "Remote
 * writes over the served wire"; approach (a), ruled 2026-11-26).
 *
 * An agent-facing (remote) caller of a served client sends a write as ONE whole operation (`runOperation`), never as
 * single engine members: the brain server then runs the operation's own handler, the same contract as in process, with
 * `ctx.remote` true and the remote caller mark on, under the access record B3 proved for the connection. Remote single
 * member writes stay refused (owner-ipc/routes.ts OWNER_IPC_REMOTE_READS).
 *
 * Who may write what:
 *  - Only the operations of REMOTE_WHOLE_OPERATIONS cross; the server refuses any other whole operation of a remote
 *    caller before it decodes its parameters.
 *  - Until per-user access lifts (ruling A1), only the brain owner's floor (an owner server token, or the local owner)
 *    may send one: any other principal is refused, so a remote whole operation never runs on a record or an authority a
 *    client built for someone else.
 *  - For the owner's floor the caller's grant the client sends (`auth`) is a narrowing claim, as the access record is
 *    (B3): it can only take scopes away, and the server checks the operation's scope against it again.
 *  - A grant that names a member credential's principal (the owner's floor serving a member, an HTTP MCP server say)
 *    runs only as the store has that credential: served/remote-claim.ts checks it before anything runs.
 *  - The client strips the bearer token from the grant it sends.
 *  - One operation crosses in one parameter form only (REMOTE_WHOLE_PARAM_FORMS): request_tools, as a surface persist.
 * Fencing and replay: the owner's persistence journal and claim fences, unchanged; a journaled operation reuses the wire
 * request id (served/session.ts), so a retry after a restart is answered by the journal's own receipt, never a second write.
 */
import { opError, type Operation, type OperationContext } from '../../ops/contract.ts';
import type { McpSurface } from '../../../mcp/surface.ts';
import { operationScopesAllowed } from '../../scope.ts';
import { ownerIpcRefusal } from '../owner-ipc/routes.ts';
import { OWNER_RUN_OPERATION } from '../owner-ipc/forwarded-names.ts';

/**
 * The closed list: each remote whole operation and the served parity file that proves it on both multi-user routes
 * (test/rust-served-remote-whole-ops.test.ts checks every file is a `served` row of test/engine-parity/rust-served-set.tsv).
 */
export const REMOTE_WHOLE_OPERATIONS: Readonly<Record<string, string>> = {
  put_page: 'test/engine-parity/credential-grant-writes.test.ts',
  // A soft delete only: purge-params.ts refuses a remote purge or retention before the delete runs.
  delete_page: 'test/engine-parity/served-remote-writes.test.ts',
  add_tag: 'test/engine-parity/served-remote-writes.test.ts',
  remove_tag: 'test/engine-parity/served-remote-writes.test.ts',
  add_timeline_entry: 'test/engine-parity/timeline-add.test.ts',
  add_link: 'test/engine-parity/served-remote-writes.test.ts',
  remove_link: 'test/engine-parity/served-remote-writes.test.ts',
  remember: 'test/engine-parity/served-remote-writes.test.ts',
  forget: 'test/engine-parity/served-remote-writes.test.ts',
  restore_page: 'test/engine-parity/served-remote-writes.test.ts',
  revert_version: 'test/engine-parity/page-mutation-reads.test.ts',
  edit_page: 'test/engine-parity/served-remote-writes.test.ts',
  takes_add: 'test/engine-parity/takes-prepare.test.ts',
  takes_update: 'test/engine-parity/takes-prepare.test.ts',
  takes_supersede: 'test/engine-parity/takes-prepare.test.ts',
  takes_resolve: 'test/engine-parity/takes-prepare.test.ts',
  // Local-only: the MCP dispatch refuses it for every remote caller before it reaches a client; listed so an in-process
  // caller that runs the handler with a remote context (the takes fence path) answers as on the other engines.
  takes_remove: 'test/engine-parity/takes-prepare.test.ts',
  // Ruled 2026-11-26 (option A): a caller's own queued write, and the other remote page writes.
  cancel_write_request: 'test/engine-parity/write-request-cancel.test.ts',
  capture: 'test/engine-parity/plain-member-writes.test.ts',
  put_pages: 'test/engine-parity/remote-links.test.ts',
  // Ruled 2026-11-27: a read-scope operation marked `mutating` (test/rust-served-remote-whole-ops.test.ts names it), and
  // only in its persist form (REMOTE_WHOLE_PARAM_FORMS): it writes the caller's own OAuth client row and its audit row.
  request_tools: 'test/engine-parity/request-tools-persist.test.ts',
};

/**
 * Operations that cross whole only in one form of their parameters (for the caller's claimed grant); any other form runs
 * on the client, as before. request_tools crosses only as the persist `{surface}` without `tools`, for a grant with an
 * OAuth client id: the listing and descriptor forms read the operation registry in the client process, and the stdio
 * session widen (no client id) changes the client's own session. A `{surface, tools}` call runs on the client and sends
 * its inner persist whole (the handler calls the registered, wrapped handler).
 */
export const REMOTE_WHOLE_PARAM_FORMS: Readonly<Record<string, (params: Record<string, unknown>, auth: Record<string, unknown> | null) => boolean>> = {
  request_tools: (params, auth) => params.surface !== undefined && params.tools === undefined
    && typeof auth?.clientId === 'string' && auth.clientId !== '',
};

/** True when `name` is a whole operation a remote caller may send over the served wire. */
export function remoteWholeOperation(name: unknown): name is string {
  return typeof name === 'string' && Object.hasOwn(REMOTE_WHOLE_OPERATIONS, name);
}

/** True when operation `name` with `params`, for the caller's claimed grant `auth`, crosses whole over the served wire. */
export function remoteWholeOperationForm(name: unknown, params: unknown, auth: unknown): boolean {
  if (!remoteWholeOperation(name)) return false;
  const form = REMOTE_WHOLE_PARAM_FORMS[name];
  if (!form) return true;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const grant = auth && typeof auth === 'object' && !Array.isArray(auth) ? auth as Record<string, unknown> : null;
  return form(params as Record<string, unknown>, grant);
}

/** True for a served client (no store of its own) whose brain server runs multi-user (its hello lists `multi_writer`). */
export function servedMultiuserClient(engine: unknown): boolean {
  const caps = (engine as { capabilities?: ReadonlySet<string> } | null)?.capabilities;
  return !!caps && caps.has('served') && caps.has('multi_writer');
}

/** The remote caller's grant a client sends as its narrowing claim: the AuthInfo without its bearer token. */
export function claimedAuth(ctx: OperationContext): Record<string, unknown> | null {
  const auth = (ctx as { auth?: Record<string, unknown> }).auth;
  if (!auth || typeof auth !== 'object') return null;
  const { token: _token, ...rest } = auth;
  return rest;
}

/**
 * The context fields a remote whole operation carries besides the claim (plain data only). `surfaceCeiling` (the MCP
 * server's surface ceiling, read by request_tools) is a narrowing claim: the brain server has no ceiling of its own
 * ('full'), so the claim can only lower it, and a value that is not a surface name is refused.
 */
export const REMOTE_CONTEXT_KEYS = ['sourceId', 'admissionOrigin', 'localFederatedSourceIds', 'agentLabel', 'transport', 'takesHoldersAllowList', 'surfaceCeiling'] as const;

/** The surface names a claimed `surfaceCeiling` may hold (mcp/surface.ts McpSurface). */
const SURFACE_CEILINGS: ReadonlySet<string> = new Set(['verbs', 'starter', 'full'] satisfies McpSurface[]);

/** True for a call of `runOperation` (args `[name, params, context, { auth }]`) whose operation and form are on the closed list. */
export function remoteWholeOperationCall(kind: unknown, member: unknown, args: unknown): boolean {
  return kind === 'fn' && member === OWNER_RUN_OPERATION && Array.isArray(args)
    && remoteWholeOperationForm(args[0], args[1], (args[3] as { auth?: unknown } | null | undefined)?.auth);
}

/**
 * The client's last step for a remote whole operation whose answer needs state in the caller's process: request_tools
 * runs the caller's tools/list_changed hook after a persist the brain server ran, as the in-process persist does.
 */
export async function finishRemoteWholeOperation(name: string, ctx: OperationContext, result: unknown): Promise<unknown> {
  const answer = result as { persisted?: unknown; surface?: unknown } | null;
  if (name !== 'request_tools' || answer?.persisted !== true || typeof answer.surface !== 'string') return result;
  const { persistedSurfaceAnswer } = await import('../../ops/request-tools.ts');
  return persistedSurfaceAnswer(ctx, answer.surface);
}

/**
 * The context a remote whole operation runs with on the brain server: `auth` from the caller's grant (a narrowing claim
 * of the owner's floor; served/session.ts admits no other principal), the plain context keys, and nothing else. Refuses
 * an operation off the closed list, a claim that is not a grant, and a grant whose scopes do not allow the operation.
 */
export function remoteOperationContext(name: string, op: Operation, context: unknown, claim: unknown): Record<string, unknown> {
  if (!remoteWholeOperation(name)) throw ownerIpcRefusal(name, 'a remote caller\'s whole operation is not run by the brain owner');
  const ceiling = (context as Record<string, unknown> | null)?.surfaceCeiling;
  if (ceiling !== undefined && !(typeof ceiling === 'string' && SURFACE_CEILINGS.has(ceiling))) {
    throw ownerIpcRefusal(name, 'its claimed surface ceiling is not a surface name');
  }
  const auth = (claim as { auth?: unknown } | null)?.auth;
  // A remote caller with no grant (an MCP stdio client of the owner's own process) runs with none, as in process.
  if (auth === null || auth === undefined) return contextKeys(context);
  if (typeof auth !== 'object' || Array.isArray(auth) || !Array.isArray((auth as { scopes?: unknown }).scopes)
    || !(auth as { scopes: unknown[] }).scopes.every(s => typeof s === 'string')) {
    throw ownerIpcRefusal(name, 'its caller grant is not an object with a scope list');
  }
  const scopes = (auth as { scopes: string[] }).scopes;
  if (!operationScopesAllowed(scopes, op)) {
    throw opError('permission_denied', `${name} needs the ${op.scope ?? 'read'} scope, which the caller's grant does not hold, so nothing ran.`,
      'Use a credential whose grant holds the scope the operation needs.', { reason: 'scope_missing', detail: `member=${name} via=served ran=false written=nothing` });
  }
  return { ...contextKeys(context), auth };
}

/** The plain context keys of a remote whole operation (REMOTE_CONTEXT_KEYS), nothing else. */
function contextKeys(context: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of REMOTE_CONTEXT_KEYS) {
    const value = (context as Record<string, unknown> | null)?.[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
