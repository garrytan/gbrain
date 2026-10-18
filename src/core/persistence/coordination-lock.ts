import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { sha256 } from './digest.ts';
import { localHostId, persistenceHome } from './identity.ts';
import type { SqlEngine } from './model.ts';
import { acquireNativeLock } from './native-lock.ts';
import { coordinationPathInsideRoot, physicalRootError, readWedgedPhysicalRootReservation, repairReservationCoordinationPath,
  reservationRepairGuardPath } from './physical-root-record.ts';
import { canonicalFilesystemPath } from './root-registry.ts';

/**
 * #6765: where a worktree's native coordination lock lives. One resolver serves claim, physical-root reservation,
 * topology clone, writer transfer and writer status:
 *   reservation       the path the outside-root reservation already records (always wins over any env)
 *   binding           the host binding's recorded path, when it is absolute, canonical and outside the root (transfer)
 *   persistence_home  persistenceHome()/locks, when that is outside the canonical root (every ordinary layout)
 *   coordination_home $GBRAIN_COORDINATION_HOME/locks/<namespace>, when persistenceHome() is inside the root
 *   home_default      ~/.gbrain/persistence/locks/<namespace>, the same case without GBRAIN_COORDINATION_HOME
 * The namespace is sha256(canonical root, host id): a shared fallback home can span roots and hosts, and restored
 * database clones can share a worktree id. A result still inside the root refuses.
 */
export type CoordinationLockRule = 'reservation' | 'binding' | 'persistence_home' | 'coordination_home' | 'home_default';
export interface CoordinationLock { path: string; rule: CoordinationLockRule }
export interface RecordedCoordinationLock { reservation?: string | null; binding?: string | null }

const statusFix = () => readFix('Shows each source\'s coordination lock path and the rule that chose it, read-only.',
  { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] });

function insideRootRefusal(root: string, path: string) {
  return opError('storage_error', `No coordination lock directory outside the canonical checkout ${root} is available.`,
    `The writer lock for ${root} would land at ${path}, inside the files it protects, so nothing was claimed or reserved. `
      + 'Export GBRAIN_COORDINATION_HOME as an absolute directory outside the checkout (in the process environment, not a .env file in the checkout) and run the command again.',
    { fix: statusFix() });
}

/** The directory a new lock of `root` goes in, and the rule that chose it. A null host (read-only status before any claim) leaves the namespace off. */
export function coordinationLockDirectory(path: string, hostId: string | null): { directory: string; rule: Exclude<CoordinationLockRule, 'reservation' | 'binding'> } {
  const root = canonicalFilesystemPath(path);
  const preferred = canonicalFilesystemPath(join(persistenceHome(), 'locks'));
  if (!coordinationPathInsideRoot(root, preferred)) return { directory: preferred, rule: 'persistence_home' };
  const override = process.env.GBRAIN_COORDINATION_HOME?.trim();
  if (override && (!isAbsolute(override) || override.includes('\0') || override.split(/[\\/]/).includes('..'))) throw opError('invalid_params',
    'GBRAIN_COORDINATION_HOME must be an absolute path without ".." segments.',
    `GBRAIN_COORDINATION_HOME is set to ${JSON.stringify(override)}, so no coordination lock was placed and nothing changed. Set it to an absolute directory outside ${root}, or unset it to use ~/.gbrain/persistence.`);
  const locks = join(override || join(homedir(), '.gbrain', 'persistence'), 'locks');
  const directory = canonicalFilesystemPath(hostId === null ? locks : join(locks, sha256(`${root}\0${hostId}`).slice(0, 32)));
  if (coordinationPathInsideRoot(root, directory)) throw insideRootRefusal(root, directory);
  return { directory, rule: override ? 'coordination_home' : 'home_default' };
}

export function resolveCoordinationLock(path: string, worktreeId: string, recorded: RecordedCoordinationLock = {}, hostId?: string): CoordinationLock {
  if (recorded.reservation) return { path: recorded.reservation, rule: 'reservation' };
  const root = canonicalFilesystemPath(path), binding = recorded.binding;
  if (binding && isAbsolute(binding) && !binding.includes('\0') && canonicalFilesystemPath(binding) === binding && !coordinationPathInsideRoot(root, binding)) {
    return { path: binding, rule: 'binding' };
  }
  const { directory, rule } = coordinationLockDirectory(root, hostId ?? localHostId());
  const lock = canonicalFilesystemPath(join(directory, `${worktreeId}.lock`));
  if (coordinationPathInsideRoot(root, lock)) throw insideRootRefusal(root, lock);
  return { path: lock, rule };
}

