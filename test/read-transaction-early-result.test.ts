/**
 * GBRA-156: a top-level search read transaction (withScopedReadTransaction with
 * alwaysTransaction, jitOffRead) hands its rows to the caller when its read
 * returns, without waiting for COMMIT's round trip (66 ms to a remote pooler,
 * once per search transaction). COMMIT still runs on the transaction's
 * connection, and the pool cannot give that connection to another statement
 * until COMMIT's answer. A failed COMMIT never surfaces as a read error. A
 * caller's own transaction still waits for its COMMIT.
 *
 * The real engine and vendored driver against a scripted server that holds
 * COMMIT's answer until the test releases it. Regression that fails it on the
 * base branch: the read stays pending until COMMIT is answered.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const frame = (type: string, body: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'ascii'); header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};
const cstr = (s: string): Buffer => Buffer.from(s + '\0', 'utf8');
const int16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const ready = (inTx: boolean) => frame('Z', Buffer.from(inTx ? 'T' : 'I'));
const startupReply = Buffer.concat([
  frame('R', int32(0)),
  frame('S', Buffer.concat([cstr('server_version'), cstr('16.0')])),
  frame('K', Buffer.concat([int32(7), int32(9)])),
  ready(false),
]);

/** This statement answers one int4 row; every other statement answers no rows. */
const ANSWER = 'SELECT 41 + 1 AS answer';
const rowDescription = frame('T', Buffer.concat([int16(1), cstr('answer'), int32(0), int16(0), int32(23), int16(4), int32(-1), int16(0)]));
const dataRow = frame('D', Buffer.concat([int16(1), int32(2), Buffer.from('42')]));
const isCommit = (text: string) => /^\s*commit/i.test(text);
const tag = (text: string) => /^\s*begin/i.test(text) ? 'BEGIN' : isCommit(text) ? 'COMMIT' : /^\s*rollback/i.test(text) ? 'ROLLBACK' : text.includes(ANSWER) ? 'SELECT 1' : 'SELECT 0';

type Sent = { conn: number; text: string };

/** Answers the simple and extended protocol, tracks each connection's transaction status, and can hold one COMMIT. */
function scriptedServer() {
  const sent: Sent[] = [];
  let holdCommit = false, commitFails = false, connections = 0;
  let release: (() => void) | null = null;
  let arrived = Promise.withResolvers<void>();
  const server: Server = createServer((socket: Socket) => {
    const conn = ++connections;
    let buffered: Buffer = Buffer.alloc(0), started = false, inTx = false, skipping = false, portal = '';
    const statements = new Map<string, { text: string; params: number }>();
    const execute = (text: string): Buffer[] => {
      if (/^\s*begin/i.test(text)) inTx = true;
      if (/^\s*(commit|rollback)/i.test(text)) inTx = false;
      if (commitFails && isCommit(text)) {
        commitFails = false;
        return [frame('E', Buffer.concat([cstr('SERROR'), cstr('C08006'), cstr('Msynthetic commit failure'), Buffer.from([0])]))];
      }
      return [...(text.includes(ANSWER) ? [dataRow] : []), frame('C', cstr(tag(text)))];
    };
    const drain = () => {
      while (!release && buffered.length >= 5) {
        const type = String.fromCharCode(buffered[0]!), length = buffered.readInt32BE(1);
        if (buffered.length < length + 1) return;
        const body = buffered.subarray(5, length + 1);
        const first = body.indexOf(0);
        const text = type === 'Q' ? body.toString('utf8', 0, first)
          : type === 'P' ? body.toString('utf8', first + 1, body.indexOf(0, first + 1)) : '';
        if (holdCommit && isCommit(text)) {
          holdCommit = false;
          release = () => { release = null; drain(); };
          arrived.resolve();
          return;
        }
        buffered = buffered.subarray(length + 1);
        if (type === 'S') { skipping = false; socket.write(ready(inTx)); continue; }
        if (skipping) continue;
        if (type === 'P') {
          statements.set(body.toString('utf8', 0, first), { text, params: body.readInt16BE(body.indexOf(0, first + 1) + 1) });
          sent.push({ conn, text });
          socket.write(frame('1'));
        } else if (type === 'B') {
          portal = statements.get(body.toString('utf8', first + 1, body.indexOf(0, first + 1)))?.text ?? '';
          socket.write(frame('2'));
        } else if (type === 'D') {
          const statement = body[0] === 0x53 ? statements.get(body.toString('utf8', 1, body.indexOf(0, 1))) : undefined;
          const params = statement ? [frame('t', Buffer.concat([int16(statement.params), ...Array.from({ length: statement.params }, () => int32(25))]))] : [];
          socket.write(Buffer.concat([...params, (statement?.text ?? portal).includes(ANSWER) ? rowDescription : frame('n')]));
        } else if (type === 'E') {
          const out = execute(portal);
          if (out[0]![0] === 0x45) skipping = true;
          socket.write(Buffer.concat(out));
        } else if (type === 'C') {
          socket.write(frame('3'));
        } else if (type === 'Q') {
          sent.push({ conn, text });
          socket.write(Buffer.concat([...(text.includes(ANSWER) ? [rowDescription] : []), ...execute(text), ready(inTx)]));
        } else if (type === 'X') {
          socket.end();
        }
      }
    };
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!started) {
        if (buffered.length < 8 || buffered.length < buffered.readInt32BE(0)) return;
        buffered = buffered.subarray(buffered.readInt32BE(0)); started = true;
        socket.write(startupReply);
      }
      drain();
    });
    socket.on('error', () => undefined);
  });
  return {
    server, sent,
    /** Hold the next COMMIT's answer (an error when \`fails\`); \`commitArrived\` resolves once the server has it. */
    holdNextCommit(fails = false) { holdCommit = true; commitFails = fails; arrived = Promise.withResolvers<void>(); },
    get commitArrived() { return arrived.promise; },
    releaseCommit() { release?.(); },
    async listen(): Promise<number> {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      return (server.address() as { port: number }).port;
    },
  };
}

let teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of teardown.reverse()) await step().catch(() => undefined);
  teardown = [];
});

const ENV = { GBRAIN_DISABLE_DIRECT_POOL: '1', GBRAIN_RLS_SCOPE_BINDING: undefined, GBRAIN_SQL_TRACE: undefined, GBRAIN_PREPARE: undefined, PGMAX_PIPELINE: undefined };

/** An engine whose pool has one connection (one server connection, as a pool at its cap) on a scripted server. */
async function fixture() {
  const srv = scriptedServer();
  const port = await srv.listen();
  teardown.push(() => new Promise<void>(resolve => srv.server.close(() => resolve())));
  const engine = new PostgresEngine();
  await engine.connect({ engine: 'postgres', database_url: 'postgresql://u:p@127.0.0.1:' + port + '/d?prepare=false', poolSize: 1, keyword_statement_timeout_ms: 8000 } as never);
  teardown.push(() => { srv.releaseCommit(); return engine.disconnect(); });
  return { srv, engine };
}

const settledWithin = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, Bun.sleep(ms).then(() => 'pending' as const)]);
const textsAfter = (sent: Sent[], from: number) => sent.slice(from).map(s => s.conn + ':' + s.text.trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase());

describe('search read transactions answer before COMMIT', () => {
  test('a search read resolves with its rows while COMMIT is unanswered; the pool cannot reuse the connection until COMMIT completes', () => withEnv(ENV, async () => {
    const { srv, engine } = await fixture();
    const from = srv.sent.length;
    srv.holdNextCommit();
    const read = engine.keywordBoundedRead(db => db.executeRaw(ANSWER));
    await srv.commitArrived;
    expect(await settledWithin(read, 1_000)).toEqual([{ answer: 42 }]);
    expect(engine.getPoolDiagnostics()!.tracked.tx).toBe(1);

    const next = engine.executeRaw('SELECT 2 AS next');
    expect(await settledWithin(next, 200)).toBe('pending');
    expect(srv.sent.some(s => s.text.includes('SELECT 2 AS next'))).toBe(false);

    srv.releaseCommit();
    expect(await settledWithin(next, 1_000)).toEqual([]);
    expect(textsAfter(srv.sent, from)).toEqual(['1:begin read', "1:select set_config('statement_timeout',", '1:select 41', '1:commit', '1:select 2']);
    expect(engine.getPoolDiagnostics()!.tracked.tx).toBe(0);
  }));

  test('a jit-off read (backlink counts) resolves while COMMIT is unanswered', () => withEnv(ENV, async () => {
    const { srv, engine } = await fixture();
    srv.holdNextCommit();
    const read = engine.getBacklinkCounts([1]);
    await srv.commitArrived;
    expect(await settledWithin(read, 1_000)).toEqual(new Map([[1, 0]]));
    srv.releaseCommit();
  }));

  test('a failed COMMIT does not surface as a read error, and the pool keeps serving', () => withEnv(ENV, async () => {
    const { srv, engine } = await fixture();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      srv.holdNextCommit(true);
      const read = engine.keywordBoundedRead(db => db.executeRaw(ANSWER));
      await srv.commitArrived;
      expect(await settledWithin(read, 1_000)).toEqual([{ answer: 42 }]);
      srv.releaseCommit();
      expect(await settledWithin(engine.executeRaw(ANSWER), 1_000)).toEqual([{ answer: 42 }]);
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
      expect(engine.getPoolDiagnostics()!.tracked.tx).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }));

  test('an error in the read still rejects the read and rolls back', () => withEnv(ENV, async () => {
    const { srv, engine } = await fixture();
    const from = srv.sent.length;
    await expect(engine.keywordBoundedRead(async () => { throw new Error('read sentinel'); })).rejects.toThrow('read sentinel');
    expect(await engine.executeRaw(ANSWER)).toEqual([{ answer: 42 }]);
    expect(textsAfter(srv.sent, from)).toEqual(['1:begin read', "1:select set_config('statement_timeout',", '1:rollback', '1:select 41']);
  }));

  test("a caller's transaction still waits for its COMMIT", () => withEnv(ENV, async () => {
    const { srv, engine } = await fixture();
    srv.holdNextCommit();
    const write = engine.transaction(tx => tx.executeRaw(ANSWER));
    await srv.commitArrived;
    expect(await settledWithin(write, 200)).toBe('pending');
    srv.releaseCommit();
    expect(await settledWithin(write, 1_000)).toEqual([{ answer: 42 }]);
  }));

  test("inside a caller's transaction the search read is a savepoint that ends before the caller's COMMIT", () => withEnv(ENV, async () => {
    const { srv, engine } = await fixture();
    const from = srv.sent.length;
    expect(await engine.transaction(tx => tx.keywordBoundedRead(db => db.executeRaw(ANSWER)))).toEqual([{ answer: 42 }]);
    expect(textsAfter(srv.sent, from).filter(s => !/current_setting|set_config/.test(s))).toEqual(['1:begin read', '1:savepoint "s0"', '1:select 41', '1:commit']);
  }));
});
