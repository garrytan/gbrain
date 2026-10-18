/**
 * #6317 (B3, I1): what doctor and `writer status --json` read from the
 * consumer heartbeat rows and the host identity file.
 *
 * - `consumerOverlap`: two resident-kind full consumers both alive on one host
 *   for longer than `OVERLAP_MIN_AGE_MS` (doctor `two_consumers_on_host`); a
 *   `put`, `import` or `cli` row, or a row younger than that, is listed, never
 *   warned about: short-lived commands keep their own consumer by design and
 *   two starters within one renewal may both start full (a preference, not a
 *   fenced role).
 * - `ownersWithoutHeartbeat`: the owner identities stamped on this host's
 *   running claims that have no heartbeat row (doctor
 *   `consumers_without_heartbeat`): an older gbrain writes no row, so this is
 *   the only evidence such a process leaves.
 * - `hostIdentityMismatches`: a worktree this filesystem holds whose binding
 *   belongs to another host identity (doctor `host_identity_mismatch`): the
 *   same machine id in both `host.json` files, or (containers without a
 *   machine id) the binding's local path exists here with its managed marker
 *   and this process's `host.json` was minted after the binding under a
 *   different `HOME`/`GBRAIN_HOME`. A re-minted identity never re-owns a
 *   binding; the fix is `GBRAIN_HOME` on the supervisor.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { CONSUMER_LAPSED_MS, RESIDENT_CONSUMER_KINDS, listHostConsumers, type ListedConsumer } from './consumer-heartbeat.ts';
import type { LocalHostIdentity } from './identity.ts';
import { hasManagedRootMarker } from './root-registry.ts';

/** Both rows must be older than this before an overlap is a warning: two starters within one renewal are a known residual. */
export const OVERLAP_MIN_AGE_MS = 30_000;

/** The rows that make a persistent overlap: live, resident-kind, full or promoted, older than `OVERLAP_MIN_AGE_MS`. Empty or one row means no overlap. */
export function consumerOverlap(rows: readonly ListedConsumer[], minAgeMs = OVERLAP_MIN_AGE_MS): ListedConsumer[] {
  const resident = rows.filter(row => row.liveness === 'live' && RESIDENT_CONSUMER_KINDS.includes(row.kind) && (row.mode === 'full' || row.mode === 'promoted') && row.age_ms >= minAgeMs);
  return resident.length >= 2 ? resident : [];
}

export interface OwnerWithoutHeartbeat { kind: string | null; pid: number; nonce: string | null; version: string | null; requests: number; sources: string[]; lapsed: boolean }
/**
 * Owners stamped on running claims of worktrees this host owns (and of database-only requests, which any process of
 * this host may hold) that have no heartbeat row for this host. Only claims whose lease is still renewed count: a lapsed
 * claim's owner is gone, which `persistence_write_stall` and the drain already report.
 */
export async function ownersWithoutHeartbeat(engine: BrainEngine, hostId: string, rows?: readonly ListedConsumer[]): Promise<OwnerWithoutHeartbeat[]> {
  if (engine.kind === 'pglite') return [];
  const consumers = rows ?? await listHostConsumers(engine, hostId);
  const claims = await engine.executeRaw<{ source_id: string; owner: unknown; lapsed: boolean | null }>(
    `SELECT r.source_id,r.claim_phase->'owner' AS owner,r.claim_expires_at<now() AS lapsed FROM persistence_requests r
      LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
      WHERE r.state='running' AND r.claim_phase->'owner' IS NOT NULL AND (r.worktree_id IS NULL OR w.owner_host_id=$1::uuid)
      ORDER BY r.sequence LIMIT 500`, [hostId]);
  const seen = new Map<string, OwnerWithoutHeartbeat>();
  for (const claim of claims) {
    const owner = (typeof claim.owner === 'string' ? JSON.parse(claim.owner) : claim.owner) as { kind?: string; pid?: number; nonce?: string; version?: string } | null;
    if (!owner || typeof owner.pid !== 'number' || claim.lapsed) continue;
    const nonce = typeof owner.nonce === 'string' ? owner.nonce : null;
    if (consumers.some(row => row.pid === owner.pid && (nonce === null || row.nonce === nonce))) continue;
    const key = `${owner.pid}:${nonce ?? ''}`;
    const entry = seen.get(key) ?? { kind: owner.kind ?? null, pid: owner.pid, nonce, version: owner.version ?? null, requests: 0, sources: [], lapsed: false };
    entry.requests++;
    if (!entry.sources.includes(claim.source_id)) entry.sources.push(claim.source_id);
    seen.set(key, entry);
  }
  return [...seen.values()];
}

export interface HostIdentityMismatch {
  worktree_id: string;
  source_ids: string[];
  owner_host_id: string;
  local_path: string;
  /** Which predicate fired. */
  reason: 'same_machine_id' | 'worktree_on_this_filesystem';
  /** This process's identity file and where it was minted. */
  this_host: { host_id: string; host_json_path: string; minted_under: Record<string, unknown> | null };
  /** The owner's identity file, from its heartbeat row when one exists (`unknown` otherwise). */
  owner_host: { host_id: string; host_json_path: string | 'unknown'; persistence_home: string | 'unknown'; minted_under: Record<string, unknown> | 'unknown'; last_seen: string | null };
  /** The one-line fix for the supervisor: `GBRAIN_HOME=<owner's home>` (the parent value; config appends `.gbrain`). */
  fix_env: string | null;
}

