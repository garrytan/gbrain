/**
 * The engine-free core of `gbrain pglite-repair --legacy-lock` (GBRA-130 C-3):
 * a legacy (pre-kernel) `<data-dir>/.gbrain-lock/` whose owner `acquireLock`
 * cannot prove dead refuses `pglite_busy` reason `legacy_owner_unverified`
 * forever, so this is its exit.
 *
 * `inspectLegacyLock` is read-only and never creates anything: it reports the
 * legacy metadata, a verdict, the plan hash an approved removal binds (the
 * canonical data dir plus the legacy dir's inode, every entry's bytes and the
 * marker bytes) and ADVISORY evidence: kill -0 and the command of the recorded
 * PID, an open-file scan of /proc (Linux), and the filesystem type (Linux
 * statfs; macOS `df -P` plus `mount`, local only with the `local` flag). That evidence covers only this host and PID namespace; it cannot
 * see other containers, PID namespaces or hosts sharing the folder, so it is
 * never stated as proof. A live holder (an open file under the data dir, a
 * live recorded PID whose command could be gbrain, or a comparable live PID),
 * a network/shared filesystem, or a filesystem whose locality cannot be read
 * (neither Linux nor macOS, a failed probe, an unrecognised type, a macOS
 * mount without the `local` flag: fail closed) makes the lock
 * not removable.
 *
 * `applyLegacyLockRemoval` runs only under the stable sibling kernel lock and
 * after consent bound to the plan hash: it moves the legacy dir into a sibling
 * `<data-dir>.legacy-lock-removed-<ts>/` (nothing is deleted), writes the
 * kernel-v1 marker the normal path writes, starts the 10-minute WAL-repair
 * quarantine (`<data-dir>.lock-reap.json`, read by `msSinceLastReap`) and
 * leaves a receipt with the exact restore command, which also puts back the
 * prior ownership marker's exact bytes (or removes the new marker when there
 * was none), so an undo restores the original refusal.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { shellQuote } from './agent-output.ts';
import { execFileSync } from './spawn.ts';
import { computePlanHash, type PlanSelection } from './consent.ts';
import { isProcessAlive, legacyOwnerUnverified, pgliteLockDirFor, readMetadata, readProcessArgs, PGLITE_LOCK_PROTOCOL, type LegacyUnverifiedReason } from './pglite-lock.ts';

/** Linux statfs magic numbers of filesystems another host (or a VM host) can mount, where this host cannot see every process. */
const NETWORK_FILESYSTEMS: Readonly<Record<number, string>> = {
  0x6969: 'nfs', 0xff534d42: 'cifs', 0xfe534d42: 'smb2', 0x517b: 'smb', 0x01021997: '9p', 0x5346414f: 'afs', 0x73757245: 'coda',
  0x564c: 'ncp', 0x00c36400: 'ceph', 0x01161970: 'gfs2', 0x7461636f: 'ocfs2', 0x6a656a63: 'virtiofs', 0x65735546: 'fuse',
  0x47504653: 'gpfs', 0x0bd00bd0: 'lustre',
};
const LOCAL_FILESYSTEMS: Readonly<Record<number, string>> = {
  0xef53: 'ext4', 0x58465342: 'xfs', 0x9123683e: 'btrfs', 0x01021994: 'tmpfs', 0x794c7630: 'overlay', 0x2fc12fc1: 'zfs', 0xf2f52010: 'f2fs',
  0xca451a4e: 'bcachefs', 0x4d44: 'vfat', 0x2011bab0: 'exfat', 0x5346544e: 'ntfs', 0x7366746e: 'ntfs3', 0x482b: 'hfsplus', 0x858458f6: 'ramfs',
  0x52654973: 'reiserfs', 0x3153464a: 'jfs', 0x3434: 'nilfs',
};
/** macOS `mount` types that are local disks; a mount counts as local only with one of these AND the `local` flag. */
const DARWIN_LOCAL_FILESYSTEMS: ReadonlySet<string> = new Set(['apfs', 'hfs', 'exfat', 'msdos']);
export function networkFilesystemName(magic: number): string | null {
  return NETWORK_FILESYSTEMS[magic >>> 0] ?? null;
}

export const LEGACY_LOCK_EVIDENCE_SCOPE = 'Advisory only: kill -0, the process command and the open-file scan cover only this host and PID namespace. '
  + 'They cannot see processes in other containers or PID namespaces, or on other hosts that share this folder, so they are not proof that the old owner has stopped.';

