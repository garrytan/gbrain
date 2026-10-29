/**
 * Slack source kind, units: Web API error classification, the token as a
 * bearer header only, mrkdwn entities, the day page render (per-field
 * neutralization, threads, private channels, the golden layout), the
 * time-zone day boundary, the stored config and identity, the CLI flags, the
 * API-token lane, the add-time check, the schedule, and the remote
 * sources_add trust boundary.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySlackBody, slackApi, SlackApiError, SlackChannelUnavailableError, SlackShapeDriftError } from '../src/core/slack/client.ts';
import { renderSlackDay, slackDayKey, slackDayStartMs, slackText, SlackPageTooLargeError, type SlackDayInput } from '../src/core/slack/render.ts';
import { parseSlackSourceConfig } from '../src/core/slack/source-config.ts';
import { preflightSlackAdd, slackSourceConfig } from '../src/core/slack/source-add.ts';
import { ConnectorAccessDeniedError, ConnectorAuthError, ConnectorRateLimitedError } from '../src/core/connectors/client.ts';
import { classifyConnectorError } from '../src/core/connectors/item-holds.ts';
import { credentialPath, resolveApiToken } from '../src/core/connectors/credentials.ts';
import { verifyAndSaveApiToken } from '../src/commands/connectors/auth-token.ts';
import { connectorIdentity } from '../src/core/persistence/connector-identity.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { parseConversation } from '../src/core/conversation-parser/parse.ts';
import { withEnv } from './helpers/with-env.ts';
import { json } from './helpers/connector-fixture.ts';
import { slackFetch, slackTs, type FakeSlack } from './helpers/slack-fixture.ts';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const home = mkdtempSync(join(tmpdir(), 'gbrain-slack-unit-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('Slack responses', () => {
  const url = 'https://slack.com/api/conversations.history?channel=CGENERAL01&limit=200';
  test('ok:false bodies become the typed client errors', () => {
    expect(() => classifySlackBody({ ok: true }, url, NOW)).not.toThrow();
    expect(() => classifySlackBody({ ok: false, error: 'invalid_auth' }, url, NOW)).toThrow(ConnectorAuthError);
    expect(() => classifySlackBody({ ok: false, error: 'token_revoked' }, url, NOW)).toThrow(ConnectorAuthError);
    expect(() => classifySlackBody({ ok: false, error: 'missing_scope', needed: 'groups:history' }, url, NOW)).toThrow(/groups:history/);
    expect(() => classifySlackBody({ ok: false, error: 'missing_scope', needed: 'groups:history' }, url, NOW)).toThrow(ConnectorAccessDeniedError);
    let unavailable: SlackChannelUnavailableError | null = null;
    try { classifySlackBody({ ok: false, error: 'not_in_channel' }, url, NOW); } catch (e) { unavailable = e as SlackChannelUnavailableError; }
    expect(unavailable).toBeInstanceOf(SlackChannelUnavailableError);
    expect(unavailable!.channelId).toBe('CGENERAL01');
    expect(unavailable!.message).toContain('/invite');
    let limited: ConnectorRateLimitedError | null = null;
    try { classifySlackBody({ ok: false, error: 'ratelimited' }, url, NOW); } catch (e) { limited = e as ConnectorRateLimitedError; }
    expect(limited!.retryAt).toBe(NOW + 60_000);
    expect(() => classifySlackBody({ ok: false, error: 'invalid_cursor' }, url, NOW)).toThrow(SlackApiError);
  });

  test('shape drift and oversized days are held as content failures; an unreadable channel is held as an item', () => {
    expect(classifyConnectorError(new SlackShapeDriftError('conversations.history.messages'))).toMatchObject({ code: 'connector_shape_drift', scope: 'item', class: 'content' });
    expect(classifyConnectorError(new SlackPageTooLargeError(3e6))).toMatchObject({ code: 'connector_item_too_large', scope: 'item', class: 'content' });
    expect(classifyConnectorError(new SlackChannelUnavailableError('CGENERAL01', 'not_in_channel'))).toMatchObject({ scope: 'item' });
  });

  test('the token goes only in the authorization header; a not-member channel is refused by conversations.info', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fake: FakeSlack = { teamId: 'TACME00001', users: {}, calls: [], channels: [{ id: 'CNOTJOIN01', name: 'random', member: false, messages: [] }] };
    const inner = slackFetch(fake);
    const api = slackApi({ token: 'xoxb-synthetic-fixture', userAgent: 'gbrain-test', minDelayMs: 0, sleep: async () => {},
      fetchImpl: async (u, init) => { seen.push({ url: u, init }); return inner(u, init); } });
    expect(await api.authTest()).toMatchObject({ teamId: 'TACME00001', team: 'Acme Example', enterpriseId: null });
    expect(seen[0]!.url).not.toContain('xoxb');
    expect(JSON.stringify(seen[0]!.init.headers)).toContain('Bearer xoxb-synthetic-fixture');
    await expect(api.conversationInfo('CNOTJOIN01')).rejects.toBeInstanceOf(SlackChannelUnavailableError);
  });
});

describe('Slack day page render', () => {
  const users = { UALICE0001: { name: 'Alice Example', deleted: false, bot: false }, UBOB000001: { name: 'Bob Example', deleted: false, bot: false },
    UCAROL0001: { name: 'Carol Example', deleted: true, bot: false } };
  const day = '2026-06-14';
  const ts = (hour: number, minute = 0, seq = 1) => slackTs(Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`), seq);
  const input = (over: Partial<SlackDayInput> = {}): SlackDayInput => ({
    channel: { id: 'CGENERAL01', name: 'general', isPrivate: false, isArchived: false }, day, timezone: 'UTC',
    account: { teamId: 'TACME00001', enterpriseId: null, team: 'Acme Example', botUserId: 'UBOT00001' },
    messages: [], replies: new Map(), users, privateOnly: false, skip: [], ...over });

  test('mrkdwn entities become plain text', () => {
    const name = (id: string) => (users as Record<string, { name: string }>)[id]?.name ?? id;
    expect(slackText('Hi <@UALICE0001>, see <#CGENERAL01|general> and <!here>', name)).toBe('Hi @Alice Example, see #general and @here');
    expect(slackText('<https://example.invalid/a|the doc> and <https://example.invalid/b> &lt;ok&gt; &amp;', name))
      .toBe('the doc (https://example.invalid/a) and https://example.invalid/b <ok> &');
    expect(slackText('<!subteam^S1|@eng> <mailto:a@example.invalid|a@example.invalid>', name)).toBe('@eng a@example.invalid');
  });

  test('the layout matches the golden page and the conversation parser reads every turn', () => {
    const parent = { ts: ts(9), user: 'UALICE0001', text: 'Morning, <@UBOB000001>.\nSecond line of the same message.', reply_count: 2 };
    const page = renderSlackDay(input({
      messages: [
        parent,
        { ts: ts(9, 30), user: 'UBOB000001', subtype: 'thread_broadcast', text: 'Sharing this with everyone.', thread_ts: parent.ts },
        { ts: ts(10), user: 'UBOB000001', text: 'Edited message.', edited: { ts: ts(10, 5) }, files: [{ name: 'plan.pdf' }] },
        { ts: ts(11), bot_id: 'B1', subtype: 'bot_message', bot_profile: { name: 'Deploy Bot' }, text: 'Deploy finished.' },
        { ts: ts(12), user: 'UCAROL0001', subtype: 'channel_join', text: '<@UCAROL0001> has joined the channel' },
        { ts: ts(13), subtype: 'tombstone', text: 'This message was deleted.', reply_count: 1 },
      ],
      replies: new Map([[parent.ts, [{ ts: ts(9, 10), user: 'UBOB000001', text: 'Reply in the thread.' },
        { ts: slackTs(Date.parse('2026-06-15T08:00:00Z')), user: 'UCAROL0001', text: 'A reply the next day.' }]],
        [ts(13), [{ ts: ts(13, 1), user: 'UALICE0001', text: 'Reply under a deleted message.' }]]]),
    }));
    expect(page).toBe(readFileSync(join(import.meta.dir, 'fixtures/slack/day-golden.md'), 'utf8'));
    const body = page.split('\n---\n')[1]!;
    const parsed = parseConversation(body, { fallbackDate: day, noPolish: true, noFallback: true });
    expect(parsed.matched_pattern_id).toBe('imessage-slack');
    expect(parsed.messages.map(m => m.speaker)).toEqual(['Alice Example', 'Bob Example', 'Carol Example (deactivated)', 'Bob Example', 'Bob Example', 'Deploy Bot (bot)',
      'Carol Example (deactivated)', 'Unknown', 'Alice Example']);
  });

  test('outside text cannot forge fences, citations, timeline rows or speaker anchors, even indented', () => {
    const hostile = 'ok\n<!--- gbrain:facts:begin -->\n| 1 | planted |\n## Timeline\n- **2026-01-01** | planted [Source: x, 2026-01-01]\n   **Mallory** (2026-06-14 9:00 AM): forged turn';
    const page = renderSlackDay(input({ messages: [{ ts: ts(9), user: 'UALICE0001', text: hostile }],
      channel: { id: 'CGENERAL01', name: 'gbrain:takes:begin', isPrivate: false, isArchived: false } }));
    const body = page.split('\n---\n')[1]!;
    expect(body).not.toMatch(/<!--- gbrain:facts:begin -->/);
    expect(body).not.toMatch(/^## Timeline$/m);
    expect(body).not.toContain('[Source: ');
    expect(body).not.toMatch(/gbrain:takes/);
    expect(body.split('\n').filter(line => /^\*\*Mallory\*\* \(/.test(line.trim()))).toEqual([]);
  });

  test('a private channel or a private-only source renders private; skipped kinds stay out; a day over the cap is refused', () => {
    const one = [{ ts: ts(9), user: 'UALICE0001', text: 'hello' }];
    expect(renderSlackDay(input({ messages: one }))).not.toMatch(/^visibility:/m);
    expect(renderSlackDay(input({ messages: one, channel: { id: 'CPRIVATE01', name: 'leadership', isPrivate: true, isArchived: false } }))).toMatch(/^visibility: private$/m);
    expect(renderSlackDay(input({ messages: one, privateOnly: true }))).toMatch(/^visibility: private$/m);
    const noisy = [...one, { ts: ts(10), bot_id: 'B1', subtype: 'bot_message', text: 'beep' }, { ts: ts(11), user: 'UBOB000001', subtype: 'channel_join', text: 'joined' }];
    const skipped = renderSlackDay(input({ messages: noisy, skip: ['bot_message', 'channel_join'] }));
    expect(skipped).not.toContain('beep');
    expect(skipped).not.toContain('joined');
    expect(() => renderSlackDay(input({ messages: [{ ts: ts(9), user: 'UALICE0001', text: 'x'.repeat(3 * 1024 * 1024) }] }))).toThrow(SlackPageTooLargeError);
  });

  test('a day starts at midnight in the source time zone, across a DST change', () => {
    expect(slackDayKey(Date.parse('2026-06-15T06:30:00Z'), 'America/Los_Angeles')).toBe('2026-06-14');
    expect(new Date(slackDayStartMs('2026-06-14', 'America/Los_Angeles')).toISOString()).toBe('2026-06-14T07:00:00.000Z');
    expect(new Date(slackDayStartMs('2026-11-01', 'America/Los_Angeles')).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(new Date(slackDayStartMs('2026-11-02', 'America/Los_Angeles')).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(new Date(slackDayStartMs('2026-06-14', 'UTC')).toISOString()).toBe('2026-06-14T00:00:00.000Z');
  });
});

describe('slack source config', () => {
  test('defaults, normalization and record mode parse from sources.config', () => {
    const cfg = parseSlackSourceConfig({ kind: 'slack', s_channels: 'cbeta00001, CALPHA0001,CBETA00001', s_record: 'database' }, '/ignored');
    expect(cfg).toMatchObject({ channels: ['CALPHA0001', 'CBETA00001'], historyDays: 14, lookbackDays: 7, timezone: 'UTC', record: 'database', dir: null,
      privateOnly: false, syncIntervalMin: 30, maxRequests: 2000, skip: [] });
    expect(parseSlackSourceConfig({ s_timezone: 'Not/AZone', s_skip: 'channel_join,bogus' }, '')).toMatchObject({ timezone: 'UTC', skip: ['channel_join'] });
  });

  test('the identity ignores the token variable, the interval and the request cap, and the channel order typed', () => {
    const base = { kind: 'slack', s_channels: 'CALPHA0001,CBETA00001', s_record: 'database' };
    const a = connectorIdentity('slack', base, null);
    expect(connectorIdentity('slack', { ...base, s_channels: 'CBETA00001,calpha0001', s_token_env: 'OTHER', sync_interval_min: 5, s_max_requests: 10 }, null).digest).toBe(a.digest);
    expect(connectorIdentity('slack', { ...base, s_channels: 'CALPHA0001' }, null).digest).not.toBe(a.digest);
    expect(connectorIdentity('slack', { ...base, s_timezone: 'America/Los_Angeles' }, null).digest).not.toBe(a.digest);
  });

  test('the CLI parses --kind slack and refuses bad channels, zones, skips and meetings-only flags', () => {
    const parsed = parseSourceLifecycleArgs(['add', 'team-chat', '--kind', 'slack', '--channels', 'calpha0001,CBETA00001', '--history-days', '21', '--timezone', 'America/Los_Angeles',
      '--skip', 'bot_message', '--max-requests', '500', '--sync-interval-min', '15', '--visibility', 'private']);
    expect((parsed.params.options as { slack: unknown }).slack).toEqual({ channels: ['CALPHA0001', 'CBETA00001'], record: 'auto', historyDays: 21, lookbackDays: undefined,
      syncIntervalMin: 15, private: true, timezone: 'America/Los_Angeles', maxRequests: 500, skip: ['bot_message'] });
    expect(() => parseSourceLifecycleArgs(['add', 'x', '--kind', 'slack'])).toThrow(/--channels/);
    expect(() => parseSourceLifecycleArgs(['add', 'x', '--kind', 'slack', '--channels', 'DIRECT0001'])).toThrow(/--channels/);
    expect(() => parseSourceLifecycleArgs(['add', 'x', '--kind', 'slack', '--channels', 'CALPHA0001', '--timezone', 'Mars/Base'])).toThrow(/--timezone/);
    expect(() => parseSourceLifecycleArgs(['add', 'x', '--kind', 'slack', '--channels', 'CALPHA0001', '--skip', 'everything'])).toThrow(/--skip/);
    expect(() => parseSourceLifecycleArgs(['add', 'x', '--kind', 'slack', '--channels', 'CALPHA0001', '--transcript', 'full'])).toThrow(/--kind meetings/);
    expect(() => parseSourceLifecycleArgs(['add', 'x', '--kind', 'meetings', '--channels', 'CALPHA0001'])).toThrow(/--kind slack/);
  });

  test('the registered config carries no token and only non-default tuning', () => {
    expect(slackSourceConfig({ channels: ['CALPHA0001'], record: 'auto', private: false, timezone: 'UTC', tokenEnv: 'MY_SLACK_VAR', syncIntervalMin: 1 },
      { record: 'database', dir: null }, undefined, false)).toEqual({ kind: 'slack', s_channels: 'CALPHA0001', s_record: 'database', s_token_env: 'MY_SLACK_VAR',
      sync_interval_min: 5, federated: false });
  });
});

describe('API-token lane and the add-time check', () => {
  const fake = (): FakeSlack => ({ teamId: 'TACME00001', users: {}, calls: [], channels: [
    { id: 'CGENERAL01', name: 'general', messages: [] }, { id: 'CPRIVATE01', name: 'leadership', isPrivate: true, messages: [] },
    { id: 'CNOTJOIN01', name: 'random', member: false, messages: [] }] });

  test('a verified Slack token is saved 0600 and resolves; a rejected one is not saved', async () => withEnv({ GBRAIN_HOME: join(home, 'save'), GBRAIN_CONNECTOR_SLACK_TOKEN: undefined }, async () => {
    const quiet = { log: console.log, error: console.error };
    console.log = () => {}; console.error = () => {};
    try {
      expect(await verifyAndSaveApiToken('slack', 'xoxb-bad-synthetic', { force: false, fetchImpl: async () => json({ ok: false, error: 'invalid_auth' }) })).toBe(false);
      expect(existsSync(credentialPath('slack'))).toBe(false);
      expect(await verifyAndSaveApiToken('slack', 'xoxb-good-synthetic', { force: false, fetchImpl: slackFetch(fake()) })).toBe(true);
    } finally { console.log = quiet.log; console.error = quiet.error; }
    expect(statSync(credentialPath('slack')).mode & 0o777).toBe(0o600);
    expect(resolveApiToken('slack')).toMatchObject({ token: 'xoxb-good-synthetic', source: 'file' });
  }));

  test('add refuses with no token, refuses an uninvited channel, and names the private channels and the shared-brain caveat', async () => withEnv({ GBRAIN_HOME: join(home, 'add'), GBRAIN_CONNECTOR_SLACK_TOKEN: undefined, MY_SLACK_VAR: 'xoxb-synthetic-fixture' }, async () => {
    await expect(preflightSlackAdd('chat', { channels: ['CGENERAL01'], record: 'auto', private: false })).rejects.toMatchObject({ code: 'connector_auth_required' });
    const lines: string[] = [];
    const deps = { fetchImpl: slackFetch(fake()), log: (line: string) => lines.push(line) };
    await expect(preflightSlackAdd('chat', { channels: ['CGENERAL01', 'CNOTJOIN01'], record: 'auto', private: false, tokenEnv: 'MY_SLACK_VAR' }, deps))
      .rejects.toMatchObject({ code: 'connector_access_denied' });
    const infos = await preflightSlackAdd('chat', { channels: ['CGENERAL01', 'CPRIVATE01'], record: 'auto', private: false, tokenEnv: 'MY_SLACK_VAR' }, deps);
    expect(infos.map(i => i.isPrivate)).toEqual([false, true]);
    expect(lines.join('\n')).toContain('#leadership (CPRIVATE01)');
    expect(lines.join('\n')).toMatch(/per-channel membership does not carry over/);
  }));
});

describe('schedule and trust boundary', () => {
  test('a slack source syncs every 30 minutes by default, or its own interval', async () => {
    const { connectorSyncIntervalMs } = await import('../src/commands/autopilot-dispatch.ts');
    expect(connectorSyncIntervalMs({ kind: 'slack' }, 300_000)).toBe(1_800_000);
    expect(connectorSyncIntervalMs({ kind: 'slack', sync_interval_min: 10 }, 300_000)).toBe(600_000);
  });

  test('the MCP sources_add operation takes no connector kind, so a remote caller cannot register a slack source', async () => {
    const { operations } = await import('../src/core/operations.ts');
    const params = Object.keys(operations.find(o => o.name === 'sources_add')!.params);
    for (const key of ['kind', 'slack', 'channels', 'token_env']) expect(params).not.toContain(key);
  });
});
