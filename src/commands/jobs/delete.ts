/** `gbrain jobs delete` (dispatched by runJobs in src/commands/jobs.ts). */
import type { JobsCommandContext } from './shared.ts';

export async function runJobsDelete({ args, queue }: JobsCommandContext): Promise<void> {
  const id = parseInt(args[1], 10);
  if (isNaN(id)) { console.error('Error: job ID required.'); process.exit(1); }

  try { await queue.ensureSchema(); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

  const removed = await queue.removeJob(id);
  if (removed) {
    console.log(`Job #${id} deleted.`);
  } else {
    console.error(`Could not delete job #${id} (must be in a terminal status).`);
    process.exit(1);
  }
}
