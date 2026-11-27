/**
 * Slack sources and initiatives (`s_channels_from: initiatives`, `s_mode: intake`).
 *
 * - Dynamic channels: a `channels_from: initiatives` source also reads, each
 *   run, the Slack channels active initiatives name (`slack_channels`). They are
 *   read at run time and never enter the source config, so they never change
 *   the connector identity. A dynamic channel the app cannot read is skipped
 *   and reported; it never stops the run.
 * - Fact routing: after such a source syncs, facts extracted from day pages of
 *   an initiative's channel are re-homed onto the initiative page
 *   (initiatives/route-facts.ts). A routing failure never fails the sync.
 * - Intake: an intake source publishes no day pages. Each new top-level message
 *   is handed to the idea intake once; an idea gets a thread reply and a
 *   reaction, and when its thread grows the replies are appended to the idea.
 *   Per-message state lives in the source state (`intake`), so a message is
 *   classified once, and a reply or reaction is never posted twice.
 */
import type { BrainEngine } from '../engine.ts';
import { ConnectorAccessDeniedError } from '../connectors/client.ts';
import { runScoped } from '../connectors/api-source.ts';
import { readInitiativesConfig, type InitiativesConfig } from '../initiatives/model.ts';
import { initiativeChannels } from '../initiatives/store.ts';
import { routeInitiativeFacts, type RouteResult } from '../initiatives/route-facts.ts';
import type { IntakeMessage, IntakeOutcome } from '../initiatives/intake.ts';
import type { SlackApi } from './client.ts';
import { SLACK_CHANNEL_ID_RE } from './source-config.ts';
import type { SlackAccount, SlackMessage, SlackSourceConfig, SlackUser } from './types.ts';

const DAY_MS = 86_400_000;

/** Test seams for the initiatives side; each defaults to the real module. */
export interface SlackInitiativesDeps {
  config?: (engine: BrainEngine) => Promise<InitiativesConfig>;
  channels?: (engine: BrainEngine, cfg: InitiativesConfig) => Promise<string[]>;
  routeFacts?: (engine: BrainEngine, cfg: InitiativesConfig, slackSourceId: string, opts: { channelNames?: Record<string, string> }) => Promise<RouteResult>;
  handleIntakeMessage?: (engine: BrainEngine, cfg: InitiativesConfig, msg: IntakeMessage) => Promise<IntakeOutcome>;
  appendIdeaDiscussion?: (engine: BrainEngine, cfg: InitiativesConfig, ideaSlug: string,
    replies: Array<{ user?: string; userName?: string; text: string; ts: string }>) => Promise<void>;
}

/** One intake message as tracked in the source state. */
export interface SlackIntakeEntry {
  /** `idea` (with slug and status) or `skipped` (with reason). */
  kind: 'idea' | 'skipped';
  slug?: string;
  status?: 'created' | 'duplicate';
  reason?: string;
  /** The reply count the idea's discussion was last appended at. */
  replies: number;
  /** The thread reply and the reaction were posted (each once). */
  replied?: boolean;
  reacted?: boolean;
  /** The reply to post (kept until it is posted). */
  reply?: string;
}

export interface SlackIntakeChannelState {
  /** Every top-level message with ts <= since has been handed to the intake. */
  since: string | null;
  messages: Record<string, SlackIntakeEntry>;
}

export interface SlackIntakeCounts { created: number; duplicate: number; skipped: number; discussions: number; failed: number }

export const emptyIntakeCounts = (): SlackIntakeCounts => ({ created: 0, duplicate: 0, skipped: 0, discussions: 0, failed: 0 });

export async function initiativesConfigFor(engine: BrainEngine, deps: SlackInitiativesDeps = {}): Promise<InitiativesConfig> {
  return (deps.config ?? readInitiativesConfig)(engine);
}

/** The channel ids active initiatives name (C…/G… only; direct messages are never a source). */
export async function dynamicSlackChannels(engine: BrainEngine, deps: SlackInitiativesDeps = {}): Promise<string[]> {
  const cfg = await initiativesConfigFor(engine, deps);
  const ids = deps.channels ? await deps.channels(engine, cfg) : (await initiativeChannels(engine, cfg)).map(c => c.channel);
  return [...new Set(ids.map(id => id.trim().toUpperCase()).filter(id => SLACK_CHANNEL_ID_RE.test(id)))].sort();
}

