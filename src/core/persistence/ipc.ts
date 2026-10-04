/** Dedicated, bounded local persistence transport. Hook IPC keeps its own small frame budget. */
import net, { type Server, type Socket } from 'node:net';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { resolveSocketPathForConfig, socketHasLiveListener } from '../context/resolve-ipc.ts';
import { isWriteErrorCode, isWriteReceipt, isWriteRequestId, publicWriteReceipt } from './types.ts';
import { isPersistenceAdminOperation, PERSISTENCE_ADMIN_OPERATIONS, type PersistenceAdminOperation } from './admin-contract.ts';
import { claimLocalIpcBinding, isWindowsIpcPipe, prepareLocalIpcPath } from '../context/ipc-path.ts';

export const PERSISTENCE_IPC_VERSION = 1;
// Five million content bytes can require six JSON bytes each (e.g. NUL).
// Leave bounded room for frontmatter, credentials, routing, and the envelope.
export const PERSISTENCE_IPC_MAX_BYTES = 32 * 1024 * 1024;
export const PERSISTENCE_IPC_MAX_CONNECTIONS = 8;
export const PERSISTENCE_IPC_OPERATIONS = [
  'put_page', 'capture', 'delete_page', 'restore_page', 'revert_version', 'edit_page',
  'remember', 'forget', 'extract_facts', 'get_write_request', 'list_write_requests', 'cancel_write_request',
  'get_page', 'fetch', 'get_recent_transcripts',
  'list_skills', 'get_skill', 'get_skill_asset', 'list_brain_skillpack',
  'put_skill', 'delete_skill', 'join_brain', 'sync_brain_skills', 'leave_brain',
  'get_skill_policy', 'set_skill_policy', 'get_skill_retention', 'prune_skill_revisions',
  'retain_skill_revision', 'import_skill_proposal',
  'add_tag', 'remove_tag', 'add_timeline_entry', 'takes_add', 'takes_update', 'takes_supersede', 'takes_resolve',
] as const;
export type PersistenceIpcOperation = typeof PERSISTENCE_IPC_OPERATIONS[number];
const OPERATIONS = new Set<string>(PERSISTENCE_IPC_OPERATIONS);
const MUTATIONS = new Set<string>([
  'put_page', 'capture', 'delete_page', 'restore_page', 'revert_version', 'edit_page', 'remember', 'forget', 'extract_facts',
  'put_skill', 'delete_skill', 'import_skill_proposal',
  'add_tag', 'remove_tag', 'add_timeline_entry', 'takes_add', 'takes_update', 'takes_supersede', 'takes_resolve',
]);

export interface PersistenceIpcRegistration {
  id: string;
  credential: string;
  lane: 'cli' | 'stdio';
}

export interface PersistenceIpcRequest {
  version: 1;
  kind: 'operation';
  brain_id: string;
  operation: PersistenceIpcOperation;
  params: Record<string, unknown>;
  registration: PersistenceIpcRegistration;
  /** Client resolves flag/env/dotfile tiers; owner resolves DB tiers using this cwd. */
  routing: { source: string | null; cwd: string };
  /** #5232: the caller's commit wait; sent only to owners advertising `write_wait`. */
  write_wait_ms?: number;
}

export interface PersistenceIpcCapabilities {
  version: 1;
  brain_id: string;
  operations: readonly PersistenceIpcOperation[];
  max_frame_bytes: number;
  /** Optional for protocol compatibility with owners predating local administration. */
  administration?: readonly PersistenceAdminOperation[];
  /** #5232: the owner honors `write_wait_ms` on operation requests. */
  write_wait?: true;
}

export interface PersistenceIpcAdminRequest {
  version: 1;
  kind: 'administration';
  brain_id: string;
  operation: PersistenceAdminOperation;
  params: Record<string, unknown>;
  registration: PersistenceIpcRegistration;
}

/** #5401: the resident's queued text-projection backlog. Counts only, never identifiers. */
export interface PersistenceProjectionStatus {
  pending: number;
  failed: number;
  oldest_age_seconds: number | null;
}

