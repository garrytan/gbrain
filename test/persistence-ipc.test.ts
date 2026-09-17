import { afterEach, describe, expect, test } from 'bun:test';
import net, { type Server } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationError } from '../src/core/ops/contract.ts';
import {
  PERSISTENCE_IPC_MAX_BYTES, PersistenceIpcTransportError,
  persistenceSocketPathForConfig, requestPersistenceCapabilities, requestPersistenceOperation,
  startPersistenceIpcServer, type PersistenceIpcBinding, type PersistenceIpcRequest,
} from '../src/core/persistence/ipc.ts';

const BRAIN = '10000000-0000-4000-8000-000000000001';
const ID = '20000000-0000-4000-8000-000000000001';
const REGISTRATION = { id: '30000000-0000-4000-8000-000000000001', credential: 'a'.repeat(64), lane: 'cli' as const };
const dirs: string[] = [];
const bindings: PersistenceIpcBinding[] = [];
const rawServers: Server[] = [];

function socketPath() {
  const dir = mkdtempSync(join(tmpdir(), 'gb-write-ipc-'));
  dirs.push(dir);
  return join(dir, 'write.sock');
}

function request(params: Record<string, unknown> = {}): PersistenceIpcRequest {
  return { version: 1, kind: 'operation', brain_id: BRAIN, operation: 'put_page',
    params: { request_id: ID, slug: 'test/page', content: 'hello', ...params },
    registration: REGISTRATION, routing: { source: null, cwd: tmpdir() } };
}

async function bind(path: string, dispatch: (request: PersistenceIpcRequest) => Promise<unknown>) {
  const result = await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch });
  expect(result).not.toBeNull();
  bindings.push(result!);
  return result!;
}

async function rawExchange(path: string, payload: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let result = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(payload));
    socket.on('data', chunk => { result += chunk.toString(); });
    socket.once('end', () => { socket.destroy(); resolve(JSON.parse(result)); });
  });
}

