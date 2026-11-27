/**
 * `initiative_finish` job (queued by finishInitiative). Data: { sourceId, slug, outcome }.
 *
 * Steps, each logged into the job result; Slack-side failures never block the merge:
 *   1. final sync of every Slack source that reads initiative channels (waits ≤ 10 min)
 *   2. route the last Slack facts onto the initiative
 *   3. (initiatives.slack.leave_on_finish) post a closing message, leave the channels
 *   4. slack_released_at = today: the channels drop off the dynamic channel list
 *   5. outcome done: plan the merge, write it on the page, apply it when merge.auto_apply
 *
 * A retry skips 1–4 once the channels are released and the planning once a plan exists.
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler, MinionJobContext } from '../types.ts';
import { MinionQueue } from '../queue.ts';
import { resolveApiToken } from '../../connectors/credentials.ts';
import { slackApi, type SlackApi } from '../../slack/client.ts';
import { VERSION } from '../../../version.ts';
import { readInitiativesConfig, today, type InitiativesConfig } from '../../initiatives/model.ts';
import { localContext, readPage, slackChannelsOf, updatePage } from '../../initiatives/store.ts';
import { routeInitiativeFacts } from '../../initiatives/route-facts.ts';
import { applyMerge, planMerge, readMergePlan, writeMergePlan, type ChatFn } from '../../initiatives/merge.ts';

/** The Slack calls this job makes. */
export interface InitiativeSlackApi {
  postMessage: SlackApi['postMessage'];
  leaveChannel(channel: string, signal?: AbortSignal): Promise<unknown>;
}

export interface InitiativeFinishDeps {
  /** Slack client for a Slack source (null: no token). Default: the source's bot token. */
  slack?: (source: { id: string; config: Record<string, unknown> }) => InitiativeSlackApi | null;
  chat?: ChatFn;
  /** Poll interval / ceiling while waiting for the final sync job. */
  pollMs?: number;
  syncTimeoutMs?: number;
}

interface StepLog { step: string; ok: boolean; detail?: string }
const TERMINAL = new Set(['completed', 'failed', 'dead', 'cancelled']);

function defaultSlack(source: { id: string; config: Record<string, unknown> }): InitiativeSlackApi | null {
  const tokenEnv = typeof source.config.s_token_env === 'string' && source.config.s_token_env.trim() ? source.config.s_token_env.trim() : undefined;
  const token = resolveApiToken('slack', tokenEnv)?.token;
  if (!token) return null;
  // leaveChannel is part of the Slack client (conversations.leave).
  return slackApi({ token, userAgent: `gbrain/${VERSION} (+https://github.com/garrytan/gbrain)`, minDelayMs: 1100 }) as unknown as InitiativeSlackApi;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function finalSync(engine: BrainEngine, sourceId: string, job: MinionJobContext, deps: InitiativeFinishDeps): Promise<string> {
  const queue = new MinionQueue(engine);
  const sync = await queue.add('sync', { sourceId, noExtract: false });
  const deadline = Date.now() + (deps.syncTimeoutMs ?? 10 * 60_000);
  for (;;) {
    const row = await queue.getJob(sync.id);
    if (!row) return `sync job ${sync.id} vanished`;
    if (TERMINAL.has(row.status)) {
      if (row.status !== 'completed') throw new Error(`sync job ${sync.id} ${row.status}${row.error_text ? `: ${row.error_text}` : ''}`);
      return `sync job ${sync.id} completed`;
    }
    if (Date.now() >= deadline) throw new Error(`sync job ${sync.id} still ${row.status} after the wait limit`);
    await wait(deps.pollMs ?? 2000, job.signal);
  }
}

async function runStep(log: StepLog[], step: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await fn();
    log.push({ step, ok: true, ...(detail ? { detail } : {}) });
    return true;
  } catch (err) {
    log.push({ step, ok: false, detail: (err as Error)?.message ?? String(err) });
    return false;
  }
}

