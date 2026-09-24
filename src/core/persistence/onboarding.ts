import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { existingLocalHostId, persistenceHome } from './identity.ts';
import { containsPath, getWorktreeBinding } from './ownership.ts';
import { assertPhysicalRoot } from './physical-root.ts';
import { inspectLegacyWriterLocks } from './legacy-locks.ts';
import { UNSUPPORTED_MANAGED_BULK_WRITERS } from './maintenance.ts';

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
  }), next_action: 'Verify that the canonical checkout, its parent (which holds the sibling reservation), and the persistence home/coordination lock survive container recreation together. A mounted path is not proof of durability. Do not delete ownership or lock files.' };
}

export async function writerOnboardingPreflight(engine: BrainEngine, sourceId?: string) {
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  const rows = await engine.executeRaw<{ id: string; local_path: string | null; incarnation: string; kind: string | null }>(
    "SELECT id,local_path,incarnation,config->>'kind' AS kind FROM sources WHERE NOT archived AND ($1::text IS NULL OR id=$1) ORDER BY id", [sourceId ?? null]);
  const fallback = await engine.getConfig('sync.repo_path'), host = existingLocalHostId();
  const writeThrough = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
  const sources = [];
  for (const row of rows) {
    const binding = await getWorktreeBinding(engine, row.id, host), configured = row.local_path || (row.id === 'default' ? fallback : null);
    const connector = row.kind === 'google' || row.kind === 'github';
    let state = !binding ? connector ? 'connector_database' : configured && writeThrough ? 'claim_required' : 'database_only' : !brain.enabled ? 'activation_required' : 'ready';
    let physicalError: string | undefined;
    if (binding && (binding.source_incarnation !== row.incarnation || binding.state !== 'active')) state = 'recovery_required';
    if (binding && binding.owner_host_id !== host) state = 'owner_host_required';
    if (binding?.owner_host_id === host && (!binding.local_path || !binding.coordination_path)) state = 'recovery_required';
    if (binding?.owner_host_id === host && binding.local_path) {
      try { assertPhysicalRoot(binding.local_path, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path }); }
      catch (error) { state = 'recovery_required'; physicalError = error instanceof Error ? error.message : String(error); }
    }
    const root = binding?.local_path ?? (connector ? null : configured);
    const paths = root ? containerPathPreflight({ canonical_root: root, reservation_parent: dirname(root), persistence_home: persistenceHome(),
      coordination_directory: binding?.coordination_path ? dirname(binding.coordination_path) : join(persistenceHome(), 'locks') }) : undefined;
    sources.push({ source_id: row.id, state, write_through: writeThrough, ...(physicalError ? { physical_error: physicalError } : {}), ...(paths ? { storage: paths } : {}) });
  }
  return { sources, legacy_locks: await inspectLegacyWriterLocks(engine), unsupported_maintenance: [...UNSUPPORTED_MANAGED_BULK_WRITERS],
    procedure: 'For deliberate onboarding, stop and upgrade older writers on every host, review all sources and durable paths, explicitly claim each filesystem source using its fresh admin_state, inspect status again, then explicitly activate with --confirm-quiesced and a fresh admin_state. A claim alone fences legacy sync; finish activation before ordinary writes or sync. This inspection never claims, activates, repairs or switches to database-only storage.' };
}
