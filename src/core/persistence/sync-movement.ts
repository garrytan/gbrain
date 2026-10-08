/**
 * #6317 (B4, I2): does managed sync data move? One reader behind
 * `gbrain sources status`, `gbrain sources writer status --json`, the doctor
 * check `managed_sync_not_moving`, the `serve` notice and
 * `gbrain sources writer movement`, so no surface can call a parked sync
 * healthy while another calls it stuck.
 *
 * Per active managed source the snapshot carries the unfinished cursor
 * (`readManagedSyncBacklog`: index, total, held, the drain's last advance),
 * the movement watermark (the newest `completed_at` of a committed
 * `managed_sync_*` receipt in the current source incarnation, read through
 * the partial index on `(worktree_id, completed_at DESC) WHERE
 * state='committed'`; never a count, since compaction nulls `intent`), the
 * head request's claim stamp (`step_since` moving is progress too: a
 * multi-wave group commits nothing until its last wave), the newest hold, and
 * who could move it: a live drain (the per-source sync lock) or a live
 * consumer on the owner host (a renewing claim, this process's own consumer,
 * or a live heartbeat row).
 *
 * The verdict: `nothing_pending` (no unfinished cursor), `parked` (pending,
 * but neither a drain nor a consumer with admitted work is live: a cursor left
 * between cron runs; informational, never scored), `held` (the newest activity
 * is a hold: #6298's containment, not a stall), `moving` (a commit or a step
 * advance within `persistence.preparation_ceiling_ms`), `not_moving` (none for
 * longer than the ceiling while something live should have produced one).
 * `data_moving` is true/false for the live states and null otherwise;
 * `not_moving_since` is the last watermark. `judgeMovement` compares two
 * snapshots over a window for the standalone command (`moved`,
 * `within_allowance`, `held`, `parked`, `not_moving`, `nothing_pending`).
 * `startMovementWatch` is the serve's unref'd ticker that prints one
 * `[gbrain notice managed_sync_not_moving]` when a source flips to not moving
 * and one line when it moves again.
 */
import type { BrainEngine } from '../engine.ts';
import { readManagedSyncBacklog, type ManagedSyncBacklog } from './sync-drain.ts';
import { claimStateOf, type ClaimState } from './claim-phase.ts';
import { readPreparationPolicy } from './switches.ts';
import { listHostConsumers } from './consumer-heartbeat.ts';

export type MovementState = 'moving' | 'held' | 'parked' | 'not_moving' | 'nothing_pending';
export interface MovementHead {
  request_id: string;
  state: string;
  phase: ClaimState['phase'] | null;
  step: string | null;
  step_since: string | null;
  step_age_ms: number | null;
  waiting_on: ClaimState['waiting_on'] | null;
  owner: ClaimState['owner'];
  last_sql: ClaimState['last_sql'];
  lapsed: boolean;
}
export interface MovementHolds { count: number; stalled: number; fences: number; concurrent: number; last_hold_at: string | null }
export interface SourceMovement {
  source_id: string;
  sampled_at: string;
  movement_state: MovementState;
  data_moving: boolean | null;
  not_moving_since: string | null;
  /** The newest committed managed receipt of this incarnation. */
  last_commit_at: string | null;
  /** The watermark the verdict used: the newest of a commit, a head step advance and the drain's cursor advance. */
  last_progress_at: string | null;
  cursor: (Pick<ManagedSyncBacklog, 'index' | 'total' | 'remaining' | 'held' | 'last_progress_at' | 'resume_command'>) | null;
  head: MovementHead | null;
  holds: MovementHolds;
  /** Managed requests admitted on the worktree and not yet settled (queued or running). */
  admitted: number;
  live: { drain: boolean; drain_pid: number | null; consumer: 'claim' | 'local' | 'heartbeat' | null };
  ceiling_ms: number;
  owner_is_this_host: boolean | null;
  writer_status_command: string;
}