export function makeInitiativeFinishHandler(engine: BrainEngine, deps: InitiativeFinishDeps = {}): MinionHandler {
  return async (job) => {
    const sourceId = String(job.data.sourceId ?? '').trim();
    const slug = String(job.data.slug ?? '').trim();
    const outcome = job.data.outcome === 'cancelled' ? 'cancelled' : 'done';
    if (!sourceId || !slug) throw new Error('initiative_finish: data needs sourceId and slug');
    const cfg: InitiativesConfig = { ...(await readInitiativesConfig(engine)), sourceId };
    const ctx = localContext(engine, cfg.sourceId);
    const log: StepLog[] = [];
    const page = await readPage(engine, cfg.sourceId, slug);
    if (!page) throw new Error(`initiative_finish: no page ${slug} in source ${cfg.sourceId}`);
    const channels = slackChannelsOf(page.frontmatter);

    if (channels.length && !page.frontmatter.slack_released_at) {
      const sources = (await engine.executeRaw<{ id: string; config: Record<string, unknown> | null }>(
        `SELECT id, config FROM sources WHERE config->>'kind' = 'slack' AND config->>'s_channels_from' = 'initiatives' ORDER BY id`,
      )).map(s => ({ id: s.id, config: s.config ?? {} }));
      for (const src of sources) {
        await runStep(log, `sync ${src.id}`, () => finalSync(engine, src.id, job, deps));
        if (job.signal.aborted) throw new Error('initiative_finish aborted');
        await runStep(log, `route facts ${src.id}`, async () => {
          const r = await routeInitiativeFacts(engine, cfg, src.id, { onlyChannels: channels });
          if (r.errors.length) throw new Error(`routed ${r.routed}; ${r.errors.join('; ')}`);
          return `routed ${r.routed} of ${r.scanned}`;
        });
      }
      if (cfg.slackLeaveOnFinish) {
        const source = sources[0] ?? { id: '', config: {} };
        const holder: { api: InitiativeSlackApi | null } = { api: null };
        await runStep(log, 'slack client', async () => {
          holder.api = (deps.slack ?? defaultSlack)(source);
          if (!holder.api) throw new Error('no Slack bot token');
        });
        const client = holder.api as InitiativeSlackApi | null;
        for (const channel of client ? channels : []) {
          if (!client) break;
          await runStep(log, `leave ${channel}`, async () => {
            await client.postMessage({ channel, text: `This initiative is finished (${outcome}); gbrain no longer reads this channel. Page: ${page.slug}` }, job.signal);
            try {
              await client.leaveChannel(channel, job.signal);
            } catch (err) {
              if (!/not_in_channel/.test(`${(err as { code?: string })?.code ?? ''} ${(err as Error)?.message ?? ''}`)) throw err;
              return 'not in channel';
            }
          });
        }
      }
      await runStep(log, 'release channels', async () => {
        await updatePage(ctx, cfg.sourceId, page.slug, p => ({ frontmatter: { ...p.frontmatter, slack_released_at: today() } }));
      });
    }

    if (outcome === 'done') {
      // Merge failures throw so the job retries (the steps above are skipped on retry).
      const current = await readPage(engine, cfg.sourceId, page.slug);
      const status = String(current?.frontmatter.merge_status ?? '');
      if (status !== 'applied' && !(status === 'proposed' && current && readMergePlan(current.body))) {
        const plan = await planMerge(engine, cfg, page.slug, { ...(deps.chat ? { chat: deps.chat } : {}) });
        await writeMergePlan(ctx, cfg, page.slug, plan);
        log.push({ step: 'plan merge', ok: true, detail: `${plan.items.length} items, ${plan.new_projects.length} new pages` });
      }
      if (cfg.mergeAutoApply && status !== 'applied') {
        const r = await applyMerge(ctx, cfg, page.slug);
        log.push({ step: 'apply merge', ok: r.errors.length === 0, detail: `applied ${r.applied}, skipped ${r.skipped}${r.errors.length ? `; ${r.errors.join('; ')}` : ''}` });
      }
    }
    return { slug: page.slug, outcome, channels, steps: log };
  };
}
