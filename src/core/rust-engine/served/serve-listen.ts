/**
 * `gbrain serve --rust-listen <host:port>` (or GBRAIN_RUST_SERVER_LISTEN): serve this process's Rust brain to other
 * machines over protocol v3 (listener.ts). Multi-user Rust only, and only in the process that owns the brain; any
 * other case refuses at start with what to change. The serve's own transports (stdio or HTTP) are unchanged.
 */
import type { BrainEngine } from '../../engine.ts';
import { opError } from '../../ops/contract.ts';
import { rustMultiuserOn, rustMultiuserSubSwitch, RUST_SERVED_SERIAL_TXN_ENV } from '../multiuser.ts';
import type { OwnerEngineServer } from '../owner-ipc/server.ts';
import { RUST_SERVER_LISTEN_ENV, listenServed, parseListenAddress, tlsFromEnv, type ServedListener } from './listener.ts';
import type { ServedServerOptions } from './session.ts';

/** True when this serve was asked to listen for brain clients. */
export function rustListenRequested(args: readonly string[], env: Record<string, string | undefined> = process.env): boolean {
  return args.includes('--rust-listen') || !!env[RUST_SERVER_LISTEN_ENV];
}

/** The v3 options an owner starts with (rust-engine.ts election), or undefined with multi-user Rust off. */
export function servedServerOptionsFor(engine: { capabilities?: ReadonlySet<string> }): ServedServerOptions | undefined {
  if (!rustMultiuserOn()) return undefined;
  return {
    // Interactive transactions over the wire: only with optimistic explicit transactions (lane L1, `multi_writer`),
    // or the test-only sub-switch that runs them on today's serialized transaction.
    transactions: () => engine.capabilities?.has('multi_writer' as never) === true || rustMultiuserSubSwitch(RUST_SERVED_SERIAL_TXN_ENV),
  };
}

export async function startRustListen(engine: BrainEngine, args: readonly string[], log: (line: string) => void): Promise<ServedListener> {
  const at = args.indexOf('--rust-listen');
  const value = at >= 0 ? args[at + 1] : process.env[RUST_SERVER_LISTEN_ENV];
  if (!value || value.startsWith('--')) throw opError('invalid_params', '--rust-listen needs <host>:<port>.', 'Pass --rust-listen 127.0.0.1:4141 (or a TLS address with GBRAIN_RUST_SERVER_TLS_CERT and _KEY).');
  if (!rustMultiuserOn()) {
    throw opError('engine_capability_missing', 'gbrain serve --rust-listen needs multi-user Rust, which is off.', 'Set GBRAIN_RUST_MULTIUSER=1 and start gbrain serve again.', { reason: 'served' });
  }
  const owner = engine.kind === 'rust' ? (engine as unknown as { ownerServer?: () => OwnerEngineServer | null }).ownerServer?.() ?? null : null;
  if (!owner) {
    throw opError('engine_capability_missing', 'gbrain serve --rust-listen serves a Rust brain this process owns, and this one does not own it.',
      'Stop the process that owns the brain (gbrain doctor names it), then start gbrain serve --rust-listen again.', { reason: 'served' });
  }
  const { host, port } = parseListenAddress(value);
  const listener = await listenServed(owner, { host, port, ...(tlsFromEnv() ? { tls: tlsFromEnv()! } : {}) });
  log(`[gbrain serve] brain server listening on ${listener.host}:${listener.port} (${listener.tls ? 'TLS' : 'plain TCP, loopback only'}; protocol v3; owner server tokens only)`);
  engine.registerBeforeDisconnect?.(() => listener.close());
  return listener;
}
