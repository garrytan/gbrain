/** `gbrain jobs prune` (dispatched by runJobs in src/commands/jobs.ts). */
import { hasFlag, parseFlag, type JobsCommandContext } from './shared.ts';

export async function runJobsPrune({ args, queue }: JobsCommandContext): Promise<void> {
  const olderThanStr = parseFlag(args, '--older-than') ?? '30d';
  const days = parseInt(olderThanStr, 10);
  if (isNaN(days) || days <= 0) {
    console.error('Error: --older-than must be a positive number (days). Example: --older-than 30d');
    process.exit(1);
  }

  try { await queue.ensureSchema(); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

  // #2712: --dry-run previews the count without deleting. It used to be
  // silently ignored (the destructive default ran anyway).
  const dryRun = hasFlag(args, '--dry-run');
  const count = await queue.prune({ olderThan: new Date(Date.now() - days * 86400000), dryRun });
  if (dryRun) {
    console.log(`[dry-run] Would prune ${count} jobs older than ${days} days. Nothing deleted.`);
  } else {
    console.log(`Pruned ${count} jobs older than ${days} days.`);
  }
}
