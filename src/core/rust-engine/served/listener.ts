/**
 * The network listener of a served Rust brain (docs/designs/rust-engine/multi-user-server.md, "M1 as built").
 * `gbrain serve --rust-listen <host:port>` starts it in the process that owns the brain, with multi-user Rust on.
 * Every connection speaks protocol v3 through the owner's own dispatcher (owner-ipc/server.ts `attachServed`), so
 * the network and the Unix socket share one set of permits, queues and bounds.
 *
 * TLS is required (a certificate and key from `GBRAIN_RUST_SERVER_TLS_CERT` / `GBRAIN_RUST_SERVER_TLS_KEY`, or the
 * options); plain TCP is accepted only on a loopback address. The TLS handshake has the hello's own time bound.
 */
import net, { type Server } from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { opError } from '../../ops/contract.ts';
import type { OwnerEngineServer } from '../owner-ipc/server.ts';

export const RUST_SERVER_LISTEN_ENV = 'GBRAIN_RUST_SERVER_LISTEN';
export const RUST_SERVER_TLS_CERT_ENV = 'GBRAIN_RUST_SERVER_TLS_CERT';
export const RUST_SERVER_TLS_KEY_ENV = 'GBRAIN_RUST_SERVER_TLS_KEY';

export interface ServedListenOptions {
  host: string;
  port: number;
  /** PEM certificate chain and key; without them only a loopback address may listen. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  handshakeTimeoutMs?: number;
}

export interface ServedListener {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  close(): Promise<void>;
}

/** True for 127.0.0.0/8, ::1 and localhost. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Parses `host:port` (`[v6]:port` too). */
export function parseListenAddress(value: string): { host: string; port: number } {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(value.trim());
  const port = m ? Number(m[2]) : NaN;
  if (!m || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw opError('invalid_params', `The brain server listen address "${value}" is not host:port.`, 'Pass --rust-listen <host>:<port>, for example 127.0.0.1:4141.');
  }
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port };
}

/** The TLS material the environment names, read once; undefined when neither variable is set. */
export function tlsFromEnv(env: Record<string, string | undefined> = process.env): { cert: Buffer; key: Buffer } | undefined {
  const certPath = env[RUST_SERVER_TLS_CERT_ENV];
  const keyPath = env[RUST_SERVER_TLS_KEY_ENV];
  if (!certPath && !keyPath) return undefined;
  if (!certPath || !keyPath) {
    throw opError('config_error', 'The brain server needs both a TLS certificate and its key.', `Set both ${RUST_SERVER_TLS_CERT_ENV} and ${RUST_SERVER_TLS_KEY_ENV} to PEM files.`);
  }
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

/** Starts the listener on `owner`, which must have been started with `served` options. */
export async function listenServed(owner: OwnerEngineServer, opts: ServedListenOptions): Promise<ServedListener> {
  const attach = owner.attachServed;
  if (!attach) {
    throw opError('engine_capability_missing', 'This process cannot serve the brain over the network: multi-user Rust is off or it does not own the brain.',
      'Set GBRAIN_RUST_MULTIUSER=1 and run gbrain serve --rust-listen in the process that owns the brain.', { reason: 'served' });
  }
  if (!opts.tls && !isLoopbackHost(opts.host)) {
    throw opError('config_error', `The brain server would listen on ${opts.host} without TLS, which is allowed only on a loopback address.`,
      `Set ${RUST_SERVER_TLS_CERT_ENV} and ${RUST_SERVER_TLS_KEY_ENV}, or listen on 127.0.0.1.`);
  }
  const handshakeTimeout = opts.handshakeTimeoutMs ?? 5_000;
  // Every accepted connection, so close() ends idle clients instead of waiting for them (review G10).
  const accepted = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
    attach(socket);
  };
  const server: Server = opts.tls
    ? tls.createServer({ cert: opts.tls.cert, key: opts.tls.key, minVersion: 'TLSv1.2', handshakeTimeout }, socket => track(socket))
    : net.createServer(socket => track(socket));
  server.on('tlsClientError', (_error: unknown, socket: { destroy(): void }) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => { server.off('error', reject); server.on('error', () => {}); resolve(); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  let closed: Promise<void> | undefined;
  return {
    host: opts.host, port, tls: !!opts.tls,
    close: () => (closed ??= new Promise<void>(resolve => {
      server.close(() => resolve());
      // The owner's dispatcher aborts the calls of each connection when it closes; work already started settles there.
      for (const socket of accepted) socket.destroy();
    })),
  };
}
