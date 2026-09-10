/** Filesystem boundary for the four generic remote jobs; not an OS sandbox.
 * Trust model excludes hostile concurrent same-UID or cross-brain writers.
 * Cooperating writers in this brain share the canonical worktree lock.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { LockStolenError, LockUnavailableError, withRefreshingLock } from '../db-lock.ts';
import { discoverGitRoot } from '../sync-git.ts';
import { authorityDigest, currentRemoteJobAuthority, currentJobSignal } from './submission-authority.ts';

const heldRoots = new AsyncLocalStorage<ReadonlySet<string>>();
const filesystemSignal = new AsyncLocalStorage<AbortSignal>();
const filesystemLeases = new AsyncLocalStorage<Array<{ key: string; lost: boolean }>>();
export function currentSourceFilesystemSignal(): AbortSignal | undefined {
  const local = filesystemSignal.getStore(), job = currentJobSignal();
  return local && job && local !== job ? AbortSignal.any([local, job]) : local ?? job;
}
export function assertSourceFilesystemActive(allowCallerAbort = false): void {
  // Lease ownership is independent of caller cancellation: a timeout racing a
  // later lease loss must never hide the loss behind a resumable partial result.
  for (const lease of filesystemLeases.getStore() ?? []) if (lease.lost) throw new LockStolenError(lease.key);
  if (allowCallerAbort) return;
  const signal = currentSourceFilesystemSignal();
  // Some Bun versions drop an asynchronously created AbortSignal reason.
  if (signal?.aborted) throw signal.reason ?? new DOMException('Source filesystem work cancelled or lock lease lost', 'AbortError');
}
function lockRoot(path: string): string {
  let canonical = resolve(path);
  try { canonical = realpathSync(canonical); } catch { /* local initialization may create it */ }
  try { if (statSync(canonical).isFile()) canonical = dirname(canonical); } catch { /* nonexistent local target */ }
  try { return realpathSync(discoverGitRoot(canonical)); } catch { return canonical; }
}
function encloses(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
export function hasSourceFilesystemLock(path: string): boolean {
  const canonical = lockRoot(path);
  return [...heldRoots.getStore() ?? []].some(root => encloses(root, canonical));
}
async function registeredLockRoot(engine: BrainEngine, path: string): Promise<string> {
  let root = lockRoot(path);
  const sources = await engine.executeRaw<{ local_path: string }>(`SELECT local_path FROM sources WHERE local_path IS NOT NULL AND local_path <> ''`);
  // A registered non-Git parent can contain a Git source. Canonicalize every
  // registered source through the same worktree rule, then choose the outermost
  // ancestor so overlapping sources agree regardless of which one starts first.
  for (const source of sources) {
    const candidate = lockRoot(source.local_path);
    if (encloses(candidate, root)) root = candidate;
  }
  return root;
}
export async function withSourceFilesystemLock<T>(engine: BrainEngine, path: string, fn: () => Promise<T>, opts: { signal?: AbortSignal; waitMs?: number } = {}): Promise<T> {
  assertSourceFilesystemActive();
  if (hasSourceFilesystemLock(path)) return fn();
  const root = await registeredLockRoot(engine, path);
  const held = new Set(heldRoots.getStore() ?? []);
  held.add(root);
  const key = `gbrain-fs:${authorityDigest(root)}`;
  const inheritedSignal = currentSourceFilesystemSignal();
  const signal = opts.signal && inheritedSignal ? AbortSignal.any([opts.signal, inheritedSignal]) : opts.signal ?? inheritedSignal;
  const deadline = Date.now() + (opts.waitMs ?? 5000);
  for (;;) {
    signal?.throwIfAborted();
    let entered = false;
    try {
      const lost = new AbortController();
      const lease = { key, lost: false };
      const activeSignal = signal ? AbortSignal.any([signal, lost.signal]) : lost.signal;
      return await withRefreshingLock(engine, key, () => {
        entered = true;
        return heldRoots.run(held, () => filesystemLeases.run([...(filesystemLeases.getStore() ?? []), lease], () => filesystemSignal.run(activeSignal, async () => {
          assertSourceFilesystemActive();
          const result = await fn();
          assertSourceFilesystemActive();
          return result;
        })));
      }, { onLockLost: reason => { lease.lost = true; lost.abort(reason); } });
    } catch (err) {
      // Retry acquisition only: never rerun a partially executed callback.
      if (entered || !(err instanceof LockUnavailableError) || err.lockId !== key || Date.now() >= deadline) throw err;
      await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }
}

export function assertSourceFilePath(path: string): string {
  assertSourceFilesystemActive();
  const authority = currentRemoteJobAuthority();
  if (!authority) return path;
  const root = authority.grant.canonicalRoot;
  if (realpathSync(root) !== root) throw new Error('Source root changed during job');
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Source file escapes registered root');
  let component = root;
  for (const part of rel.split(sep)) {
    component = resolve(component, part);
    if (lstatSync(component).isSymbolicLink()) throw new Error('Remote source jobs do not follow symlinks');
  }
  const real = realpathSync(absolute);
  const realRel = relative(root, real);
  if (isAbsolute(realRel) || realRel === '..' || realRel.startsWith(`..${sep}`)) throw new Error('Source file escapes registered root');
  return real;
}

function openSourceFile(path: string, write: boolean): number {
  const real = assertSourceFilePath(path);
  if (constants.O_NOFOLLOW === undefined) throw new Error('Remote filesystem jobs require O_NOFOLLOW support');
  const fd = openSync(real, (write ? constants.O_WRONLY : constants.O_RDONLY) | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Source path must identify a regular file');
    // Parent-directory checks and final-descriptor checks are complementary;
    // the descriptor is retained through I/O rather than reopening the path.
    assertSourceFilePath(real);
    return fd;
  } catch (err) { closeSync(fd); throw err; }
}
export function readSourceFileSync(path: string): Buffer;
export function readSourceFileSync(path: string, encoding: BufferEncoding): string;
export function readSourceFileSync(path: string, encoding?: BufferEncoding): Buffer | string {
  assertSourceFilesystemActive();
  if (!currentRemoteJobAuthority()) return encoding ? readFileSync(path, encoding) : readFileSync(path);
  const fd = openSourceFile(path, false);
  try { return encoding ? readFileSync(fd, encoding) : readFileSync(fd); }
  finally { closeSync(fd); }
}
export function writeSourceFileSync(path: string, content: string): void {
  assertSourceFilesystemActive();
  if (!currentRemoteJobAuthority()) { writeFileSync(path, content); return; }
  const fd = openSourceFile(path, true);
  try { assertSourceFilesystemActive(); ftruncateSync(fd, 0); writeFileSync(fd, content); }
  finally { closeSync(fd); }
}
