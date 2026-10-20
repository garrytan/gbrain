/** Apple recovery is driven by durable pages and queue outcomes, not a one-shot cache flag.
 * Revisions skipped under a disabled switch/consent or deferred by provider/spend/depth are
 * reconsidered on every sweep. Only an actual extracted outcome settles a paid revision.
 */
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import { isAvailable } from '../ai/gateway.ts';
import { loopsSpendGate } from '../google/loops-spend.ts';
import { pendingLoopsExtractDepth, readLoopsExtractOutcomes, type LoopsEnqueueReport } from '../google/loop-catchup.ts';
import { LOOPS_EXTRACT_ENQUEUE_CEILING, LOOPS_EXTRACT_JOB, isLoopsExtractionEnabled } from '../google/loops-extract.ts';

export async function enqueueAppleCandidates(input: { engine: BrainEngine; sourceId: string;
  candidates: Array<{ slug: string; threadId: string; newestMs: number }>; log: (m: string) => void }): Promise<LoopsEnqueueReport> {
  const { engine, sourceId, log } = input;
  const skip = (reason: string): LoopsEnqueueReport => {
    log(`[apple] loops_extract: ${reason}; durable page revisions are retried next sweep`);
    return { enqueued: 0, deferred: input.candidates.length, skipped_reason: reason };
  };
  if (!(await isLoopsExtractionEnabled(engine))) return skip('extraction_disabled');
  if (!isAvailable('chat')) return skip('chat_unavailable');
  const spend = await loopsSpendGate(engine);
  if (!spend.ok) return skip(spend.reason);
  const outcomes = await readLoopsExtractOutcomes(engine, sourceId);
  const jobs = await engine.executeRaw<{ id: number; data: Record<string, unknown>; status: string; result: Record<string, unknown> | null }>(
    `SELECT id, data, status, result FROM minion_jobs WHERE name=$1 AND data->>'sourceId'=$2 ORDER BY id DESC`, [LOOPS_EXTRACT_JOB, sourceId]);
  let budget = Math.max(0, LOOPS_EXTRACT_ENQUEUE_CEILING - await pendingLoopsExtractDepth(engine, sourceId));
  const report: LoopsEnqueueReport = { enqueued: 0, deferred: 0, skipped_reason: null };
  const queue = new MinionQueue(engine);
  const candidates = [...new Map(input.candidates.map(c => [c.slug, c])).values()].sort((a,b) => b.newestMs-a.newestMs);
  for (const c of candidates) {
    const prior = outcomes[c.slug];
    if (prior?.rev === c.newestMs && prior.outcome === 'extracted') continue;
    const job = jobs.find(j => j.data.slug === c.slug && j.data.newestMs === c.newestMs);
    if (job && ['waiting', 'delayed', 'active'].includes(job.status)) continue;
    if (job?.status === 'completed' && job.result?.status === 'extracted') continue;
    if (budget <= 0) { report.deferred++; continue; }
    // Re-check source-authoritative consent immediately before each queue write as well as at entry.
    const { appleExtractionPolicy } = await import('./loops.ts');
    const policy = await appleExtractionPolicy(engine, sourceId);
    if (policy.refusal || !(await isLoopsExtractionEnabled(engine))) { report.skipped_reason = policy.refusal ?? 'extraction_disabled'; report.deferred++; continue; }
    const key = `loops:${sourceId}:${c.slug}:${c.newestMs}${job ? `:retry:${job.id}` : ''}`;
    await queue.add(LOOPS_EXTRACT_JOB, { slug: c.slug, sourceId, threadId: c.threadId, newestMs: c.newestMs, sourceKind: 'apple' },
      { priority: 5, idempotency_key: key }, { spendAuthorization: spend.record });
    budget--;
    report.enqueued++;
  }
  log(`[apple] loops_extract: enqueued ${report.enqueued}, deferred ${report.deferred}; unsettled revisions remain on durable pages`);
  return report;
}
