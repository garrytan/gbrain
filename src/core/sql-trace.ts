/**
 * Env-gated wire-level SQL trace for benchmarks (`GBRAIN_SQL_TRACE=<file.jsonl>`,
 * docs/eval/managed-sync-catchup.md). Every postgres.js pool (module singleton,
 * instance pool, read and direct pools) passes its options through
 * `traceSqlOptions`, so `executeRaw`, `tx.unsafe`, the engine-sql adapter and
 * tagged templates are all seen at the socket. Each Sync or simple Query sent
 * and its ReadyForQuery reply is one record: one database round trip, including
 * the describe round trip an unprepared parameterized statement pays. Records
 * carry the statement text (never parameter values), start, duration, process,
 * pool, client connection and backend pid; `application_name` names the process
 * so `pg_stat_activity` lock samples can be attributed. TLS connections are not
 * decodable and are recorded once as `kind: "tls_untraced"`.
 *
 * Off (the default) it returns the options object untouched: no socket wrapper,
 * no per-query work.
 */
import { appendFileSync } from 'node:fs';
import net from 'node:net';

interface Pending { sql: string; kind: 'execute' | 'describe' | 'simple' | 'connect'; t: number; err?: string; flush?: boolean }
interface TraceConnection {
  id: number; backend: number; prepared: Map<string, string>; text: string; executed: boolean; pending: Pending[];
  out: Buffer | null; startup: boolean; opaque: boolean;
  inHeader: Buffer; inType: number; inLeft: number; inBody: Buffer[] | null;
}

let connections = 0;
/** Unwritten records by trace file: each pool's records go to the file it was created with. */
const buffered = new Map<string, string[]>();
let flushOnExit = false;
const clock = () => performance.timeOrigin + performance.now();
const SSL_REQUEST = 80877103;
const KEEP_BODY = new Set([0x4b, 0x45, 0x5a, 0x54, 0x6e]);

function cstring(buf: Buffer, at: number): [string, number] {
  const end = buf.indexOf(0, at);
  return end < 0 ? [buf.toString('utf8', at), buf.length] : [buf.toString('utf8', at, end), end + 1];
}

function emit(file: string, record: Record<string, unknown>): void {
  let lines = buffered.get(file);
  if (!lines) buffered.set(file, lines = []);
  lines.push(JSON.stringify(record));
  if (!flushOnExit) { flushOnExit = true; process.on('exit', flushAll); setInterval(flushAll, 1000).unref(); }
  if (lines.length >= 500) flush(file);
}
function flushAll(): void {
  for (const file of [...buffered.keys()]) flush(file);
}
function flush(file: string): void {
  const pending = buffered.get(file);
  if (!pending?.length) return;
  const lines = pending.join('\n') + '\n';
  buffered.delete(file);
  try { appendFileSync(file, lines); } catch { /* a trace that cannot be written never fails the traced process */ }
}

function outgoing(c: TraceConnection, chunk: Buffer): void {
  let buf = c.out ? Buffer.concat([c.out, chunk]) : chunk;
  c.out = null;
  while (!c.opaque) {
    if (c.startup) {
      if (buf.length < 8) break;
      const len = buf.readInt32BE(0);
      if (buf.readInt32BE(4) === SSL_REQUEST) { c.opaque = true; break; }
      if (buf.length < len) break;
      c.startup = false; buf = buf.subarray(len); continue;
    }
    if (buf.length < 5) break;
    const total = 1 + buf.readInt32BE(1);
    if (buf.length < total) break;
    const type = buf[0]; const body = buf.subarray(5, total);
    if (type === 0x50) { const [name, at] = cstring(body, 0); c.text = cstring(body, at)[0]; c.prepared.set(name, c.text); }
    else if (type === 0x42) { const [, at] = cstring(body, 0); c.text = c.prepared.get(cstring(body, at)[0]) ?? c.text; }
    else if (type === 0x45) c.executed = true;
    else if (type === 0x51) c.pending.push({ sql: cstring(body, 0)[0], kind: 'simple', t: clock() });
    else if (type === 0x53) { c.pending.push({ sql: c.text, kind: c.executed ? 'execute' : 'describe', t: clock() }); c.executed = false; }
    else if (type === 0x48) c.pending.push({ sql: c.text, kind: 'describe', t: clock(), flush: true });
    buf = buf.subarray(total);
  }
  if (!c.opaque && buf.length) c.out = Buffer.from(buf);
}

