/**
 * The `ideas` dream-cycle phase entry: runs the ideas phase and posts its
 * status notices (idea planned / implemented / reopened) as thread replies on
 * the Slack messages ideas were born from, when a Slack bot token exists.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { runIdeasPhase, type IdeaStatusNotice } from './ideas-phase.ts';
import { initiativesSlackApi } from './slack.ts';

export async function runIdeasCyclePhase(engine: BrainEngine, opts: { dryRun?: boolean; signal?: AbortSignal }): Promise<PhaseResult> {
  const api = opts.dryRun ? null : initiativesSlackApi();
  const notify = api
    ? async (n: IdeaStatusNotice) => { await api.postMessage({ channel: n.channel, thread_ts: n.ts, text: n.text } as never); }
    : undefined;
  return runIdeasPhase(engine, { ...opts, ...(notify ? { notify } : {}) });
}
