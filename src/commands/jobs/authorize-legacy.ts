/** `gbrain jobs authorize-legacy` (dispatched by runJobs in src/commands/jobs.ts). */
import { parseFlag, type JobsCommandContext } from './shared.ts';
import { authorizeLegacyJobs, parseLegacyJobIds } from '../../core/minions/authorize-legacy.ts';

export async function runJobsAuthorizeLegacy({ args, engine }: JobsCommandContext): Promise<void> {
  const ids = parseLegacyJobIds(parseFlag(args, '--ids'));
  const preview = args.includes('--dry-run');
  const result = await authorizeLegacyJobs(engine, ids, preview ? undefined : parseFlag(args, '--expect'), !preview && args.includes('--yes'));
  console.log(JSON.stringify(result, null, 2));
}
