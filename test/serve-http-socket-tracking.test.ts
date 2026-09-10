import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { trackServerSockets } from '../src/commands/serve-http.ts';

// A REAL server, unlike the lifecycle suite's FakeHttpServer whose 'close'
// fires synchronously — which is why it never caught the retained sockets.

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

/** Teardown and GC are async — poll until `done`, then let the assertion talk. */
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

    // node:http, not `fetch`: Bun's fetch pool can keep a server-side socket
    // reachable in-process and mask the result.
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

    // Still open on both ends, so still tracked — else close() hangs on it.
    expect(tracker.size()).toBe(1);

    tracker.destroyAll();
    await settle(() => tracker.size() === 0);
    expect(tracker.size()).toBe(0);
    agent.destroy();
  });
});
