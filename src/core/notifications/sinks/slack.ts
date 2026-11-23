/**
 * The `slack` sink: one message per take proposal in one channel, edited in place when the proposal is decided, with
 * Accept / Reject buttons while it is pending.
 *
 * - take_proposal.created posts the proposal as it is now (chat.postMessage) and records { channel, ts } on the row,
 *   so a re-run or a backfill never posts it twice (the outbox queues each (sink, event, subject) once).
 * - take_proposal.accepted / .rejected edit that message (chat.update) to show the decision; before it is posted
 *   there is nothing to edit (the post, when it happens, already shows the decision).
 * - slack.interaction rows are button clicks the HTTP endpoint verified and queued (notifications/slack-interactions.ts).
 *   The clicker must be in `allowed_users` (Slack ids or emails) when that is set, else a member of the channel; their
 *   email (users.info, users:read.email) becomes the reviewer (acted_by), and the decision runs through the same
 *   acceptProposal / rejectProposal core the takes_proposal_accept / _reject operations use, with acted_via and the
 *   take write's agent label `slack:<sink>`. A refused or already-decided click gets an ephemeral reply.
 *
 * Token: the Slack connector's bot token (`resolveApiToken('slack', token_env)`: the named variable, else
 * GBRAIN_CONNECTOR_SLACK_TOKEN, else the token saved with `gbrain connectors auth slack --token -`).
 * Bot scopes: chat:write, users:read, users:read.email, channels:read (groups:read for a private channel).
 */
import { resolveApiToken } from '../../connectors/credentials.ts';
import { ConnectorAccessDeniedError, ConnectorAuthError } from '../../connectors/client.ts';
import { slackApi, SlackChannelUnavailableError, type SlackApi } from '../../slack/client.ts';
import { SLACK_CHANNEL_ID_RE } from '../../slack/source-config.ts';
import { VERSION } from '../../../version.ts';
import type { OperationContext } from '../../ops/contract.ts';
import { acceptProposal, rejectProposal, TakeProposalError } from '../../take-proposals.ts';
import { ALL_SOURCES } from '../../source-id.ts';
import type { SinkConfig } from '../config.ts';
import { deliveryOf, type OutboxRow } from '../outbox.ts';
import { proposalPayload, readProposalRows } from '../emit.ts';
import { NonRetryableSinkError, type DeliveryOutcome, type NotificationSink, type SinkContext } from '../types.ts';
import { renderProposalMessage } from './slack-blocks.ts';

export const SLACK_INTERACTION_EVENT = 'slack.interaction';
export const DEFAULT_SIGNING_SECRET_ENV = 'GBRAIN_SLACK_SIGNING_SECRET';

export interface SlackSinkSettings {
  channel: string;
  tokenEnv?: string;
  signingSecretEnv: string;
  interactive: boolean;
  allowedUsers: string[];
  pageUrl?: string;
}

export function slackSettings(config: SinkConfig): SlackSinkSettings {
  const channel = typeof config.channel === 'string' ? config.channel.trim().toUpperCase() : '';
  if (!SLACK_CHANNEL_ID_RE.test(channel)) throw new NonRetryableSinkError(`slack sink '${config.name}': channel must be a Slack channel id (C… or G…)`);
  const allowed = Array.isArray(config.allowed_users) ? config.allowed_users.filter((u): u is string => typeof u === 'string' && !!u.trim()).map(u => u.trim()) : [];
  return {
    channel,
    ...(typeof config.token_env === 'string' && config.token_env.trim() ? { tokenEnv: config.token_env.trim() } : {}),
    signingSecretEnv: typeof config.signing_secret_env === 'string' && config.signing_secret_env.trim() ? config.signing_secret_env.trim() : DEFAULT_SIGNING_SECRET_ENV,
    interactive: config.interactive !== false,
    allowedUsers: allowed,
    ...(typeof config.page_url === 'string' && config.page_url.trim() ? { pageUrl: config.page_url.trim() } : {}),
  };
}

export interface InteractionPayload { user_id: string; action: 'accept' | 'reject'; proposal_id: number; channel: string; message_ts: string | null }

