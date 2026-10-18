/**
 * #6355: two reconnect defects of the vendored driver that the crash robot's `pooler_disconnect` fault reached.
 *
 * A backend terminated while the driver is still starting the connection (the array-types fetch that
 * `fetch_types` runs before the caller's first statement) used to leave that internal query and its FATAL
 * `57P01` behind in the connection's state. The fresh connection then delivered the stale error to the caller's
 * query at its first ReadyForQuery (the crash robot's `put_page refused/57P01` on a live database), and the
 * internal query's promise rejected with nobody awaiting it, which Bun treats as fatal for the process (the
 * robot worker's exit 1). The vendored driver now settles the internal query and clears the saved error before
 * reconnecting, and the fetch swallows its own failure.
 *
 * A close that arrives while a statement's bytes wait for the connection's write immediate used to leave those
 * bytes and the cleared timer handle behind, so the next connection's StartupMessage was appended to them and never
 * scheduled: the socket stayed open until CONNECT_TIMEOUT and every statement the pool bound to that slot failed,
 * for as long as the slot kept being chosen (the robot's effects worker, 10 s per pass, for minutes).
 *
 * Forced probes against a scripted server: the first kills the first connection with FATAL 57P01 at its first
 * statement (before the fix the caller's `select 1` rejected with 57P01 or the process saw an unhandled rejection);
 * the second delivers a close to the driver while a statement's bytes wait for the write immediate (before the fix
 * the statement after it failed with CONNECT_TIMEOUT against a server that answers in a millisecond). Both serve
 * the second connection normally.
 */
import { afterEach, expect, test } from 'bun:test';
import { createServer, Socket, type Server } from 'node:net';
import postgres from '#postgres';

/** A client socket whose close the test can deliver to the driver synchronously, the way a FIN read in the same poll as a reply lands. */
class ScriptedSocket extends Socket {
  closeNow(): void {
    const listeners = this.listeners('close') as ((hadError: boolean) => void)[];
    this.removeAllListeners('close');
    this.destroy();
    for (const listener of listeners) listener(false);
  }
}

/** A one-byte type plus int32 length frame of the wire protocol. */
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
  frame('S', Buffer.concat([cstr('client_encoding'), cstr('UTF8')])),
  frame('K', Buffer.from([0, 0, 0, 7, 0, 0, 0, 9])),
  readyForQuery,
]);
const fatalTerminated = frame('E', Buffer.concat([
  Buffer.from('S'), cstr('FATAL'), Buffer.from('V'), cstr('FATAL'), Buffer.from('C'), cstr('57P01'),
  Buffer.from('M'), cstr('terminating connection due to administrator command'), Buffer.from([0]),
]));

type Script = { kill?: boolean; killAt?: number };
/**
 * Answers the extended protocol with empty results (ParseComplete, BindComplete, NoData, CommandComplete, ReadyForQuery)
 * and a simple Query with CommandComplete. `kill` ends the connection with FATAL 57P01 at its first statement, `killAt`
 * at its n-th (1-based).
 */
function serve(socket: Socket, buffered: Buffer, mode: Script, onStatement: () => number): Buffer {
  let rest: Buffer = buffered;
  for (;;) {
    if (rest.length < 5) return rest;
    const type = String.fromCharCode(rest[0]!), length = rest.readInt32BE(1);
    if (rest.length < length + 1) return rest;
    rest = rest.subarray(length + 1);
    const statement = type === 'P' || type === 'Q' ? onStatement() : 0;
    if (mode.kill || (statement > 0 && statement === mode.killAt)) { socket.write(fatalTerminated); socket.end(); return Buffer.alloc(0); }
    if (type === 'P') socket.write(frame('1'));
    else if (type === 'B') socket.write(frame('2'));
    else if (type === 'D') socket.write(frame('n'));
    else if (type === 'E') socket.write(frame('C', cstr('SELECT 0')));
    else if (type === 'S') socket.write(readyForQuery);
    else if (type === 'Q') socket.write(Buffer.concat([frame('C', cstr('SELECT 0')), readyForQuery]));
    else if (type === 'X') { socket.end(); return Buffer.alloc(0); }
  }
}

let server: Server | undefined;
afterEach(() => new Promise<void>(resolve => { server ? server.close(() => resolve()) : resolve(); server = undefined; }));

