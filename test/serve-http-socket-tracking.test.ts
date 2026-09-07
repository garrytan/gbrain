import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { trackServerSockets } from '../src/commands/serve-http.ts';

// The shipped leak: `serve --http` tracked every accepted socket in a Set for
// shutdown teardown and dropped it only on the socket's 'close' event. Bun's
// node:http never emits 'close' (nor 'end'/'error') on server-side sockets, and
// the socket keeps reporting open/writable after the peer is gone, so every
// connection stayed tracked forever. Each kubelet health probe is a fresh TCP
// connection, so a probe-only pod grew ~9 MB/h until OOMKilled. The lifecycle
// tests use a FakeHttpServer whose 'close' fires synchronously, which is why
// they never saw it — this file exercises a REAL server on the current runtime.

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function listen(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_req, res) => res.end('ok'));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/health` };
}

/**
 * Let the runtime release dropped sockets; tracking must not out-live them.
 * Socket teardown and GC are asynchronous, so poll until `done` holds (or a
 * generous deadline passes and the assertion reports the real count).
 */
async function settle(done: () => boolean = () => false): Promise<void> {
  const deadline = Date.now() + 3000;
  do {
    (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
    await new Promise((r) => setTimeout(r, 25));
    if (done()) return;
  } while (Date.now() < deadline);
}

describe('trackServerSockets on a real http.Server', () => {
  test('releases connections the peer has closed', async () => {
    const { server, url } = await listen();
    const tracker = trackServerSockets(server);

    // node:http client, not `fetch`: Bun's in-process fetch pool can keep one
    // server-side socket reachable for a while, which would mask what the
    // tracker does. Real probes come from another process (kubelet).
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve, reject) => {
        http.get(url, { headers: { Connection: 'close' } }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
      });
    }
    await settle(() => tracker.size() === 0);

    expect(tracker.size()).toBe(0);
  });

  test('keeps a live keep-alive connection so shutdown can sever it', async () => {
    const { server, url } = await listen();
    const tracker = trackServerSockets(server);

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve, reject) => {
      http.get(url, { agent }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
    });
    await settle();

    // The pooled socket is still open on both ends: it must still be tracked,
    // otherwise `server.close()` would hang on it at shutdown.
    expect(tracker.size()).toBe(1);

    tracker.destroyAll();
    await settle(() => tracker.size() === 0);
    expect(tracker.size()).toBe(0);
    agent.destroy();
  });
});
