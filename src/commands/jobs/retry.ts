/** `gbrain jobs retry` (dispatched by runJobs in src/commands/jobs.ts). */
import type { JobsCommandContext } from './shared.ts';

export async function runJobsRetry({ args, queue }: JobsCommandContext): Promise<void> {
  const id = parseInt(args[1], 10);
  if (isNaN(id)) { console.error('Error: job ID required.'); process.exit(1); }

  try { await queue.ensureSchema(); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

  const retried = await queue.retryJob(id);
  if (retried) {
    console.log(`Job #${id} re-queued for retry.`);
  } else {
    console.error(`Could not retry job #${id} (must be failed or dead).`);
    process.exit(1);
  }
}