export interface LegacyLockEvidence {
  advisory: true;
  scope: string;
  pid: number | null;
  pid_alive: boolean | null;
  pid_command: string | null;
  fd_scan: { method: 'proc' | 'unavailable'; holders: Array<{ pid: number; command: string | null; paths: string[] }>; uninspectable: number };
  /** `network: null` means locality is unknown (neither Linux nor macOS, a failed probe, an unrecognised type, or a macOS mount that is not local) and refuses `filesystem_unverified`. */
  filesystem: { type: string | null; magic: number | null; network: boolean | null };
}

export interface LegacyLockInspection {
  data_dir: string;
  legacy_lock: {
    dir: string;
    present: boolean;
    /** The dir would block a kernel-v1 open (no marker yet, or metadata from another protocol). */
    legacy: boolean;
    verdict: 'absent' | 'current' | 'live' | 'dead' | 'unverified';
    reason: LegacyUnverifiedReason | null;
    metadata: { pid: number | null; command: string | null; acquired_at: number | null; pid_ns: string | null; boot_id: string | null } | null;
  };
  evidence: LegacyLockEvidence | null;
  refusal: { reason: 'live_holder' | 'network_filesystem' | 'filesystem_unverified'; message: string } | null;
  removable: boolean;
  plan_hash: string | null;
  selection: PlanSelection | null;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const markerPathOf = (dataDir: string) => `${dataDir}.gbrain-owner.json`;

/** Test seam for the host probes; production reads the real platform and statfs. */
export interface LegacyLockProbe {
  platform?: NodeJS.Platform;
  statfs?: (path: string) => { type: number };
  /** Runs an absolute-path command without a shell and returns its stdout (macOS `df` and `mount`). */
  exec?: (file: string, args: readonly string[]) => string;
}
const execNoShell = (file: string, args: readonly string[]): string =>
  String(execFileSync(file, [...args], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } }));

function scanOpenFiles(dataDir: string, platform: NodeJS.Platform): LegacyLockEvidence['fd_scan'] {
  if (platform !== 'linux' || !existsSync('/proc/self/fd')) return { method: 'unavailable', holders: [], uninspectable: 0 };
  const holders: LegacyLockEvidence['fd_scan']['holders'] = [];
  let uninspectable = 0;
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!/^\d+$/.test(entry) || pid === process.pid) continue;
    let fds: string[];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') uninspectable++;
      continue;
    }
    const paths = new Set<string>();
    for (const fd of fds) {
      let target: string;
      try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (target === dataDir || target.startsWith(`${dataDir}/`)) paths.add(target);
    }
    if (paths.size > 0) holders.push({ pid, command: readProcessArgs(pid)?.slice(0, 200) ?? null, paths: [...paths].sort().slice(0, 5) });
  }
  return { method: 'proc', holders, uninspectable };
}

/**
 * macOS: the data dir's mount point from `df -P` (everything after the
 * capacity column, so spaces survive), then that mount point's one line in
 * `mount` (`<dev> on <mountpoint> (<type>, <flags...>)`). Local only with the
 * `local` flag and a known-local type; anything else, including a network
 * type, a missing or duplicated line and any parse or command failure, is
 * unknown (`network: null`).
 */
function darwinFilesystemOf(dataDir: string, exec: NonNullable<LegacyLockProbe['exec']>): LegacyLockEvidence['filesystem'] {
  const unknown = (type: string | null = null) => ({ type, magic: null, network: null });
  try {
    const df = exec('/bin/df', ['-P', dataDir]).split('\n').filter(line => line.trim() !== '');
    const mountPoint = df.length === 2 ? /^.+?\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/.exec(df[1]!)?.[1] : undefined;
    if (!mountPoint) return unknown();
    const marker = ` on ${mountPoint} (`;
    const lines = exec('/sbin/mount', []).split('\n').filter(line => line.endsWith(')') && line.includes(marker));
    if (lines.length !== 1) return unknown();
    const [type, ...flags] = lines[0]!.slice(lines[0]!.indexOf(marker) + marker.length, -1).split(',').map(part => part.trim());
    if (!type) return unknown();
    return flags.includes('local') && DARWIN_LOCAL_FILESYSTEMS.has(type) ? { type, magic: null, network: false } : unknown(type);
  } catch { return unknown(); }
}