export interface PersistenceIpcProvider {
  brainId: string;
  /** Read-only and credential-free, like capabilities: serves doctor while this process holds the datastore. */
  projectionStatus?(): Promise<PersistenceProjectionStatus>;
  /** Authenticate registration against the DB, reconstruct context, then dispatch through the registry. */
  dispatch(request: PersistenceIpcRequest): Promise<unknown>;
  /** Verify the live CLI registration again; never accept stdio or a wire trust assertion. */
  administer?(request: PersistenceIpcAdminRequest): Promise<unknown>;
}

export interface PersistenceIpcBinding {
  server: Server;
  socketPath: string;
  /** Stops admission. In-flight durable work is drained by the owner's persistence lifecycle. */
  close(): void;
}

export function isPersistenceIpcOperation(value: unknown): value is PersistenceIpcOperation {
  return typeof value === 'string' && OPERATIONS.has(value);
}

export function isPersistenceIpcMutation(value: string): boolean {
  return MUTATIONS.has(value);
}

export function persistenceSocketPathForConfig(config: Parameters<typeof resolveSocketPathForConfig>[0]): string | null {
  return resolveSocketPathForConfig(config, 'persistence');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

export function isPersistenceIpcRegistration(value: unknown): value is PersistenceIpcRegistration {
  return record(value) && exactKeys(value, ['id', 'credential', 'lane'])
    && isWriteRequestId(value.id)
    && typeof value.credential === 'string' && /^[a-f0-9]{64}$/.test(value.credential)
    && (value.lane === 'cli' || value.lane === 'stdio');
}

const OPERATION_REQUEST_KEYS = ['version', 'kind', 'brain_id', 'operation', 'params', 'registration', 'routing'];
function operationRequest(value: unknown): value is PersistenceIpcRequest {
  if (!record(value) || !(exactKeys(value, OPERATION_REQUEST_KEYS) || exactKeys(value, [...OPERATION_REQUEST_KEYS, 'write_wait_ms']))) return false;
  if (value.write_wait_ms !== undefined && !(typeof value.write_wait_ms === 'number'
    && Number.isSafeInteger(value.write_wait_ms) && value.write_wait_ms >= 0)) return false;
  if (value.version !== 1 || value.kind !== 'operation' || !isWriteRequestId(value.brain_id)
    || !isPersistenceIpcOperation(value.operation) || !record(value.params)
    || !isPersistenceIpcRegistration(value.registration) || !record(value.routing)
    || !exactKeys(value.routing, ['source', 'cwd'])) return false;
  if (!(value.routing.source === null || typeof value.routing.source === 'string' && /^(?:[a-z0-9-]{1,32}|__all__)$/.test(value.routing.source))) return false;
  if (typeof value.routing.cwd !== 'string' || value.routing.cwd.length > 32_768 || !isAbsolute(value.routing.cwd)) return false;
  // Wire mutations always have an ID BEFORE bytes are sent. Never allocate
  // an ID on the listener: a lost acknowledgment must be replayable.
  return !isPersistenceIpcMutation(value.operation) || isWriteRequestId(value.params.request_id);
}

function administrationRequest(value: unknown): value is PersistenceIpcAdminRequest {
  return record(value) && exactKeys(value, ['version', 'kind', 'brain_id', 'operation', 'params', 'registration'])
    && value.version === 1 && value.kind === 'administration' && isWriteRequestId(value.brain_id)
    && isPersistenceAdminOperation(value.operation) && record(value.params)
    && isPersistenceIpcRegistration(value.registration) && value.registration.lane === 'cli';
}

const writerStatusFix = (why: string): Action => readFix(why, { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] });
const ownerVersionsFix = (): Action => writerStatusFix(
  'Shows the running owner, this host and the latest admitter and consumer versions per host, read-only, to spot a CLI and owner on different releases.');
const clientBug = (message: string): OperationError => opError('invalid_params', message,
  'This gbrain build produced a malformed local persistence request, so nothing was sent to the owner. It is a client fault, not a caller mistake: run gbrain doctor --json on this host and report it to the user with the command that failed.',
  { fix: readFix('Checks this installation and its persistence owner without changing anything.', { argv: ['gbrain', 'doctor', '--json'] }) });

