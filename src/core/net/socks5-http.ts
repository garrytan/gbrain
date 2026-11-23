/**
 * A plain-HTTP GET or POST through a SOCKS5 proxy, in TypeScript with no dependency (RFC 1928, no-authentication method; RFC
 * 9112 for the request and response). socks5h semantics: a host name is sent to the proxy unresolved (address type 3),
 * so the proxy, not this host, resolves it; an IP literal goes as an IPv4 or IPv6 address. The request asks the server
 * to close the connection, and the response is read to its end, bounded, then parsed (Content-Length or chunked).
 * Used by apple/contacts-client.ts to reach GBrain Helper through a SOCKS5 proxy (for example a private network's userspace proxy).
 */
import { connect, isIP, type Socket } from 'node:net';

export interface Socks5HttpRequest {
  proxyHost: string;
  proxyPort: number;
  host: string;
  port: number;
  /** Path and query, starting with '/'. */
  path: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
  /** POST with this body (sent with Content-Length); GET when absent. */
  body?: Buffer;
}

export interface RawHttpResponse { status: number; headers: Record<string, string>; body: Buffer }

const SOCKS_REPLIES: Record<number, string> = {
  1: 'general SOCKS server failure', 2: 'connection not allowed by ruleset', 3: 'network unreachable', 4: 'host unreachable',
  5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported',
};

export class Socks5Error extends Error {
  constructor(message: string) { super(message); this.name = 'Socks5Error'; }
}

/** Bytes from the socket, read on demand; a read past maxBytes fails the request. */
class ByteReader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  constructor(socket: Socket, maxBytes: number) {
    let size = 0;
    socket.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) { this.fail(new Socks5Error(`the response exceeded ${maxBytes} bytes`)); socket.destroy(); return; }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.notify();
    });
    socket.on('end', () => { this.ended = true; this.notify(); });
    socket.on('close', () => { this.ended = true; this.notify(); });
    socket.on('error', (error) => this.fail(error));
  }
  fail(error: Error): void { this.failure ??= error; this.notify(); }
  private notify(): void { const wake = this.wake; this.wake = null; wake?.(); }
  private async next(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.ended) throw new Socks5Error('the connection closed early');
    await new Promise<void>(resolve => { this.wake = resolve; });
    if (this.failure) throw this.failure;
  }
  async take(n: number): Promise<Buffer> {
    while (this.buffer.byteLength < n) await this.next();
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }
  async rest(): Promise<Buffer> {
    while (!this.ended) {
      if (this.failure) throw this.failure;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
    if (this.failure) throw this.failure;
    return this.buffer;
  }
}

function ipv6Bytes(host: string): number[] {
  const split = (s: string) => (s ? s.split(':') : []);
  const [head = '', tail = ''] = host.split('::');
  const groups = host.includes('::') ? [...split(head), ...Array(8 - split(head).length - split(tail).length).fill('0'), ...split(tail)] : split(host);
  return groups.flatMap(g => { const v = parseInt(g, 16); return [v >> 8, v & 0xff]; });
}

function addressBytes(host: string): Buffer {
  const family = isIP(host);
  if (family === 4) return Buffer.from([1, ...host.split('.').map(Number)]);
  if (family === 6) return Buffer.from([4, ...ipv6Bytes(host)]);
  const name = Buffer.from(host, 'utf8');
  if (name.byteLength > 255) throw new Socks5Error('the host name is longer than 255 bytes');
  return Buffer.concat([Buffer.from([3, name.byteLength]), name]);
}

async function handshake(socket: Socket, reader: ByteReader, host: string, port: number): Promise<void> {
  socket.write(Buffer.from([5, 1, 0]));
  const [version, method] = await reader.take(2);
  if (version !== 5) throw new Socks5Error('the proxy is not a SOCKS5 proxy');
  if (method !== 0) throw new Socks5Error('the proxy requires an authentication method gbrain does not offer');
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), addressBytes(host), Buffer.from([port >> 8, port & 0xff])]));
  const [v, reply, , atyp] = await reader.take(4);
  if (v !== 5) throw new Socks5Error('the proxy sent a malformed reply');
  if (reply !== 0) throw new Socks5Error(`the proxy could not connect: ${SOCKS_REPLIES[reply!] ?? `reply ${reply}`}`);
  const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? (await reader.take(1))[0]! : -1;
  if (addrLen < 0) throw new Socks5Error('the proxy sent a malformed reply');
  await reader.take(addrLen + 2);
}

function dechunk(body: Buffer): Buffer {
  const out: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = body.indexOf('\r\n', at);
    if (eol < 0) throw new Socks5Error('the chunked response ended early');
    const size = parseInt(body.subarray(at, eol).toString('latin1').split(';')[0]!.trim(), 16);
    if (!Number.isSafeInteger(size) || size < 0) throw new Socks5Error('the chunked response is malformed');
    if (size === 0) return Buffer.concat(out);
    if (eol + 2 + size > body.byteLength) throw new Socks5Error('the chunked response ended early');
    out.push(body.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
}

export function parseHttpResponse(raw: Buffer): RawHttpResponse {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) throw new Socks5Error('the server sent no complete response header');
  const [statusLine, ...lines] = raw.subarray(0, end).toString('latin1').split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine ?? '');
  if (!m) throw new Socks5Error('the server sent a malformed status line');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  let body = raw.subarray(end + 4);
  if (/\bchunked\b/i.test(headers['transfer-encoding'] ?? '')) body = dechunk(body);
  else if (headers['content-length'] !== undefined) {
    const length = Number(headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 0 || length > body.byteLength) throw new Socks5Error('the response body is shorter than its Content-Length');
    body = body.subarray(0, length);
  }
  return { status: Number(m[1]), headers, body };
}

export async function socks5HttpGet(req: Socks5HttpRequest): Promise<RawHttpResponse> {
  req.signal.throwIfAborted();
  const socket = connect({ host: req.proxyHost, port: req.proxyPort });
  const reader = new ByteReader(socket, req.maxBytes);
  const abortError = () => (req.signal.reason instanceof Error ? req.signal.reason : new Socks5Error('aborted'));
  const onAbort = () => { reader.fail(abortError()); socket.destroy(); };
  req.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      req.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    await handshake(socket, reader, req.host, req.port);
    const hostHeader = isIP(req.host) === 6 ? `[${req.host}]:${req.port}` : `${req.host}:${req.port}`;
    socket.write([`${req.body ? 'POST' : 'GET'} ${req.path} HTTP/1.1`, `Host: ${hostHeader}`, 'Connection: close',
      ...(req.body ? [`Content-Length: ${req.body.length}`] : []),
      ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n'));
    if (req.body) socket.write(req.body);
    return parseHttpResponse(await reader.rest());
  } finally {
    req.signal.removeEventListener('abort', onAbort);
    socket.destroy();
  }
}
