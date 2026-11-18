/**
 * Which process owns a Rust brain (docs/designs/RUST_ENGINE.md, "Owner protocol for the Rust engine"). The first
 * process to take the owner lock (`<database_path>.gbrain-owner.lock`, a kernel lock the OS drops when the process
 * dies) owns the brain and serves its engine on `<database_path>/.gbrain-owner.sock`. Every other process connects
 * there as a client instead of failing with `store_locked`.
 *
 * Election retries for a bounded time: an owner that holds the lock but has not bound its socket yet, or one that just
 * exited, is waited for; once the lock is free this process takes it. Handing the brain over while calls are in
 * flight is not part of this release (routes.ts `ownerGone`).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from '../../engine.ts';
import { opError } from '../../ops/contract.ts';
import { tryAcquireNativeLock, type NativeLockHandle } from '../../persistence/native-lock.ts';
import { parseGlobalFlags } from '../../cli-options.ts';
import { connectOwner, type OwnerConnection } from './client.ts';
import { ownerLockPath, ownerSocketPath } from './protocol.ts';
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
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + (opts.waitMs ?? OWNER_ELECTION_WAIT_MS);
  let lastError: unknown;
  for (;;) {
    const lock = await tryAcquireNativeLock(lockPath);
    if (lock) {
      try {
        const server = await serveOwnerEngine(engine, socketPath, { ...opts, serve: opts.serve ?? processIsServe() });
        if (server) return { role: 'owner', lock, server };
        lastError = new Error('The owner socket is claimed by another process.');
      } catch (error) {
        lastError = error;
      }
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
