/**
 * Slack interactivity (button clicks on proposal messages), received over HTTP at POST /integrations/slack/interactions
 * (serve-http-slack.ts). The request is verified with the app's signing secret (Slack's v0 scheme: HMAC-SHA256 of
 * `v0:<timestamp>:<raw body>`, timestamp within 5 minutes, constant-time compare), then the click is queued in the
 * outbox (`slack.interaction`) and acknowledged at once: Slack wants a 2xx within 3 s, and the decision (users.info,
 * the take write, chat.update) runs from the queue (sinks/slack.ts). Only clicks on our own buttons, from an
 * interactive slack sink's channel, are queued; anything else is acknowledged and dropped.
 */
import { createHmac } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { safeHexEqual } from '../timing-safe.ts';
import { loadSinks, sinkEnabled, type SinkConfig } from './config.ts';
import { enqueue } from './outbox.ts';
import { kickDispatcher } from './emit.ts';
import { ACCEPT_ACTION, REJECT_ACTION } from './sinks/slack-blocks.ts';
import { SLACK_INTERACTION_EVENT, slackSettings, type InteractionPayload } from './sinks/slack.ts';

export const SLACK_INTERACTIONS_PATH = '/integrations/slack/interactions';
const MAX_SKEW_SECONDS = 300;

/** True when `signature` (`v0=<hex>`) signs `v0:<timestamp>:<body>` under one of `secrets` and the timestamp is fresh. */
export function verifySlackSignature(body: string, timestamp: string | undefined, signature: string | undefined, secrets: string[], nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !signature.startsWith('v0=')) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const given = signature.slice(3);
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  let ok = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
    if (safeHexEqual(expected, given)) ok = true;
  }
  return ok;
}

/** The interactive slack sinks and the signing secrets their environment holds. */
export async function interactiveSlackSinks(engine: BrainEngine): Promise<Array<{ config: SinkConfig; channel: string; secret: string | null }>> {
  const { sinks } = await loadSinks(engine);
  const out: Array<{ config: SinkConfig; channel: string; secret: string | null }> = [];
  for (const config of sinks) {
    if (config.type !== 'slack' || !sinkEnabled(config)) continue;
    try {
      const settings = slackSettings(config);
      if (!settings.interactive) continue;
      out.push({ config, channel: settings.channel, secret: process.env[settings.signingSecretEnv]?.trim() || null });
    } catch { /* an invalid sink receives nothing */ }
  }
  return out;
}

export type InteractionOutcome =
  | { status: 401; reason: string }
  | { status: 404; reason: string }
  | { status: 200; queued: boolean; reason?: string };

/** Verify, parse and queue one interaction request. Never throws for a malformed body. */
export async function receiveSlackInteraction(engine: BrainEngine, req: { body: string; timestamp?: string; signature?: string }, nowSeconds?: number): Promise<InteractionOutcome> {
  const sinks = await interactiveSlackSinks(engine);
  const secrets = sinks.map(s => s.secret).filter((s): s is string => !!s);
  if (secrets.length === 0) return { status: 404, reason: 'no interactive slack sink with a signing secret' };
  if (!verifySlackSignature(req.body, req.timestamp, req.signature, secrets, nowSeconds)) return { status: 401, reason: 'bad signature' };
  let payload: Record<string, any>;
  try {
    const raw = new URLSearchParams(req.body).get('payload');
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return { status: 200, queued: false, reason: 'unparseable payload' };
  }
  if (payload?.type !== 'block_actions' || !Array.isArray(payload.actions)) return { status: 200, queued: false, reason: `ignored ${String(payload?.type)}` };
  const action = payload.actions.find((a: any) => a?.action_id === ACCEPT_ACTION || a?.action_id === REJECT_ACTION);
  if (!action) return { status: 200, queued: false, reason: 'not a gbrain action' };
  const match = /^([a-z0-9][a-z0-9-]{0,39}):(\d{1,15})$/.exec(String(action.value ?? ''));
  const userId = typeof payload.user?.id === 'string' ? payload.user.id : '';
  const channel = typeof payload.channel?.id === 'string' ? payload.channel.id : typeof payload.container?.channel_id === 'string' ? payload.container.channel_id : '';
  if (!match || !userId || !channel) return { status: 200, queued: false, reason: 'incomplete action' };
  const sink = sinks.find(s => s.config.name === match[1]);
  if (!sink || sink.channel !== channel) return { status: 200, queued: false, reason: 'action from another sink or channel' };
  const messageTs = typeof payload.container?.message_ts === 'string' ? payload.container.message_ts : typeof payload.message?.ts === 'string' ? payload.message.ts : null;
  const click: InteractionPayload = { user_id: userId, action: action.action_id === ACCEPT_ACTION ? 'accept' : 'reject', proposal_id: Number(match[2]), channel, message_ts: messageTs };
  const actionTs = typeof action.action_ts === 'string' ? action.action_ts : String(Date.now() / 1000);
  const queued = await enqueue(engine, { sink: sink.config.name, event: SLACK_INTERACTION_EVENT,
    subject: `slack_action:${userId}:${actionTs}`, payload: click as unknown as Record<string, unknown> });
  if (queued) kickDispatcher();
  return { status: 200, queued };
}