export interface CoordinationHomeIgnored { configured_directory: string; recorded_path: string; move_step: string }

/**
 * v3 review: a recorded lock always wins over GBRAIN_COORDINATION_HOME, so when the variable applies to `root`
 * (rule 4) and names another directory than the recorded lock's, say so: the recorded file stays in use by every
 * process, and the step that changes where it lives is the operator's (no claim or env change moves it). Null when
 * the variable is unset, invalid, not read for this root, or already names the recorded location.
 */
export function coordinationHomeIgnored(root: string, recordedPath: string): CoordinationHomeIgnored | null {
  const override = process.env.GBRAIN_COORDINATION_HOME?.trim();
  if (!override) return null;
  let resolved: ReturnType<typeof coordinationLockDirectory>;
  try { resolved = coordinationLockDirectory(root, null); } catch { return null; }
  if (resolved.rule !== 'coordination_home') return null;
  const recorded = canonicalFilesystemPath(recordedPath);
  if (recorded.startsWith(resolved.directory + sep)) return null;
  return { configured_directory: resolved.directory, recorded_path: recorded,
    move_step: `Nothing moves: every process keeps locking ${recorded}, because GBRAIN_COORDINATION_HOME only places the lock of a checkout that has no reservation yet, and no claim, transfer or environment change rewrites a recorded one. `
      + `Make ${dirname(recorded)} survive container recreation (mount it), and unset GBRAIN_COORDINATION_HOME for this checkout's processes if it was meant to move the lock. `
      + 'No gbrain command relocates a recorded lock yet (docs/architecture/topologies.md#coordination-lock).' };
}

/** How long a repair waits for another repairer of the same root before refusing. */
const REPAIR_GUARD_WAIT_MS = 2000;

/**
 * #6766: a release before #6765 placed the lock of a checkout that contains GBRAIN_HOME inside that checkout, wrote the
 * reservation and then refused it, so every later claim failed closed. A first claim on the reserving host rewrites only
 * the reservation's coordinationPath, under a guard beside the reservation (independent of any env), when the brain and
 * host match and no worktree row exists for it. A missing or healthy reservation returns before taking the guard, so a
 * caller inside a database transaction never waits on it for a healthy root.
 */
export async function repairWedgedReservation(engine: SqlEngine, root: string, hostId: string): Promise<void> {
  if (!readWedgedPhysicalRootReservation(root)) return;
  const guard = await acquireNativeLock(reservationRepairGuardPath(root), { timeoutMs: REPAIR_GUARD_WAIT_MS });
  if (!guard) throw opError('writer_lock_unavailable', 'Another process is repairing this checkout\'s reservation.',
    `Another gbrain process is moving the coordination lock recorded for ${root} out of the checkout, so nothing was claimed. Run the claim again once that process has finished.`,
    { fix: statusFix() });
  try {
    const wedged = readWedgedPhysicalRootReservation(root);
    if (!wedged) return;
    const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    if (wedged.brainId !== brain?.brain_id) throw physicalRootError('This checkout\'s reservation (its lock inside the checkout) belongs to another brain, so it was left unchanged.');
    if (wedged.hostId !== hostId) throw physicalRootError('Another host reserved this physical checkout with its lock inside the checkout; only a claim on that host repairs it.');
    const owned = await engine.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid', [wedged.worktreeId]);
    if (owned.length) throw physicalRootError('An owned checkout requires verified writer recovery; its recorded coordination lock is never moved by a claim.');
    const lock = resolveCoordinationLock(root, wedged.worktreeId, {}, hostId).path;
    repairReservationCoordinationPath(root, wedged, lock);
    process.stderr.write(`[persistence] reservation of ${root} recorded its coordination lock inside the checkout (${wedged.coordinationPath}); moved it to ${lock}, identity unchanged.\n`);
  } finally { await guard.release(); }
}
