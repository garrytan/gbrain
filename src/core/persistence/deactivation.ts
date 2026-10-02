/**
 * `gbrain sources writer deactivate` (#5455, #5628): a deliberate, state-bound
 * conversion from managed mode back to classic mode. Brain-wide and
 * trusted-local only.
 *
 * Deactivate takes the native worktree locks like activation, then in one
 * transaction locks `persistence_brain FOR UPDATE` first, checks the expected
 * admin state and the writer admin lock, locks worktrees then sources (the
 * order admission uses) and rechecks quiescence: no request queued, running or
 * recovering, no request or topology change with a recovery record, no
 * uncommitted effect, no live connector or maintenance lease. It then sets
 * `enabled=false`, increments `mode_epoch`, marks every worktree `retired`
 * (rows kept for receipt and effect foreign keys), deletes source and host
 * bindings, and records a committed `writer_deactivate` topology change naming
 * the brain, the retired epoch and the retired worktree ids and roots. Skill
 * bundle and protocol-floor settings and writer protocol registrations are
 * kept (inert while disabled).
 *
 * Local markers (registry records, `.gbrain-managed`, Git `gbrain-managed.json`,
 * `.gbrain-owner.json` and its reservation) are removed by
 * `cleanupRetiredManagedMarkers` only when they name this brain and a retired
 * epoch (or, without an epoch, a retired worktree id or root) recorded by a
 * committed deactivation; a newer or unknown one is kept and reported pending.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { configDir } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { acquireWorktree, getWorktreeBinding } from './ownership.ts';
import { existingLocalHostId } from './identity.ts';
import type { NativeLockHandle } from './native-lock.ts';
import { assertWriterAdminState } from './admin-intent.ts';
import { assertWriterAdminUnlocked, readWriterAdminLock, WRITER_ADMIN_LOCKED_DOCS } from './admin-lock.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { recordTopologyChange } from './topology-receipts.ts';
import { lockTopologyPrincipal, topologyPrincipal } from './topology-locks.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { carryHoldsToClassicState, holdCarryBlocked, planHoldCarry, type HoldCarry } from '../connectors/item-holds-store.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath } from './physical-root-record.ts';

export const DEACTIVATE_DOCS = 'docs/architecture/topologies.md#deactivate-runbook';

export interface DeactivationBlocker {
  kind: 'writer_admin_lock' | 'request' | 'topology_recovery' | 'effect' | 'lease' | 'connector_holds';
  id: string;
  source_id?: string;
  detail: string;
  /** The supported exit, filled with real values. */
  exit: string;
}

export interface LocalMarkerReport {
  state: 'cleared' | 'pending';
  removed: string[];
  pending: Array<{ path: string; reason: string }>;
  rerun?: string;
}

export interface DeactivationReport {
  mode: 'classic' | 'managed';
  deactivated: boolean;
  dry_run: boolean;
  mode_epoch: number;
  retired_mode_epoch?: number;
  retired_worktrees: Array<{ id: string; roots: string[] }>;
  source_bindings: number;
  kept: { skill_bundles_enabled: boolean; writer_protocol_floor: number; writer_protocol_registrations: number };
  blockers: DeactivationBlocker[];
  /** Held connector items copied (or, on a dry run, to be copied) into each source's classic state file. */
  carried_holds?: HoldCarry[];
  local_markers?: LocalMarkerReport;
}

interface BrainRow { brain_id: string; enabled: boolean; mode_epoch: string | number; skill_bundles_enabled: boolean | null; writer_protocol_floor: number | null }

async function readBrain(engine: BrainEngine, lock = false): Promise<BrainRow> {
  const [brain] = await engine.executeRaw<BrainRow>(`SELECT brain_id, enabled, mode_epoch,
      (to_jsonb(persistence_brain)->>'skill_bundles_enabled')::boolean AS skill_bundles_enabled,
      (to_jsonb(persistence_brain)->>'writer_protocol_floor')::int AS writer_protocol_floor
    FROM persistence_brain WHERE singleton=1${lock ? ' FOR UPDATE' : ''}`);
  if (!brain) throw new OperationError('writer_not_initialized', 'Persistence identity is missing.');
  return brain;
}

