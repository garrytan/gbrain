import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { existingLocalHostId, persistenceHome } from './identity.ts';
import { containsPath, getWorktreeBinding, readManagedMode, type WorktreeBinding } from './ownership.ts';
import { verifyOwnerRoot } from './owner-verification.ts';
import { readPhysicalRootReservation, readWedgedPhysicalRootReservation } from './physical-root-record.ts';
import { coordinationHomeIgnored, coordinationLockDirectory } from './coordination-lock.ts';
import { inspectLegacyWriterLocks } from './legacy-locks.ts';
import { UNSUPPORTED_MANAGED_BULK_WRITERS } from './maintenance.ts';
import { isConnectorSourceKind } from './connector-identity.ts';
import { writeThroughConfigured } from './switches.ts';

export function containerPathPreflight(paths: Record<string, string>, mountinfo?: string, container?: boolean) {
  if (container === undefined) container = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  if (mountinfo === undefined && process.platform === 'linux') {
    try { mountinfo = readFileSync('/proc/self/mountinfo', 'utf8'); } catch { mountinfo = ''; }
  }
  const mounts = (mountinfo ?? '').split('\n').flatMap(line => {
    const [fields, filesystem] = line.split(' - ');
    const mount = fields?.split(' ')[4];
    return mount && filesystem ? [{ path: mount.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8))), type: filesystem.split(' ')[0] }] : [];
  }).sort((a, b) => b.path.length - a.path.length);
  return { container, durability_verified: false, paths: Object.entries(paths).map(([role, path]) => {
    const mount = mounts.find(entry => containsPath(entry.path, path));
    const ephemeral = !!mount && (['tmpfs', 'ramfs'].includes(mount.type) || container && ['overlay', 'aufs'].includes(mount.type));
    return { role, path, backing: ephemeral ? 'ephemeral' : mount ? 'mounted_unverified' : 'unknown', mount_path: mount?.path ?? null, filesystem: mount?.type ?? null };
  }), next_action: 'Verify that the canonical checkout, its parent (which holds the sibling reservation), and the persistence home/coordination lock survive container recreation together. A mounted path is not proof of durability. '
    + 'When GBRAIN_HOME lies inside the checkout, the lock is placed under GBRAIN_COORDINATION_HOME (else ~/.gbrain/persistence) instead, so set GBRAIN_COORDINATION_HOME to a mounted directory outside the checkout. '
    + 'A reservation an older release wrote with its lock inside the checkout (coordination_lock.old_path_wedge, "must live outside the canonical checkout") is repaired by the next claim on the host that reserved it. Do not delete ownership or lock files.' };
}

/**
 * #6765: the coordination lock path of `root` and the rule that chose it, as a claim or transfer resolves it
 * (coordination-lock.ts); an unclaimed root without a reservation reports the directory a claim would use.
 * Read-only: never mints a host identity, so before the first claim the fallback namespace is left off.
 */
function coordinationLockStatus(root: string, binding: WorktreeBinding | null, host: string | null): Record<string, unknown> {
  try {
    const wedged = readWedgedPhysicalRootReservation(root);
    if (wedged) return { path: wedged.coordinationPath, rule: 'reservation', old_path_wedge: true };
    const reservation = readPhysicalRootReservation(root)?.coordinationPath;
    const recorded = reservation ? { path: reservation, rule: 'reservation' } : binding?.coordination_path ? { path: binding.coordination_path, rule: 'binding' } : null;
    if (recorded) {
      const ignored = coordinationHomeIgnored(root, recorded.path);
      return ignored ? { ...recorded, coordination_home_ignored: ignored } : recorded;
    }
    return { path: null, ...coordinationLockDirectory(root, host) };
  } catch (error) {
    return { path: binding?.coordination_path ?? null, rule: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function writerOnboardingPreflight(engine: BrainEngine, sourceId?: string) {
  const managed = await readManagedMode(engine);
  const rows = await engine.executeRaw<{ id: string; local_path: string | null; incarnation: string; kind: string | null }>(
    "SELECT id,local_path,incarnation,config->>'kind' AS kind FROM sources WHERE NOT archived AND ($1::text IS NULL OR id=$1) ORDER BY id", [sourceId ?? null]);
  const fallback = await engine.getConfig('sync.repo_path'), host = existingLocalHostId();
  const writeThrough = writeThroughConfigured(await engine.getConfig('sync.write_through'));
  const sources = [];
  for (const row of rows) {
    const binding = await getWorktreeBinding(engine, row.id, host), configured = row.local_path || (row.id === 'default' ? fallback : null);
    const connector = isConnectorSourceKind(row.kind);
    let state = !binding ? connector ? 'connector_database' : configured && writeThrough ? 'claim_required' : 'database_only' : !managed ? 'activation_required' : 'ready';
    let physicalError: string | undefined;
    if (binding && (binding.source_incarnation !== row.incarnation || binding.state !== 'active')) state = 'recovery_required';
    if (binding && binding.owner_host_id !== host) state = 'owner_host_required';
    // #6741 C: the claim's owner verification, shared with background admissions (owner-verification.ts).
    const owner = binding?.owner_host_id === host ? verifyOwnerRoot(binding) : null;
    if (owner) { state = 'recovery_required'; physicalError = owner.physical_error; }
    const root = binding?.local_path ?? (connector ? null : configured);
    const lock = root ? coordinationLockStatus(root, binding, host) : undefined;
    const lockDirectory = typeof lock?.path === 'string' ? dirname(lock.path) : typeof lock?.directory === 'string' ? lock.directory : join(persistenceHome(), 'locks');
    const paths = root ? containerPathPreflight({ canonical_root: root, reservation_parent: dirname(root), persistence_home: persistenceHome(),
      coordination_directory: lockDirectory }) : undefined;
    sources.push({ source_id: row.id, state, write_through: writeThrough, ...(physicalError ? { physical_error: physicalError } : {}),
      ...(lock ? { coordination_lock: lock } : {}), ...(paths ? { storage: paths } : {}) });
  }
  return { sources, legacy_locks: await inspectLegacyWriterLocks(engine), unsupported_maintenance: [...UNSUPPORTED_MANAGED_BULK_WRITERS],
    procedure: 'For deliberate onboarding, stop and upgrade older writers on every host, review all sources and durable paths, explicitly claim each filesystem source using its fresh admin_state, inspect status again, then explicitly activate with --confirm-quiesced and a fresh admin_state. A claim alone fences legacy sync; finish activation before ordinary writes or sync. This inspection never claims, activates, repairs or switches to database-only storage.' };
}
