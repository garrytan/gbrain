/**
 * managed_sync_not_moving (#6317, B4): the health surface stops calling a
 * parked sync healthy. Reads `readSourceMovement` (the reader `sources
 * status`, `writer status` and `writer movement` share) and warns, with the
 * writer-status command as a structured fix, when an unfinished managed
 * cursor has had neither a committed page nor a head step advance for longer
 * than `persistence.preparation_ceiling_ms` while a drain or consumer is live.
 * A cursor left between runs with nothing live is `parked`: listed, never
 * warned, unless (#6552 §2, #6712 PR 2) admitted requests wait in its queue
 * with no consumer and no progress for longer than that ceiling: nothing will
 * ever drain them, so the check fails and names the resume sync (which runs
 * its own consumer) as the safe action. A source whose backlog read failed
 * (#6781, `movement_state: unknown`) warns with `details.health: unknown`,
 * never `ok`. Reads the database only.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { readSourceMovement, type SourceMovement } from '../../../core/persistence/sync-movement.ts';
import { agentFix, checkError } from '../check-fix.ts';

const DOCS = 'docs/guides/troubleshooting.md#managed-sync-not-moving';

async function runManagedSyncMovementCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const movement = await readSourceMovement(connectedEngine(ctx));
    const pending = movement.filter(m => m.movement_state !== 'nothing_pending');
    const stuck = pending.filter(m => m.movement_state === 'not_moving');
    const parked = pending.filter(m => m.movement_state === 'parked');
    const stranded = parked.filter(strandedQueue);
    const unknown = pending.filter(m => m.movement_state === 'unknown');
    const details = { count: stuck.length, parked: parked.length, stranded: stranded.length, ...(unknown.length ? { unknown: unknown.length, health: 'unknown' } : {}), sources: pending.map(m => ({ source_id: m.source_id, movement_state: m.movement_state, data_moving: m.data_moving,
      not_moving_since: m.not_moving_since, last_commit_at: m.last_commit_at, last_progress_at: m.last_progress_at, cursor: m.cursor, head: m.head, live: m.live, admitted: m.admitted,
      ceiling_ms: m.ceiling_ms, writer_status_command: m.writer_status_command, ...(m.unknown ? { unknown: m.unknown } : {}) })), docs: DOCS };
    if (stranded.length) {
      const first = stranded[0]!;
      checks.push({ name: 'managed_sync_not_moving', status: 'fail', readiness_state: 'degraded', details,
        message: `${stranded.map(m => `${m.source_id} (${m.admitted} admitted request(s), no progress since ${m.last_progress_at ?? m.admitted_since})`).join('; ')}: managed sync is parked with a non-empty `
          + `write queue and no consumer for longer than the ${Math.round(first.ceiling_ms / 1000)}s ceiling, so nothing will drain it. Resuming the sync runs its own consumer beside the queue.`,
        fix: agentFix(['gbrain', 'sync', ...(first.cursor?.resume_args ?? ['--source', first.source_id, '--no-pull'])],
          `Resumes ${first.source_id}'s unfinished cursor with its stored options; the run consumes the queued requests itself (one drainer per source) and finishes the frozen manifest.`,
          'managed_sync_not_moving', { docs: DOCS }) });
    } else if (stuck.length) {
      const first = stuck[0]!;
      checks.push({ name: 'managed_sync_not_moving', status: 'warn', readiness_state: 'degraded', details,
        message: `${stuck.map(m => `${m.source_id} (since ${m.not_moving_since}${m.head?.step ? `, head at step ${m.head.step}` : ''}${m.head?.owner ? `, ${m.head.owner.kind} pid ${m.head.owner.pid}` : ''})`).join('; ')}: `
          + `managed sync data has not moved for longer than the ${Math.round(first.ceiling_ms / 1000)}s ceiling while a sync or consumer is live. The health signals are green; the data is not.`,
        fix: agentFix(['gbrain', 'sources', 'writer', 'status', '--source', first.source_id, '--json'],
          'Read-only: names the request at the head, its step, what it waits on, the owner process and the next step (`claim.next`) on the running claim.', 'managed_sync_not_moving', { docs: DOCS }) });
    } else if (unknown.length) {
      checks.push({ name: 'managed_sync_not_moving', status: 'warn', readiness_state: 'degraded', details,
        message: `${unknown.map(m => m.source_id).join(', ')}: the managed sync backlog could not be read (${unknown[0]!.unknown?.error ?? 'no detail'}), so whether sync data moves is unknown; this is not an all-clear.`,
        fix: agentFix(['gbrain', 'sources', 'writer', 'movement', unknown[0]!.source_id, '--json'],
          'Read-only: reads the backlog again and judges movement over one window; if the read keeps failing, gbrain doctor --json checks the database.', 'managed_sync_not_moving', { docs: DOCS }) });
    } else if (pending.length) {
      checks.push({ name: 'managed_sync_not_moving', status: 'ok', severity: 'info', details,
        message: `Managed sync data is moving${parked.length ? `; ${parked.map(m => `${m.source_id} is parked at ${m.cursor!.index}/${m.cursor!.total} (no sync or consumer live; resume: ${m.cursor!.resume_command})`).join('; ')}` : ''}.` });
    } else {
      checks.push({ name: 'managed_sync_not_moving', status: 'ok', message: 'No managed sync is pending.', details });
    }
  } catch (error) {
    checks.push(checkError('managed_sync_not_moving', 'read managed sync movement', error, { details: { health: 'unknown', docs: DOCS } }));
  }
  return checks;
}

/** #6552 §2: parked, yet admitted requests wait with no consumer, and nothing has moved (or, before any progress, been admitted) for longer than the ceiling. */
function strandedQueue(m: SourceMovement): boolean {
  const at = m.last_progress_at ?? m.admitted_since;
  const since = at ? Date.parse(at) : NaN;
  return m.admitted > 0 && m.live.consumer === null && Number.isFinite(since) && Date.parse(m.sampled_at) - since > m.ceiling_ms;
}

/** #6696 B1: an ops section (sync cursor movement and age); it reads request and checkpoint tables, so on PGLite the ops tier skips it. */
export const managedSyncMovementEntry: DoctorEntry = { name: 'managed_sync_not_moving', emits: ['managed_sync_not_moving'], tier: 'ops', opsPglite: 'not_applicable', run: runManagedSyncMovementCheck };
