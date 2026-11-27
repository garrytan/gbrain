/**
 * Slack sources and initiatives: dynamic channels (`s_channels_from: initiatives`),
 * the skip of an initiative channel the app cannot read, fact routing after the
 * sync, and intake mode (`s_mode: intake`): one intake call per message, a
 * thread reply and a reaction posted once, and a grown thread appended to the
 * idea. Synthetic Slack fixtures only; the initiatives side is injected.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { json, options } from './helpers/connector-fixture.ts';
import { slackFetch, slackTs, type FakeSlack, slackTestToken } from './helpers/slack-fixture.ts';
import { runSlackSync } from '../src/core/slack/slack-source.ts';
import { parseSlackSourceConfig } from '../src/core/slack/source-config.ts';
import { slackApi, resolveSlackChannel, SlackChannelNotFoundError } from '../src/core/slack/client.ts';
import { connectorIdentity } from '../src/core/persistence/connector-identity.ts';
import { slackSourceConfig } from '../src/core/slack/source-add.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import type { SlackInitiativesDeps } from '../src/core/slack/intake-sync.ts';
import type { InitiativesConfig } from '../src/core/initiatives/model.ts';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const HOUR = 3_600_000;

interface Posted { method: string; body: Record<string, unknown> }

/** The shared fixture plus the write routes intake uses and conversations.list. */
function fetchWith(fake: FakeSlack, posted: Posted[]) {
  const base = slackFetch(fake);
  return async (url: string, init: RequestInit) => {
    const method = new URL(url).pathname.replace('/api/', '');
    if (['chat.postMessage', 'reactions.add', 'conversations.join', 'conversations.leave'].includes(method)) {
      const body = JSON.parse(String(init.body ?? '{}')) as unknown as Record<string, unknown>;
      posted.push({ method, body });
      fake.calls.push(`${method}:${body.channel}`);
      return json({ ok: true, channel: body.channel, ts: '1.000001' });
    }
    if (method === 'chat.getPermalink') {
      fake.calls.push(method);
      const p = new URL(url).searchParams;
      return json({ ok: true, permalink: `https://example.invalid/archives/${p.get('channel')}/p${p.get('message_ts')}` });
    }
    if (method === 'conversations.list') {
      fake.calls.push(method);
      return json({ ok: true, channels: fake.channels.map(c => ({ id: c.id, name: c.name, is_private: !!c.isPrivate, is_member: c.member !== false })),
        response_metadata: { next_cursor: '' } });
    }
    return base(url, init);
  };
}

const api = (fake: FakeSlack, posted: Posted[] = []) => slackApi({ token: slackTestToken(), userAgent: 'gbrain-test',
  fetchImpl: fetchWith(fake, posted), sleep: async () => {}, minDelayMs: 0, now: () => NOW });

const ICFG = { sourceId: 'default', ideasPrefix: 'ideas/', initiativesPrefix: 'initiatives/' } as InitiativesConfig;

let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-slack-init-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