function publicError(error: unknown): Record<string, unknown> {
  if (error instanceof OperationError) return error.toJSON();
  // Never reflect driver errors, SQL, credentials, or private payloads.
  return { error: 'storage_error', message: 'The persistence owner could not complete this request.' };
}

function responseFrame(value: unknown): string {
  const frame = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(frame) > PERSISTENCE_IPC_MAX_BYTES) {
    throw opError('response_too_large', 'Persistence response exceeds the local transport limit.',
      `Nothing larger than ${PERSISTENCE_IPC_MAX_BYTES} bytes crosses the local persistence socket, so this frame was not delivered. A write may still have committed on the owner: inspect it by its request_id (get_write_request, or gbrain write-request on the CLI) before resubmitting; for a read, ask for less (a smaller page, limit or selection).`);
  }
  return frame;
}

/** Bind only when no live listener owns the discovery path. Never displace on timeout. */
export async function startPersistenceIpcServer(
  socketPath: string,
  provider: PersistenceIpcProvider,
): Promise<PersistenceIpcBinding | null> {
  if (!isWriteRequestId(provider.brainId)) throw new Error('Persistence IPC requires a durable brain UUID.');
  const binding = await claimLocalIpcBinding(socketPath);
  if (!binding) return null;
  socketPath = binding.socketPath;
  if (await socketHasLiveListener(socketPath)) { await binding.release(); return null; }
  try {
    // Refuse to remove ordinary files or symlinks from the discovery path.
    if (binding.removeStaleWindowsSocket) binding.removeStaleWindowsSocket();
    else if (!isWindowsIpcPipe(socketPath)) {
      if (!lstatSync(socketPath).isSocket()) throw new Error('Persistence IPC path is not a socket.');
      unlinkSync(socketPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await binding.release(); throw error; }
  }

  const sockets = new Set<Socket>();
  let active = 0;
  let closing = false;
  const server = net.createServer(socket => {
    socket.on('error', () => { /* transport loss never cancels durable work */ });
    if (closing || sockets.size >= PERSISTENCE_IPC_MAX_CONNECTIONS) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let chunks: Buffer[] = [];
    let bytes = 0;
    let handled = false;
    const readTimeout = setTimeout(() => socket.destroy(), 15_000);
    readTimeout.unref();
    socket.once('close', () => clearTimeout(readTimeout));
    socket.on('data', data => {
      const chunk = typeof data === 'string' ? Buffer.from(data) : data;
      if (handled) return;
      bytes += chunk.length;
      if (bytes > PERSISTENCE_IPC_MAX_BYTES) { handled = true; socket.destroy(); return; }
      const newline = chunk.indexOf(10);
      chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
      if (newline === -1) return;
      handled = true; // latch before async dispatch, even if another frame arrives
      clearTimeout(readTimeout);
      const payload = Buffer.concat(chunks).toString('utf8');
      chunks = [];
      void (async () => {
        let admitted = false;
        try {
          const request: unknown = JSON.parse(payload);
          if (record(request) && exactKeys(request, ['version', 'kind']) && request.version === 1 && request.kind === 'capabilities') {
            socket.end(responseFrame({ version: 1, ok: true, result: {
              version: 1, brain_id: provider.brainId, operations: PERSISTENCE_IPC_OPERATIONS,
              max_frame_bytes: PERSISTENCE_IPC_MAX_BYTES,
              ...(provider.administer ? { administration: PERSISTENCE_ADMIN_OPERATIONS } : {}),
              write_wait: true,
            } satisfies PersistenceIpcCapabilities }));
            return;
          }
          if (record(request) && exactKeys(request, ['version', 'kind']) && request.version === 1 && request.kind === 'projection_status') {
            if (!provider.projectionStatus) throw opError('unavailable', 'This owner does not report projection status.',
              'The running persistence owner predates projection status reporting, so the status could not be read; nothing changed. Restart the owner on this gbrain release, or read the owner state with the command in fix instead.',
              { fix: ownerVersionsFix() });
            if (active >= PERSISTENCE_IPC_MAX_CONNECTIONS) throw opError('queue_capacity', 'The persistence listener is at capacity; retry shortly.',
              `All ${PERSISTENCE_IPC_MAX_CONNECTIONS} local persistence connections are busy. This status read changed nothing, so read it again in a few seconds.`);
            active++;
            admitted = true;
            const status = await provider.projectionStatus();
            if (!socket.destroyed) socket.end(responseFrame({ version: 1, ok: true, result: status }));
            return;
          }
          if (!operationRequest(request) && !administrationRequest(request)) throw opError('invalid_params', 'Invalid persistence request envelope.',
            'The owner rejected the request frame as malformed, so nothing was admitted. This usually means the CLI and the running owner are different gbrain releases: compare them with the command in fix, restart the owner on the CLI\'s release, then submit the request again.',
            { fix: ownerVersionsFix() });
          if (request.brain_id !== provider.brainId) throw opError('source_changed', 'The persistence listener now serves a different brain.',
            `This socket's owner serves brain ${provider.brainId}, not the brain ${request.brain_id} the request was built for, so nothing was admitted. Check which brain the command targets (its brain selection) against the owner in fix, then submit the request again.`,
            { fix: writerStatusFix('Shows the brain this host\'s owner serves and its sources, read-only.') });
          if (active >= PERSISTENCE_IPC_MAX_CONNECTIONS) throw opError('queue_capacity', 'The persistence listener is at capacity; retry this request ID.',
            `All ${PERSISTENCE_IPC_MAX_CONNECTIONS} local persistence connections are busy, so this request was not admitted. Submit it again in a few seconds with the same arguments and the same request_id${typeof request.params.request_id === 'string' ? ` (${request.params.request_id})` : ''}; never allocate a replacement ID.`);
          active++;
          admitted = true;
          if (request.kind === 'administration' && !provider.administer) throw opError('unavailable', 'This owner does not support local administration.',
            'The running persistence owner was started without local administration (an older release or a non-CLI owner), so nothing ran. Restart the owner on this gbrain release, or stop it and run the administration command from the gbrain CLI on this host.',
            { fix: ownerVersionsFix() });
          const result = request.kind === 'administration' ? await provider.administer!(request) : await provider.dispatch(request);
          if (!socket.destroyed) socket.end(responseFrame({ version: 1, ok: true, result }));
        } catch (error) {
          if (!socket.destroyed) socket.end(responseFrame({ version: 1, ok: false, error: publicError(error) }));
        } finally {
          if (admitted) active--;
        }
      })();
    });
  });
  let listened = false;
  server.once('close', () => { void binding.release(); });
  const bound = await new Promise<boolean>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    };
    server.once('error', onError);
    server.listen(socketPath, () => {
      listened = true;
      try {
        if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
        server.off('error', onError);
        server.on('error', () => {});
        resolve(true);
      } catch (error) {
        closing = true;
        server.close();
        for (const socket of sockets) socket.destroy();
        reject(error);
      }
    });
  }).catch(async error => { if (!listened) await binding.release(); throw error; });
  if (!bound) { await binding.release(); return null; }
  return {
    server, socketPath,
    close() {
      if (closing) return;
      closing = true;
      server.close(); // own socket only; never blind-unlink a replacement owner
      for (const socket of sockets) socket.destroy();
    },
  };
}

