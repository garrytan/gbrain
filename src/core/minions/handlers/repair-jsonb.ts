/**
 * `repair-jsonb` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { MinionHandler } from '../types.ts';

export const repairJsonbHandler: MinionHandler = async (job) => {
  const { repairJsonb } = await import('../../../commands/repair-jsonb.ts');
  const dryRun = !!job.data.dryRun;
  const result = await repairJsonb({ dryRun });
  return result;
};
