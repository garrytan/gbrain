/**
 * #6932: reclaim a Git index lock that provably belongs to no live process.
 *
 * A git killed with SIGKILL after it created `index.lock` (a bounded step that
 * missed its deadline, a job group killed after its grace) leaves the lock
 * behind, and every later git in that checkout refuses to run. Only the
 * checkout's writer, while it holds the writer lock, may reclaim one, and only
 * when it can prove the lock is abandoned:
 *
 * - Linux with a full view of the process table: `/proc` is not mounted with
 *   `hidepid`, and this process is not in a nested PID namespace (a container
 *   cannot see a git running on its host).
 * - The lock is on a local filesystem; a git on another machine sharing a
 *   network mount is invisible here.
 * - No process has the lock open, and no git process runs with its working
 *   directory, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR` or
 *   `GIT_INDEX_FILE` inside the checkout or its git directory. A git process
 *   whose open files or environment cannot be read fails the proof. Another
 *   user's processes that are not git cannot be read and are not checked: only
 *   git creates this lock, and their git processes still fail the proof.
 * - The lock is empty and at least {@link RECLAIM_MIN_AGE_MS} old, or older
 *   than the stale threshold.
 *
 * Anything short of that proof leaves the lock in place. A reclaim moves the
 * lock aside, checks it is still the file that was proven, removes it, and
 * appends a receipt to {@link indexLockReceiptPath} that doctor reports.
 */
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statfsSync, statSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { persistenceHome } from './identity.ts';

/** An empty lock younger than this is left to its git, which may have just created it. */
export const RECLAIM_MIN_AGE_MS = 5_000;
/** Receipts kept after a trim; the file is trimmed once it passes twice this many lines. */
const RECEIPTS_KEPT = 100;

/** statfs magic numbers of network and userspace filesystems, where another machine's git may hold the lock. */
const SHARED_FILESYSTEMS = new Set([
  0x6969, // nfs
  0x517b, // smb
  0xff534d42, // cifs
  0xfe534d42, // smb2
  0x65735546, // fuse
  0x00c36400, // ceph
  0x01021997, // 9p
  0x5346414f, // afs
  0x47504653, // gpfs
  0x0bd00bd0, // lustre
  0x013111a8, // ibrix
  0x6b414653, // kafs
]);

export interface IndexLockProof { abandoned: true; size: number; ageMs: number; dev: number; ino: number; mtimeMs: number; birthtimeMs: number }
export interface IndexLockDoubt { abandoned: false; reason: string }
export type IndexLockVerdict = IndexLockProof | IndexLockDoubt;

export interface IndexLockReclaim {
  at: string;
  checkout: string;
  lock: string;
  size: number;
  age_ms: number;
  pid: number;
}

const doubt = (reason: string): IndexLockDoubt => ({ abandoned: false, reason });
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const inside = (path: string, roots: string[]) => roots.some(root => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));
const gone = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Why this process cannot see every process that could hold a lock, or null when it can. */
export function processTableBlind(): string | null {
  if (process.platform !== 'linux') return `this platform (${process.platform}) gives no way to list the processes that hold a file open`;
  try {
    const nspid = /^NSpid:\s*(.*)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]?.trim().split(/\s+/) ?? [];
    if (nspid.length > 1) return 'gbrain runs in a nested PID namespace (a container), so a git running outside it is invisible';
    for (const line of readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
      const [mount, options] = line.split(' - ');
      if (mount?.split(' ')[4] === '/proc' && /(^|,)hidepid=(1|2|invisible|noaccess)(,|$)/.test(options?.split(' ')[2] ?? '')) {
        return '/proc is mounted with hidepid, so other users\' processes are invisible';
      }
    }
  } catch { return 'the process table under /proc could not be read'; }
  return null;
}

/** The git environment variables that place a process's repository or index. */
const GIT_LOCATION_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'];

/**
 * A process that holds the lock or runs git in the checkout, or a git process this process cannot inspect.
 * A process that has the lock open is named first, then a git in the checkout, then a git that cannot be
 * inspected, so a refusal names the actual holder when there is one.
 */
function liveHolder(lock: { dev: number; ino: number }, roots: string[]): string | null {
  const opaque: string[] = [];
  const inRepository: string[] = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let comm: string;
    try { comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { continue; }
    let fds: string[] | null = null;
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch (error) { if (gone(error)) continue; }
    for (const fd of fds ?? []) {
      let opened;
      try { opened = statSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (opened.dev === lock.dev && opened.ino === lock.ino) return `process ${pid} (${comm}) has the lock open`;
    }
    if (!comm.startsWith('git')) continue;
    if (fds === null) { opaque.push(`git process ${pid} (${comm}) belongs to another user, so its open files cannot be checked`); continue; }
    let cwd: string;
    let environ: string;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, '');
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch (error) {
      if (!gone(error)) opaque.push(`git process ${pid} (${comm}) could not be inspected`);
      continue;
    }
    if (inside(cwd, roots)) { inRepository.push(`git process ${pid} (${comm}) is running in the checkout`); continue; }
    for (const entry of environ.split('\0')) {
      const at = entry.indexOf('=');
      if (at < 0 || !GIT_LOCATION_VARIABLES.includes(entry.slice(0, at))) continue;
      const value = entry.slice(at + 1);
      if (value && inside(canonical(isAbsolute(value) ? value : resolve(cwd, value)), roots)) {
        inRepository.push(`git process ${pid} (${comm}) uses this repository through ${entry.slice(0, at)}`);
        break;
      }
    }
  }
  return inRepository[0] ?? opaque[0] ?? null;
}