function filesystemOf(dataDir: string, probe: LegacyLockProbe): LegacyLockEvidence['filesystem'] {
  const platform = probe.platform ?? process.platform;
  if (platform === 'darwin') return darwinFilesystemOf(dataDir, probe.exec ?? execNoShell);
  if (platform !== 'linux') return { type: null, magic: null, network: null };
  try {
    const magic = (probe.statfs ?? statfsSync)(dataDir).type >>> 0;
    const network = networkFilesystemName(magic);
    const local = LOCAL_FILESYSTEMS[magic];
    return { type: network ?? local ?? `0x${magic.toString(16)}`, magic, network: network !== null ? true : local ? false : null };
  } catch { return { type: null, magic: null, network: null }; }
}

/** Whether a live recorded PID could still be the legacy gbrain: its command is unreadable, names gbrain, or names the recorded script. */
function couldBeOwner(command: string | null, recorded: string | null): boolean {
  if (command === null) return true;
  if (command.includes('gbrain')) return true;
  const script = recorded?.trim().split(/\s+/)[0];
  return !!script && command.includes(script);
}

function planSelection(dataDir: string, lockDir: string): PlanSelection {
  const dir = lstatSync(lockDir);
  const entries = readdirSync(lockDir).sort().map(name => {
    const path = join(lockDir, name);
    const st = lstatSync(path);
    return { id: `.gbrain-lock/${name}`, revision: st.isFile() ? sha256(readFileSync(path)) : `${st.isDirectory() ? 'dir' : 'other'}:${st.ino}` };
  });
  const marker = markerPathOf(dataDir);
  return {
    brain: dataDir, source: null, operation: 'pglite-repair --legacy-lock',
    records: [{ id: '.gbrain-lock', revision: `${dir.dev}:${dir.ino}` }, ...entries],
    parameters: { marker: existsSync(marker) ? sha256(readFileSync(marker)) : null }, effects: ['destructive'],
  };
}

function evidenceFor(dataDir: string, pid: number | null, recordedCommand: string | null, verdict: LegacyLockInspection['legacy_lock']['verdict'], probe: LegacyLockProbe): { evidence: LegacyLockEvidence; refusal: LegacyLockInspection['refusal'] } {
  const pidAlive = pid === null ? null : isProcessAlive(pid);
  const pidCommand = pid !== null && pidAlive ? readProcessArgs(pid)?.slice(0, 200) ?? null : null;
  const evidence: LegacyLockEvidence = { advisory: true, scope: LEGACY_LOCK_EVIDENCE_SCOPE, pid, pid_alive: pidAlive, pid_command: pidCommand,
    fd_scan: scanOpenFiles(dataDir, probe.platform ?? process.platform), filesystem: filesystemOf(dataDir, probe) };
  const holder = evidence.fd_scan.holders[0];
  if (holder) return { evidence, refusal: { reason: 'live_holder', message: `Process ${holder.pid} (${holder.command ?? 'command unreadable'}) has ${holder.paths[0]} open, so the data dir is still in use on this host.` } };
  if (pidAlive && (verdict === 'live' || couldBeOwner(pidCommand, recordedCommand))) {
    return { evidence, refusal: { reason: 'live_holder', message: `The recorded legacy PID ${pid} is running (${pidCommand ?? 'command unreadable'}) and may still be the old gbrain.` } };
  }
  const fs = evidence.filesystem, platform = probe.platform ?? process.platform;
  if (fs.network) {
    return { evidence, refusal: { reason: 'network_filesystem', message: `The data dir is on a ${fs.type} filesystem that other hosts can mount; this host cannot see their processes.` } };
  }
  if (fs.network === null) {
    const why = platform !== 'linux' && platform !== 'darwin' ? `gbrain reads filesystem locality only on Linux and macOS and this host runs ${platform}`
      : fs.type === null ? `reading its filesystem type (${platform === 'darwin' ? 'df and mount' : 'statfs'}) failed`
      : `its filesystem ${fs.type} is not one gbrain can confirm is a local disk`;
    return { evidence, refusal: { reason: 'filesystem_unverified', message: `gbrain could not confirm that the data dir is on a local filesystem (${why}), so another host sharing this folder could still hold the lock.` } };
  }
  return { evidence, refusal: null };
}

