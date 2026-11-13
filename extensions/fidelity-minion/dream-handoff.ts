import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { CYCLE_DEADLINE_RESERVE_MS } from '../../src/core/cycle/base-phase.ts';
import { runSubagentsInline } from '../../src/core/cycle/inline-drain.ts';
import { MinionQueue, DEFAULT_PRIVATE_QUEUE_LEASE_MS } from '../../src/core/minions/queue.ts';
import { FIDELITY_DREAM_GUARD_CAPABILITY, probeLiveFullConsumer } from '../../src/core/persistence/consumer-heartbeat.ts';
import { hostIdFor } from '../../src/core/persistence/identity.ts';
import { readWriteSwitchSnapshot } from '../../src/core/persistence/switches.ts';
import { FIDELITY_DREAM_INTENT } from '../../src/core/persistence/prepared-maintenance.ts';
import { waiterOnlyOwner } from '../../src/core/persistence/service.ts';
import { readCompletedDreamInputs, readDreamFidelityScope, dreamFidelityScopeKey, type DreamFidelityScope } from './dream-scope.ts';
import { JOB, makeFidelityHandler } from './handler.ts';

export type FidelityHandoff =
  | { status: 'skipped'; reason: 'deadline' | 'serve_unavailable' | 'extract_incomplete' | 'scope_changed' }
  | { status: 'published' | 'unchanged' | 'write_pending' | 'revision_conflict' | 'failed'; job_id: number; result: unknown }
  | { status: 'write_pending'; receipt: { request_id: string; state: string } }
  | { status: 'failed'; job_id?: number; reason: 'handoff_failed' };

type DreamLease = {
  signal?: AbortSignal;
  deadlineAtMs?: number | null;
  ownerJobId?: number | null;
  yieldDuringPhase?: () => Promise<void>;
};

/** Dispatch in a Dream-owned Minion queue, while the extraction source lease is held. */
export async function handoffFidelity(engine: BrainEngine, sourceId: string, scope: DreamFidelityScope, lease: DreamLease): Promise<FidelityHandoff | undefined> {
  if (engine.kind !== 'postgres') return;
  let jobId: number | undefined;
  try {
    const scopeStillActive = async () => {
      const current = await readDreamFidelityScope(engine, sourceId);
      return current !== null && dreamFidelityScopeKey(current) === dreamFidelityScopeKey(scope);
    };
    if (!await scopeStillActive()) return { status: 'skipped', reason: 'scope_changed' };
    const inputs = await readCompletedDreamInputs(engine, sourceId, scope);
    if (!inputs) return { status: 'skipped', reason: 'extract_incomplete' };
    const { topic } = scope;
    const { signal, ownerJobId, yieldDuringPhase } = lease;
    signal?.throwIfAborted();
    const { switches, preparation } = await readWriteSwitchSnapshot(engine);
    const owner = switches.single_consumer
      ? await probeLiveFullConsumer(engine, hostIdFor(engine), undefined, { ceilingMs: preparation.ceilingMs })
      : null;
    const delegation = waiterOnlyOwner(engine);
    if (owner?.kind !== 'serve' || owner.mode !== 'full' || !owner.capabilities?.includes(FIDELITY_DREAM_GUARD_CAPABILITY) ||
        delegation?.pid !== owner.pid || delegation?.nonce !== owner.nonce) {
      return { status: 'skipped', reason: 'serve_unavailable' };
    }

    signal?.throwIfAborted();
    const timeoutMs = Math.min(25_000, (lease.deadlineAtMs ?? Number.POSITIVE_INFINITY) - Date.now() - CYCLE_DEADLINE_RESERVE_MS);
    if (timeoutMs < 10_000) return { status: 'skipped', reason: 'deadline' };
    const [pending] = await engine.executeRaw<{ request_id: string; state: string }>(`
      SELECT request_id::text AS request_id, state FROM persistence_requests
      WHERE source_id=$1 AND slug=$2 AND intent->>'kind' IN ('managed_maintenance_guarded_page_v1', $3)
        AND state IN ('queued', 'deferred', 'running', 'recovering')
      ORDER BY created_at LIMIT 1`, [sourceId, `concepts/minion-fidelity-${topic}`, FIDELITY_DREAM_INTENT]);
    if (pending) return { status: 'write_pending', receipt: pending };
    const target = { sourceId, topic };
    const queue = new MinionQueue(engine);
    const ownerToken = randomUUID();
    const queueName = `dream-inline-fidelity-${ownerToken}`;
    try {
      const job = await queue.add(JOB, target, {
        queue: queueName, max_attempts: 1, max_stalled: 0, timeout_ms: timeoutMs,
        private_queue_owner_job_id: ownerJobId ?? null,
        private_queue_owner_token: ownerToken,
        private_queue_lease_ms: DEFAULT_PRIVATE_QUEUE_LEASE_MS,
      });
      jobId = job.id;
      await runSubagentsInline(engine, queue, queueName,
        queue.makeThrottledLeaseRenewer(queueName, ownerToken, yieldDuringPhase),
        async ctx => {
          if (!await scopeStillActive()) throw new Error('Fidelity Dream scope changed');
          return makeFidelityHandler(engine, target, { pages: inputs, activation: scope.activation })(ctx);
        }, 30_000, 1, lease.deadlineAtMs, signal, JOB, 10_000);
      const done = await queue.getJob(job.id);
      const outcome = done?.result?.status;
      const status = done?.status === 'completed' &&
        (outcome === 'published' || outcome === 'unchanged' || outcome === 'write_pending' || outcome === 'revision_conflict')
        ? outcome : 'failed';
      return { status, job_id: job.id, result: done?.result ?? null };
    } finally {
      await queue.reconcilePrivateQueue(queueName, 'fidelity extraction handoff ended');
    }
  } catch (error) {
    if (lease.signal?.aborted) throw error;
    return { status: 'failed', job_id: jobId, reason: 'handoff_failed' };
  }
}
