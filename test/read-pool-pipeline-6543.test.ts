/**
 * #6543 (A3): a read-side pool whose URL is a transaction-mode pooler does not
 * pipeline. Through Supavisor's transaction mode, statements pipelined on one
 * client connection crossed transaction boundaries: they hung until the
 * in-flight watchdog fired, or came back with another statement's rows.
 *
 * `resolveReadPoolPipeline(url)` decides it once for the three read-side
 * construction sites (the module singleton in db.ts, an engine's instance pool,
 * the connection manager's read pool) and names the reason: `0` for a
 * transaction-mode URL (port 6543 or `?prepare=false`, read from the URL even
 * when `GBRAIN_PREPARE=1`) or `GBRAIN_PREPARE=0`; unset (the driver's default
 * 100) otherwise, a session-mode pooler included; and unset when the user set
 * `?max_pipeline=` or a non-empty `PGMAX_PIPELINE`, because the driver lets the
 * options object outrank both.
 *
 * Regression that fails it on the base branch: every case reads the driver's
 * default 100, because no site set `max_pipeline`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import postgres from '#postgres';
import { connect as connectModule, disconnect as disconnectModule, getConnection, readPoolPipelineOptions, resolveReadPoolPipeline, type ReadPoolPipelineReason } from '../src/core/db.ts';
import { ConnectionManager } from '../src/core/connection-manager.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const NO_OVERRIDES = { PGMAX_PIPELINE: undefined, GBRAIN_PREPARE: undefined, GBRAIN_DIRECT_DATABASE_URL: undefined, GBRAIN_DISABLE_DIRECT_POOL: undefined, GBRAIN_SQL_TRACE: undefined };
const POOLER_HOST = 'aws-0-us-east-1.pooler.supabase.com';

/** URL, extra env, the option the helper returns, its reason, the max_pipeline the driver ends up with. */
const MATRIX: Array<{ name: string; url: string; env?: Record<string, string>; option: { max_pipeline?: number }; reason: ReadPoolPipelineReason; effective: number }> = [
  { name: 'direct :5432', url: 'postgresql://u:p@db.example.invalid:5432/d', option: {}, reason: 'default', effective: 100 },
  { name: 'transaction pooler port :6543', url: 'postgresql://u:p@db.example.invalid:6543/d', option: { max_pipeline: 0 }, reason: 'transaction_pooler_port', effective: 0 },
  { name: '?prepare=false', url: 'postgresql://u:p@db.example.invalid:5432/d?prepare=false', option: { max_pipeline: 0 }, reason: 'url_prepare_false', effective: 0 },
  { name: 'GBRAIN_PREPARE=0', url: 'postgresql://u:p@db.example.invalid:5432/d', env: { GBRAIN_PREPARE: '0' }, option: { max_pipeline: 0 }, reason: 'gbrain_prepare_off', effective: 0 },
  { name: 'Supabase transaction pooler :6543 with GBRAIN_PREPARE=1', url: `postgresql://postgres.ref:p@${POOLER_HOST}:6543/postgres`, env: { GBRAIN_PREPARE: '1' }, option: { max_pipeline: 0 }, reason: 'transaction_pooler_port', effective: 0 },
  { name: ':6543 with ?prepare=true', url: 'postgresql://u:p@db.example.invalid:6543/d?prepare=true', option: { max_pipeline: 0 }, reason: 'transaction_pooler_port', effective: 0 },
  { name: 'Supabase session pooler :5432', url: `postgresql://postgres.ref:p@${POOLER_HOST}:5432/postgres`, option: {}, reason: 'default', effective: 100 },
  { name: ':6543 with ?max_pipeline=5', url: 'postgresql://u:p@db.example.invalid:6543/d?max_pipeline=5', option: {}, reason: 'url_max_pipeline', effective: 5 },
  { name: ':6543 with PGMAX_PIPELINE=5', url: 'postgresql://u:p@db.example.invalid:6543/d', env: { PGMAX_PIPELINE: '5' }, option: {}, reason: 'env_pgmax_pipeline', effective: 5 },
  { name: 'direct :5432 with PGMAX_PIPELINE=5', url: 'postgresql://u:p@db.example.invalid:5432/d', env: { PGMAX_PIPELINE: '5' }, option: {}, reason: 'env_pgmax_pipeline', effective: 5 },
  { name: '?prepare=false with GBRAIN_PREPARE=1', url: 'postgresql://u:p@db.example.invalid:5432/d?prepare=false', env: { GBRAIN_PREPARE: '1' }, option: { max_pipeline: 0 }, reason: 'url_prepare_false', effective: 0 },
  { name: ':6543 with an empty PGMAX_PIPELINE', url: 'postgresql://u:p@db.example.invalid:6543/d', env: { PGMAX_PIPELINE: '' }, option: { max_pipeline: 0 }, reason: 'transaction_pooler_port', effective: 0 },
  { name: 'direct :5432 with an empty PGMAX_PIPELINE', url: 'postgresql://u:p@db.example.invalid:5432/d', env: { PGMAX_PIPELINE: '' }, option: {}, reason: 'default', effective: 100 },
];