/** Read-only: never creates the data dir, the legacy dir or the kernel lock. */
export function inspectLegacyLock(path: string, probe: LegacyLockProbe = {}): LegacyLockInspection {
  const lockDir = pgliteLockDirFor(path), dataDir = dirname(lockDir);
  const present = existsSync(lockDir) && lstatSync(lockDir).isDirectory();
  let migrated = false;
  try { migrated = JSON.parse(readFileSync(markerPathOf(dataDir), 'utf8')).protocol === PGLITE_LOCK_PROTOCOL; } catch { /* not yet upgraded */ }
  const metadata = present ? readMetadata(lockDir) : null;
  const legacy = present && (!migrated || (!!metadata && metadata.protocol !== PGLITE_LOCK_PROTOCOL));
  const reason = legacy ? legacyOwnerUnverified(metadata, lockDir) : null;
  const pid = Number.isInteger(metadata?.pid) && metadata!.pid! > 0 ? metadata!.pid! : null;
  const verdict = !present ? 'absent' : !legacy ? 'current' : reason ? 'unverified' : isProcessAlive(pid!) ? 'live' : 'dead';
  const recordedCommand = typeof metadata?.command === 'string' ? metadata.command : null;
  const { evidence, refusal } = legacy ? evidenceFor(dataDir, pid, recordedCommand, verdict, probe) : { evidence: null, refusal: null };
  const selection = legacy ? planSelection(dataDir, lockDir) : null;
  return {
    data_dir: dataDir,
    legacy_lock: { dir: lockDir, present, legacy, verdict, reason,
      metadata: metadata ? { pid, command: recordedCommand, acquired_at: typeof metadata.acquired_at === 'number' ? metadata.acquired_at : null,
        pid_ns: metadata.pid_ns ?? null, boot_id: metadata.boot_id ?? null } : null },
    evidence, refusal, removable: legacy && refusal === null,
    plan_hash: selection ? computePlanHash(selection) : null, selection,
  };
}

export interface LegacyLockRemovalReceipt {
  action: 'removed';
  data_dir: string;
  moved_to: string;
  marker_path: string;
  prior_marker: string | null;
  /** Exact bytes of the prior ownership marker, restored by `restore_command`; null when there was none (the undo removes the new marker). */
  prior_marker_backup: string | null;
  plan_hash: string;
  removed_at: string;
  evidence: LegacyLockEvidence | null;
  restore_command: string;
}

/** Caller holds the stable sibling kernel lock and consent bound to `inspection.plan_hash`, re-inspected under that lock. */
export function applyLegacyLockRemoval(inspection: LegacyLockInspection, now = new Date()): LegacyLockRemovalReceipt {
  const { data_dir: dataDir, legacy_lock: { dir: lockDir } } = inspection;
  const markerPath = markerPathOf(dataDir);
  const priorBytes = existsSync(markerPath) ? readFileSync(markerPath) : null;
  const movedTo = `${dataDir}.legacy-lock-removed-${now.toISOString().replace(/[:.]/g, '-')}`;
  mkdirSync(movedTo, { mode: 0o700 });
  const priorBackup = priorBytes === null ? null : join(movedTo, 'prior-owner-marker.json');
  if (priorBackup) writeFileSync(priorBackup, priorBytes!, { mode: 0o600 });
  renameSync(lockDir, join(movedTo, '.gbrain-lock'));
  writeFileSync(markerPath, JSON.stringify({ protocol: PGLITE_LOCK_PROTOCOL }), { mode: 0o600 });
  writeFileSync(`${dataDir}.lock-reap.json`, JSON.stringify({ ts: now.getTime(), reason: 'legacy_lock_removed' }), { mode: 0o600 });
  const restoring = `${markerPath}.restore`;
  const markerUndo = priorBackup === null ? [shellQuote(['rm', '-f', markerPath])]
    : [shellQuote(['cp', priorBackup, restoring]), shellQuote(['mv', '-f', restoring, markerPath])];
  const restore = [shellQuote(['mv', join(movedTo, '.gbrain-lock'), lockDir]), ...markerUndo].join(' && ');
  const receipt: LegacyLockRemovalReceipt = { action: 'removed', data_dir: dataDir, moved_to: movedTo, marker_path: markerPath,
    prior_marker: priorBytes === null ? null : priorBytes.toString('utf8'), prior_marker_backup: priorBackup,
    plan_hash: inspection.plan_hash!, removed_at: now.toISOString(), evidence: inspection.evidence, restore_command: restore };
  writeFileSync(join(movedTo, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}