export const MOVEMENT_WATCH_MS = 60_000;

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const newest = (...values: Array<string | null | undefined>): string | null => values.reduce<string | null>((best, value) => value && (!best || value > best) ? value : best, null);

export function writerStatusCommand(sourceId: string): string { return `gbrain sources writer status --source ${sourceId} --json`; }

interface BindingRow { source_id: string; worktree_id: string; source_incarnation: string; owner_host_id: string | null }
interface WatermarkRow { last_commit_at: unknown; admitted: number | string }
interface HeadRow { request_id: string; state: string; claim_phase: unknown; execution_token: string | null; claim_lapsed: boolean | null; publication_started: boolean | null }
interface HoldRow { count: number | string | null; stalled: number | string | null; fences: number | string | null; concurrent: number | string | null; updated_at: unknown }

/** The movement of every active managed source (or of `sourceIds`), one bounded read each; sources without a binding are omitted. */
export async function readSourceMovement(engine: BrainEngine, opts: { sourceIds?: string[]; now?: number } = {}): Promise<SourceMovement[]> {
  const now = opts.now ?? Date.now();
  const bindings = await engine.executeRaw<BindingRow>(`SELECT b.source_id, b.worktree_id::text AS worktree_id, b.source_incarnation::text AS source_incarnation, w.owner_host_id::text AS owner_host_id
    FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation
    JOIN persistence_worktrees w ON w.id=b.worktree_id WHERE ($1::text[] IS NULL OR b.source_id=ANY($1::text[])) ORDER BY b.source_id`, [opts.sourceIds ?? null]);
  if (!bindings.length) return [];
  const backlog = new Map((await readManagedSyncBacklog(engine, bindings.map(b => b.source_id)).catch(() => [])).map(b => [b.source_id, b]));
  const policy = await readPreparationPolicy(engine);
  const { localHostId } = await import('./identity.ts');
  const { persistenceConsumerStatus } = await import('./service.ts');
  const { liveSyncStatus } = await import('../db-lock.ts');
  const host = localHostId();
  const localConsumer = persistenceConsumerStatus(engine).state === 'open';
  let heartbeat: Promise<boolean> | undefined;
  const liveHeartbeat = () => heartbeat ??= listHostConsumers(engine, host).then(rows => rows.some(row => (row.mode === 'full' || row.mode === 'promoted') && row.liveness === 'live'), () => false);
  const out: SourceMovement[] = [];
  for (const binding of bindings) {
    const [mark] = await engine.executeRaw<WatermarkRow>(`SELECT
        (SELECT r.completed_at FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state='committed' AND r.source_incarnation=$2::uuid
           AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' ORDER BY r.completed_at DESC LIMIT 1) AS last_commit_at,
        (SELECT count(*) FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running') AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS admitted`,
    [binding.worktree_id, binding.source_incarnation]);
    const [headRow] = await engine.executeRaw<HeadRow>(`SELECT request_id::text AS request_id, state, claim_phase, execution_token::text AS execution_token,
        (claim_expires_at IS NOT NULL AND claim_expires_at < now()) AS claim_lapsed, publication_started
      FROM persistence_requests WHERE worktree_id=$1::uuid AND state IN ('queued','running','recovering') ORDER BY (state <> 'running'), sequence LIMIT 1`, [binding.worktree_id]);
    const [holdRow] = await engine.executeRaw<HoldRow>(`SELECT (completed_keys->0->>'count')::int AS count, (completed_keys->0->>'stalled')::int AS stalled,
        (completed_keys->0->>'fences')::int AS fences, (completed_keys->0->>'concurrent')::int AS concurrent, updated_at
      FROM op_checkpoints WHERE op='sync-hold-summary' AND completed_keys->0->>'source_id'=$1 AND completed_keys->0->>'incarnation'=$2 LIMIT 1`, [binding.source_id, binding.source_incarnation]);
    const claim = headRow ? claimStateOf({ state: headRow.state, claim_phase: headRow.claim_phase, execution_token: headRow.execution_token, claim_lapsed: headRow.claim_lapsed, publication_started: headRow.publication_started }, now) : null;
    const stampSince = (() => {
      const raw = typeof headRow?.claim_phase === 'string' ? safeJson(headRow.claim_phase) : headRow?.claim_phase;
      const stamp = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      return stamp && headRow && stamp.token === headRow.execution_token ? iso(stamp.step_since ?? stamp.since) : null;
    })();
    const head: MovementHead | null = headRow ? { request_id: headRow.request_id, state: headRow.state, phase: claim?.phase ?? null, step: claim?.step ?? null, step_since: stampSince,
      step_age_ms: claim?.step_age_ms ?? null, waiting_on: claim?.waiting_on ?? null, owner: claim?.owner ?? null, last_sql: claim?.last_sql ?? null, lapsed: headRow.claim_lapsed === true } : null;
    const drain = await liveSyncStatus(engine, binding.source_id);
    const ownerHere = binding.owner_host_id === null ? null : binding.owner_host_id === host;
    const claimLive = !!claim && (claim.phase === 'preparing' || claim.phase === 'publishing');
    const consumer: SourceMovement['live']['consumer'] = claimLive ? 'claim' : ownerHere !== false && localConsumer ? 'local' : ownerHere !== false && await liveHeartbeat() ? 'heartbeat' : null;
    const cursor = backlog.get(binding.source_id) ?? null;
    const holds: MovementHolds = { count: Number(holdRow?.count ?? 0), stalled: Number(holdRow?.stalled ?? 0), fences: Number(holdRow?.fences ?? 0), concurrent: Number(holdRow?.concurrent ?? 0), last_hold_at: iso(holdRow?.updated_at) };
    const lastCommitAt = iso(mark?.last_commit_at);
    const admitted = Number(mark?.admitted ?? 0);
    const progressAt = newest(lastCommitAt, claimLive ? head?.step_since : null, cursor?.last_progress_at);
    const sampledAt = new Date(now).toISOString();
    const base = { source_id: binding.source_id, sampled_at: sampledAt, last_commit_at: lastCommitAt, last_progress_at: progressAt,
      cursor: cursor ? { index: cursor.index, total: cursor.total, remaining: cursor.remaining, held: cursor.held, last_progress_at: cursor.last_progress_at, resume_command: cursor.resume_command } : null,
      head, holds, admitted, live: { drain: !!drain, drain_pid: drain?.holder_pid ?? null, consumer }, ceiling_ms: policy.ceilingMs, owner_is_this_host: ownerHere,
      writer_status_command: writerStatusCommand(binding.source_id) };
    out.push({ ...base, ...verdict(base, now) });
  }
  return out;
}

