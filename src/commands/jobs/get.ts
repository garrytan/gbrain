/** `foresights jobs get` (dispatched by runJobs in src/commands/jobs.ts). */
import { formatJobDetail, hasFlag, rehydrateJobDates, type JobsCommandContext } from './shared.ts';
import { isThinClient, loadConfig } from '../../core/config.ts';
import type { MinionJob } from '../../core/minions/types.ts';
import { callRemoteTool, unpackToolResult } from '../../core/mcp-client.ts';
import { spendBasis } from '../../core/minions/spend-record.ts';
import { jobGroupAmounts } from '../../core/minions/spend-authorization.ts';
import { describeJobs, withInsight, type JobInsight } from '../../core/minions/job-insight.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { shellQuote } from '../../core/agent-output.ts';

export async function runJobsGet({ args, queue, engine }: JobsCommandContext): Promise<void> {
  const id = parseInt(args[1], 10);
  if (isNaN(id)) { console.error('Error: job ID required. Usage: foresights jobs get <id>'); process.exit(1); }

  // v0.32: thin-client routing (mirrors `list` branch above).
  const cfg = loadConfig();
  let job: MinionJob | null;
  if (isThinClient(cfg)) {
    try {
      const raw = await callRemoteTool(cfg!, 'get_job', { id }, { timeoutMs: 30_000 });
      job = rehydrateJobDates(unpackToolResult<MinionJob | null>(raw));
    } catch (e) {
      // The remote op throws `invalid_params` on not-found; surface as
      // the same "Job not found" exit-1 the local path produces.
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found/i.test(msg)) {
        console.error(`Job #${id} not found.`);
        process.exit(1);
      }
      throw e;
    }
  } else {
    try { await queue.ensureSchema(); }
    catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
    job = await queue.getJob(id);
  }
  if (!job) { console.error(`Job #${id} not found.`); process.exit(1); }
  await printJob(job, hasFlag(args, '--json'), isThinClient(cfg) ? null : engine);
}

/** The `jobs get` document (also printed by `jobs wait`): the row, #7241 insight and spend basis. A thin client's row already carries the insight. */
export async function printJob(job: MinionJob, json: boolean, engine: BrainEngine | null): Promise<void> {
  const insight = engine ? (await describeJobs(engine, [job])).get(job.id) : undefined;
  const doc = withInsight(job, insight) as MinionJob & Partial<JobInsight>;
  // #3685: same machine-readable contract as `list --json` above.
  if (json) {
    const { basis, why } = spendBasis(job);
    const group = job.spend_authorization && engine ? await jobGroupAmounts(engine, job.spend_authorization) : undefined;
    console.log(JSON.stringify({ ...doc, spend_basis: basis, spend_why: why, ...(group ? { spend_group: group } : {}) }, null, 2));
    return;
  }
  console.log(formatJobDetail(job));
  for (const line of insightLines(doc)) console.log(line);
}

function insightLines(doc: Partial<JobInsight>): string[] {
  const lines: string[] = [];
  const by = doc.submitted_by;
  if (by) lines.push(`  Submitted by: ${by.kind}${'id' in by && by.id != null ? ` ${by.id}` : ''}${'via' in by && by.via ? ` (${by.via})` : ''}`);
  for (const b of doc.blocked_by ?? []) {
    if (b.kind === 'queue') lines.push(`  Blocked by: queue ${b.queue}, position ${b.queue_position} (${b.ahead} ahead, ${b.active} running${b.active_jobs.length ? `: ${b.active_jobs.map(j => `#${j.id} ${j.name}`).join(', ')}` : ''})${b.private_queue ? ', private queue' : ''}`);
    else if (b.kind === 'waiting_children') lines.push(`  Blocked by: ${b.pending} unfinished children${b.child_ids.length ? ` (${b.child_ids.map(c => '#' + c).join(', ')})` : ''}`);
    else if (b.kind === 'delayed') lines.push(`  Blocked by: delayed until ${b.delay_until ?? '?'} (${b.reason})`);
    else if (b.kind === 'lock') lines.push(`  Blocked by: lock ${b.lock ?? ''} held${b.holder_job_id != null ? ` by job #${b.holder_job_id}` : b.holder ? ` by a ${b.holder.kind} holder` : ''}`);
    else if (b.kind === 'unreviewed_authority') lines.push(`  Blocked by: unreviewed legacy authority (${shellQuote(b.fix.argv ?? [])})`);
    else lines.push(`  Blocked by: ${b.kind}`);
  }
  if (doc.lock_expires_in_ms != null) {
    lines.push(`  Heartbeat: ${doc.heartbeat_age_ms == null ? '?' : Math.round(doc.heartbeat_age_ms / 1000) + 's ago'}; lock ${doc.stalled ? `expired ${Math.round(-doc.lock_expires_in_ms / 1000)}s ago (STALLED)` : `expires in ${Math.round(doc.lock_expires_in_ms / 1000)}s`}`);
  }
  const s = doc.spend;
  if (s && (s.tokens_input || s.tokens_output || s.cost_usd !== null)) {
    lines.push(`  Spend: ${s.cost_usd === null ? 'unpriced' : '$' + s.cost_usd.toFixed(4)}${s.includes_children ? ' (with children)' : ''}${s.unsettled_reservations ? `, ${s.unsettled_reservations} unsettled` : ''}`);
  }
  return lines;
}
