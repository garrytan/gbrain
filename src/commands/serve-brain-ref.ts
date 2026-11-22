/**
 * The brain reference a running `gbrain serve` leaves for `gbrain engine status --probe` (src/core/brain-ref.ts).
 *
 * A serve holds a PGLite brain's single-writer lock for as long as it runs, so the status probe cannot open the brain
 * to read its identity. At start the serve writes `<data dir>.gbrain-brain-ref.json` (0600, replaced atomically): the
 * `brain_ref` and a digest of the owner token its lock recorded. The identity itself is never written. The status
 * probe trusts the file only while the lock's live holder recorded that same token, so a file an earlier serve left,
 * or one written for a data directory that was replaced since, is never read as current.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { readBrainRef } from '../core/brain-ref.ts';
import { flushDirectory } from '../core/fs-durable.ts';
import { openedPgliteDatastore, registerPgliteReopen } from '../core/pglite-lifecycle.ts';
import { getPgliteKernelLockPath, heldLockFor, liveHolderToken } from '../core/pglite-lock.ts';

const BRAIN_REF = /^[0-9a-f]{16}$/;

/** `<canonical data dir>.gbrain-brain-ref.json`, a sibling of the kernel lock file. */
export function brainRefSidecarPath(dataDir: string): string {
  return getPgliteKernelLockPath(dataDir)!.replace(/\.gbrain-owner\.lock$/, '.gbrain-brain-ref.json');
}

function holderDigest(token: string): string {
  return createHash('sha256').update(`gbrain-brain-ref-holder-v1\0${token}`).digest('hex').slice(0, 16);
}

/**
 * Writes the sidecar for the brain this process serves and returns the reference it wrote, or null when it wrote
 * nothing: this process does not hold `dataDir`'s lock, or the brain has no persistence identity. `known` is a
 * reference already read for this same datastore, so a rewrite under a new lock token reads nothing from the database.
 */
export async function recordServeBrainRef(
  engine: Pick<BrainEngine, 'readPersistenceBrainId'>,
  dataDir: string,
  known?: string,
): Promise<string | null> {
  if (!heldLockFor(dataDir)) return null;
  const token = liveHolderToken(dataDir);
  if (!token) return null;
  const brainRef = known ?? await readBrainRef(engine);
  if (!brainRef) return null;
  const path = brainRefSidecarPath(dataDir);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ version: 1, brain_ref: brainRef, holder: holderDigest(token) })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  flushDirectory(dirname(path), { bestEffort: true });
  return brainRef;
}

export type ServeBrainRef =
  | { brain_ref: string }
  | { brain_ref: null; note: 'serve_brain_ref_missing' | 'serve_brain_ref_stale' };

/** The `brain_ref` the live serve of `dataDir` recorded, or why there is none. Read-only. */
export function readServeBrainRef(dataDir: string): ServeBrainRef {
  let doc: { version?: unknown; brain_ref?: unknown; holder?: unknown };
  try {
    doc = JSON.parse(readFileSync(brainRefSidecarPath(dataDir), 'utf8'));
  } catch {
    return { brain_ref: null, note: 'serve_brain_ref_missing' };
  }
  const token = liveHolderToken(dataDir);
  if (!token || doc?.version !== 1 || typeof doc.brain_ref !== 'string' || !BRAIN_REF.test(doc.brain_ref) || doc.holder !== holderDigest(token)) {
    return { brain_ref: null, note: 'serve_brain_ref_stale' };
  }
  return { brain_ref: doc.brain_ref };
}

/**
 * `gbrain serve` start: records the sidecar for the PGLite datastore the served engine itself opened (a mounted brain's
 * own data dir, never the host config's), and records it again after every reopen of that engine, since a reconnect
 * takes a fresh lock token. Any other engine opened no PGLite datastore, so nothing is written.
 *
 * The identity is read from the database once, here at start, and kept whether or not the first write lands. A reopen
 * only schedules a rewrite (setImmediate, so nothing runs inside the reconnect) that reuses that reference and sends no
 * statement to the database, so a reconnect or a close never waits on this file. Serve calls this without awaiting
 * it, and every failure ends here as one log line with an error code (never a message, which could carry a path or
 * identity).
 */
export async function recordServeBrainRefAtStart(
  engine: Pick<BrainEngine, 'readPersistenceBrainId'>,
  log: (line: string) => void = line => console.error(line),
): Promise<void> {
  let cached: { dataDir: string; brainRef: string } | null = null;
  const guarded = async (step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      log(`[gbrain serve] brain_ref not recorded for engine status (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  };
  registerPgliteReopen(engine, sameDatastore => {
    setImmediate(() => {
      void guarded(async () => {
        const dataDir = openedPgliteDatastore(engine);
        if (!dataDir || !sameDatastore || cached?.dataDir !== dataDir) return;
        await recordServeBrainRef(engine, dataDir, cached.brainRef);
      });
    });
  });
  await guarded(async () => {
    const dataDir = openedPgliteDatastore(engine);
    if (!dataDir || !heldLockFor(dataDir)) return;
    const brainRef = await readBrainRef(engine);
    if (!brainRef) return;
    cached = { dataDir, brainRef };
    await recordServeBrainRef(engine, dataDir, brainRef);
  });
}
