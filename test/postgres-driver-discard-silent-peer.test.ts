/**
 * A discarded connection whose peer accepted it and then went silent: Terminate is sent with socket.end(), and a peer
 * that never answers that half-close (a stalled pooler, a dropped network path) never sends the FIN that would close the
 * socket. Until the socket closes, the pool counts the connection as open, so a one-connection pool could never connect
 * again. Every discard path (a reserved connection's discard() and cancelAndDiscard(), a transaction's discard()) must
 * give the slot back. The peer here is a minimal Postgres wire server that completes startup, answers simple queries,
 * leaves any query naming "silent" unanswered, and never closes a socket itself.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createServer, type Socket } from 'net';
import postgres from '#postgres';

const sockets = new Set<Socket>();
const server = createServer({ allowHalfOpen: true }, socket => {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  let buffer = Buffer.alloc(0);
  let started = false;
  let inTransaction = false;
  const send = (type: string, body: Buffer) => {
    const head = Buffer.alloc(5);
    head.write(type, 0);
    head.writeInt32BE(body.length + 4, 1);
    if (!socket.destroyed) socket.write(Buffer.concat([head, body]));
  };
  const int32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const ready = () => send('Z', Buffer.from(inTransaction ? 'T' : 'I'));
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!started) {
        if (buffer.length < 8) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        const code = buffer.readInt32BE(4);
        buffer = buffer.subarray(length);
        if (code === 80877102) continue;
        started = true;
        send('R', int32(0));
        send('K', Buffer.concat([int32(1), int32(2)]));
        ready();
        continue;
      }
      if (buffer.length < 5) return;
      const type = String.fromCharCode(buffer[0]);
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) return;
      const body = buffer.subarray(5, length + 1);
      buffer = buffer.subarray(length + 1);
      if (type !== 'Q') continue;
      const text = body.toString('utf8', 0, body.length - 1).trim().toLowerCase();
      if (text.includes('silent')) continue;
      if (text.startsWith('begin')) inTransaction = true;
      if (text.startsWith('commit') || text.startsWith('rollback')) inTransaction = false;
      send('C', Buffer.from((text.split(/\s+/)[0] || 'select').toUpperCase() + '\0'));
      ready();
    }
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
});

const pool = () => postgres({ host: '127.0.0.1', port, user: 'u', database: 'd', ssl: false, max: 1, fetch_types: false, connect_timeout: 5, idle_timeout: 0, onnotice: () => {} });

async function slotComesBack(sql: ReturnType<typeof pool>): Promise<boolean> {
  const next = sql.reserve().then(reserved => { reserved.release(); return true; });
  return Promise.race([next, Bun.sleep(6_000).then(() => false)]);
}

describe('discard against a peer that stays silent', () => {
  test('a reserved connection discarded under a silent statement gives its pool slot back', async () => {
    const sql = pool();
    const reserved = await sql.reserve();
    const pending = reserved.unsafe('select silent').simple().execute().catch(error => error);
    await Bun.sleep(50);
    reserved.discard();
    expect(await pending).toMatchObject({ code: expect.stringMatching(/^CONNECTION_/) });
    expect(await slotComesBack(sql)).toBe(true);
    await sql.end({ timeout: 0 });
  }, 15_000);

  test('cancelAndDiscard on a silent statement gives its pool slot back', async () => {
    const sql = pool();
    const reserved = await sql.reserve();
    const pending = reserved.unsafe('select silent', [], { cancelFence: true } as never).simple().execute().catch(error => error);
    await Bun.sleep(50);
    await reserved.cancelAndDiscard({ timeout: 100 }).catch(() => {});
    await pending;
    expect(await slotComesBack(sql)).toBe(true);
    await sql.end({ timeout: 0 });
  }, 15_000);

  test("a transaction's discard gives its pool slot back", async () => {
    const sql = pool();
    const outcome = await sql.begin(async tx => {
      (tx as unknown as { discard: () => void }).discard();
      await tx.unsafe('select 1').simple();
    }).catch(error => error);
    expect(outcome).toMatchObject({ code: expect.stringMatching(/^CONNECTION_/) });
    expect(await slotComesBack(sql)).toBe(true);
    await sql.end({ timeout: 0 });
  }, 15_000);
});
