/**
 * GBRA-133 PR 2b (#6930): the managed engine's Postgres round trips.
 *
 * 1. Array types. postgres.js runs a pg_type query on every new connection before its first statement. A sync run
 *    opens its pool's connections in a burst (sync-drain's pre-warm), so every one of them paid that round trip, on
 *    every pool of the process. The array types are now fetched by the process's first connection to a database and
 *    applied by every later one, of any pool.
 * 2. Transaction pipelining. Behind a transaction-mode pooler a read pool does not pipeline (#6543), which also kept
 *    the statements of one transaction, which the pooler pins to one server connection, at one round trip each. They
 *    are pipelined again on the connection their owner holds, never behind a statement that may end the transaction.
 *
 * The unit arm runs on a scripted server (no database) and records, for every statement, how many earlier ones were
 * still unanswered when it arrived: a decision the client made, not a timing. The Postgres arm runs a managed sync
 * through a fresh traced pool and counts its connections and pg_type queries.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { resolvePoolSize } from '../../src/core/db.ts';
import { _resetSharedParameterTypesForTests } from '../../src/core/pg-type-cache.ts';
import { drainManagedSync } from '../../src/core/persistence/sync-drain.ts';
import { readSqlTrace } from '../helpers/statement-counter.ts';
import { withEnv } from '../helpers/with-env.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const NO_OVERRIDES = { PGMAX_PIPELINE: undefined, GBRAIN_PREPARE: undefined, GBRAIN_DISABLE_DIRECT_POOL: '1', GBRAIN_SQL_TRACE: undefined,
  GBRAIN_PG_TYPE_CACHE: undefined, GBRAIN_PG_TXN_PIPELINE: undefined, GBRAIN_DIRECT_DATABASE_URL: undefined };
const ANSWER_DELAY_MS = 25;

interface Arrival { conn: number; sql: string; unanswered: number }

/**
 * A server that speaks just enough of the protocol for gbrain's pool: trust auth, empty results, a transaction status
 * that follows BEGIN / COMMIT / ROLLBACK, and every answer held ANSWER_DELAY_MS so a pipelining client is seen sending
 * its next statement before the previous answer.
 */
async function scriptedServer(): Promise<{ url: (query: string) => string; arrivals: Arrival[]; connections: () => number; close: () => Promise<void> }> {
  const arrivals: Arrival[] = [];
  let connections = 0;
  const frame = (type: string, body: Buffer = Buffer.alloc(0)) => {
    const header = Buffer.alloc(5);
    header.write(type, 0, 'ascii'); header.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([header, body]);
  };
  const cstr = (s: string) => Buffer.from(`${s}\0`, 'utf8');
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    const conn = ++connections;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffered = Buffer.alloc(0), started = false, status = 'I', text = '';
    let reply: Buffer[] = [];
    const queue: Array<{ frames: Buffer; status: string }> = [];
    let answering = false;
    const pump = () => {
      if (answering || !queue.length) return;
      answering = true;
      setTimeout(() => {
        const next = queue.shift()!;
        if (!socket.destroyed) socket.write(Buffer.concat([next.frames, frame('Z', Buffer.from(next.status))]));
        answering = false;
        pump();
      }, ANSWER_DELAY_MS);
    };
    const statement = (sqlText: string, frames: Buffer[]) => {
      arrivals.push({ conn, sql: sqlText.replace(/\s+/g, ' ').trim(), unanswered: queue.length });
      for (const part of sqlText.split(';')) {
        const s = part.trim().toLowerCase();
        if (/^(begin|start transaction)\b/.test(s)) status = 'T';
        else if (/^(commit|rollback|end|abort)\b/.test(s)) status = 'I';
      }
      queue.push({ frames: Buffer.concat(frames), status });
      pump();
    };
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!started) {
        if (buffered.length < 8 || buffered.length < buffered.readInt32BE(0)) return;
        buffered = buffered.subarray(buffered.readInt32BE(0)); started = true;
        socket.write(Buffer.concat([frame('R', Buffer.from([0, 0, 0, 0])), frame('S', Buffer.concat([cstr('server_version'), cstr('16.0')])),
          frame('K', Buffer.from([0, 0, 0, 7, 0, 0, 0, 9])), frame('Z', Buffer.from('I'))]));
      }
      while (buffered.length >= 5) {
        const type = String.fromCharCode(buffered[0]!), length = buffered.readInt32BE(1);
        if (buffered.length < length + 1) break;
        const body = buffered.subarray(5, length + 1);
        buffered = buffered.subarray(length + 1);
        if (type === 'P') { const nameEnd = body.indexOf(0); text = body.subarray(nameEnd + 1, body.indexOf(0, nameEnd + 1)).toString('utf8'); reply.push(frame('1')); }
        else if (type === 'B') reply.push(frame('2'));
        else if (type === 'D') reply.push(frame('n'));
        else if (type === 'E') reply.push(frame('C', cstr('SELECT 0')));
        else if (type === 'S') { statement(text, reply); reply = []; }
        else if (type === 'Q') { const q = body.subarray(0, body.indexOf(0)).toString('utf8'); statement(q, q.split(';').map(() => frame('C', cstr('SELECT 0')))); }
        else if (type === 'X') socket.end();
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: query => `postgresql://u:p@127.0.0.1:${port}/d${query}`,
    arrivals,
    connections: () => connections,
    close: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

const engines: PostgresEngine[] = [];
let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => {
  while (engines.length) await engines.pop()!.disconnect().catch(() => undefined);
  await closeServer?.();
  closeServer = undefined;
});