/** Every piece of work that keeps the brain from quiescing, with its CLI exit. Read-only. */
export async function deactivationBlockers(engine: BrainEngine): Promise<DeactivationBlocker[]> {
  const blockers: DeactivationBlocker[] = [];
  const lock = await readWriterAdminLock(engine);
  if (lock.locked) blockers.push({ kind: 'writer_admin_lock', id: 'persistence.writer_admin_lock', detail: `set at ${lock.set_at ?? 'unknown'}`,
    exit: 'gbrain sources writer unlock' });
  const requests = await engine.executeRaw<{ request_id: string; source_id: string; slug: string; operation: string; state: string; recovering: boolean }>(
    `SELECT request_id::text AS request_id, source_id, slug, operation, state, recovery IS NOT NULL AS recovering FROM persistence_requests
     WHERE state IN ('queued','running','recovering') OR recovery IS NOT NULL ORDER BY sequence LIMIT 50`);
  for (const r of requests) {
    blockers.push({ kind: 'request', id: r.request_id, source_id: r.source_id, detail: `${r.operation} ${r.state}${r.recovering ? ', recovering' : ''} (${r.source_id}:${r.slug})`,
      exit: r.state === 'queued' && !r.recovering ? `gbrain cancel-write-request ${r.request_id} (MCP: cancel_write_request), or wait for the owner to publish it`
        : r.state === 'running' && !r.recovering ? 'wait for the owner to finish publishing it, then rerun deactivate'
          : `gbrain sync --source ${r.source_id} --no-pull --retry-failed` });
  }
  const topology = await engine.executeRaw<{ id: string; operation: string; source_id: string }>(
    "SELECT id::text AS id, operation, source_id FROM persistence_topology_changes WHERE state='recovering' OR recovery IS NOT NULL ORDER BY created_at LIMIT 20");
  for (const t of topology) blockers.push({ kind: 'topology_recovery', id: t.id, source_id: t.source_id, detail: `${t.operation} for ${t.source_id} is recovering`,
    exit: `gbrain sources writer status ${t.source_id} --json, then let the owner finish recovery` });
  const effects = await engine.executeRaw<{ effect_id: string; kind: string; state: string; source_id: string; request_id: string; error_code: string | null; recovering: boolean; source_live: boolean }>(
    `SELECT e.id::text AS effect_id, e.kind, e.state, COALESCE(e.source_id, r.source_id) AS source_id, r.request_id::text AS request_id, e.error_code,
       e.recovery IS NOT NULL AS recovering,
       EXISTS (SELECT 1 FROM sources s WHERE s.id = r.source_id AND s.incarnation = r.source_incarnation) AS source_live
     FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
     WHERE e.state<>'committed' OR e.recovery IS NOT NULL ORDER BY e.id LIMIT 50`);
  for (const e of effects) {
    blockers.push({ kind: 'effect', id: e.effect_id, source_id: e.source_id, detail: `${e.kind} effect ${e.state}${e.error_code ? ` (${e.error_code})` : ''} for request ${e.request_id}`,
      exit: e.kind === 'embedding' ? (e.source_live ? `gbrain repair embedding-effects --source ${e.source_id}` : 'gbrain repair embedding-effects (its source was removed; run it brain-wide)')
        : e.state === 'failed' ? `gbrain sources writer retry-effects ${e.source_id} --request-id ${e.request_id} --dry-run`
          : 'wait for the owner to drain it, then rerun deactivate' });
  }
  // Managed connector holds live in the managed checkpoint, which classic mode does not read. Deactivation copies
  // them into each source's classic state file; only a source whose holds have nowhere to go blocks it.
  for (const carry of await planHoldCarry(engine, existingLocalHostId())) {
    if (!holdCarryBlocked(carry)) continue;
    const resolve = `gbrain sources status ${carry.source_id} names each item's error; fix its cause, then gbrain sources retry-held ${carry.source_id} and gbrain sync --source ${carry.source_id} (a successful re-attempt clears the hold)`;
    blockers.push({ kind: 'connector_holds', id: carry.source_id, source_id: carry.source_id,
      detail: carry.owner_host
        ? `${carry.items} held item(s) on a worktree owned by host ${carry.owner_host}; deactivate cannot write that host's classic state`
        : carry.state_file
          ? `${carry.items} held item(s); the classic state file ${carry.state_file} does not parse (${carry.unreadable})`
          : `${carry.items} held item(s) and no classic state directory to carry them into`,
      exit: carry.owner_host
        ? `run deactivate on host ${carry.owner_host}; or ${resolve}`
        : carry.state_file ? `move ${carry.state_file} aside, then rerun deactivate; or ${resolve}` : resolve });
  }
  const leases = await engine.executeRaw<{ id: string; holder_host: string; holder_pid: number }>(
    'SELECT id, holder_host, holder_pid FROM gbrain_cycle_locks WHERE ttl_expires_at > now() ORDER BY id');
  for (const l of leases) blockers.push({ kind: 'lease', id: l.id, detail: `held by host ${l.holder_host}, pid ${l.holder_pid}`,
    exit: 'wait for that connector sync or maintenance run to finish (gbrain doctor shows live locks), then rerun deactivate' });
  return blockers;
}

