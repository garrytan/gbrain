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
import { gbrainPath, type GBrainConfig } from '../core/config.ts';
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
 * Writes the sidecar for the brain this process serves. Writes nothing unless this process holds `dataDir`'s lock
 * and the brain has a persistence identity.
 */
export async function recordServeBrainRef(engine: Pick<BrainEngine, 'readPersistenceBrainId'>, dataDir: string): Promise<'written' | 'skipped'> {
  if (!heldLockFor(dataDir)) return 'skipped';
  const token = liveHolderToken(dataDir);
  if (!token) return 'skipped';
  const brainRef = await readBrainRef(engine);
  if (!brainRef) return 'skipped';
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
  return 'written';
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
 * `gbrain serve` start: records the sidecar for a local PGLite brain (a serve of any other brain holds no PGLite lock,
 * so `recordServeBrainRef` skips it); a failure costs only the status field and one log line.
 */
export async function recordServeBrainRefAtStart(
  engine: Pick<BrainEngine, 'readPersistenceBrainId'>,
  cfg: GBrainConfig | null,
  log: (line: string) => void = line => console.error(line),
): Promise<void> {
  if (!cfg || cfg.remote_mcp || cfg.database_url) return;
  try {
    await recordServeBrainRef(engine, cfg.database_path ?? gbrainPath('brain.pglite'));
  } catch (error) {
    log(`[gbrain serve] brain_ref not recorded for engine status (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}
