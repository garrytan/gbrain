/**
 * Which process owns a Rust brain (docs/designs/RUST_ENGINE.md, "Owner protocol for the Rust engine"). The first
 * process to take the owner lock (`<database_path>.gbrain-owner.lock`, a kernel lock the OS drops when the process
 * dies) owns the brain and serves its engine on `<database_path>/.gbrain-owner.sock`. Every other process connects
 * there as a client instead of failing with `store_locked`.
 *
 * Election retries for a bounded time: an owner that holds the lock but has not bound its socket yet, or one that just
 * exited, is waited for; once the lock is free this process takes it. A client whose owner exits runs the election
 * again on its next call (client.ts `rejoin`, RustEngine `_takeOver`); its calls in flight end `owner_unavailable`
 * (routes.ts `ownerGone`, `outcome_unknown`) and are never sent again, since the owner may have started them.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from '../../engine.ts';
import { opError } from '../../ops/contract.ts';
import { tryAcquireNativeLock, type NativeLockHandle } from '../../persistence/native-lock.ts';
import { parseGlobalFlags } from '../../cli-options.ts';
import { connectOwner, type OwnerConnection } from './client.ts';
import { recordOwnedRustBrain } from '../owned-brains.ts';
import { canonicalDatabasePath, ownerLockPath, ownerSocketPath } from './protocol.ts';
import { serveOwnerEngine, type OwnerEngineServer, type OwnerServerOptions } from './server.ts';

/** How long a process keeps trying to become the owner or reach it before it reports `owner_unavailable`. */
export const OWNER_ELECTION_WAIT_MS = 5_000;
const ELECTION_POLL_MS = 25;

/** True when this process runs `gbrain serve` (an owner that also answers whole MCP operations). */
export function processIsServe(argv: readonly string[] = process.argv): boolean {
  try { return parseGlobalFlags(argv.slice(2)).rest[0] === 'serve'; } catch { return false; }
}

export type OwnerRole =
  | { role: 'owner'; lock: NativeLockHandle; server: OwnerEngineServer }
  | { role: 'client'; connection: OwnerConnection };

export interface ElectOptions extends OwnerServerOptions {
  waitMs?: number;
  /** False: the store directory must already be there; nothing is created and a missing one throws `brain_missing`. */
  createStore?: boolean;
  /**
   * Runs once this process holds the owner lock and before its socket serves (the Rust engine opens its store here).
   * It returns the step that undoes it, run before the lock is released when serving fails. When it throws, the lock
   * is released and the election ends with that error.
   */
  onLock?: () => Promise<(() => Promise<void>) | void>;
}

function retryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
}

/**
 * Takes the owner lock and serves `engine`, or connects to the process that holds it. Throws `owner_unavailable`
 * (`not_sent`) when neither works within `waitMs`.
 */
export async function electOwner(engine: BrainEngine, databasePath: string, opts: ElectOptions = {}): Promise<OwnerRole> {
  const lockPath = ownerLockPath(databasePath);
  const socketPath = ownerSocketPath(databasePath);
  const storeDir = canonicalDatabasePath(databasePath);
  if (opts.createStore === false) {
    // An existing brain: no folder is made, so a moved store or an unmounted drive is never replaced by an empty one.
    const { rustStoreGuard } = await import('../../../commands/doctor/missing-brain.ts');
    const { configPath } = await import('../../config.ts');
    const verdict = rustStoreGuard(storeDir, configPath(), 'serve', false);
    if (typeof verdict !== 'string') throw verdict;
  }
  mkdirSync(dirname(lockPath), { recursive: true });
  // The store directory is private whatever the socket length: a short socket path hardens it to 0700 as the socket's
  // parent, but a long one moves the socket elsewhere, so the store's own files would keep the umask's mode.
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(storeDir, 0o700);
  const deadline = Date.now() + (opts.waitMs ?? OWNER_ELECTION_WAIT_MS);
  let lastError: unknown;
  for (;;) {
    const lock = await tryAcquireNativeLock(lockPath);
    if (lock) {
      let undo: (() => Promise<void>) | void = undefined;
      try { undo = await opts.onLock?.(); }
      catch (error) { await lock.release(); throw error; }
      try {
        const { waitMs: _waitMs, onLock: _onLock, createStore: _createStore, ...serverOpts } = opts;
        const server = await serveOwnerEngine(engine, socketPath, { ...serverOpts, serve: opts.serve ?? processIsServe() });
        if (server) { recordOwnedRustBrain(databasePath, lock); return { role: 'owner', lock, server }; }
        lastError = new Error('The owner socket is claimed by another process.');
      } catch (error) {
        lastError = error;
      }
      if (undo) await undo();
      await lock.release();
    } else {
      try {
        return { role: 'client', connection: await connectOwner(socketPath, { timeoutMs: Math.max(250, deadline - Date.now()) }) };
      } catch (error) {
        if (!retryable(error)) throw error;
        lastError = error;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, ELECTION_POLL_MS));
  }
  throw opError('owner_unavailable',
    'Another process holds this brain, and it did not answer on its owner socket in time, so nothing was sent.',
    'Run the command again. If it keeps failing, find the process that holds the brain (gbrain serve, a sync, an import) and stop it.',
    { reason: 'not_sent', retryable: true,
      detail: `lock=${lockPath} socket=${socketPath} via=owner_ipc last_error=${(lastError as Error | undefined)?.message ?? 'none'}`,
      why: 'One process owns a Rust brain at a time; the others reach it through the owner socket.' });
}
