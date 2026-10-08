/**
 * `reindex` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 *
 * W4.5: a paid run (re-embedding) is authorized only by the spend record a
 * consent-gated producer stored on the job (`jobs submit reindex`, the
 * search-mode switch prompt); the worker never prompts. A queued job without
 * one fails terminally with the consent refusal instead of spending.
 */
import type { BrainEngine } from '../../engine.ts';
import { UnrecoverableError } from '../errors.ts';
import type { MinionHandler } from '../types.ts';

export function makeReindexHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runReindex } = await import('../../../commands/reindex.ts');
    const args: string[] = ['--markdown'];
    if (typeof job.data.limit === 'number') args.push('--limit', String(job.data.limit));
    if (job.data.dryRun) args.push('--dry-run');
    if (job.data.noEmbed) args.push('--no-embed');
    if (typeof job.data.repoPath === 'string') args.push('--repo', job.data.repoPath);
    try {
      const result = await runReindex(engine, args, { authorized: job.spend?.record != null, interactive: false });
      return { ...result, ran: 'reindex' };
    } catch (e) {
      const { isConsentRefusal } = await import('../../consent.ts');
      if (!isConsentRefusal(e)) throw e;
      throw new UnrecoverableError(`confirmation_required: reindex job ${job.id} has no stored spend authorization, so it re-embedded nothing. `
        + `Ask the user, then queue it again with approval (gbrain jobs submit reindex --params '{"markdown":true}' --yes) or run it inline: ${e.consent.fix.command ?? 'gbrain reindex --markdown --yes'}.`);
    }
  };
}
