import { expect, test } from 'bun:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net, { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PERSISTENCE_IPC_MAX_CONNECTIONS, PersistenceIpcTransportError,
  requestPersistenceOperation, startPersistenceIpcServer, type PersistenceIpcRequest,
} from '../src/core/persistence/ipc.ts';

test('incomplete IPC frames exhaust only the bounded connection slots and release them at the read deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-ipc-backpressure-'));
  const socketPath = join(dir, 'write.sock');
  const brainId = '10000000-0000-4000-8000-000000000001';
  let dispatches = 0;
  const binding = await startPersistenceIpcServer(socketPath, {
    brainId, dispatch: async () => { dispatches++; return { status: 'accepted' }; },
  });
  expect(binding).not.toBeNull();
  const sockets: Socket[] = [];
  const closed: Promise<unknown>[] = [];
  const request: PersistenceIpcRequest = {
    version: 1, kind: 'operation', brain_id: brainId, operation: 'put_page',
    params: { request_id: '20000000-0000-4000-8000-000000000001', slug: 'example', content: 'Example' },
    registration: { id: '30000000-0000-4000-8000-000000000001', credential: 'a'.repeat(64), lane: 'cli' },
    routing: { source: null, cwd: dir },
  };
  try {
    for (let i = 0; i < PERSISTENCE_IPC_MAX_CONNECTIONS; i++) {
      const socket = net.createConnection(socketPath);
      sockets.push(socket);
      closed.push(once(socket, 'close'));
      await once(socket, 'connect');
      socket.write('{"version":1');
    }
    await expect(requestPersistenceOperation(socketPath, request, 1000))
      .rejects.toBeInstanceOf(PersistenceIpcTransportError);
    expect(dispatches).toBe(0);
    expect(sockets.every(socket => !socket.destroyed)).toBe(true);

    await Promise.all(closed);
    expect(sockets.every(socket => socket.destroyed)).toBe(true);
    expect(dispatches).toBe(0);
    expect(await requestPersistenceOperation(socketPath, request, 1000)).toEqual({ status: 'accepted' });
    expect(dispatches).toBe(1);
  } finally {
    for (const socket of sockets) socket.destroy();
    const serverClosed = binding!.server.listening ? once(binding!.server, 'close') : Promise.resolve();
    binding!.close();
    await serverClosed;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
