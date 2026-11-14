/**
 * The `wakeshift_report_back` coaching notice (Wakeshift plan D9). A remote caller that submits a job
 * (`submit_job`, `submit_agent`) holds an id it would otherwise poll, so the submit result tells it once that
 * gbrain can report back instead: with reporting back published (`mcp.publish_wakeshift`), the watch_job call that
 * wakes this conversation; without it, the owner's switch. Every remote submit qualifies: gbrain cannot tell a job's
 * runtime at submit (a sync of one file or ten thousand), remote submit_job only takes sync, import, lint and
 * lint-fix, and submit_agent is a model loop. The notice ledger keeps it to once per session (HTTP: per principal),
 * inside the coaching budget, and `mute_notice` / `gbrain notices mute wakeshift_report_back` silence it.
 * A trusted local CLI submit gets none: it has no conversation to wake.
 */
import type { Notice } from './agent-output.ts';
import type { OperationContext } from './ops/contract.ts';
import { wakeshiftPublished } from './wakeshift/config.ts';

export const REPORT_BACK_NOTICE_CODE = 'wakeshift_report_back';

/** The notice for a submitted job, in the published or the off wording. */
export function reportBackNotice(jobId: number, published: boolean): Notice {
  return {
    code: REPORT_BACK_NOTICE_CODE,
    kind: 'coaching',
    why: published
      ? `Want this conversation woken when it's done? Call watch_job with id ${jobId}.`
      : 'gbrain can report back when this finishes, through Wakeshift: ask the brain owner to run gbrain wakeshift enable.',
  };
}

/** Emit the notice on a remote caller's accepted submit. Advice only: never throws. */
export function emitReportBackNotice(ctx: OperationContext, jobId: number): void {
  if (ctx.remote === false || !ctx.emitNotice) return;
  try {
    ctx.emitNotice(reportBackNotice(jobId, wakeshiftPublished()));
  } catch { /* advice never fails a committed submission */ }
}