async function engineOn(url: string, poolSize: number): Promise<PostgresEngine> {
  const engine = new PostgresEngine();
  engines.push(engine);
  await engine.connect({ engine: 'postgres', database_url: url, poolSize });
  return engine;
}
async function serverFor(): Promise<Awaited<ReturnType<typeof scriptedServer>>> {
  const server = await scriptedServer();
  closeServer = server.close;
  return server;
}
const isTypeFetch = (sql: string) => /pg_catalog\.pg_type/.test(sql) && /typarray/.test(sql);
const unansweredOf = (arrivals: Arrival[], re: RegExp) => arrivals.filter(a => re.test(a.sql)).map(a => a.unanswered);

describe('#6930 unit: scripted server', () => {
  test('array types are fetched by the process\'s first connection to a database, not by every connection of every pool', async () => withEnv(NO_OVERRIDES, async () => {
    _resetSharedParameterTypesForTests();
    const server = await serverFor();
    const a = await engineOn(server.url(''), 3);
    const b = await engineOn(server.url(''), 3);
    await Promise.all([a, b].flatMap(engine => Array.from({ length: 6 }, () => engine.sql.unsafe('SELECT 1'))));
    expect(server.connections()).toBeGreaterThanOrEqual(4);
    expect({ connections: server.connections(), typeFetches: server.arrivals.filter(x => isTypeFetch(x.sql)).length })
      .toEqual({ connections: server.connections(), typeFetches: 1 });
  }));

  test('GBRAIN_PG_TYPE_CACHE=0 keeps the stock fetch on every connection', async () => withEnv({ ...NO_OVERRIDES, GBRAIN_PG_TYPE_CACHE: '0' }, async () => {
    _resetSharedParameterTypesForTests();
    const server = await serverFor();
    const a = await engineOn(server.url(''), 3);
    await Promise.all(Array.from({ length: 6 }, () => a.sql.unsafe('SELECT 1')));
    expect(server.connections()).toBeGreaterThanOrEqual(2);
    expect(server.arrivals.filter(x => isTypeFetch(x.sql)).length).toBe(server.connections());
  }));

  test('behind a transaction pooler, the statements one transaction issues together share a round trip', async () => withEnv(NO_OVERRIDES, async () => {
    const server = await serverFor();
    const engine = await engineOn(server.url('?prepare=false'), 1);
    await engine.sql.begin(tx => Promise.all([1, 2, 3, 4].map(n => tx.unsafe(`SELECT ${n} AS in_tx`))));
    expect(unansweredOf(server.arrivals, /^SELECT \d AS in_tx$/)).toEqual([0, 1, 2, 3]);
    expect(unansweredOf(server.arrivals, /^commit$/)).toEqual([0]);
  }));

  test('behind a transaction pooler, a bounded read sends BEGIN; SET LOCAL, the read and COMMIT in one round trip', async () => withEnv(NO_OVERRIDES, async () => {
    const server = await serverFor();
    const engine = await engineOn(server.url('?prepare=false'), 1);
    await engine.executeRaw('SELECT 1 AS bounded', [], { timeoutMs: 5000 });
    const sent = server.arrivals.filter(a => /^BEGIN READ WRITE; SET LOCAL statement_timeout|^SELECT 1 AS bounded$|^COMMIT$/.test(a.sql));
    expect(sent.map(a => a.unanswered)).toEqual([0, 1, 2]);
  }));

  test('#6543 kept: autocommit statements are never pipelined, and nothing is sent behind COMMIT', async () => withEnv(NO_OVERRIDES, async () => {
    const server = await serverFor();
    const engine = await engineOn(server.url('?prepare=false'), 1);
    await Promise.all(Array.from({ length: 5 }, (_, n) => engine.sql.unsafe(`SELECT ${n} AS autocommit`)));
    expect(unansweredOf(server.arrivals, /AS autocommit$/)).toEqual([0, 0, 0, 0, 0]);
    const reserved = await engine.sql.reserve();
    try {
      await Promise.all([reserved.unsafe('BEGIN').simple().execute(), reserved.unsafe('SELECT 1 AS before_commit').execute(),
        reserved.unsafe('COMMIT').execute(), reserved.unsafe('SELECT 2 AS after_commit').execute()]);
    } finally { reserved.release(); }
    expect(unansweredOf(server.arrivals, /AS after_commit$/)).toEqual([0]);
  }));

  test('behind a transaction pooler, a reserved connection pipelines from BEGIN through COMMIT', async () => withEnv(NO_OVERRIDES, async () => {
    const server = await serverFor();
    const engine = await engineOn(server.url('?prepare=false'), 1);
    const reserved = await engine.sql.reserve();
    try {
      await Promise.all([reserved.unsafe('BEGIN').simple().execute(), reserved.unsafe('SELECT 1 AS reserved_tx').execute(), reserved.unsafe('COMMIT').execute()]);
    } finally { reserved.release(); }
    expect(server.arrivals.filter(a => /^BEGIN$|AS reserved_tx$|^COMMIT$/.test(a.sql)).map(a => a.unanswered)).toEqual([0, 1, 2]);
  }));

  test('a direct URL keeps the driver\'s pipelining, and GBRAIN_PG_TXN_PIPELINE=0 restores one round trip per statement', async () => {
    await withEnv(NO_OVERRIDES, async () => {
      const server = await serverFor();
      const engine = await engineOn(server.url(''), 1);
      await engine.sql.begin(tx => Promise.all([1, 2].map(n => tx.unsafe(`SELECT ${n} AS direct_tx`))));
      expect(unansweredOf(server.arrivals, /AS direct_tx$/)).toEqual([0, 1]);
    });
    while (engines.length) await engines.pop()!.disconnect();
    await closeServer?.();
    await withEnv({ ...NO_OVERRIDES, GBRAIN_PG_TXN_PIPELINE: '0' }, async () => {
      const server = await serverFor();
      const engine = await engineOn(server.url('?prepare=false'), 1);
      await engine.sql.begin(tx => Promise.all([1, 2].map(n => tx.unsafe(`SELECT ${n} AS switched_off`))));
      expect(unansweredOf(server.arrivals, /AS switched_off$/)).toEqual([0, 0]);
    });
  });
});

