/**
 * Outbound notification sinks: the dream cycle's propose_takes phase and every accept/reject queue take_proposal.*
 * events in a durable outbox, a dispatcher delivers them to configured sinks, and the slack sink posts one message per
 * proposal with Accept / Reject buttons, takes the decision from a verified button click and edits the message.
 *
 * Protects: new proposals are queued once per sink and filter (a re-run queues nothing more); one proposal posts one
 * message, however often the queue drains; a signed click from a channel member accepts through the same operation
 * MCP uses, records the clicker's email as acted_by with acted_via slack:<sink>, and edits that message (buttons gone,
 * decision shown); a click from a non-member changes nothing and gets an ephemeral reply; a decision made elsewhere
 * (CLI/MCP) edits the message too; unsigned, forged or stale requests are refused; an invalid sink config never fails
 * the cycle; the webhook sink signs its body; a backfill queues only up to its limit.
 * Fails when: the emit hooks, the outbox idempotency, the signature check, the membership check or the message update
 * are dropped.
 * Seams: a repo-less PGLite brain with the real ops, outbox, dispatcher and interaction receiver; Slack's Web API is a
 * recording fake behind the SlackApi seam, webhooks a fake fetch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor } from '../src/core/cycle/propose-takes.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetSinkConfigCache, NOTIFY_SINKS_KEY, type SinkConfig } from '../src/core/notifications/config.ts';
import { drainOnce } from '../src/core/notifications/dispatcher.ts';
import { createSlackSink } from '../src/core/notifications/sinks/slack.ts';
import { createWebhookSink } from '../src/core/notifications/sinks/webhook.ts';
import { receiveSlackInteraction, verifySlackSignature } from '../src/core/notifications/slack-interactions.ts';
import { backfillCreated } from '../src/core/notifications/backfill.ts';
import { ACCEPT_ACTION, REJECT_ACTION } from '../src/core/notifications/sinks/slack-blocks.ts';
import type { SlackApi } from '../src/core/slack/client.ts';
import { envForFile } from './helpers/with-env.ts';

const SECRET = 'synthetic-signing-secret';
const CHANNEL = 'C0TEST1234';
const SLUG = 'companies/notify-example';
const CONFIG = { engine: 'pglite', embedding_disabled: true } as never;
const SINK: SinkConfig = { name: 'team', type: 'slack', channel: CHANNEL, filter: { min_weight: 0.5 } };

envForFile({ GBRAIN_SLACK_SIGNING_SECRET: SECRET, GBRAIN_CONNECTOR_SLACK_TOKEN: 'xoxb-synthetic', GBRAIN_NOTIFY_SINKS: undefined, HOOK_URL: 'https://hooks.example.com/in', HOOK_SECRET: 'hook-secret' });

interface Call { method: string; args: unknown[] }
const MEMBERS = new Set(['U_ALICE']);
const EMAILS: Record<string, string> = { U_ALICE: 'alice@example.com', U_MALLORY: 'mallory@example.com' };

function fakeSlack(calls: Call[]): SlackApi {
  let n = 0;
  const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }); };
  return {
    async postMessage(message) { record('postMessage', message); n++; return { channel: message.channel, ts: `1700000000.00000${n}` }; },
    async updateMessage(channel, ts, message) { record('updateMessage', channel, ts, message); },
    async postEphemeral(channel, user, text) { record('postEphemeral', channel, user, text); },
    async userInfo(user) { record('userInfo', user); return { id: user, email: EMAILS[user] ?? null, name: user, deleted: false, bot: false }; },
    async isChannelMember(channel, user) { record('isChannelMember', channel, user); return channel === CHANNEL && MEMBERS.has(user); },
  } as SlackApi;
}

function signed(payload: unknown, opts: { secret?: string; ts?: number } = {}) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const signature = 'v0=' + createHmac('sha256', opts.secret ?? SECRET).update(`v0:${timestamp}:${body}`).digest('hex');
  return { body, timestamp, signature };
}
const click = (user: string, action: string, id: number, ts: string) => ({
  type: 'block_actions', user: { id: user }, channel: { id: CHANNEL }, container: { message_ts: ts },
  actions: [{ action_id: action, value: `team:${id}`, action_ts: `${Date.now() / 1000}${Math.random()}` }],
});

describe('notification sinks: take proposals to Slack and back', () => {
  let engine: PGLiteEngine;
  const calls: Call[] = [];
  let sink: ReturnType<typeof createSlackSink>;
  const ids: Record<string, number> = {};
  const local = (): OperationContext => ({ engine, config: CONFIG, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext);
  const drain = () => drainOnce(engine, { config: CONFIG, sinks: [sink], log: () => {} });
  const proposal = async (id: number) => (await engine.executeRaw<Record<string, any>>(
    'SELECT status, acted_by, acted_via FROM take_proposals WHERE id = $1', [id]))[0]!;
  const outbox = async (event: string) => engine.executeRaw<{ subject: string; status: string; delivery: unknown }>(
    'SELECT subject, status, delivery FROM notification_outbox WHERE event = $1 ORDER BY id', [event]);

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig(NOTIFY_SINKS_KEY, JSON.stringify([SINK]));
    resetSinkConfigCache();
    sink = createSlackSink(SINK, { api: () => fakeSlack(calls) });
    await operationsByName.put_page.handler(local(), { slug: SLUG, content: '---\ntype: company\ntitle: Notify Example\n---\n\n# Notify Example\n\nI bet notify-example ships weekly.\n' });
  }, 120_000);

  afterAll(async () => {
    resetSinkConfigCache();
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  });

  test('the propose_takes phase queues each new proposal once, filtered per sink', async () => {
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Notify-example ships weekly', kind: 'bet', holder: 'world', weight: 0.8 },
      { claim_text: 'Notify-example hires slowly', kind: 'hunch', holder: 'world', weight: 0.6 },
      { claim_text: 'Notify-example might pivot', kind: 'hunch', holder: 'world', weight: 0.2 },
    ];
    const phase = await runPhaseProposeTakes(local(), { extractor });
    expect(phase.status).toBe('ok');
    const rows = await engine.executeRaw<{ id: number; claim_text: string }>('SELECT id, claim_text FROM take_proposals WHERE page_slug = $1 ORDER BY id', [SLUG]);
    ids.ships = Number(rows.find(r => r.claim_text.includes('ships'))!.id);
    ids.hires = Number(rows.find(r => r.claim_text.includes('hires'))!.id);
    ids.pivot = Number(rows.find(r => r.claim_text.includes('pivot'))!.id);
    expect((await outbox('take_proposal.created')).map(r => r.subject).sort()).toEqual([`take_proposal:${ids.ships}`, `take_proposal:${ids.hires}`].sort());
  }, 120_000);

  test('one proposal posts one message with Accept / Reject buttons, however often the queue drains', async () => {
    const first = await drain();
    expect(first.delivered).toBe(2);
    expect(await drain()).toMatchObject({ delivered: 0, skipped: 0, retrying: 0, failed: 0 });
    const posts = calls.filter(c => c.method === 'postMessage');
    expect(posts.length).toBe(2);
    const blocks = JSON.stringify((posts[0]!.args[0] as { blocks: unknown[] }).blocks);
    expect(blocks).toContain(ACCEPT_ACTION);
    expect(blocks).toContain(REJECT_ACTION);
    expect((await outbox('take_proposal.created')).every(r => r.status === 'delivered')).toBe(true);
    // A backfill of an already-queued proposal queues nothing more.
    expect((await backfillCreated(engine, { limit: 10 })).queued).toEqual([]);
  }, 60_000);

  test('forged, stale and unsigned interactions are refused', async () => {
    const forged = signed(click('U_ALICE', ACCEPT_ACTION, ids.ships!, '1'), { secret: 'wrong-secret' });
    expect((await receiveSlackInteraction(engine, forged)).status).toBe(401);
    const stale = signed(click('U_ALICE', ACCEPT_ACTION, ids.ships!, '1'), { ts: Math.floor(Date.now() / 1000) - 600 });
    expect((await receiveSlackInteraction(engine, stale)).status).toBe(401);
    expect((await receiveSlackInteraction(engine, { body: 'payload=%7B%7D' })).status).toBe(401);
    expect(verifySlackSignature('x', '1', 'v0=' + '0'.repeat(64), [SECRET], 1)).toBe(false);
    expect((await proposal(ids.ships!)).status).toBe('pending');
  }, 60_000);

  test('a non-member click changes nothing and gets an ephemeral reply', async () => {
    const posted = (await outbox('take_proposal.created')).find(r => r.subject === `take_proposal:${ids.hires}`)!;
    const ts = (typeof posted.delivery === 'string' ? JSON.parse(posted.delivery) : posted.delivery as { ts: string }).ts;
    expect((await receiveSlackInteraction(engine, signed(click('U_MALLORY', REJECT_ACTION, ids.hires!, ts))))).toMatchObject({ status: 200, queued: true });
    await drain();
    expect((await proposal(ids.hires!)).status).toBe('pending');
    expect(calls.some(c => c.method === 'postEphemeral' && c.args[1] === 'U_MALLORY')).toBe(true);
  }, 60_000);

  test('a member click accepts as that person and edits the same message', async () => {
    const posted = (await outbox('take_proposal.created')).find(r => r.subject === `take_proposal:${ids.ships}`)!;
    const ts = (typeof posted.delivery === 'string' ? JSON.parse(posted.delivery) : posted.delivery as { ts: string }).ts;
    expect(await receiveSlackInteraction(engine, signed(click('U_ALICE', ACCEPT_ACTION, ids.ships!, ts)))).toMatchObject({ status: 200, queued: true });
    await drain();
    expect(await proposal(ids.ships!)).toMatchObject({ status: 'accepted', acted_by: 'alice@example.com', acted_via: 'slack:team' });
    const update = calls.filter(c => c.method === 'updateMessage').at(-1)!;
    expect(update.args[0]).toBe(CHANNEL);
    expect(update.args[1]).toBe(ts);
    const blocks = JSON.stringify((update.args[2] as { blocks: unknown[] }).blocks);
    expect(blocks).toContain('Accepted');
    expect(blocks).toContain('alice@example.com');
    expect(blocks).not.toContain(ACCEPT_ACTION);
  }, 120_000);

  test('a decision made elsewhere edits the message too', async () => {
    const before = calls.filter(c => c.method === 'updateMessage').length;
    await operationsByName.takes_proposal_reject.handler(local(), { id: ids.hires, reason: 'Not on the page' });
    await drain();
    const updates = calls.filter(c => c.method === 'updateMessage');
    expect(updates.length).toBe(before + 1);
    expect(JSON.stringify((updates.at(-1)!.args[2] as { blocks: unknown[] }).blocks)).toContain('Not on the page');
  }, 60_000);

  test('an invalid sink config never fails the cycle', async () => {
    await engine.setConfig(NOTIFY_SINKS_KEY, '{not json');
    resetSinkConfigCache();
    try {
      await engine.executeRaw(`UPDATE pages SET compiled_truth = compiled_truth || ' More.' WHERE slug = $1`, [SLUG]);
      const extractor: ProposeTakesExtractor = async () => [{ claim_text: 'Notify-example expands', kind: 'bet', holder: 'world', weight: 0.9 }];
      const phase = await runPhaseProposeTakes(local(), { extractor, once: true });
      expect(phase.status).not.toBe('failed');
    } finally {
      await engine.setConfig(NOTIFY_SINKS_KEY, JSON.stringify([SINK]));
      resetSinkConfigCache();
    }
  }, 120_000);

  test('the webhook sink signs its body', async () => {
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    const hook = createWebhookSink({ name: 'hook', type: 'webhook', url_env: 'HOOK_URL', secret_env: 'HOOK_SECRET' });
    expect(hook.ready()).toBeNull();
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('', { status: 204 });
    }) as never;
    const out = await hook.deliver({ id: 7, sink: 'hook', event: 'take_proposal.created', subject: 'take_proposal:1', payload: { a: 1 }, status: 'pending', attempts: 1, last_error: null, delivery: null, created_at: new Date() },
      { engine, config: CONFIG, log: () => {}, fetchImpl });
    expect(out.status).toBe('delivered');
    expect(seen[0]!.headers['x-gbrain-signature']).toBe('sha256=' + createHmac('sha256', 'hook-secret').update(seen[0]!.body).digest('hex'));
  });

  test('a backfill queues pending proposals up to its limit, highest weight first', async () => {
    await engine.executeRaw('DELETE FROM notification_outbox');
    const dry = await backfillCreated(engine, { limit: 1, dryRun: true });
    expect(dry.queued).toEqual([]);
    expect(dry.matched.length).toBe(1);
    const real = await backfillCreated(engine, { limit: 1 });
    expect(real.queued.length).toBe(1);
    const weights = await engine.executeRaw<{ weight: number }>(`SELECT weight FROM take_proposals WHERE id = $1`, [real.queued[0]!.id]);
    const max = await engine.executeRaw<{ w: number }>(`SELECT max(weight) AS w FROM take_proposals WHERE status = 'pending' AND weight >= 0.5`);
    expect(Number(weights[0]!.weight)).toBeCloseTo(Number(max[0]!.w), 5);
  }, 60_000);
});