let n = 0;
async function source(config: Record<string, unknown>) {
  const id = `slack-init-${++n}`;
  const full = { kind: 'slack', s_record: 'database', federated: false, ...config };
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', [id, JSON.stringify(full)]);
  return { id, cfg: parseSlackSourceConfig(full, '') };
}
const pageSlugs = async (sourceId: string) => (await engine.executeRaw<{ slug: string }>(
  'SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [sourceId])).map(r => r.slug);

describe('channels from initiatives', () => {
  test('a run reads the static channels and the initiatives\' channels; routing runs after the sync', async () => {
    const fake: FakeSlack = { teamId: 'TACME00001', users: { UALICE0001: { name: 'Alice Example' } }, calls: [], channels: [
      { id: 'CSTATIC001', name: 'general', messages: [{ ts: slackTs(NOW - 2 * HOUR), user: 'UALICE0001', text: 'Static channel note.' }] },
      { id: 'CINITIAT01', name: 'proj-alpha', messages: [{ ts: slackTs(NOW - 3 * HOUR), user: 'UALICE0001', text: 'Initiative channel note.' }] },
    ] };
    const { id, cfg } = await source({ s_channels: 'CSTATIC001', s_channels_from: 'initiatives' });
    expect(cfg.channelsFrom).toBe('initiatives');
    const routed: Array<Record<string, string> | undefined> = [];
    const deps: SlackInitiativesDeps = {
      config: async () => ICFG,
      channels: async () => ['cinitiat01', 'CSTATIC001', 'DDIRECT001'],
      routeFacts: async (_e, _c, sid, opts) => { routed.push(opts.channelNames); expect(sid).toBe(id); return { scanned: 0, routed: 0, skipped: 0, watermark: 0, errors: [] }; },
    };
    const result = await runSlackSync(engine, id, cfg, options, { api: api(fake), now: () => NOW, initiatives: deps }) as unknown as Record<string, unknown>;
    expect(result.added).toBe(2);
    const slugs = await pageSlugs(id);
    expect(slugs.some(s => s.includes('cinitiat01'))).toBe(true);
    expect(slugs.some(s => s.includes('cstatic001'))).toBe(true);
    expect(fake.calls.filter(c => c.startsWith('conversations.history'))).toEqual(['conversations.history:CSTATIC001', 'conversations.history:CINITIAT01']);
    expect(routed).toEqual([{ CSTATIC001: 'general', CINITIAT01: 'proj-alpha' }]);
    expect(result.initiativeRouting).toEqual({ scanned: 0, routed: 0, skipped: 0, watermark: 0, errors: [] });
  });

  test('an initiative channel the app cannot read is skipped and reported; a routing error does not fail the sync', async () => {
    const fake: FakeSlack = { teamId: 'TACME00001', users: { UALICE0001: { name: 'Alice Example' } }, calls: [], channels: [
      { id: 'CSTATIC001', name: 'general', messages: [{ ts: slackTs(NOW - 2 * HOUR), user: 'UALICE0001', text: 'Static channel note.' }] },
      { id: 'CNOTMEMB01', name: 'proj-beta', member: false, messages: [{ ts: slackTs(NOW - 3 * HOUR), user: 'UALICE0001', text: 'Unreadable.' }] },
    ] };
    const { id, cfg } = await source({ s_channels: 'CSTATIC001', s_channels_from: 'initiatives' });
    const deps: SlackInitiativesDeps = {
      config: async () => ICFG,
      channels: async () => ['CNOTMEMB01', 'CMISSING01'],
      routeFacts: async () => { throw new Error('routing exploded'); },
    };
    const result = await runSlackSync(engine, id, cfg, options, { api: api(fake), now: () => NOW, initiatives: deps }) as unknown as Record<string, unknown>;
    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);
    expect((result.slackChannelsSkipped as Array<{ channel: string }>).map(s => s.channel).sort()).toEqual(['CMISSING01', 'CNOTMEMB01']);
    expect(result.initiativeRouting).toEqual({ error: 'routing exploded' });
    expect(result.failedFiles).toBeUndefined();
  });

  test('a channels-from source with no static channels syncs only the initiatives\' channels', async () => {
    const fake: FakeSlack = { teamId: 'TACME00001', users: {}, calls: [], channels: [
      { id: 'CINITIAT02', name: 'proj-gamma', messages: [{ ts: slackTs(NOW - HOUR), user: 'UALICE0001', text: 'Only dynamic.' }] }] };
    const { id, cfg } = await source({ s_channels: '', s_channels_from: 'initiatives' });
    expect(cfg.channels).toEqual([]);
    const result = await runSlackSync(engine, id, cfg, options, { api: api(fake), now: () => NOW,
      initiatives: { config: async () => ICFG, channels: async () => ['CINITIAT02'], routeFacts: async () => ({ scanned: 0, routed: 0, skipped: 0, watermark: 0, errors: [] }) } });
    expect(result.added).toBe(1);
  });
});

describe('intake mode', () => {
  test('a message goes to the intake once, gets a reply and a reaction; a grown thread is appended to the idea', async () => {
    const ideaTs = slackTs(NOW - 2 * HOUR);
    const chatTs = slackTs(NOW - HOUR);
    const fake: FakeSlack = { teamId: 'TACME00001', users: { UALICE0001: { name: 'Alice Example' }, UBOB000001: { name: 'Bob Example' } }, calls: [], channels: [
      { id: 'CIDEAS0001', name: 'ideas', messages: [
        { ts: ideaTs, user: 'UALICE0001', text: 'We should add dark mode.' },
        { ts: chatTs, user: 'UBOB000001', text: 'lunch?' },
        { ts: slackTs(NOW - 90 * 60_000), text: 'A bot note.', subtype: 'bot_message', bot_id: 'B0001' },
        { ts: slackTs(NOW - 80 * 60_000), user: 'UBOB000001', text: 'joined', subtype: 'channel_join' },
      ] }] };
    const { id, cfg } = await source({ s_channels: 'CIDEAS0001', s_mode: 'intake' });
    expect(cfg.mode).toBe('intake');
    const handled: Array<{ ts: string; userName?: string; permalink?: string; channelName?: string }> = [];
    const appended: Array<{ slug: string; texts: string[] }> = [];
    const deps: SlackInitiativesDeps = {
      config: async () => ICFG,
      handleIntakeMessage: async (_e, _c, msg) => {
        handled.push({ ts: msg.ts, userName: msg.userName, permalink: msg.permalink, channelName: msg.channelName });
        return msg.text.includes('dark mode') ? { kind: 'idea', status: 'created', slug: 'ideas/dark-mode', reply: 'Saved as ideas/dark-mode.' }
          : { kind: 'skipped', reason: 'not an idea' };
      },
      appendIdeaDiscussion: async (_e, _c, slug, replies) => { appended.push({ slug, texts: replies.map(r => `${r.userName}: ${r.text}`) }); },
    };
    const posted: Posted[] = [];
    const run = (at: number) => runSlackSync(engine, id, cfg, options, { api: api(fake, posted), now: () => at, initiatives: deps }) as unknown as Promise<Record<string, unknown>>;

    const first = await run(NOW);
    expect(handled.map(h => h.ts)).toEqual([ideaTs, chatTs]);
    expect(handled[0]).toEqual({ ts: ideaTs, userName: 'Alice Example', channelName: 'ideas', permalink: `https://example.invalid/archives/CIDEAS0001/p${ideaTs}` });
    expect(posted).toEqual([
      { method: 'chat.postMessage', body: { channel: 'CIDEAS0001', thread_ts: ideaTs, text: 'Saved as ideas/dark-mode.', unfurl_links: false, unfurl_media: false } },
      { method: 'reactions.add', body: { channel: 'CIDEAS0001', timestamp: ideaTs, name: 'white_check_mark' } },
    ]);
    expect(first.slackIntake).toEqual({ created: 1, duplicate: 0, skipped: 1, discussions: 0, failed: 0 });
    expect(await pageSlugs(id)).toEqual([]);

    // Second run: nothing new, nothing re-classified or re-posted.
    const second = await run(NOW + 60_000);
    expect(handled).toHaveLength(2);
    expect(posted).toHaveLength(2);
    expect(second.slackIntake).toEqual({ created: 0, duplicate: 0, skipped: 0, discussions: 0, failed: 0 });

    // The idea's thread grows: its non-bot replies are appended once.
    fake.channels[0]!.messages[0]!.replies = [
      { ts: slackTs(NOW + 2 * 60_000), user: 'UBOB000001', text: 'Yes please, my eyes.' },
      { ts: slackTs(NOW + 3 * 60_000), text: 'bot echo', bot_id: 'B0001', subtype: 'bot_message' },
    ];
    await run(NOW + 5 * 60_000);
    expect(appended).toEqual([{ slug: 'ideas/dark-mode', texts: ['Bob Example: Yes please, my eyes.'] }]);
    await run(NOW + 6 * 60_000);
    expect(appended).toHaveLength(1);
    expect(handled).toHaveLength(2);
    expect(posted).toHaveLength(2);

    // A new top-level message is handled; a duplicate gets the link reaction.
    fake.channels[0]!.messages.push({ ts: slackTs(NOW + 7 * 60_000), user: 'UALICE0001', text: 'Dark mode again, please.' });
    deps.handleIntakeMessage = async (_e, _c, msg) => { handled.push({ ts: msg.ts }); return { kind: 'idea', status: 'duplicate', slug: 'ideas/dark-mode', reply: 'Already known.' }; };
    await run(NOW + 8 * 60_000);
    expect(handled).toHaveLength(3);
    expect(posted.at(-1)).toEqual({ method: 'reactions.add', body: { channel: 'CIDEAS0001', timestamp: slackTs(NOW + 7 * 60_000), name: 'link' } });
  });

  test('an intake failure is retried next run and never re-handles the messages that succeeded', async () => {
    const fake: FakeSlack = { teamId: 'TACME00001', users: { UALICE0001: { name: 'Alice Example' } }, calls: [], channels: [
      { id: 'CIDEAS0002', name: 'ideas-two', messages: [
        { ts: slackTs(NOW - 2 * HOUR), user: 'UALICE0001', text: 'first' },
        { ts: slackTs(NOW - HOUR), user: 'UALICE0001', text: 'second' },
      ] }] };
    const { id, cfg } = await source({ s_channels: 'CIDEAS0002', s_mode: 'intake' });
    const seen: string[] = [];
    let fail = true;
    const deps: SlackInitiativesDeps = {
      config: async () => ICFG,
      handleIntakeMessage: async (_e, _c, msg) => {
        seen.push(msg.text);
        if (msg.text === 'first' && fail) throw new Error('embedding down');
        return { kind: 'skipped', reason: 'no' };
      },
      appendIdeaDiscussion: async () => {},
    };
    const first = await runSlackSync(engine, id, cfg, options, { api: api(fake), now: () => NOW, initiatives: deps }) as unknown as Record<string, unknown>;
    expect(first.status).toBe('partial');
    fail = false;
    await runSlackSync(engine, id, cfg, options, { api: api(fake), now: () => NOW + 60_000, initiatives: deps });
    expect(seen).toEqual(['first', 'second', 'first']);
  });
});

describe('config, identity and add flags', () => {
  test('channels-from and mode are absent by default, so an existing source keeps its identity', () => {
    const base = { kind: 'slack', s_channels: 'CSTATIC001', s_record: 'database' };
    const parsed = parseSlackSourceConfig(base, '');
    expect('channelsFrom' in parsed).toBe(false);
    expect('mode' in parsed).toBe(false);
    expect(connectorIdentity('slack', { ...base, s_mode: 'days' }, null).digest).toBe(connectorIdentity('slack', base, null).digest);
    expect(connectorIdentity('slack', { ...base, s_channels_from: 'initiatives' }, null).digest).not.toBe(connectorIdentity('slack', base, null).digest);
  });

  test('sources add --kind slack --channels-from initiatives needs no --channels; --mode intake needs --channels', () => {
    const parsed = parseSourceLifecycleArgs(['add', 'team-slack', '--kind', 'slack', '--channels-from', 'initiatives', '--record', 'database']);
    const slack = (parsed.params.options as { slack: Record<string, unknown> }).slack;
    expect(slack.channels).toEqual([]);
    expect(slack.channelsFrom).toBe('initiatives');
    const config = slackSourceConfig(slack as never, { record: 'database', dir: null } as never, false, false);
    expect(config.s_channels_from).toBe('initiatives');
    expect(config.s_mode).toBeUndefined();
    expect(() => parseSourceLifecycleArgs(['add', 'team-slack', '--kind', 'slack', '--mode', 'intake', '--channels-from', 'initiatives'])).toThrow(/--mode intake needs --channels/);
    expect(() => parseSourceLifecycleArgs(['add', 'team-slack', '--kind', 'slack'])).toThrow(/--channels needs/);
    expect(() => parseSourceLifecycleArgs(['add', 'team-slack', '--kind', 'slack', '--channels-from', 'everything'])).toThrow(/--channels-from must be initiatives/);
    const intake = parseSourceLifecycleArgs(['add', 'idea-intake', '--kind', 'slack', '--mode', 'intake', '--channels', 'CIDEAS0001']);
    expect((intake.params.options as { slack: Record<string, unknown> }).slack.mode).toBe('intake');
  });
});

describe('client helpers', () => {
  const fake = (): FakeSlack => ({ teamId: 'TACME00001', users: {}, calls: [], channels: [
    { id: 'CPUBLIC001', name: 'general', messages: [] },
    { id: 'COUTSIDE01', name: 'proj-outside', member: false, messages: [] },
  ] });

  test('resolveSlackChannel takes an id or a name with or without #', async () => {
    const a = api(fake());
    expect(await resolveSlackChannel(a, 'CPUBLIC001')).toEqual({ id: 'CPUBLIC001', name: 'general', isMember: true });
    expect(await resolveSlackChannel(a, '#general')).toEqual({ id: 'CPUBLIC001', name: 'general', isMember: true });
    expect(await resolveSlackChannel(a, 'proj-outside')).toEqual({ id: 'COUTSIDE01', name: 'proj-outside', isMember: false });
    expect(await resolveSlackChannel(a, 'COUTSIDE01')).toEqual({ id: 'COUTSIDE01', name: 'proj-outside', isMember: false });
    const missing = await resolveSlackChannel(a, '#nope').catch(e => e);
    expect(missing).toBeInstanceOf(SlackChannelNotFoundError);
    expect(missing.code).toBe('slack_channel_not_found');
    expect((await resolveSlackChannel(a, 'CMISSING01').catch(e => e)).code).toBe('slack_channel_not_found');
  });

  test('join, leave and an already-placed reaction', async () => {
    const posted: Posted[] = [];
    const a = api(fake(), posted);
    await a.joinChannel('CPUBLIC001');
    await a.leaveChannel('CPUBLIC001');
    expect(posted.map(p => p.method)).toEqual(['conversations.join', 'conversations.leave']);
    const already = slackApi({ token: slackTestToken(), userAgent: 'gbrain-test', sleep: async () => {}, minDelayMs: 0,
      fetchImpl: async () => json({ ok: false, error: 'already_reacted' }) });
    await already.reactionsAdd('CPUBLIC001', '1.000001', 'link');
    const notIn = slackApi({ token: slackTestToken(), userAgent: 'gbrain-test', sleep: async () => {}, minDelayMs: 0,
      fetchImpl: async () => json({ ok: false, error: 'not_in_channel' }) });
    await notIn.leaveChannel('CPUBLIC001');
    expect((await notIn.joinChannel('CPUBLIC001').catch(e => e)).channelId).toBe('CPUBLIC001');
  });
});