const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Bench Example', '-c', 'user.email=bench@example.invalid', ...args], { cwd: root });

for (const { backend, databaseUrl } of pathologicalArms().filter(arm => arm.backend === 'postgres')) {
  describe(`#6930 ${backend}: a managed sync run`, () => {
    test('opens at most its pool\'s connections, all on one pool, and runs the pg_type query once', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-6930-trace-'));
      const trace = join(dir, 'sync.jsonl');
      try {
        await managedBrain(async ({ engine, root }) => {
          writeFileSync(join(root, 'alice-example.md'), '---\ntitle: Alice Example\ntype: note\n---\nRound trip probe.\n');
          git(root, 'add', '-A');
          git(root, 'commit', '-qm', 'probe');
          const url = (engine as unknown as { _savedConfig: { database_url: string } })._savedConfig.database_url;
          await withEnv({ ...NO_OVERRIDES, GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: 'sync-6930' }, async () => {
            _resetSharedParameterTypesForTests();
            const run = new PostgresEngine();
            await run.connect({ engine: 'postgres', database_url: url, poolSize: resolvePoolSize() });
            try {
              await drainManagedSync(run, { sourceId: 'default', noPull: true, noEmbed: true } as Parameters<typeof drainManagedSync>[1], false);
            } finally { await run.disconnect(); }
          });
          await Bun.sleep(1200);
        }, { databaseUrl, setup: ({ root }) => {
          git(root, 'init', '-q');
          writeFileSync(join(root, 'acme-example.md'), '---\ntitle: Acme Example\ntype: note\n---\nSeed.\n');
          git(root, 'add', '-A');
          git(root, 'commit', '-qm', 'seed');
        } });
        const records = readSqlTrace(trace).filter(r => (r as { label?: string }).label === 'sync-6930');
        const connects = records.filter(r => r.kind === 'connect');
        expect(connects.length).toBeGreaterThanOrEqual(2);
        expect({ within_pool: connects.length <= resolvePoolSize(), pools: [...new Set(connects.map(r => (r as { pool?: string }).pool))], type_fetches: records.filter(r => isTypeFetch(r.sql)).length })
          .toEqual({ within_pool: true, pools: ['instance'], type_fetches: 1 });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 180_000);
  });
}