/** Routes facts after a successful sync; never throws (the error comes back in the result). */
export async function routeFactsAfterSync(engine: BrainEngine, sourceId: string, channelNames: Record<string, string>,
  deps: SlackInitiativesDeps = {}): Promise<RouteResult | { error: string }> {
  try {
    const cfg = await initiativesConfigFor(engine, deps);
    return await (deps.routeFacts ?? routeInitiativeFacts)(engine, cfg, sourceId, { channelNames });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const isBot = (m: SlackMessage, botUserId: string | null) =>
  m.subtype === 'bot_message' || !!m.bot_id || (!!botUserId && m.user === botUserId);

/** A message the intake reads: top level, from a person, not a join notice or other system subtype. */
export function intakeCandidate(m: SlackMessage, botUserId: string | null): boolean {
  if (m.thread_ts && m.thread_ts !== m.ts) return false;
  if (isBot(m, botUserId)) return false;
  if (m.subtype && m.subtype !== 'thread_broadcast' && m.subtype !== 'file_share') return false;
  return !!(m.text ?? '').trim();
}

export interface IntakeChannelCtx {
  engine: BrainEngine;
  api: SlackApi;
  cfg: SlackSourceConfig;
  account: SlackAccount;
  channel: { id: string; name: string };
  state: SlackIntakeChannelState;
  users: Readonly<Record<string, SlackUser>>;
  ensureUsers: (messages: SlackMessage[]) => Promise<void>;
  runStart: number;
  counts: SlackIntakeCounts;
  initiatives: InitiativesConfig;
  deps: SlackInitiativesDeps;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/**
 * One intake channel: new top-level messages go to the idea intake once; ideas get their thread reply and reaction;
 * a tracked idea whose reply count grew has its non-bot replies appended. A per-message failure is counted and the
 * message is retried next run; a run-scoped error (auth, rate limit, request budget) stops the run with the state kept.
 */
export async function syncIntakeChannel(ctx: IntakeChannelCtx): Promise<void> {
  const { api, cfg, channel, state, signal } = ctx;
  const handle = ctx.deps.handleIntakeMessage ?? (await import('../initiatives/intake.ts')).handleIntakeMessage;
  const append = ctx.deps.appendIdeaDiscussion ?? (await import('../initiatives/intake.ts')).appendIdeaDiscussion;
  const horizon = ctx.runStart - cfg.lookbackDays * DAY_MS;
  const sinceMs = state.since ? Number(state.since) * 1000 : null;
  const oldest = sinceMs === null ? ctx.runStart - cfg.historyDays * DAY_MS : Math.min(sinceMs, horizon);
  const messages = (await api.history(channel.id, oldest / 1000, ctx.runStart / 1000 + 1, signal))
    .filter(m => intakeCandidate(m, ctx.account.botUserId));
  await ctx.ensureUsers(messages);
  const userName = (id?: string) => (id ? ctx.users[id]?.name : undefined);

  let blocked = false;
  const attempt = async (what: string, work: () => Promise<void>): Promise<boolean> => {
    try { await work(); return true; } catch (error) {
      if (runScoped(error)) throw error;
      ctx.counts.failed++;
      ctx.log?.(`[slack] intake ${channel.id} ${what}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  for (const m of messages) {
    let entry = state.messages[m.ts];
    if (!entry && state.since !== null && Number(m.ts) <= Number(state.since)) continue;
    if (!entry) {
      const ok = await attempt(`message ${m.ts}`, async () => {
        const permalink = await api.permalink(channel.id, m.ts, signal).catch(error => { if (runScoped(error)) throw error; return undefined; });
        const outcome = await handle(ctx.engine, ctx.initiatives, {
          channel: channel.id, channelName: channel.name, ts: m.ts, text: m.text ?? '',
          ...(m.user ? { user: m.user } : {}), ...(userName(m.user) ? { userName: userName(m.user) } : {}), ...(permalink ? { permalink } : {}),
        });
        entry = outcome.kind === 'idea'
          ? { kind: 'idea', slug: outcome.slug, status: outcome.status, reply: outcome.reply, replies: m.reply_count ?? 0 }
          : { kind: 'skipped', reason: outcome.reason, replies: m.reply_count ?? 0 };
        state.messages[m.ts] = entry;
        if (outcome.kind === 'idea') ctx.counts[outcome.status]++;
        else ctx.counts.skipped++;
      });
      if (!ok) { blocked = true; continue; }
    }
    if (!blocked) state.since = state.since !== null && Number(state.since) > Number(m.ts) ? state.since : m.ts;
    const e = entry!;
    if (e.kind !== 'idea' || !e.slug) continue;
    if (!e.replied && e.reply) {
      await api.postMessage({ channel: channel.id, thread_ts: m.ts, text: e.reply }, signal);
      e.replied = true;
      delete e.reply;
    } else if (!e.reply) e.replied = true;
    if (!e.reacted) {
      try { await api.reactionsAdd(channel.id, m.ts, e.status === 'created' ? 'white_check_mark' : 'link', signal); } catch (error) {
        // A missing reactions:write scope never blocks intake: the thread reply already answered.
        if (!(error instanceof ConnectorAccessDeniedError) && runScoped(error)) throw error;
        ctx.log?.(`[slack] intake ${channel.id} reaction on ${m.ts}: ${error instanceof Error ? error.message : String(error)}`);
      }
      e.reacted = true;
    }
    const count = m.reply_count ?? 0;
    if (count > e.replies) {
      await attempt(`discussion ${m.ts}`, async () => {
        const replies = (await api.replies(channel.id, m.ts, signal)).filter(r => !isBot(r, ctx.account.botUserId) && (r.text ?? '').trim());
        await ctx.ensureUsers(replies);
        if (replies.length) {
          await append(ctx.engine, ctx.initiatives, e.slug!, replies.map(r => ({
            ...(r.user ? { user: r.user } : {}), ...(userName(r.user) ? { userName: userName(r.user) } : {}), text: r.text ?? '', ts: r.ts })));
          ctx.counts.discussions++;
        }
        e.replies = count;
      });
    }
  }
  // Entries older than the re-read horizon and at or below the watermark are never read again.
  for (const ts of Object.keys(state.messages)) {
    if (Number(ts) * 1000 < horizon && state.since !== null && Number(ts) <= Number(state.since)) delete state.messages[ts];
  }
}