function blockedError(blockers: DeactivationBlocker[]): OperationError {
  const locked = blockers.find(b => b.kind === 'writer_admin_lock');
  if (locked) return new OperationError('writer_admin_locked', 'Writer administration is locked; deactivation was not applied.',
    `Run gbrain sources writer unlock on the brain host, deactivate, then gbrain sources writer lock again.`, WRITER_ADMIN_LOCKED_DOCS);
  return new OperationError('writer_not_quiesced', `Deactivation requires a quiesced brain; ${blockers.length} item(s) block it.`,
    blockers.slice(0, 10).map(b => `${b.kind} ${b.id} (${b.detail}): ${b.exit}`).join(' | '), DEACTIVATE_DOCS);
}

async function retiredTopology(engine: BrainEngine): Promise<{ worktrees: Array<{ id: string; roots: string[] }>; bindings: number }> {
  const rows = await engine.executeRaw<{ id: string; root: string | null }>(`SELECT w.id::text AS id, h.local_path AS root FROM persistence_worktrees w
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=w.id WHERE w.state<>'retired' ORDER BY w.id, h.local_path`);
  const worktrees = new Map<string, string[]>();
  for (const row of rows) {
    const roots = worktrees.get(row.id) ?? [];
    if (row.root) roots.push(row.root);
    worktrees.set(row.id, roots);
  }
  const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM persistence_source_bindings');
  return { worktrees: [...worktrees].map(([id, roots]) => ({ id, roots })), bindings: Number(n) };
}

async function keptSettings(engine: BrainEngine, brain: BrainRow): Promise<DeactivationReport['kept']> {
  const [{ n }] = await engine.executeRaw<{ n: number }>("SELECT COUNT(*)::int AS n FROM persistence_writer_protocols").catch(() => [{ n: 0 }]);
  return { skill_bundles_enabled: brain.skill_bundles_enabled === true, writer_protocol_floor: brain.writer_protocol_floor ?? 1, writer_protocol_registrations: Number(n) };
}