afterEach(async () => {
  for (const binding of bindings.splice(0)) {
    const closed = binding.server.listening ? once(binding.server, 'close') : Promise.resolve();
    binding.close();
    await closed;
  }
  for (const server of rawServers.splice(0)) {
    if (server.listening) { const closed = once(server, 'close'); server.close(); await closed; }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dedicated persistence IPC', () => {
  test('capabilities identify the durable brain and operations; socket is private', async () => {
    const path = socketPath();
    await bind(path, async () => { throw new Error('Capabilities must not dispatch.'); });
    const capabilities = await requestPersistenceCapabilities(path);
    expect(capabilities.brain_id).toBe(BRAIN);
    expect(capabilities.operations).toContain('get_write_request');
    expect(capabilities.operations).toContain('fetch');
    expect(capabilities.max_frame_bytes).toBe(PERSISTENCE_IPC_MAX_BYTES);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(persistenceSocketPathForConfig({ engine: 'pglite', database_path: tmpdir() })).toBe(join(tmpdir(), '.gbrain-persistence.sock'));
  });

  test('preserves explicit source, client cwd, principal credential, and request ID', async () => {
    const path = socketPath();
    let received: PersistenceIpcRequest | undefined;
    await bind(path, async value => { received = value; return { status: 'created', revision: ID }; });
    const sent = request();
    sent.routing.source = 'client-source';
    const result = await requestPersistenceOperation(path, sent);
    expect(received).toEqual(sent);
    expect(result).toEqual({ status: 'created', revision: ID });
  });

  test('five million maximally escaped content bytes fit without truncation', async () => {
    const path = socketPath();
    await bind(path, async value => ({ bytes: Buffer.byteLength(value.params.content as string), tail: (value.params.content as string).slice(-1) }));
    const content = '\0'.repeat(4_999_999) + 'z';
    const result = await requestPersistenceOperation(path, request({ content }));
    expect(result).toEqual({ bytes: 5_000_000, tail: 'z' });
  });

  test('oversized request refuses before delivery', async () => {
    const path = socketPath();
    let calls = 0;
    await bind(path, async () => { calls++; return {}; });
    await expect(requestPersistenceOperation(path, request({ content: 'x'.repeat(PERSISTENCE_IPC_MAX_BYTES) }))).rejects.toThrow('transport limit');
    expect(calls).toBe(0);
  });

  test('unknown operations, forged context, wrong brain and missing IDs cannot dispatch', async () => {
    const path = socketPath();
    let calls = 0;
    await bind(path, async () => { calls++; return {}; });
    for (const malformed of [
      { ...request(), operation: 'execute_sql' },
      { ...request(), remote: false },
      { ...request(), auth: { scopes: ['admin'] } },
      { ...request(), registration: { ...REGISTRATION, principal: 'admin' } },
      { ...request(), params: { slug: 'test/page', content: 'hello' } },
      { ...request(), brain_id: '10000000-0000-4000-8000-000000000002' },
    ]) {
      const response = await rawExchange(path, JSON.stringify(malformed) + '\n');
      expect(response.ok).toBe(false);
    }
    expect(calls).toBe(0);
  });

  test('multiple frames on one connection dispatch at most once', async () => {
    const path = socketPath();
    let calls = 0;
    await bind(path, async () => { calls++; await Bun.sleep(5); return { ok: true }; });
    await rawExchange(path, (JSON.stringify(request()) + '\n').repeat(2));
    expect(calls).toBe(1);
  });

  test('frozen pending envelopes and revision errors survive transport', async () => {
    const path = socketPath();
    await bind(path, async () => {
      const error = new OperationError('unavailable', 'Write queued.', 'Retry the same request ID.');
      error.protocolVersion = 1;
      error.writeError = 'write_pending';
      error.writeRequest = { request_id: ID, state: 'queued', retry_after_ms: 100 };
      throw error;
    });
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected pending error.'); }
    catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).toJSON()).toMatchObject({ error: 'unavailable', protocol_version: 1,
        write_error: 'write_pending', write_request: { request_id: ID, state: 'queued' } });
    }
  });

  test('private driver failures are not reflected', async () => {
    const path = socketPath();
    await bind(path, async () => { throw new Error(`secret=${REGISTRATION.credential}`); });
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected error.'); }
    catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as Error).message).not.toContain(REGISTRATION.credential);
    }
  });

  test('lost acknowledgement is unknown, keeps original ID, and never auto-retries', async () => {
    const path = socketPath();
    let calls = 0;
    const server = net.createServer(socket => {
      socket.once('data', () => { calls++; socket.destroy(); });
    });
    rawServers.push(server);
    server.listen(path);
    await once(server, 'listening');
    try { await requestPersistenceOperation(path, request()); throw new Error('Expected lost response.'); }
    catch (error) {
      expect(error).toBeInstanceOf(PersistenceIpcTransportError);
      expect((error as PersistenceIpcTransportError).toJSON()).toMatchObject({ request_id: ID, submission_status: 'unknown' });
      expect((error as PersistenceIpcTransportError).toJSON()).not.toHaveProperty('write_request');
    }
    expect(calls).toBe(1);
  });

  test('timeout does not abort work already dispatched', async () => {
    const path = socketPath();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let completed = false;
    await bind(path, async () => { await gate; completed = true; return {}; });
    await expect(requestPersistenceOperation(path, request(), 30)).rejects.toMatchObject({ sent: true, requestId: ID });
    finish();
    await Bun.sleep(5);
    expect(completed).toBe(true);
  });

  test('live owners are preserved and close is idempotent', async () => {
    const path = socketPath();
    const first = await bind(path, async () => ({ owner: 'first' }));
    const second = await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({ owner: 'second' }) });
    expect(second).toBeNull();
    expect(await requestPersistenceOperation(path, request())).toEqual({ owner: 'first' });
    const closed = once(first.server, 'close');
    first.close(); first.close();
    await closed;
    await bind(path, async () => ({ owner: 'next' }));
    expect(await requestPersistenceOperation(path, request())).toEqual({ owner: 'next' });
  });

  test('ordinary files at the discovery path are never removed', async () => {
    const path = socketPath();
    writeFileSync(path, 'keep');
    await expect(startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) })).rejects.toThrow('not a socket');
    expect(readFileSync(path, 'utf8')).toBe('keep');
  });
});