/** No receipt is fabricated when delivery is ambiguous: the durable state is unknown. */
export class PersistenceIpcTransportError extends Error {
  constructor(public sent: boolean, public requestId?: string) {
    super(sent && requestId
      ? `The persistence response was lost. Submission state is unknown for request ${requestId}.`
      : 'The local persistence owner is unavailable.');
    this.name = 'PersistenceIpcTransportError';
  }
  toJSON() {
    return {
      error: 'owner_unavailable', message: this.message,
      ...(this.requestId ? { request_id: this.requestId } : {}),
      submission_status: this.sent ? 'unknown' : 'not_sent',
      suggestion: this.requestId
        ? `Retry the same operation and arguments with request_id ${this.requestId}; do not generate a replacement ID.`
        : this.sent ? 'Inspect writer status and local registrations before repeating administration; the acknowledgment was lost.'
          : 'Restart the persistence owner, then retry.',
    };
  }
}

function remoteOperationError(value: unknown): OperationError {
  if (!record(value) || typeof value.error !== 'string' || typeof value.message !== 'string') {
    throw new Error('Malformed persistence error response.');
  }
  const error = new OperationError(value.error, value.message, typeof value.suggestion === 'string' ? value.suggestion : undefined,
    typeof value.docs === 'string' ? value.docs : undefined);
  if (typeof value.detail === 'string') error.detail = value.detail;
  if (typeof value.protocol_version === 'number') error.protocolVersion = value.protocol_version;
  if (isWriteReceipt(value.write_request)) error.writeRequest = publicWriteReceipt(value.write_request);
  if (isWriteErrorCode(value.write_error)) error.writeError = value.write_error;
  return error;
}