const opened: Array<{ end: (o?: { timeout?: number }) => Promise<void> }> = [];
let server: Server | undefined;
afterEach(async () => {
  while (opened.length) await opened.pop()!.end({ timeout: 1 }).catch(() => {});
  await new Promise<void>(resolve => { server ? server.close(() => resolve()) : resolve(); server = undefined; });
});
const effective = (pool: unknown): number => (pool as { options: { max_pipeline: number } }).options.max_pipeline;

describe('resolveReadPoolPipeline', () => {
  for (const c of MATRIX) {
    test(`${c.name}: ${JSON.stringify(c.option)} (${c.reason}), driver max_pipeline ${c.effective}`, async () => withEnv({ ...NO_OVERRIDES, ...c.env }, async () => {
      expect(resolveReadPoolPipeline(c.url)).toEqual({ value: c.option.max_pipeline ?? null, reason: c.reason });
      expect(readPoolPipelineOptions(c.url)).toEqual(c.option);
      const pool = postgres(c.url, { ...readPoolPipelineOptions(c.url) } as Parameters<typeof postgres>[1]);
      opened.push(pool);
      expect(effective(pool)).toBe(c.effective);
    }));
  }
});

describe('connection manager read pool', () => {
  for (const c of MATRIX) {
    test(`${c.name}: max_pipeline ${c.effective}`, async () => withEnv({ ...NO_OVERRIDES, GBRAIN_DISABLE_DIRECT_POOL: '1', ...c.env }, async () => {
      // getReadPool builds the pool without connecting, so an unreachable host is fine here.
      const pool = await new ConnectionManager({ url: c.url }).getReadPool();
      opened.push(pool);
      expect(effective(pool)).toBe(c.effective);
    }));
  }
});

/**
 * The module singleton and the instance pool connect at once, so they run against a scripted server that answers the
 * extended protocol with empty results; the URL cases are those a loopback address can carry.
 */
const frame = (type: string, body: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'ascii'); header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};
const cstr = (s: string): Buffer => Buffer.from(`${s}\0`, 'utf8');
const readyForQuery = frame('Z', Buffer.from('I'));
const startupReply = Buffer.concat([
  frame('R', Buffer.from([0, 0, 0, 0])),
  frame('S', Buffer.concat([cstr('server_version'), cstr('16.0')])),
  frame('K', Buffer.from([0, 0, 0, 7, 0, 0, 0, 9])),
  readyForQuery,
]);
function answer(socket: Socket, buffered: Buffer): Buffer {
  let rest = buffered;
  while (rest.length >= 5) {
    const type = String.fromCharCode(rest[0]!), length = rest.readInt32BE(1);
    if (rest.length < length + 1) break;
    rest = rest.subarray(length + 1);
    if (type === 'P') socket.write(frame('1'));
    else if (type === 'B') socket.write(frame('2'));
    else if (type === 'D') socket.write(frame('n'));
    else if (type === 'E') socket.write(frame('C', cstr('SELECT 0')));
    else if (type === 'S') socket.write(readyForQuery);
    else if (type === 'Q') socket.write(Buffer.concat([frame('C', cstr('SELECT 0')), readyForQuery]));
    else if (type === 'X') socket.end();
  }
  return rest;
}
async function scriptedServer(): Promise<number> {
  server = createServer(socket => {
    let buffered: Buffer = Buffer.alloc(0), started = false;
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!started) {
        if (buffered.length < 8 || buffered.length < buffered.readInt32BE(0)) return;
        buffered = buffered.subarray(buffered.readInt32BE(0)); started = true;
        socket.write(startupReply);
      }
      buffered = answer(socket, buffered);
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as { port: number }).port;
}
const LOOPBACK: Array<{ name: string; query: string; env?: Record<string, string>; effective: number }> = [
  { name: 'direct', query: '', effective: 100 },
  { name: '?prepare=false', query: '?prepare=false', effective: 0 },
  { name: 'GBRAIN_PREPARE=0', query: '', env: { GBRAIN_PREPARE: '0' }, effective: 0 },
  { name: '?prepare=false&max_pipeline=5', query: '?prepare=false&max_pipeline=5', effective: 5 },
  { name: 'GBRAIN_PREPARE=0 with PGMAX_PIPELINE=5', query: '', env: { GBRAIN_PREPARE: '0', PGMAX_PIPELINE: '5' }, effective: 5 },
];

describe('module singleton and instance pool', () => {
  for (const c of LOOPBACK) {
    test(`${c.name}: max_pipeline ${c.effective} on both`, async () => withEnv({ ...NO_OVERRIDES, GBRAIN_DISABLE_DIRECT_POOL: '1', ...c.env }, async () => {
      const port = await scriptedServer();
      const url = `postgresql://u:p@127.0.0.1:${port}/d${c.query}`;
      const engine = new PostgresEngine();
      await engine.connect({ engine: 'postgres', database_url: url, poolSize: 2 });
      try { expect(effective(engine.sql)).toBe(c.effective); } finally { await engine.disconnect(); }
      const warn = console.warn;
      console.warn = () => {};
      try {
        await connectModule({ engine: 'postgres', database_url: url });
        expect(effective(getConnection())).toBe(c.effective);
      } finally { console.warn = warn; await disconnectModule(); }
    }), 15_000);
  }
});
