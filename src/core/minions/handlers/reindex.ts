/**
 * `reindex` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

export function makeReindexHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runReindex } = await import('../../../commands/reindex.ts');
    const args: string[] = ['--markdown'];
    if (typeof job.data.limit === 'number') args.push('--limit', String(job.data.limit));
    if (job.data.dryRun) args.push('--dry-run');
    if (job.data.noEmbed) args.push('--no-embed');
    if (typeof job.data.repoPath === 'string') args.push('--repo', job.data.repoPath);
    const result = await runReindex(engine, args);
    return { ...result, ran: 'reindex' };
  };
}
