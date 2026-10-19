/**
 * D-24 (GBRA-131, #6989): a persistence IPC reply too large to frame keeps the write's request ID.
 *
 * Protects: when the owner dispatched a mutation and its result exceeds the local frame limit, the
 * `response_too_large` error the client receives names the mutation's request_id (and its receipt when the result
 * held one), so the advice "inspect it by its request_id" is actionable; the client also fills the ID in when an
 * older owner omits it. The error stays an error (no success is claimed). A read's oversized reply carries no request ID.
 * Fails when: the owner's catch frames the generic error and drops the ID the client generated (local-client.ts
 * allocates it), leaving advice that requires an ID absent from the reply.
 * Seams: a real IPC listener with a stub dispatch returning a committed receipt plus an oversized payload.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationError } from '../src/core/ops/contract.ts';
import { PERSISTENCE_IPC_MAX_BYTES, requestPersistenceOperation, startPersistenceIpcServer, type PersistenceIpcBinding,
  type PersistenceIpcRequest } from '../src/core/persistence/ipc.ts';

const BRAIN = '10000000-0000-4000-8000-000000000001';
const ID = '20000000-0000-4000-8000-000000000069';
const REGISTRATION = { id: '30000000-0000-4000-8000-000000000001', credential: 'a'.repeat(64), lane: 'cli' as const };
const dirs: string[] = [];
const bindings: PersistenceIpcBinding[] = [];
const servers: net.Server[] = [];

function socketPath() {
  const dir = mkdtempSync(join(tmpdir(), 'gb-ipc-6989-'));
  dirs.push(dir);
  return join(dir, 'write.sock');
}
const request = (operation: string, params: Record<string, unknown>): PersistenceIpcRequest =>
  ({ version: 1, kind: 'operation', brain_id: BRAIN, operation, params, registration: REGISTRATION, routing: { source: null, cwd: tmpdir() } }) as PersistenceIpcRequest;
const receipt = { request_id: ID, state: 'committed', retry_after_ms: null };
const oversized = { write_request: receipt, page: { compiled_truth: 'x'.repeat(PERSISTENCE_IPC_MAX_BYTES) } };

async function bind(path: string, dispatch: (request: PersistenceIpcRequest) => Promise<unknown>) {
  const binding = await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch });
  expect(binding).not.toBeNull();
  bindings.push(binding!);
}
const rejection = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

afterEach(async () => {
  for (const binding of bindings.splice(0)) {
    const closed = binding.server.listening ? once(binding.server, 'close') : Promise.resolve();
    binding.close();
    await closed;
  }
  for (const server of servers.splice(0)) if (server.listening) { const closed = once(server, 'close'); server.close(); await closed; }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('D-24 persistence IPC response_too_large keeps the write identity (#6989)', () => {
  test('a mutation whose result is too large to frame: the error names its request_id and receipt', async () => {
    const path = socketPath();
    await bind(path, async () => oversized);
    const error = await rejection(requestPersistenceOperation(path, request('put_page', { request_id: ID, slug: 'notes/acme-example', content: 'x' })));
    expect(error).toBeInstanceOf(OperationError);
    const wire = (error as OperationError).toJSON() as Record<string, unknown>;
    expect({ code: wire.code, request_id: wire.request_id, receipt: (wire.write_request as { request_id?: string } | undefined)?.request_id })
      .toEqual({ code: 'response_too_large', request_id: ID, receipt: ID });
  });

  test('a mutation result with no receipt still carries the request_id', async () => {
    const path = socketPath();
    await bind(path, async () => ({ page: oversized.page }));
    const error = await rejection(requestPersistenceOperation(path, request('put_page', { request_id: ID, slug: 'notes/acme-example', content: 'x' })));
    const wire = (error as OperationError).toJSON() as Record<string, unknown>;
    expect({ code: wire.code, request_id: wire.request_id, receipt: wire.write_request }).toEqual({ code: 'response_too_large', request_id: ID, receipt: undefined });
  });

  test('a read whose result is too large carries no invented request identity', async () => {
    const path = socketPath();
    await bind(path, async () => oversized);
    const error = await rejection(requestPersistenceOperation(path, request('get_page', { slug: 'notes/acme-example' })));
    const wire = (error as OperationError).toJSON() as Record<string, unknown>;
    expect({ code: wire.code, request_id: wire.request_id, receipt: wire.write_request }).toEqual({ code: 'response_too_large', request_id: undefined, receipt: undefined });
  });

  test('an older owner that omits the ID: the client fills in the request_id it sent', async () => {
    const path = socketPath();
    const server = net.createServer(socket => {
      socket.once('data', () => socket.end(JSON.stringify({ version: 1, ok: false, error: { error: 'response_too_large', message: 'Persistence response exceeds the local transport limit.' } }) + '\n'));
    });
    servers.push(server);
    server.listen(path);
    await once(server, 'listening');
    const error = await rejection(requestPersistenceOperation(path, request('put_page', { request_id: ID, slug: 'notes/acme-example', content: 'x' })));
    expect(((error as OperationError).toJSON() as Record<string, unknown>).request_id).toBe(ID);
  });
});