/**
 * Whether `lock` (the checkout's own index lock) is provably abandoned. `checkout` is the worktree root;
 * the lock's directory is the git directory that owns the index. A lock older than `staleMs` qualifies
 * whatever its size; a younger one only when it is empty and at least {@link RECLAIM_MIN_AGE_MS} old.
 */
export function proveIndexLockAbandoned(lock: string, checkout: string, staleMs: number): IndexLockVerdict {
  const blind = processTableBlind();
  if (blind) return doubt(blind);
  let before;
  try { before = lstatSync(lock); } catch { return doubt('the lock disappeared while it was checked'); }
  if (!before.isFile()) return doubt('the lock is not a regular file');
  const ageMs = Date.now() - before.mtimeMs;
  if (ageMs < 0) return doubt('the lock is dated in the future, so its age proves nothing');
  if (before.size > 0 && ageMs < staleMs) return doubt(`the lock holds ${before.size} bytes and is younger than ${Math.round(staleMs / 60_000)} minutes, so a git may still be writing it`);
  if (ageMs < RECLAIM_MIN_AGE_MS) return doubt('the lock was created moments ago');
  try {
    if (SHARED_FILESYSTEMS.has(Number(statfsSync(dirname(lock)).type) >>> 0)) return doubt('the checkout is on a network or userspace filesystem, where a git on another machine is invisible');
  } catch { return doubt('the filesystem holding the lock could not be identified'); }
  let holder: string | null;
  try { holder = liveHolder(before, [canonical(checkout), canonical(dirname(lock))]); }
  catch { return doubt('the process table under /proc could not be read'); }
  if (holder) return doubt(holder);
  let after;
  try { after = lstatSync(lock); } catch { return doubt('the lock disappeared while it was checked'); }
  if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return doubt('the lock changed while it was checked');
  return { abandoned: true, size: before.size, ageMs, dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs, birthtimeMs: before.birthtimeMs };
}

/**
 * Remove a proven lock. It is renamed aside first, so a lock that a new git created after the proof is
 * never the one removed: a renamed file that is not the proven one is put back and nothing is reclaimed.
 * A freed inode number is reused at once, so the proven file is matched by inode, size, modification
 * and birth time together, not by inode alone.
 */
export function reclaimIndexLock(lock: string, checkout: string, proof: IndexLockProof): IndexLockReclaim | null {
  const aside = `${lock}.gbrain-reclaim-${process.pid}-${Date.now()}`;
  try { renameSync(lock, aside); } catch { return null; }
  const moved = lstatSync(aside);
  if (moved.dev !== proof.dev || moved.ino !== proof.ino || moved.size !== proof.size || moved.mtimeMs !== proof.mtimeMs || moved.birthtimeMs !== proof.birthtimeMs) {
    try { renameSync(aside, lock); } catch { /* a newer lock now holds the name; the moved file stays aside for the operator */ }
    return null;
  }
  unlinkSync(aside);
  const receipt = { at: new Date().toISOString(), checkout, lock, size: proof.size, age_ms: Math.round(proof.ageMs), pid: process.pid };
  try { recordReceipt(receipt); } catch { /* the log line below still records it */ }
  console.error(`[gbrain] reclaimed an abandoned Git index lock in ${checkout}: ${lock} (${proof.size} bytes, ${Math.round(proof.ageMs / 1000)}s old, no live process held it); retrying the Git effect`);
  return receipt;
}

/** Host-local receipts of reclaimed index locks, newest last. */
export function indexLockReceiptPath(): string { return join(persistenceHome(), 'index-lock-reclaims.jsonl'); }

function recordReceipt(receipt: IndexLockReclaim): void {
  const path = indexLockReceiptPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (lines.length > RECEIPTS_KEPT * 2) writeFileSync(path, `${lines.slice(-RECEIPTS_KEPT).join('\n')}\n`, { mode: 0o600 });
}

/** Receipts recorded on this host, oldest first; an unreadable file or line reads as none. */
export function readIndexLockReclaims(): IndexLockReclaim[] {
  let text: string;
  try { text = readFileSync(indexLockReceiptPath(), 'utf8'); } catch { return []; }
  return text.split('\n').flatMap(line => {
    try { const entry = JSON.parse(line) as IndexLockReclaim; return typeof entry?.at === 'string' && typeof entry.lock === 'string' ? [entry] : []; }
    catch { return []; }
  });
}
