/**
 * The only network adapter for untrusted URLs. The caller has already checked
 * every DNS answer; connect to that literal while preserving the HTTP authority
 * and TLS identity. Bun >= 1.3.11 is required for explicit TLS serverName.
 *
 * Bun's native fetch and node:http wrapper cannot reliably disable environment
 * proxies per request. Fail closed in that environment: a proxy could resolve
 * the original hostname again. Never mutate process-wide proxy settings.
 */
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { assertSupportedBun } from './runtime-version.ts';

export interface PinnedHttpTarget {
  resolvedUrl: string;
  resolvedIp: string;
  originalHost: string;
  ipv6: boolean;
}

export interface PinnedHttpRequest {
  method: string;
  headers: Headers;
  body?: string;
  signal: AbortSignal;
}

export type PinnedHttpFetch = (
  target: PinnedHttpTarget,
  originalUrl: URL,
  init: PinnedHttpRequest,
) => Promise<Response>;

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const hasAmbientProxy = () => PROXY_VARIABLES.some(key => Boolean(process.env[key]?.trim()));
// Also remember the import-time state because runtimes may cache proxy settings.
const ambientProxyAtImport = hasAmbientProxy();

export class HttpProxyError extends Error {
  readonly code = 'PROXY_NOT_SUPPORTED';
  constructor() {
    super('Guarded URL requests require a direct connection. Remove HTTP_PROXY, HTTPS_PROXY and ALL_PROXY (including lowercase variants), then restart GBrain.');
    this.name = 'HttpProxyError';
  }
}

/** @internal Inject only the raw fetch in hermetic TLS tests. */
export function createPinnedHttpFetch(fetchImpl: typeof fetch): PinnedHttpFetch {
  return async (target, originalUrl, init) => {
    assertSupportedBun();
    if (ambientProxyAtImport || hasAmbientProxy()) throw new HttpProxyError();
    const headers = new Headers(init.headers);
    // Never accept caller-controlled routing headers. Keep non-default ports.
    headers.set('host', originalUrl.host);
    headers.set('connection', 'close');
    headers.set('accept-encoding', 'gzip, deflate, br');
    return fetchImpl(target.resolvedUrl, {
      method: init.method,
      headers,
      body: init.body,
      signal: init.signal,
      redirect: 'manual',
      keepalive: false,
      // Decode ourselves, with a cap on the decoded stream.
      decompress: false,
      ...(originalUrl.protocol === 'https:' ? {
        tls: {
          rejectUnauthorized: true,
          ...(target.originalHost ? { serverName: target.originalHost } : {}),
        },
      } : {}),
    });
  };
}

export const fetchPinnedHttp: PinnedHttpFetch = (...args) => createPinnedHttpFetch(fetch)(...args);

export class HttpBodyError extends Error {
  constructor(readonly code: 'BODY_TOO_LARGE' | 'UNSUPPORTED_ENCODING', message: string) {
    super(message);
    this.name = 'HttpBodyError';
  }
}

/** Consume a finite decoded body, destroying both network and decoder on error. */
export async function readBoundedHttpBody(res: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const encoding = (res.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
  if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) {
    await res.body?.cancel();
    throw new HttpBodyError('UNSUPPORTED_ENCODING', 'Unsupported HTTP Content-Encoding');
  }
  // Compressed Content-Length is not the decoded size. The stream limit below
  // remains authoritative for missing, misleading, and compressed lengths.
  const length = res.headers.get('content-length');
  if (encoding === 'identity' && length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await res.body?.cancel();
    throw new HttpBodyError('BODY_TOO_LARGE', `Response body exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return Buffer.alloc(0);

  const source = Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>);
  const decoder = encoding === 'gzip' ? createGunzip()
    : encoding === 'deflate' ? createInflate()
      : encoding === 'br' ? createBrotliDecompress() : undefined;
  const stream = decoder ? source.pipe(decoder) : source;
  // pipe() does not forward source errors to the destination.
  const onSourceError = (err: Error) => decoder?.destroy(err);
  source.on('error', onSourceError);
  const abort = () => {
    const err = signal.reason instanceof Error ? signal.reason : new DOMException('Request aborted', 'AbortError');
    source.destroy(err);
    decoder?.destroy(err);
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (signal.aborted) abort();
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpBodyError('BODY_TOO_LARGE', `Response body exceeds ${maxBytes} decoded bytes`);
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', abort);
    source.unpipe(decoder);
    source.destroy();
    decoder?.destroy();
  }
}
