/**
 * `integrity` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { MinionHandler } from '../types.ts';

export const integrityHandler: MinionHandler = async (job) => {
  const { runIntegrity } = await import('../../../commands/integrity.ts');
  const args: string[] = [];
  args.push(job.data.mode === 'auto' ? 'auto' : 'check');
  if (typeof job.data.confidence === 'number') args.push('--confidence', String(job.data.confidence));
  if (job.data.dryRun) args.push('--dry-run');
  await runIntegrity(args);
  return { ran: 'integrity', mode: args[0] };
};
