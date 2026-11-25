/**
 * The process that owns a local brain and takes work a second process hands it (docs/designs/RUST_ENGINE.md,
 * "Process model"): a PGLite brain's lock holder, or a Rust brain's owner (its owner socket's hello).
 *
 * The CLI's delegates ask here before they send work to a resident owner, so a Rust brain is routed the way a PGLite
 * brain is. A Rust owner takes persistence work (writes, sync, fact repair, refresh, code reindex) only when it is a
 * `gbrain serve` whose engine reports `persistence_journal`, the same check `maybeDelegateLocalOperation` makes on the
 * Rust engine trunk (`inspectRustOwner` + `rustOwnerServesPersistence`). It must also answer its persistence socket:
 * until a Rust serve binds that socket, every caller keeps the engine path it takes today. Any other Rust owner leaves
 * the call to the engine path, which reaches the owner as its client and refuses typed where a capability is missing.
 */
import { join } from 'node:path';
import { inspectLockHolder, type LockHolderInfo } from '../pglite-lock.ts';
import { probeLivePgliteHolder } from '../bootstrap/uninstall.ts';
import { localIpcSocketPath } from '../context/ipc-path.ts';
import { ownerSocketPath } from '../rust-engine/owner-ipc/protocol.ts';
import { readIpcSecret, resolveSocketPath, socketHasLiveListener } from '../context/resolve-ipc.ts';
import { persistenceSocketPathForConfig } from './ipc.ts';

/** The engine of a brain kept in a local directory, whose owner process can take delegated work. */
export type LocalBrainEngine = 'pglite' | 'rust';

interface LocalBrainConfig { engine?: string; database_path?: string; database_url?: string }

/** "PGLite" or "Rust" for each engine kept in a local directory; also the set of those engines. */
const LOCAL_ENGINE_LABELS: Readonly<Record<LocalBrainEngine, string>> = { pglite: 'PGLite', rust: 'Rust' };

/** `pglite` or `rust` for a brain kept in a local directory; null for Postgres, a URL, or no path. */
export function localBrainEngine(config: LocalBrainConfig | null | undefined): LocalBrainEngine | null {
  if (!config?.database_path || config.database_url || !config.engine) return null;
  return Object.hasOwn(LOCAL_ENGINE_LABELS, config.engine) ? config.engine as LocalBrainEngine : null;
}

/** The owner's persistence socket. A Rust brain keeps it in its store directory, as PGLite does. */
export function residentPersistenceSocketPath(engine: LocalBrainEngine, config: LocalBrainConfig): string | null {
  switch (engine) {
    case 'pglite': return persistenceSocketPathForConfig(config as Parameters<typeof persistenceSocketPathForConfig>[0]);
    case 'rust': return localIpcSocketPath(join(config.database_path!, '.gbrain-persistence.sock'));
    default: { const unreachable: never = engine; return unreachable; }
  }
}

export interface ResidentOwner {
  engine: LocalBrainEngine;
  databasePath: string;
  socketPath: string | null;
  holder: LockHolderInfo;
  /** Reads the holder again (the owner-startup wait in local-client.ts re-checks it is still the same serve). */
  inspect: () => LockHolderInfo | Promise<LockHolderInfo>;
}

/**
 * The resident owner that takes persistence work for `config`, or null when the caller keeps the engine path: no
 * holder; or a Rust owner that is not a serve, lacks `persistence_journal`, or does not answer its persistence socket.
 */
export async function persistenceResidentOwner(config: LocalBrainConfig | null | undefined): Promise<ResidentOwner | null> {
  const engine = localBrainEngine(config);
  if (!engine) return null;
  const databasePath = config!.database_path!;
  const socketPath = residentPersistenceSocketPath(engine, config!);
  switch (engine) {
    case 'pglite': {
      const inspect = () => inspectLockHolder(databasePath);
      const holder = inspect();
      return holder.held ? { engine, databasePath, socketPath, holder, inspect } : null;
    }
    case 'rust': return rustPersistenceOwner(databasePath, socketPath);
    default: { const unreachable: never = engine; return unreachable; }
  }
}

async function rustPersistenceOwner(databasePath: string, socketPath: string | null): Promise<ResidentOwner | null> {
  // Loaded only for a Rust brain, so a PGLite command never loads the Rust owner client.
  const { inspectRustOwner, rustOwnerServesPersistence } = await import('../rust-engine/owner-ipc/client.ts');
  const inspect = () => inspectRustOwner(databasePath);
  const holder = await inspect();
  if (!holder.held || holder.serve !== true || !rustOwnerServesPersistence(holder.capabilities)) return null;
  if (!socketPath || !(await socketHasLiveListener(socketPath))) return null;
  return { engine: 'rust', databasePath, socketPath, holder, inspect };
}

/**
 * The live `gbrain serve` that takes a delegated sync or sweep over its hook socket, or null when the caller keeps
 * the engine path. A Rust serve counts only once its hook socket and secret exist in the store directory; until a
 * Rust serve binds them, a Rust brain's sync and sweep run as they do today.
 */
export async function hookServeOwner(engine: LocalBrainEngine, dataDir: string): Promise<{ pid: number; serve: true } | null> {
  switch (engine) {
    case 'pglite': {
      const holder = probeLivePgliteHolder(dataDir);
      return holder?.serve ? { pid: holder.pid, serve: true } : null;
    }
    case 'rust': return rustHookServe(dataDir);
    default: { const unreachable: never = engine; return unreachable; }
  }
}

async function rustHookServe(dataDir: string): Promise<{ pid: number; serve: true } | null> {
  const { inspectRustOwner } = await import('../rust-engine/owner-ipc/client.ts');
  const holder = await inspectRustOwner(dataDir);
  if (!holder.held || holder.serve !== true || holder.pid === undefined || !readIpcSecret(dataDir)) return null;
  if (!(await socketHasLiveListener(resolveSocketPath(dataDir)))) return null;
  return { pid: holder.pid, serve: true };
}

/**
 * True while the serve that took a delegated sync or sweep still holds the brain, for the re-checks after a lost
 * acknowledgment and between status polls. A false answer lets the caller run the work itself, so a Rust owner counts
 * as gone only when its owner socket refuses connections (the kernel drops the owner lock and the listener together
 * when the owner exits). A busy owner that does not answer its hello in time still holds the brain, and so does one
 * whose pid this process cannot see (another PID namespace): the pid it advertised is not proof of death here.
 */
export async function hookServeStillHolds(engine: LocalBrainEngine, dataDir: string): Promise<boolean> {
  switch (engine) {
    case 'pglite': return probeLivePgliteHolder(dataDir)?.serve === true;
    case 'rust': return socketHasLiveListener(ownerSocketPath(dataDir));
    default: { const unreachable: never = engine; return unreachable; }
  }
}

/** "PGLite" or "Rust", for messages that name the brain a serve holds. */
export const engineLabel = (engine: LocalBrainEngine): string => LOCAL_ENGINE_LABELS[engine];