function verdict(m: Omit<SourceMovement, 'movement_state' | 'data_moving' | 'not_moving_since'>, now: number): Pick<SourceMovement, 'movement_state' | 'data_moving' | 'not_moving_since'> {
  if (!m.cursor) return { movement_state: 'nothing_pending', data_moving: null, not_moving_since: null };
  const driving = m.live.drain || (m.admitted > 0 && m.live.consumer !== null);
  if (!driving) return { movement_state: 'parked', data_moving: null, not_moving_since: null };
  if (m.holds.last_hold_at && (!m.last_commit_at || m.holds.last_hold_at > m.last_commit_at) && m.last_progress_at && m.holds.last_hold_at >= m.last_progress_at) {
    return { movement_state: 'held', data_moving: true, not_moving_since: null };
  }
  const since = m.last_progress_at ? Date.parse(m.last_progress_at) : NaN;
  if (Number.isFinite(since) && now - since > m.ceiling_ms) return { movement_state: 'not_moving', data_moving: false, not_moving_since: m.last_progress_at };
  return { movement_state: 'moving', data_moving: true, not_moving_since: null };
}
function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }

/** One human line per source for `gbrain sources status`; null for a source with nothing pending. */
export function formatSourceMovement(m: SourceMovement): string | null {
  if (m.movement_state === 'nothing_pending') return null;
  const where = m.head?.step ? ` head at step ${m.head.step}${m.head.waiting_on && m.head.waiting_on !== 'unknown' ? ` (waiting on ${m.head.waiting_on})` : ''}${m.head.owner ? `, ${m.head.owner.kind} pid ${m.head.owner.pid}` : ''};` : '';
  switch (m.movement_state) {
    case 'not_moving': return `${m.source_id}: managed sync NOT MOVING since ${m.not_moving_since} (no committed page or step advance for longer than ${Math.round(m.ceiling_ms / 1000)}s while a ${m.live.drain ? 'sync' : 'consumer'} is live);${where} inspect: ${m.writer_status_command}`;
    case 'parked': return `${m.source_id}: managed sync parked at ${m.cursor!.index}/${m.cursor!.total} (no sync or consumer is live; informational). Resume: ${m.cursor!.resume_command}`;
    case 'held': return `${m.source_id}: managed sync advancing by holds only (${m.holds.count} held, newest ${m.holds.last_hold_at}); the containment is working, not a stall.`;
    default: return `${m.source_id}: managed sync moving (last progress ${m.last_progress_at ?? 'unknown'}, ${m.cursor!.remaining} remaining).`;
  }
}