/** A scripted server; `script(n)` chooses how the n-th connection (1-based) behaves. */
async function listen(script: (connection: number) => Script): Promise<{ port: number; connections: { statements: number }[] }> {
  const connections: { statements: number }[] = [];
  server = createServer(socket => {
    const connection = { statements: 0 };
    connections.push(connection);
    const mode = script(connections.length);
    let buffered: Buffer = Buffer.alloc(0), started = false;
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!started) {
        if (buffered.length < 8) return;
        const length = buffered.readInt32BE(0);
        if (buffered.length < length) return;
        buffered = buffered.subarray(length); started = true;
        socket.write(startupReply);
      }
      buffered = serve(socket, buffered, mode, () => ++connection.statements);
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as { port: number }).port, connections };
}
function client(port: number, extra: Record<string, unknown> = {}): { sql: ReturnType<typeof postgres>; socket: () => ScriptedSocket } {
  let current: ScriptedSocket | undefined;
  // A socket option hands the driver a connecting socket (the driver then skips its own connect step); the option is not in the public types.
  const options = { host: '127.0.0.1', port, user: 'u', password: 'p', database: 'd', ssl: false, max: 1, prepare: false, fetch_types: true, connect_timeout: 2, onnotice() {},
    socket: () => (current = new ScriptedSocket()).connect(port, '127.0.0.1'), ...extra };
  const sql = postgres(options as unknown as Parameters<typeof postgres>[0]);
  return { sql, socket: () => current! };
}

test('forced probe: a backend terminated during startup neither fails the caller\'s first statement with the stale 57P01 nor leaves an unhandled rejection', async () => {
  const { port, connections } = await listen(connection => ({ kill: connection === 1 }));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const { sql } = client(port);
  try {
    // The caller's first statement: the driver's own types fetch runs ahead of it on the first connection, which the server kills.
    const rows = await sql.unsafe('select 1');
    expect([...rows]).toEqual([]);
    expect(connections.length).toBe(2);
    expect(connections[0]).toEqual({ statements: 1 });
    expect(connections[1]!.statements).toBeGreaterThanOrEqual(2);
    await Bun.sleep(20);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await sql.end({ timeout: 1 });
  }
}, 15_000);

test('forced probe: a close delivered while a statement\'s bytes wait for the write immediate does not leave the next connection\'s startup unsent', async () => {
  // The crash robot's stuck pool slot: a backend answered and was terminated at once; the caller's next statement was
  // buffered for that socket (its write immediate pending) when the close arrived. The cleared immediate left its
  // handle and bytes behind, so the reconnect's StartupMessage was appended and never flushed: the socket sat open
  // until CONNECT_TIMEOUT, and every statement the pool bound to that slot failed the same way, for minutes.
  const { port, connections } = await listen(() => ({}));
  const { sql, socket } = client(port);
  try {
    expect([...await sql.unsafe('select 1')]).toEqual([]);
    const second = sql.unsafe('select 2').then(() => null, (error: { code?: string }) => error.code);
    // Let the statement reach the connection (Query.handle awaits one tick before dispatching) without letting the
    // write immediate run, then deliver the close: the bytes are still buffered for the socket that just closed.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    socket().closeNow();
    expect(await second).toBe('CONNECTION_CLOSED');
    // The next statement takes the slot the pool reconnects: before the fix, CONNECT_TIMEOUT against a server that answers at once.
    expect([...await sql.unsafe('select 3')]).toEqual([]);
    expect(connections.length).toBe(2);
    expect(connections[1]!.statements).toBeGreaterThanOrEqual(2);
  } finally { await sql.end({ timeout: 1 }); }
}, 15_000);

test('forced probe (#6543): a backend terminated under a running statement does not hand its 57P01 to the first statement of the replacement connection', async () => {
  // The serve wedge's `recovery_scan reason=57P01`: a FATAL that arrived before the close stayed in the connection's
  // state, and the reconnect's startup ReadyForQuery delivered it to the statement the pool had queued for the slot.
  // `max_pipeline: 0` keeps that statement in the pool's queue, so it is written only on the replacement connection.
  const { port, connections } = await listen(connection => (connection === 1 ? { killAt: 2 } : {}));
  const { sql } = client(port, { fetch_types: false, max_pipeline: 0 });
  const settled = (query: PromiseLike<unknown>) => Promise.resolve(query).then(rows => ({ rows: [...rows as unknown[]] }), (error: { code?: string }) => ({ code: error.code }));
  try {
    expect([...await sql.unsafe('select 1')]).toEqual([]);
    const head = settled(sql.unsafe('select 2'));
    const queued = settled(sql.unsafe('select 3'));
    expect(await head).toEqual({ code: 'CONNECTION_CLOSED' });
    expect(await queued).toEqual({ rows: [] });
    expect(connections.length).toBe(2);
    expect(connections[1]!.statements).toBe(1);
  } finally { await sql.end({ timeout: 1 }); }
}, 15_000);