/** One bounded exchange. No automatic reconnect or replay after any request bytes are sent. */
async function exchange(socketPath: string, request: unknown, timeoutMs: number, requestId?: string): Promise<unknown> {
  const frame = responseFrame(request);
  try { socketPath = prepareLocalIpcPath(socketPath); }
  catch { throw new PersistenceIpcTransportError(false, requestId); }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let sent = false;
    let done = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const settle = (error?: Error, result?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const lost = () => settle(new PersistenceIpcTransportError(sent, requestId));
    const timer = setTimeout(lost, timeoutMs);
    socket.once('error', lost);
    socket.once('close', () => { if (!done) lost(); });
    socket.once('connect', () => {
      sent = true; // partial writes are ambiguous too
      socket.write(frame);
    });
    socket.on('data', data => {
      const chunk = typeof data === 'string' ? Buffer.from(data) : data;
      if (done) return;
      bytes += chunk.length;
      if (bytes > PERSISTENCE_IPC_MAX_BYTES) { lost(); return; }
      const newline = chunk.indexOf(10);
      chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
      if (newline === -1) return;
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!record(value) || value.version !== 1 || typeof value.ok !== 'boolean') { lost(); return; }
        if (value.ok) settle(undefined, value.result);
        else settle(remoteOperationError(value.error));
      } catch { lost(); }
    });
  });
}

export async function requestPersistenceCapabilities(socketPath: string, timeoutMs = 2_000): Promise<PersistenceIpcCapabilities> {
  const value = await exchange(socketPath, { version: 1, kind: 'capabilities' }, timeoutMs);
  if (!record(value) || value.version !== 1 || !isWriteRequestId(value.brain_id)
    || !Array.isArray(value.operations) || !value.operations.every(isPersistenceIpcOperation)
    || value.administration !== undefined && (!Array.isArray(value.administration) || !value.administration.every(isPersistenceAdminOperation))
    || typeof value.max_frame_bytes !== 'number' || !Number.isSafeInteger(value.max_frame_bytes)
    || value.max_frame_bytes < 1 || value.max_frame_bytes > PERSISTENCE_IPC_MAX_BYTES) {
    throw new PersistenceIpcTransportError(false);
  }
  return value as unknown as PersistenceIpcCapabilities;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export async function requestPersistenceProjectionStatus(socketPath: string, timeoutMs = 2_000): Promise<PersistenceProjectionStatus> {
  const value = await exchange(socketPath, { version: 1, kind: 'projection_status' }, timeoutMs);
  if (!record(value) || !count(value.pending) || !count(value.failed)
    || !(value.oldest_age_seconds === null || count(value.oldest_age_seconds))) throw new PersistenceIpcTransportError(false);
  return { pending: value.pending, failed: value.failed, oldest_age_seconds: value.oldest_age_seconds };
}

export async function requestPersistenceOperation(socketPath: string, request: PersistenceIpcRequest, timeoutMs = 30_000): Promise<unknown> {
  if (!operationRequest(request)) throw clientBug('Invalid persistence request envelope.');
  return exchange(socketPath, request, timeoutMs,
    typeof request.params.request_id === 'string' ? request.params.request_id : undefined);
}

export async function requestPersistenceAdministration(socketPath: string, request: PersistenceIpcAdminRequest, timeoutMs = 30_000): Promise<unknown> {
  if (!administrationRequest(request)) throw clientBug('Invalid local administration envelope.');
  return exchange(socketPath, request, timeoutMs,
    typeof request.params.request_id === 'string' ? request.params.request_id : undefined);
}