export async function deactivatePersistence(engine: BrainEngine, opts: { dryRun?: boolean; expectedState?: string; requestId?: string;
  hooks?: { afterLocks?: () => Promise<void> } } = {}): Promise<DeactivationReport> {
  const brain = await readBrain(engine);
  const topology = await retiredTopology(engine);
  const kept = await keptSettings(engine, brain);
  const base = { dry_run: opts.dryRun === true, retired_worktrees: topology.worktrees, source_bindings: topology.bindings, kept };
  if (!brain.enabled) {
    // A disabled brain has nothing to convert; a rerun only clears this host's retired markers.
    return { ...base, mode: 'classic', deactivated: false, mode_epoch: Number(brain.mode_epoch), retired_worktrees: [], source_bindings: 0, blockers: [],
      ...(opts.dryRun ? {} : { local_markers: await cleanupRetiredManagedMarkers(engine) }) };
  }
  const blockers = await deactivationBlockers(engine);
  if (opts.dryRun) {
    const carried_holds = (await planHoldCarry(engine, existingLocalHostId())).filter(c => c.items > 0 && !holdCarryBlocked(c));
    return { ...base, mode: 'managed', deactivated: false, mode_epoch: Number(brain.mode_epoch), blockers, carried_holds };
  }
  if (blockers.length) throw blockedError(blockers);
  const principal = await topologyPrincipal(engine);
  const requestId = opts.requestId ?? randomUUID();
  const hostId = existingLocalHostId();
  const locks: NativeLockHandle[] = [];
  let report: DeactivationReport;
  try {
    // Native worktree locks precede the transaction, as in activation.
    const sources = await engine.executeRaw<{ id: string }>('SELECT source_id AS id FROM persistence_source_bindings ORDER BY source_id');
    const local = new Map<string, Awaited<ReturnType<typeof getWorktreeBinding>>>();
    for (const { id } of sources) {
      const binding = await getWorktreeBinding(engine, id, hostId);
      if (binding && binding.owner_host_id === hostId && binding.local_path) local.set(binding.worktree_id, binding);
    }
    for (const binding of [...local.values()].sort((a, b) => a!.worktree_id.localeCompare(b!.worktree_id))) {
      const lock = await acquireWorktree(binding!);
      if (!lock) throw new OperationError('writer_lock_unavailable', `A local process holds the canonical worktree lock of source '${binding!.source_id}'.`,
        'Stop the resident owner on this host (gbrain serve or autopilot), then rerun deactivate.');
      locks.push(lock);
    }
    report = await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('lock_timeout','5000ms',true),set_config('synchronous_commit','on',true)");
      const current = await readBrain(tx, true);
      await assertWriterAdminState(tx, opts.expectedState);
      await assertWriterAdminUnlocked(tx);
      if (!current.enabled) throw new OperationError('writer_admin_state_changed', 'The brain was deactivated concurrently.');
      await tx.executeRaw('SELECT id FROM persistence_worktrees ORDER BY id FOR UPDATE');
      await tx.executeRaw('SELECT id FROM sources ORDER BY id FOR UPDATE');
      await opts.hooks?.afterLocks?.();
      const inside = await deactivationBlockers(tx);
      if (inside.length) throw blockedError(inside);
      // Written before commit: if the transaction then fails, the brain stays managed and ignores these files.
      const carried_holds = await carryHoldsToClassicState(tx, hostId);
      const retired = await retiredTopology(tx);
      const [epoch] = await tx.executeRaw<{ mode_epoch: string }>(
        'UPDATE persistence_brain SET enabled=false, mode_epoch=mode_epoch+1 WHERE singleton=1 RETURNING mode_epoch::text');
      await tx.executeRaw("UPDATE persistence_worktrees SET state='retired' WHERE state<>'retired'");
      await tx.executeRaw('DELETE FROM persistence_source_bindings');
      await tx.executeRaw('DELETE FROM persistence_host_bindings');
      const sourceRoots = (await tx.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE local_path IS NOT NULL')).map(r => r.local_path);
      const outcome = { brain_id: current.brain_id, retired_mode_epoch: Number(current.mode_epoch), mode_epoch: Number(epoch.mode_epoch),
        worktrees: retired.worktrees, source_roots: sourceRoots };
      await lockTopologyPrincipal(tx, principal);
      await recordTopologyChange(tx, { principal, requestId, intent: { operation: 'writer_deactivate' }, operation: 'writer_deactivate', sourceId: '*',
        incarnation: null, worktrees: retired.worktrees.map(w => w.id) }, outcome);
      await refreshManagedFilesystemRoots(tx, managedFilesystemDatastorePath(engine));
      return { ...base, mode: 'classic' as const, deactivated: true, mode_epoch: Number(epoch.mode_epoch), retired_mode_epoch: Number(current.mode_epoch),
        retired_worktrees: retired.worktrees, source_bindings: retired.bindings, blockers: [], carried_holds };
    });
  } finally { for (const lock of locks.reverse()) await lock.release(); }
  return { ...report, local_markers: await cleanupRetiredManagedMarkers(engine) };
}

interface RetiredRecord { epochs: Set<number>; worktrees: Set<string>; roots: Set<string> }

async function readRetired(engine: BrainEngine, brainId: string): Promise<RetiredRecord> {
  const rows = await engine.executeRaw<{ outcome: { brain_id?: string; retired_mode_epoch?: number; worktrees?: Array<{ id: string; roots: string[] }>; source_roots?: string[] } }>(
    "SELECT outcome FROM persistence_topology_changes WHERE operation='writer_deactivate' AND state='committed'");
  const retired: RetiredRecord = { epochs: new Set(), worktrees: new Set(), roots: new Set() };
  const canonical = (path: string) => { try { return canonicalFilesystemPath(path); } catch { return path; } };
  for (const { outcome } of rows) {
    if (outcome?.brain_id !== brainId) continue;
    if (typeof outcome.retired_mode_epoch === 'number') retired.epochs.add(outcome.retired_mode_epoch);
    for (const w of outcome.worktrees ?? []) { retired.worktrees.add(w.id); for (const root of w.roots) retired.roots.add(canonical(root)); }
    for (const root of outcome.source_roots ?? []) retired.roots.add(canonical(root));
  }
  return retired;
}

