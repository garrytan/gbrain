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
 *
 * #5312 Windows half: Bun cannot `lstat` a stale AF_UNIX reparse point (EACCES),
 * so classifying first threw before the probe/claim/remove sequence ran. An
 * `unreadable` entry at one of gbrain's own socket paths skips the
 * symlink/socket classification and goes to the probe and the bind claim;
 * removal happens only through the native tag-verifying remover
 * (`binding.removeStaleWindowsSocket`, which opens the leaf with
 * FILE_FLAG_OPEN_REPARSE_POINT and checks IO_REPARSE_TAG_AF_UNIX). Without one
 * (POSIX, or a claim that offers none) the entry is `kept: unreadable`, never
 * unlinked. `fs` is imported as a namespace so a test can inject the EACCES.
 */
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveSocketPathForConfig, socketHasLiveListener } from '../context/resolve-ipc.ts';
import { claimLocalIpcBinding } from '../context/ipc-path.ts';
import { AgentInstallError } from '../agent-install/state.ts';

export type KeptArtefactReason = 'live_listener' | 'symlink' | 'not_a_socket' | 'foreign_socket' | 'foreign_fifo' | 'unreadable';

export interface RuntimeArtefactSweep {
  /** gbrain runtime sockets whose holder was dead; unlinked before the dump. */
  removed: string[];
  /** Non-regular entries the sweep refused to touch, with the reason it left each one. */
  kept: { path: string; reason: KeptArtefactReason }[];
}

const GBRAIN_SOCKET_KINDS = ['resolve', 'persistence'] as const;

/** What the runtime reports for a stale Windows AF_UNIX reparse point (EACCES on Bun; the others are its neighbours). */
export const UNREADABLE_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'EINVAL', 'UNKNOWN']);

function entryStat(path: string): fs.Stats | 'missing' | 'unreadable' {
  try { return fs.lstatSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'missing';
    if (code && UNREADABLE_CODES.has(code)) return 'unreadable';
    throw error;
  }
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
    if (stat === 'missing') continue;
    if (stat !== 'unreadable') {
      if (stat.isSymbolicLink()) { sweep.kept.push({ path, reason: 'symlink' }); continue; }
      if (!stat.isSocket()) { sweep.kept.push({ path, reason: 'not_a_socket' }); continue; }
    }
    // An accepted (or timed-out) probe connect means "not ours to remove"; the
    // bind claim a live serve retains for its whole lifetime is taken only for a
    // dead-looking socket, so removal is serialized with a serve starting up,
    // and the probe is repeated under it before anything is unlinked.
    if (await socketHasLiveListener(path)) { sweep.kept.push({ path, reason: 'live_listener' }); continue; }
    const binding = await claimLocalIpcBinding(path).catch(() => null);
    if (!binding) { sweep.kept.push({ path, reason: 'live_listener' }); continue; }
    try {
      if (await socketHasLiveListener(path)) { sweep.kept.push({ path, reason: 'live_listener' }); continue; }
      if (binding.removeStaleWindowsSocket) {
        // The native remover verifies the AF_UNIX reparse tag through the retained claim; a leaf it does not
        // recognise (or cannot open) is left in place, whatever lstat said about it.
        let removed = false;
        try { removed = binding.removeStaleWindowsSocket(); } catch { removed = false; }
        if (removed) sweep.removed.push(path);
        else sweep.kept.push({ path, reason: 'unreadable' });
      } else if (stat === 'unreadable') {
        // Nothing here can verify what the entry is: an unreadable owned path is never blindly unlinked.
        sweep.kept.push({ path, reason: 'unreadable' });
      } else {
        fs.unlinkSync(path);
        sweep.removed.push(path);
      }
    } finally { await binding.release(); }
  }
  for (const name of fs.readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (owned.has(path)) continue;
    const stat = entryStat(path);
    if (stat === 'missing') continue;
    if (stat === 'unreadable') sweep.kept.push({ path, reason: 'unreadable' });
    else if (stat.isSymbolicLink()) sweep.kept.push({ path, reason: 'symlink' });
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
  unreadable: 'an entry this runtime cannot inspect (on Windows, a stale gbrain socket the native verifier did not remove)',
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
