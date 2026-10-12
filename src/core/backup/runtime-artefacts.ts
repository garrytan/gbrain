/**
 * #5312: gbrain's own IPC endpoints live INSIDE the PGLite data dir
 * (`resolveSocketPathForConfig` → `<database_path>/.gbrain-<kind>.sock`), and
 * PGLite's `dumpDataDir` cannot read a non-regular file, so one socket left by
 * a killed `gbrain serve` wedges every later `backup create` until a human
 * deletes it. The sweep below runs under the engine's writer lock, right
 * before the dump, and removes ONLY those two gbrain artefacts, ONLY when their
 * holder is provably dead (no bind claim holder AND no live listener). Any
 * other socket, FIFO or symlink at the data dir's top level is left in place
 * and named, so the typed `backup_dump_failed` refusal tells the operator what
 * blocks the dump instead of a bare WASI errno. Symlinks are never followed and
 * regular files are never deleted: the engine lock proves there is no PGLite
 * owner, not that an arbitrary endpoint belongs to a dead gbrain process.
 */
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveSocketPathForConfig, socketHasLiveListener } from '../context/resolve-ipc.ts';
import { claimLocalIpcBinding } from '../context/ipc-path.ts';
import { AgentInstallError } from '../agent-install/state.ts';

export type KeptArtefactReason = 'live_listener' | 'symlink' | 'not_a_socket' | 'foreign_socket' | 'foreign_fifo';

export interface RuntimeArtefactSweep {
  /** gbrain runtime sockets whose holder was dead; unlinked before the dump. */
  removed: string[];
  /** Non-regular entries the sweep refused to touch, with the reason it left each one. */
  kept: { path: string; reason: KeptArtefactReason }[];
}

const GBRAIN_SOCKET_KINDS = ['resolve', 'persistence'] as const;

function entryStat(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Remove gbrain's dead runtime sockets from `dataDir`; list every other non-regular top-level entry. Call only while holding the PGLite writer lock. */
export async function sweepStaleRuntimeArtefacts(dataDir: string): Promise<RuntimeArtefactSweep> {
  const dir = resolve(dataDir);
  const sweep: RuntimeArtefactSweep = { removed: [], kept: [] };
  const owned = new Set<string>();
  for (const kind of GBRAIN_SOCKET_KINDS) {
    const path = resolveSocketPathForConfig({ engine: 'pglite', database_path: dataDir }, kind);
    // A path budget overflow relocates the socket under the system temp root; nothing in the data dir then.
    if (!path || dirname(resolve(path)) !== dir) continue;
    owned.add(resolve(path));
    const stat = entryStat(path);
    if (!stat) continue;
    if (stat.isSymbolicLink()) { sweep.kept.push({ path, reason: 'symlink' }); continue; }
    if (!stat.isSocket()) { sweep.kept.push({ path, reason: 'not_a_socket' }); continue; }
    // An accepted (or timed-out) probe connect means "not ours to remove"; the
    // bind claim a live serve retains for its whole lifetime is taken only for a
    // dead-looking socket, so removal is serialized with a serve starting up,
    // and the probe is repeated under it before anything is unlinked.
    if (await socketHasLiveListener(path)) { sweep.kept.push({ path, reason: 'live_listener' }); continue; }
    const binding = await claimLocalIpcBinding(path).catch(() => null);
    if (!binding) { sweep.kept.push({ path, reason: 'live_listener' }); continue; }
    try {
      if (await socketHasLiveListener(path)) { sweep.kept.push({ path, reason: 'live_listener' }); continue; }
      if (binding.removeStaleWindowsSocket) binding.removeStaleWindowsSocket();
      else unlinkSync(path);
      sweep.removed.push(path);
    } finally { await binding.release(); }
  }
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (owned.has(path)) continue;
    const stat = entryStat(path);
    if (!stat) continue;
    if (stat.isSymbolicLink()) sweep.kept.push({ path, reason: 'symlink' });
    else if (stat.isSocket()) sweep.kept.push({ path, reason: 'foreign_socket' });
    else if (stat.isFIFO()) sweep.kept.push({ path, reason: 'foreign_fifo' });
  }
  return sweep;
}

const KEPT_REASON_TEXT: Record<KeptArtefactReason, string> = {
  live_listener: 'a gbrain socket something is still listening on',
  symlink: 'a symbolic link (not followed)',
  not_a_socket: 'a regular file where a gbrain socket is expected',
  foreign_socket: 'a socket gbrain does not own',
  foreign_fifo: 'a FIFO gbrain does not own',
};

/** The typed refusal for a `dumpDataDir` failure: the WASI errno plus every non-regular entry the sweep left in the data dir. */
export function backupDumpFailed(cause: unknown, sweep: RuntimeArtefactSweep): AgentInstallError {
  const detail = (typeof cause === 'object' && cause !== null ? cause : {}) as { errno?: unknown; message?: unknown };
  const errno = typeof detail.errno === 'number' ? ` (errno ${detail.errno})` : '';
  const kept = sweep.kept.map(entry => `${entry.path}: ${KEPT_REASON_TEXT[entry.reason]}`);
  const blockers = kept.length
    ? ` The data dir holds entries the dump cannot read and the backup will not remove: ${kept.join('; ')}. Stop the process using each one, or move it out of the data dir, then retry.`
    : typeof detail.message === 'string' && detail.message.trim() ? ` ${detail.message.trim()}` : '';
  return new AgentInstallError('backup_dump_failed', `PGLite could not dump the data dir${errno}.${blockers}`);
}
