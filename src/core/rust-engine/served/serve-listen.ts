/**
 * `gbrain serve --rust-listen <host:port>` (or GBRAIN_RUST_SERVER_LISTEN): serve this process's Rust brain to other
 * machines over protocol v3 (listener.ts). Multi-user Rust only, and only in the process that owns the brain; any
 * other case refuses at start with what to change. The serve's own transports (stdio or HTTP) are unchanged.
 */
import type { BrainEngine } from '../../engine.ts';
import { opError } from '../../ops/contract.ts';
import { rustMultiuserFromEnv, rustMultiuserSubSwitch } from '../multiuser-switch.ts';
import { storeMultiuser } from '../access-self-check.ts';
import type { OwnerEngineServer } from '../owner-ipc/server.ts';
import { RUST_SERVER_LISTEN_ENV, listenServed, parseListenAddress, tlsFromEnv, type ServedListener } from './listener.ts';
import type { ServedServerOptions } from './session.ts';

/** True when this serve was asked to listen for brain clients. */
export function rustListenRequested(args: readonly string[], env: Record<string, string | undefined> = process.env): boolean {
  // The flag always asks (and refuses with the switch off); the environment variable acts only while the environment
  // half of the switch is on, so with it off a serve starts exactly as before (review G13).
  return args.includes('--rust-listen') || (!!env[RUST_SERVER_LISTEN_ENV] && rustMultiuserFromEnv(env));
}

/**
 * Test-only: run interactive transactions over the wire on today's serialized transaction before optimistic explicit
 * transactions (lane L1) exist. Protocol evidence only; the final gate runs with it off.
 */
export const RUST_SERVED_SERIAL_TXN_ENV = 'GBRAIN_RUST_SERVED_SERIAL_TXN';

/** The brain's resolved multi-user mode: the store's answer, else the environment half (access-self-check.ts). */
export function storeMode(store: object | null | undefined): { readonly multiuser: boolean } {
  return { multiuser: store ? storeMultiuser(store) : rustMultiuserFromEnv() };
}

/**
 * The v3 options an owner starts with (rust-engine.ts election, once its store is open), or undefined when the brain
 * is not in multi-user mode.
 */
export function servedServerOptionsFor(engine: { capabilities?: ReadonlySet<string> }, store: object | null | undefined): ServedServerOptions | undefined {
  const mode = storeMode(store);
  if (!mode.multiuser) return undefined;
  return {
    // Interactive transactions over the wire: only with optimistic explicit transactions (lane L1, `multi_writer`),
    // or the test-only sub-switch that runs them on today's serialized transaction.
    // Following: offered by the session only to an owner server token on a brain with a commit log.
    follower: {},
    transactions: () => engine.capabilities?.has('multi_writer' as never) === true || rustMultiuserSubSwitch(RUST_SERVED_SERIAL_TXN_ENV, mode),
  };
}

export async function startRustListen(engine: BrainEngine, args: readonly string[], log: (line: string) => void): Promise<ServedListener> {
  const at = args.indexOf('--rust-listen');
  const value = at >= 0 ? args[at + 1] : process.env[RUST_SERVER_LISTEN_ENV];
  if (!value || value.startsWith('--')) throw opError('invalid_params', '--rust-listen needs <host>:<port>.', 'Pass --rust-listen 127.0.0.1:4141 (or a TLS address with GBRAIN_RUST_SERVER_TLS_CERT and _KEY).');
  const store = (engine as unknown as { openStoreIfOpen?: (m: string) => object | null }).openStoreIfOpen?.('rustListen');
  if (!storeMode(store).multiuser) {
    throw opError('engine_capability_missing', 'gbrain serve --rust-listen needs multi-user Rust, which is off.', 'Set GBRAIN_RUST_MULTIUSER=1, or run gbrain config set engine.rust.multiuser true, and start gbrain serve again.', { reason: 'served' });
  }
  const owner = engine.kind === 'rust' ? (engine as unknown as { ownerServer?: () => OwnerEngineServer | null }).ownerServer?.() ?? null : null;
  if (!owner) {
    throw opError('engine_capability_missing', 'gbrain serve --rust-listen serves a Rust brain this process owns, and this one does not own it.',
      'Stop the process that owns the brain (the doctor report names it), then start gbrain serve --rust-listen again.', { reason: 'served' });
  }
  const { host, port } = parseListenAddress(value);
  const listener = await listenServed(owner, { host, port, ...(tlsFromEnv() ? { tls: tlsFromEnv()! } : {}) });
  log(`[gbrain serve] brain server listening on ${listener.host}:${listener.port} (${listener.tls ? 'TLS' : 'plain TCP, loopback only'}; protocol v3; owner server tokens only)`);
  engine.registerBeforeDisconnect?.(() => listener.close());
  return listener;
}
