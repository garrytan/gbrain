/** `gbrain jobs cancel` (dispatched by runJobs in src/commands/jobs.ts). */
import type { JobsCommandContext } from './shared.ts';

export async function runJobsCancel({ args, queue }: JobsCommandContext): Promise<void> {
  const id = parseInt(args[1], 10);
  if (isNaN(id)) { console.error('Error: job ID required.'); process.exit(1); }

  try { await queue.ensureSchema(); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

  const cancelled = await queue.cancelJob(id);
  if (cancelled) {
    console.log(`Job #${id} cancelled.`);
  } else {
    console.error(`Could not cancel job #${id} (may already be completed/dead).`);
    process.exit(1);
  }
}
