/**
 * Host sleep must not retire a healthy Postgres connection (t_233071e1).
 *
 * The in-flight watchdog arms a setTimeout, which keeps counting while a laptop sleeps, and reports the statement's
 * age from performance.now(), which stops during sleep. A nightly job that dark-woke mid-statement logged
 * `pg_connection_stuck reason=age age_ms=271 budget_ms=330000` and failed the orphans phase.
 *
 * Protects: a timer that fires while the monotonic clock says the budget is unspent re-arms instead of retiring the
 * connection; a statement that really stays silent past its budget is still retired. No database: a fake wire server.
 */
import { describe, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import postgres from '#postgres';

function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
function msg(type: string, body: Buffer) { return Buffer.concat([Buffer.from(type), u32(body.length + 4), body]); }

/** Accepts the startup, answers ReadyForQuery, then never answers a query. */
function silentServer(): Promise<{ server: Server; port: number; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      sockets.push(socket);
      let started = false;
      socket.on('error', () => {});
      socket.on('data', () => {
        if (started) return;
        started = true;
        socket.write(Buffer.concat([msg('R', u32(0)), msg('Z', Buffer.from('I'))]));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, sockets }));
  });
}

async function runStatement(frozenClock: boolean): Promise<{ stuck: Array<Record<string, unknown>>; waitedMs: number }> {
  const { server, port, sockets } = await silentServer();
  const stuck: Array<Record<string, unknown>> = [];
  const sql = postgres({
    host: '127.0.0.1', port, user: 'u', database: 'd', max: 1, fetch_types: false, prepare: false, connect_timeout: 5,
    inflight_timeout: 0.3, inflight_max: 0.3, inflight_grace: 0,
    onstuck: (info: Record<string, unknown>) => { stuck.push(info); },
  } as never);
  const realNow = performance.now.bind(performance);
  const t0 = Date.now();
  try {
    const pending = sql`SELECT 1`.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
    await new Promise((r) => setTimeout(r, 100)); // let the statement become the connection's head
    // Host sleep: the uptime clock stops while wall-clock timers keep running.
    if (frozenClock) { const frozen = realNow(); performance.now = () => frozen; }
    await new Promise((r) => setTimeout(r, 900));
    if (stuck.length === 0) { performance.now = realNow; }
    void pending;
  } finally {
    performance.now = realNow;
    for (const s of sockets) s.destroy();
    server.close();
    await sql.end({ timeout: 0 }).catch(() => {});
  }
  return { stuck, waitedMs: Date.now() - t0 };
}

describe('in-flight watchdog vs host sleep', () => {
  test('all three shipped driver copies carry the sleep-skew re-arm', () => {
    for (const path of ['src', 'cjs/src', 'cf/src']) {
      const connection = readFileSync(new URL(`../vendor/postgres/${path}/connection.js`, import.meta.url), 'utf8');
      expect(connection).toContain('const armedAt = performance.now()');
      expect(connection).toContain('Math.min(1000, ms / 10) < ms ? arm(ms - spent)');
    }
  });

  test('a timer that fires while the uptime clock is stopped does not retire the connection', async () => {
    const { stuck } = await runStatement(true);
    expect(stuck).toEqual([]);
  });

  test('a statement that stays silent on a running clock is still retired as stuck', async () => {
    const { stuck } = await runStatement(false);
    expect(stuck.length).toBe(1);
    expect(stuck[0]!.reason).toBe('idle');
    expect(stuck[0]!.budget_ms).toBe(300);
    expect(Number(stuck[0]!.age_ms)).toBeGreaterThanOrEqual(290);
  });
});
