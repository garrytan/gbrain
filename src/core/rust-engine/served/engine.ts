/**
 * A Rust engine served by a brain server (docs/designs/rust-engine/multi-user-server.md, "M1 as built"). The engine
 * never opens a store: `connect` reaches the server over protocol v3 (client.ts) and the owner client installs the
 * forwarded members (owner-ipc/client.ts `installOwnerClient`), exactly as for a local second process. It reports the
 * server's capabilities plus `served` (I-8). With the server's `txn` capability, `transaction(fn)` runs over the wire
 * (a transaction the server holds; calls on its handle carry its id); without it, `transaction` refuses as on a local
 * second process (decision N: whole operations first).
 *
 * A served engine has no election to fall back on: when the server is gone its calls end `owner_unavailable`, never
 * in a local store (review finding F5 of the L3 plan).
 */
import { readFileSync } from 'node:fs';
import type { BrainEngine, TransactionOptions } from '../../engine.ts';
import type { EngineConfig } from '../../types.ts';
import { opError } from '../../ops/contract.ts';
import { installOwnerClient, missingOnRustOwner } from '../owner-ipc/client.ts';
import { capabilityMissing } from '../errors.ts';
import { OWNER_IPC_ROUTES, ownerIpcRefusal } from '../owner-ipc/routes.ts';
import { rustMultiuserFromEnv } from '../multiuser-switch.ts';
import { connectServed, type ServedConnection } from './client.ts';
import { SERVED_STORE_CALL, STORE_RETURNING_MEMBERS } from './store-returning.ts';

export const RUST_SERVER_URL_ENV = 'GBRAIN_RUST_SERVER_URL';
export const RUST_SERVER_TOKEN_ENV = 'GBRAIN_RUST_SERVER_TOKEN';

/** Where a served engine connects; the token is read from the environment variable the config names, never stored. */
export interface ServedTarget { url: string; token?: string; ca?: Buffer }

export interface RustServerConfig { url?: string; token_env?: string; ca_file?: string }

/**
 * The brain server this config names, or null when the engine should open its own store: multi-user Rust off, or no
 * server configured. Off, a configured `rust_server` is ignored and nothing changes.
 */
export function servedTargetFor(config: EngineConfig & { rust_server?: RustServerConfig }, env: Record<string, string | undefined> = process.env): ServedTarget | null {
  // A client has no store of its own, so only the environment half of the switch can turn it on (multiuser-switch.ts).
  if (!rustMultiuserFromEnv(env)) return null;
  const url = env[RUST_SERVER_URL_ENV] || config.rust_server?.url;
  if (!url) return null;
  const tokenVar = config.rust_server?.token_env || RUST_SERVER_TOKEN_ENV;
  const token = env[tokenVar];
  let ca: Buffer | undefined;
  if (config.rust_server?.ca_file) {
    try { ca = readFileSync(config.rust_server.ca_file); } catch {
      throw opError('config_error', 'The certificate authority file rust_server.ca_file names cannot be read.', 'Point rust_server.ca_file at a readable PEM file.');
    }
  }
  return { url, ...(token ? { token } : {}), ...(ca ? { ca } : {}) };
}

type EngineRecord = Record<string, unknown>;


function storeProxy(connection: ServedConnection, member: string, ref: string | undefined): object {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args: unknown[]) => ref
        ? connection.request('call', `${member}.${prop}`, args, { txn: ref })
        : connection.request('fn', SERVED_STORE_CALL, [member, prop, args]);
    },
  });
}

/**
 * The engine-shaped handle of a transaction the server holds: every forwarded member runs inside it, and a nested
 * `transaction(fn)` opens a savepoint there. `own` is true for a transaction this client opened (it commits it);
 * a handle the server lent to a callback is ended by the server.
 */
function transactionHandle(engine: object, connection: ServedConnection, ref: string): BrainEngine {
  const handle = Object.create(engine) as EngineRecord;
  for (const [member, route] of Object.entries(OWNER_IPC_ROUTES)) {
    if (route === 'local') continue;
    const missing = missingOnRustOwner(connection.hello, member);
    const value = missing !== null
      ? () => Promise.reject(capabilityMissing(missing, member))
      : member === 'transaction' || member === 'transactionDirect'
        ? (fn: (tx: BrainEngine) => Promise<unknown>, opts?: TransactionOptions) => runTransaction(engine, connection, fn, opts, ref)
        : STORE_RETURNING_MEMBERS.has(member)
          ? async () => storeProxy(connection, member, ref)
        : route === 'refuse'
          ? () => Promise.reject(ownerIpcRefusal(member, 'reserved connections and engine callbacks do not cross the connection to the brain server'))
          : (...args: unknown[]) => connection.request('call', member, args, { txn: ref });
    Object.defineProperty(handle, member, { value, writable: true, configurable: true, enumerable: false });
  }
  Object.defineProperty(handle, '__servedTxRef', { value: ref, enumerable: false });
  // The page keys the transaction holds live on the server's transaction; this marks the handle as one that holds
  // them, as a local transaction handle is marked (persistence/origin-guard.ts reads it), and lockPageKeys on it
  // takes them there.
  Object.defineProperty(handle, '_heldPageKeys', { value: Object.freeze({ served: true }), enumerable: false });
  return handle as unknown as BrainEngine;
}

async function runTransaction<T>(engine: object, connection: ServedConnection, fn: (tx: BrainEngine) => Promise<T>,
  opts: TransactionOptions | undefined, parent?: string): Promise<T> {
  if (opts?.signal?.aborted) throw opError('cancelled', 'The transaction was cancelled before it began; nothing was written.', 'Retry the transaction.', { detail: 'member=transaction via=served' });
  const ref = String(await connection.txn('begin', { ...(parent ? { txn: parent } : {}), ...(opts?.readOnly ? { readOnly: true } : {}) }));
  const tx = transactionHandle(engine, connection, ref);
  let value: T;
  try { value = await fn(tx); }
  catch (error) {
    await connection.txn('rollback', { txn: ref }).catch(() => undefined);
    throw error;
  }
  await connection.txn('commit', { txn: ref });
  return value;
}

/**
 * Connects `engine` to its brain server and installs the forwarded members. Returns what undoes it (disconnect).
 */
export async function connectServedEngine(engine: object, target: ServedTarget): Promise<() => void> {
  const connection = await connectServed(target.url, { ...(target.token ? { token: target.token } : {}), ...(target.ca ? { ca: target.ca } : {}) });
  const undo = installOwnerClient(engine, connection);
  const record = engine as EngineRecord;
  const capabilities = record.capabilities as Set<string> | undefined;
  capabilities?.add('served');
  connection.txProxy = ref => transactionHandle(engine, connection, ref);
  for (const member of STORE_RETURNING_MEMBERS) {
    if (missingOnRustOwner(connection.hello, member) !== null) continue;
    Object.defineProperty(record, member, { value: async () => storeProxy(connection, member, undefined), writable: true, configurable: true, enumerable: false });
  }
  if (connection.caps.has('txn')) {
    for (const member of ['transaction', 'transactionDirect'] as const) {
      Object.defineProperty(record, member, {
        value: (fn: (tx: BrainEngine) => Promise<unknown>, opts?: TransactionOptions) => runTransaction(engine, connection, fn, opts),
        writable: true, configurable: true, enumerable: false,
      });
    }
  }
  return () => { for (const member of ['transaction', 'transactionDirect', ...STORE_RETURNING_MEMBERS]) delete record[member]; undo(); };
}