type OwnerBinding = { worktree_id: string; owner_host_id: string; local_path: string; created_at: string; source_ids: string[] | null };
type OwnerRow = { host_id: string; host_json_path: string; persistence_home: string; minted_under: unknown; renewed_at: string };

/** The `GBRAIN_HOME` parent value a supervisor sets so this process mints under the owner's home: the owner's `gbrain_home`, else its persistence home's grandparent (`<home>/.gbrain/persistence`). */
function fixEnv(owner: OwnerRow | undefined): string | null {
  const minted = owner ? parse(owner.minted_under) : null;
  if (typeof minted?.gbrain_home === 'string' && minted.gbrain_home) return `GBRAIN_HOME=${minted.gbrain_home}`;
  if (owner?.persistence_home) return `GBRAIN_HOME=${dirname(dirname(owner.persistence_home))}`;
  return null;
}
function parse(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'string') { try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; } }
  return typeof value === 'object' ? value as Record<string, unknown> : null;
}
function mintedAt(path: string): number | null {
  try { const stat = statSync(path); return Math.min(stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs); } catch { return null; }
}

/**
 * Bindings owned by another host identity that this filesystem can see. `now` and `exists`/`marked` are seams for tests.
 */
export async function hostIdentityMismatches(engine: BrainEngine, me: LocalHostIdentity,
  seams: { now?: number; exists?: (path: string) => boolean; marked?: (path: string) => boolean; hostJsonMintedAt?: number | null } = {}): Promise<HostIdentityMismatch[]> {
  const exists = seams.exists ?? (path => { try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; } });
  const marked = seams.marked ?? hasManagedRootMarker;
  const bindings = await engine.executeRaw<OwnerBinding>(`SELECT w.id::text AS worktree_id,w.owner_host_id::text AS owner_host_id,h.local_path,w.created_at::text AS created_at,
      (SELECT array_agg(b.source_id ORDER BY b.source_id) FROM persistence_source_bindings b WHERE b.worktree_id=w.id) AS source_ids
    FROM persistence_worktrees w JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=w.owner_host_id
    WHERE w.owner_host_id IS NOT NULL AND w.owner_host_id<>$1::uuid AND w.state<>'recovering' ORDER BY w.created_at`, [me.id]);
  if (!bindings.length) return [];
  const owners = engine.kind === 'pglite' ? [] : await engine.executeRaw<OwnerRow>(`SELECT DISTINCT ON (host_id) host_id::text AS host_id,host_json_path,persistence_home,minted_under,renewed_at::text AS renewed_at
    FROM persistence_consumers WHERE host_id=ANY($1::uuid[]) ORDER BY host_id,renewed_at DESC`, [[...new Set(bindings.map(b => b.owner_host_id))]]);
  const myMintedAt = seams.hostJsonMintedAt === undefined ? mintedAt(me.path) : seams.hostJsonMintedAt;
  const out: HostIdentityMismatch[] = [];
  for (const binding of bindings) {
    const owner = owners.find(row => row.host_id === binding.owner_host_id);
    const ownerMinted = owner ? parse(owner.minted_under) : null;
    const sameMachine = !!me.minted_under?.machine_id && ownerMinted?.machine_id === me.minted_under.machine_id;
    const differentHome = !ownerMinted || ownerMinted.home !== me.minted_under?.home || ownerMinted.gbrain_home !== me.minted_under?.gbrain_home;
    const mintedAfter = myMintedAt !== null && myMintedAt > Date.parse(binding.created_at);
    const onThisFilesystem = !sameMachine && exists(binding.local_path) && marked(binding.local_path) && mintedAfter && differentHome;
    if (!sameMachine && !onThisFilesystem) continue;
    out.push({ worktree_id: binding.worktree_id, source_ids: binding.source_ids ?? [], owner_host_id: binding.owner_host_id, local_path: binding.local_path,
      reason: sameMachine ? 'same_machine_id' : 'worktree_on_this_filesystem',
      this_host: { host_id: me.id, host_json_path: me.path, minted_under: me.minted_under },
      owner_host: { host_id: binding.owner_host_id, host_json_path: owner?.host_json_path ?? 'unknown', persistence_home: owner?.persistence_home ?? 'unknown',
        minted_under: ownerMinted ?? 'unknown', last_seen: owner?.renewed_at ?? null },
      fix_env: fixEnv(owner) });
  }
  return out;
}

/** The rows `writer status --json` prints as `host.consumers`, oldest first, plus the overlap verdict and the lapsed window. */
export async function hostConsumersReport(engine: BrainEngine, hostId: string | null) {
  const consumers = hostId && engine.kind !== 'pglite' ? await listHostConsumers(engine, hostId) : [];
  return { consumers, overlap: consumerOverlap(consumers).map(row => ({ kind: row.kind, pid: row.pid, nonce: row.nonce })), lapsed_after_ms: CONSUMER_LAPSED_MS,
    ...(engine.kind === 'pglite' ? { scope: 'PGLite admits one process; no heartbeat rows are kept.' } : {}) };
}