/** The command's verdict over a window: what changed between two snapshots of one source. */
export type MovementVerdict = 'moved' | 'within_allowance' | 'held' | 'parked' | 'not_moving' | 'nothing_pending';
export function judgeMovement(before: SourceMovement | undefined, after: SourceMovement): MovementVerdict {
  if (after.movement_state === 'nothing_pending') return 'nothing_pending';
  if (!before) return after.movement_state === 'moving' ? 'moved' : after.movement_state;
  if (after.last_commit_at && (!before.last_commit_at || after.last_commit_at > before.last_commit_at)) return 'moved';
  if (after.holds.last_hold_at && (!before.holds.last_hold_at || after.holds.last_hold_at > before.holds.last_hold_at)) return 'held';
  if (after.movement_state === 'parked') return 'parked';
  const stepAdvanced = after.head?.step_since && (!before.head || before.head.request_id !== after.head.request_id || before.head.step_since !== after.head.step_since);
  if (stepAdvanced || (after.cursor && before.cursor && after.cursor.index > before.cursor.index)) return 'within_allowance';
  return 'not_moving';
}

export interface MovementWatch { stop(): void; tick(): Promise<void> }
/**
 * The serve's ticker: reads movement every `everyMs` and logs one notice when a source flips to `not_moving`
 * (and one recovery line when it moves again). Read failures are swallowed; the timer never keeps the process alive.
 */
export function startMovementWatch(engine: BrainEngine, opts: { log: (line: string) => void; everyMs?: number; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval } ): MovementWatch {
  const flipped = new Set<string>();
  let inflight = false;
  const tick = async () => {
    if (inflight) return;
    inflight = true;
    try {
      for (const m of await readSourceMovement(engine)) {
        if (m.movement_state === 'not_moving' && !flipped.has(m.source_id)) {
          flipped.add(m.source_id);
          opts.log(`[gbrain notice managed_sync_not_moving kind=degraded] ${formatSourceMovement(m)}\nnext: run ${m.writer_status_command} (read-only) and act on the running claim's next step.`);
        } else if (m.movement_state !== 'not_moving' && flipped.delete(m.source_id)) {
          opts.log(`[gbrain notice managed_sync_not_moving kind=info] ${m.source_id}: managed sync data is moving again (${m.movement_state}).`);
        }
      }
    } catch { /* a diagnostic read never disturbs the serve */ } finally { inflight = false; }
  };
  const every = opts.everyMs ?? MOVEMENT_WATCH_MS;
  const timer = (opts.setInterval ?? setInterval)(() => { void tick(); }, every);
  (timer as { unref?: () => void }).unref?.();
  return { tick, stop: () => { (opts.clearInterval ?? clearInterval)(timer); } };
}