function readJson(path: string): Record<string, unknown> | null {
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(readFileSync(path, 'utf8'));
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Remove this host's managed markers and registry records of retired epochs of
 * the connected brain. Runs on connect before any filesystem guard check, after
 * deactivate on the deactivating host, and on a rerun of deactivate. Each file
 * is re-read before unlinking; other brains' files and a newer prepared claim
 * are never touched; a filesystem error keeps the file and reports it pending.
 */
export async function cleanupRetiredManagedMarkers(engine: BrainEngine): Promise<LocalMarkerReport> {
  const report: LocalMarkerReport = { state: 'cleared', removed: [], pending: [] };
  const [present] = await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('persistence_topology_changes') IS NOT NULL AS present");
  if (!present?.present) return report;
  const [brain] = await engine.executeRaw<{ brain_id: string; enabled: boolean; mode_epoch: string | null }>(
    "SELECT brain_id, enabled, to_jsonb(persistence_brain)->>'mode_epoch' AS mode_epoch FROM persistence_brain WHERE singleton=1");
  if (!brain) return report;
  const current = Number(brain.mode_epoch ?? 1);
  const retired = await readRetired(engine, brain.brain_id);
  if (!retired.epochs.size && !retired.worktrees.size) return report;
  const activeRoots = new Set(brain.enabled ? (await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM persistence_host_bindings'))
    .map(row => { try { return canonicalFilesystemPath(row.local_path); } catch { return row.local_path; } }) : []);
  const known = retired.epochs.size > 0;
  /** removable, keep (normal), or a pending reason. */
  const judge = (value: Record<string, unknown>, root: string | null): 'remove' | 'keep' | string => {
    const epoch = value.mode_epoch === undefined ? null : Number(value.mode_epoch);
    if (epoch !== null) {
      if (retired.epochs.has(epoch) && epoch < current) return 'remove';
      if (brain.enabled && epoch === current) return 'keep';
      return epoch > current ? 'newer_mode_epoch' : 'unknown_mode_epoch';
    }
    // Worktree ids never repeat: a retired one is removed, any other (a newer prepared claim) is kept.
    const worktree = typeof value.worktree_id === 'string' ? value.worktree_id : typeof value.worktreeId === 'string' ? value.worktreeId : null;
    if (worktree) return retired.worktrees.has(worktree) ? 'remove' : 'keep';
    if (root !== null && retired.roots.has(root) && !activeRoots.has(root)) return 'remove';
    return brain.enabled || !known ? 'keep' : 'unrecorded_pre_epoch_marker';
  };
  const remove = (path: string, value: Record<string, unknown>) => {
    const again = readJson(path);
    if (!again || JSON.stringify(again) !== JSON.stringify(value)) { report.pending.push({ path, reason: 'changed_while_cleaning' }); return; }
    unlinkSync(path);
    report.removed.push(path);
  };
  const visit = (path: string, root: string | null, owns: (value: Record<string, unknown>) => boolean) => {
    try {
      const value = readJson(path);
      if (!value || !owns(value)) return;
      const verdict = judge(value, root);
      if (verdict === 'remove') remove(path, value);
      else if (verdict !== 'keep') report.pending.push({ path, reason: verdict });
    } catch (error) {
      report.pending.push({ path, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const ours = (value: Record<string, unknown>) => value.brain_id === brain.brain_id || value.brainId === brain.brain_id;
  const roots = new Set(retired.roots);
  const registry = join(configDir(), 'persistence', 'managed-roots');
  let files: string[] = [];
  try { files = readdirSync(registry).filter(file => file.startsWith(`${brain.brain_id}.`) && file.endsWith('.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report.pending.push({ path: registry, reason: `unreadable: ${(error as Error).message}` }); }
  for (const file of files) {
    const path = join(registry, file);
    try {
      const value = readJson(path);
      if (value && typeof value.root === 'string') roots.add(value.root);
      visit(path, typeof value?.root === 'string' ? value.root : null, ours);
    } catch (error) { report.pending.push({ path, reason: `unreadable: ${(error as Error).message}` }); }
  }
  for (const root of roots) {
    // A prepared-claim reservation lives beside the checkout and fences it even when the checkout is gone.
    visit(physicalRootReservationPath(root), root, ours);
    if (!existsSync(root)) continue;
    const gitMarker = gitManagedMarker(root);
    for (const marker of [join(root, '.gbrain-managed'), ...(gitMarker ? [gitMarker] : [])]) visit(marker, root, ours);
    visit(join(root, PHYSICAL_ROOT_MARKER), root, ours);
  }
  await refreshManagedFilesystemRoots(engine);
  if (report.pending.length) {
    report.state = 'pending';
    report.rerun = 'gbrain sources writer status (rerun on this host after fixing the named paths)';
  }
  return report;
}

function gitManagedMarker(root: string): string | null {
  for (let current = root; ; current = dirname(current)) {
    const git = join(current, '.git');
    if (existsSync(git)) {
      try {
        if (lstatSync(git).isDirectory()) return join(git, 'gbrain-managed.json');
        const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(git, 'utf8'));
        return match ? join(resolve(current, match[1]), 'gbrain-managed.json') : null;
      } catch { return null; }
    }
    if (dirname(current) === current) return null;
  }
}
