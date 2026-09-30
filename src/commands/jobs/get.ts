/** `gbrain jobs get` (dispatched by runJobs in src/commands/jobs.ts). */
import { formatJobDetail, hasFlag, rehydrateJobDates, type JobsCommandContext } from './shared.ts';
import { isThinClient, loadConfig } from '../../core/config.ts';
import type { MinionJob } from '../../core/minions/types.ts';
import { callRemoteTool, unpackToolResult } from '../../core/mcp-client.ts';

export async function runJobsGet({ args, queue }: JobsCommandContext): Promise<void> {
  const id = parseInt(args[1], 10);
  if (isNaN(id)) { console.error('Error: job ID required. Usage: gbrain jobs get <id>'); process.exit(1); }

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
  // #3685: same machine-readable contract as `list --json` above.
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(job, null, 2));
    return;
  }
  console.log(formatJobDetail(job));
}