export function createSlackSink(config: SinkConfig, deps: { api?: (token: string, ctx: SinkContext) => SlackApi } = {}): NotificationSink {
  const settings = slackSettings(config);
  const token = () => resolveApiToken('slack', settings.tokenEnv)?.token ?? null;
  const apiFor = (ctx: SinkContext): SlackApi => {
    const t = token();
    if (!t) throw new NonRetryableSinkError(`slack sink '${config.name}': no bot token`);
    return deps.api ? deps.api(t, ctx) : slackApi({ token: t, userAgent: `gbrain/${VERSION} (+https://github.com/garrytan/gbrain)`, minDelayMs: 1100,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) });
  };
  const render = (row: Parameters<typeof proposalPayload>[1]) =>
    renderProposalMessage(proposalPayload('render', row).proposal, { sink: config.name, interactive: settings.interactive, ...(settings.pageUrl ? { pageUrlTemplate: settings.pageUrl } : {}) });
  const fatal = (error: unknown): never => {
    if (error instanceof SlackChannelUnavailableError || error instanceof ConnectorAuthError || error instanceof ConnectorAccessDeniedError) {
      throw new NonRetryableSinkError(error.message);
    }
    throw error;
  };

  async function currentProposal(ctx: SinkContext, subject: string) {
    const id = Number(subject.replace(/^take_proposal:/, ''));
    const [row] = Number.isSafeInteger(id) ? await readProposalRows(ctx.engine, [id]) : [];
    return row ?? null;
  }

  async function postProposal(row: OutboxRow, ctx: SinkContext): Promise<DeliveryOutcome> {
    if (row.delivery?.ts) return { status: 'delivered', delivery: row.delivery };
    const proposal = await currentProposal(ctx, row.subject);
    if (!proposal) return { status: 'skipped', reason: 'proposal no longer exists' };
    const message = render(proposal);
    const posted = await apiFor(ctx).postMessage({ channel: settings.channel, ...message }).catch(fatal);
    return { status: 'delivered', delivery: { channel: posted.channel, ts: posted.ts } };
  }

  async function updateProposal(row: OutboxRow, ctx: SinkContext): Promise<DeliveryOutcome> {
    const posted = await deliveryOf(ctx.engine, config.name, 'take_proposal.created', row.subject);
    const ref = posted?.status === 'delivered' ? posted.delivery : null;
    if (!ref?.channel || !ref?.ts) return { status: 'skipped', reason: 'no posted message to update (the post shows the decision)' };
    const proposal = await currentProposal(ctx, row.subject);
    if (!proposal) return { status: 'skipped', reason: 'proposal no longer exists' };
    await apiFor(ctx).updateMessage(String(ref.channel), String(ref.ts), render(proposal)).catch(fatal);
    return { status: 'delivered', delivery: { channel: ref.channel, ts: ref.ts } };
  }

  async function handleInteraction(row: OutboxRow, ctx: SinkContext): Promise<DeliveryOutcome> {
    const click = row.payload as unknown as InteractionPayload;
    const api = apiFor(ctx);
    const reply = async (text: string, outcome: string): Promise<DeliveryOutcome> => {
      await api.postEphemeral(settings.channel, click.user_id, text).catch(e => ctx.log(`[notify] ${config.name}: ephemeral reply failed: ${e instanceof Error ? e.message : String(e)}`));
      return { status: 'delivered', delivery: { outcome } };
    };
    if (click.channel !== settings.channel) return { status: 'skipped', reason: `click from channel ${click.channel}, sink posts to ${settings.channel}` };
    const user = await api.userInfo(click.user_id).catch(fatal);
    const allowed = settings.allowedUsers.length > 0
      ? settings.allowedUsers.includes(user.id) || (!!user.email && settings.allowedUsers.map(u => u.toLowerCase()).includes(user.email.toLowerCase()))
      : await api.isChannelMember(settings.channel, user.id).catch(fatal);
    if (!allowed || user.deleted || user.bot) return reply(`You can't review take proposals from this channel.`, 'refused_not_allowed');
    if (!user.email) return reply(`gbrain could not read your email address from Slack, so it can't record you as the reviewer.`, 'refused_no_email');
    // The same core path the takes_proposal_accept / _reject operations use, as the trusted host with the clicker
    // recorded as the reviewer (acted_by) and the sink as the surface (acted_via, and the take write's agent label).
    const ctxFor: OperationContext = {
      engine: ctx.engine, config: ctx.config, remote: false, dryRun: false, sourceId: ALL_SOURCES,
      logger: { info: ctx.log, warn: ctx.log, error: ctx.log }, agentLabel: `slack:${config.name}`,
    };
    const target = { engine: ctx.engine, config: ctx.config, actedBy: user.email, actedVia: `slack:${config.name}`, callerCtx: ctxFor };
    try {
      if (click.action === 'accept') await acceptProposal(target, click.proposal_id);
      else await rejectProposal(target, click.proposal_id);
      return { status: 'delivered', delivery: { outcome: click.action === 'accept' ? 'accepted' : 'rejected', reviewer: user.email } };
    } catch (error) {
      if (!(error instanceof TakeProposalError)) throw error;
      const [now] = await readProposalRows(ctx.engine, [click.proposal_id]);
      if (now && now.status !== 'pending') return reply(`Proposal #${click.proposal_id} was already ${now.status}${now.acted_by ? ` by ${now.acted_by}` : ''}.`, 'already_decided');
      return reply(`Proposal #${click.proposal_id} was not ${click.action === 'accept' ? 'accepted' : 'rejected'}: ${error.message}`, error.code);
    }
  }

  return {
    name: config.name,
    type: 'slack',
    ready: () => token() ? null : `no Slack bot token (set ${settings.tokenEnv ?? 'GBRAIN_CONNECTOR_SLACK_TOKEN'} or run gbrain connectors auth slack --token -)`,
    async deliver(row, ctx) {
      if (row.event === 'take_proposal.created') return postProposal(row, ctx);
      if (row.event === 'take_proposal.accepted' || row.event === 'take_proposal.rejected') return updateProposal(row, ctx);
      if (row.event === SLACK_INTERACTION_EVENT) return handleInteraction(row, ctx);
      return { status: 'skipped', reason: `slack sink does not handle ${row.event}` };
    },
  };
}