function message(c: TraceConnection, type: number, body: Buffer, file: string, label: string, pool: string): void {
  if (type === 0x4b) c.backend = body.readInt32BE(0);
  else if (type === 0x45 && c.pending[0]) {
    for (let at = 0; at < body.length && body[at] !== 0;) {
      const field = body[at]!; const [value, next] = cstring(body, at + 1); at = next;
      if (field === 0x43) { c.pending[0].err = value; break; }
    }
  } else if (type === 0x5a || (type === 0x54 || type === 0x6e) && c.pending[0]?.flush) {
    const done = c.pending.shift();
    if (!done) return;
    const end = clock();
    emit(file, { t: Math.round(done.t * 1000) / 1000, ms: Math.round((end - done.t) * 1000) / 1000, pid: process.pid, label, pool,
      conn: c.id, backend: c.backend, kind: done.kind, sql: done.sql.length > 2000 ? done.sql.slice(0, 2000) : done.sql, ...(done.err ? { err: done.err } : {}) });
  }
}

function incoming(c: TraceConnection, chunk: Buffer, file: string, label: string, pool: string): void {
  let at = 0;
  while (at < chunk.length && !c.opaque) {
    if (c.inLeft === 0) {
      const take = Math.min(5 - c.inHeader.length, chunk.length - at);
      c.inHeader = Buffer.concat([c.inHeader, chunk.subarray(at, at + take)]); at += take;
      if (c.inHeader.length < 5) return;
      c.inType = c.inHeader[0]!; c.inLeft = c.inHeader.readInt32BE(1) - 4; c.inHeader = Buffer.alloc(0);
      c.inBody = KEEP_BODY.has(c.inType) ? [] : null;
      if (c.inLeft === 0) { message(c, c.inType, Buffer.alloc(0), file, label, pool); continue; }
    }
    const take = Math.min(c.inLeft, chunk.length - at);
    c.inBody?.push(chunk.subarray(at, at + take));
    at += take; c.inLeft -= take;
    if (c.inLeft === 0 && c.inBody) message(c, c.inType, Buffer.concat(c.inBody), file, label, pool);
  }
}

async function tracedSocket(options: { host: string[]; port: number[]; path?: string | false }, file: string, label: string, pool: string): Promise<net.Socket> {
  const opened = clock();
  const socket = options.path ? net.connect(options.path) : net.connect(options.port[0]!, options.host[0]!);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const c: TraceConnection = { id: ++connections, backend: 0, prepared: new Map(), text: '', executed: false, pending: [{ sql: '<connect>', kind: 'connect', t: opened }], out: null,
    startup: true, opaque: false, inHeader: Buffer.alloc(0), inType: 0, inLeft: 0, inBody: null };
  const write = socket.write.bind(socket) as (chunk: unknown, ...rest: unknown[]) => boolean;
  socket.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (!c.opaque && Buffer.isBuffer(chunk)) {
      outgoing(c, chunk);
      if (c.opaque) emit(file, { t: clock(), ms: 0, pid: process.pid, label, pool, conn: c.id, backend: 0, kind: 'tls_untraced', sql: '' });
    }
    return write(chunk, ...rest);
  }) as typeof socket.write;
  socket.on('data', (chunk: Buffer) => { if (!c.opaque) incoming(c, chunk, file, label, pool); });
  return socket;
}

/** Returns `options` unchanged unless GBRAIN_SQL_TRACE names a file; then adds the tracing socket and a labelled application_name. */
export function traceSqlOptions<T extends Record<string, unknown>>(options: T, pool: string): T {
  const file = process.env.GBRAIN_SQL_TRACE;
  if (!file) return options;
  const label = process.env.GBRAIN_SQL_TRACE_LABEL || process.argv[2] || 'gbrain';
  return {
    ...options,
    connection: { ...(options.connection as Record<string, unknown> | undefined), application_name: `gbrain:${label}:${process.pid}:${pool}`.slice(0, 63) },
    socket: (o: { host: string[]; port: number[]; path?: string | false }) => tracedSocket(o, file, label, pool),
  };
}
