/**
 * Finish an initiative: flip its status (done | cancelled) and queue the
 * `initiative_finish` job, which does the slow part in the background (final
 * Slack sync + fact routing, leaving and releasing the channels, and for
 * `done` planning — optionally applying — the merge into its targets).
 */
import { MinionQueue } from '../minions/queue.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { INITIATIVE_TYPE, initiativeStatusOf, today, type InitiativesConfig } from './model.ts';
import { readPage, slackChannelsOf, updatePage } from './store.ts';

export interface FinishResult { slug: string; outcome: 'done' | 'cancelled'; status: 'queued' | 'dry_run'; job_id?: number; steps: string[]; channels: string[] }

export const INITIATIVE_FINISH_JOB = 'initiative_finish';

export function finishSteps(cfg: InitiativesConfig, outcome: 'done' | 'cancelled', channels: string[]): string[] {
  const steps = [`set status ${outcome}, finished_at ${today()}`];
  if (channels.length) {
    steps.push(`final Slack sync and fact routing for ${channels.join(', ')}`);
    if (cfg.slackLeaveOnFinish) steps.push(`post a closing message in and leave ${channels.join(', ')}`);
    steps.push('release the Slack channels (slack_released_at)');
  }
  if (outcome === 'done') steps.push(cfg.mergeAutoApply ? 'plan the merge into its targets and apply it' : 'plan the merge into its targets (merge_status: proposed)');
  else steps.push('merge nothing (cancelled)');
  return steps;
}

export async function finishInitiative(ctx: OperationContext, cfg: InitiativesConfig, slug: string,
  opts: { outcome: 'done' | 'cancelled'; note?: string; dryRun?: boolean }): Promise<FinishResult> {
  if (opts.outcome !== 'done' && opts.outcome !== 'cancelled') {
    throw new OperationError('invalid_params', `outcome must be done or cancelled, got ${String(opts.outcome)}.`, 'Pass outcome: done or cancelled.');
  }
  const page = await readPage(ctx.engine, cfg.sourceId, slug);
  if (!page || page.type !== INITIATIVE_TYPE) {
    throw new OperationError('initiative_not_found', `No initiative ${slug} in source ${cfg.sourceId}.`, 'Pass the slug of an initiative page.');
  }
  const status = initiativeStatusOf(page.frontmatter);
  if (status !== 'active') {
    throw new OperationError('initiative_not_active', `Initiative ${page.slug} is already ${status}.`, 'Only an active initiative can be finished.');
  }
  const channels = slackChannelsOf(page.frontmatter);
  const steps = finishSteps(cfg, opts.outcome, channels);
  if (opts.dryRun) return { slug: page.slug, outcome: opts.outcome, status: 'dry_run', steps, channels };

  const note = opts.note?.trim();
  await updatePage({ ...ctx, sourceId: cfg.sourceId }, cfg.sourceId, page.slug, p => {
    if (initiativeStatusOf(p.frontmatter) !== 'active') {
      throw new OperationError('initiative_not_active', `Initiative ${p.slug} is already ${initiativeStatusOf(p.frontmatter)}.`, 'Only an active initiative can be finished.');
    }
    return { frontmatter: { ...p.frontmatter, status: opts.outcome, finished_at: today(), ...(note ? { finish_note: note } : {}) } };
  });
  const job = await new MinionQueue(ctx.engine).add(INITIATIVE_FINISH_JOB,
    { sourceId: cfg.sourceId, slug: page.slug, outcome: opts.outcome },
    { queue: 'default', max_attempts: 3, idempotency_key: `${INITIATIVE_FINISH_JOB}:${cfg.sourceId}:${page.slug}` });
  return { slug: page.slug, outcome: opts.outcome, status: 'queued', job_id: Number(job.id), steps, channels };
}
