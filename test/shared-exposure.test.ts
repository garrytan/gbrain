/**
 * GST-363: the shared-token exposure detection (src/core/grants/shared-exposure.ts)
 * and the doctor check built on it (unscoped_multi_user_token). Every brain
 * here is an in-memory PGLite brain with no repository: sources are added
 * without a path, so the repo-less default install is the case under test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { insertUnifiedToken } from '../src/core/token-mint.ts';
import { grantFromTokenRow } from '../src/core/grants/model.ts';
import {
  BOT_HARNESSES, CHAT_PAGE_TYPES, botHarnessForWorkspace, chatChannelCensus, claudeCodeChannelPlugins, credentialReadSources,
  exposureFix, exposureReasons, sharedTokenNotice, stdioReadSources,
} from '../src/core/grants/shared-exposure.ts';
import { unscopedMultiUserTokenEntry } from '../src/commands/doctor/checks/unscoped-multi-user-token.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { withEnv } from './helpers/with-env.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

let engine: PGLiteEngine;
const roots: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gbrain-shared-exposure-')); roots.push(d); return d; };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { if (engine) await engine.disconnect(); for (const r of roots) rmSync(r, { recursive: true, force: true }); }, 60_000);

async function reset() {
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw('DELETE FROM access_tokens');
  await engine.executeRaw('DELETE FROM oauth_clients');
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.setConfig('search.remote_private_pages', 'hidden');
  __resetPrivateVisibilityCacheForTests();
}
const chat = (slug: string, title: string, frontmatter: Record<string, unknown> = {}, type = 'slack', sourceId = 'default') =>
  engine.putPage(slug, { type: type as any, title, compiled_truth: 'hello', frontmatter }, { sourceId } as any);
async function token(name: string, sources?: string[]) {
  const [row] = await insertUnifiedToken(engine, { name, tokenHash: `hash-${name}`, grant: {
    sources: sources ? (sources.length === 1 ? { kind: 'scalar', writeSource: sources[0]! } : { kind: 'federated', writeSource: sources[0]!, readSources: sources }) : { kind: 'default' },
    takesHolders: ['world'], allowedOperations: null } });
  const [full] = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE id = $1', [row!.id]);
  return grantFromTokenRow(full!);
}
const doctor = async (extra: Partial<DoctorContext> = {}, home = tmp()) =>
  withEnv({ GBRAIN_HOME: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }, async () =>
    (await unscopedMultiUserTokenEntry.run({ engine, args: [], ...extra } as DoctorContext) as any[])[0]);

describe('chat census', () => {
  test('channels come from frontmatter, a #title, or the source; deleted and private pages do not count', async () => {
    await reset();
    await chat('chats/a1', '#alpha-team, Jul 2');
    await chat('chats/a2', '#Alpha-Team, Jul 3');
    await chat('chats/b1', 'Standup notes', { channel: 'beta' });
    await chat('chats/x', '#gamma, Jul 4', { visibility: 'private' });
    await chat('chats/gone', '#delta, Jul 5');
    await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'chats/gone'");
    await engine.putPage('notes/n', { type: 'note' as any, title: '#not-chat', compiled_truth: 'x' });
    const c = await chatChannelCensus(engine, ['default']);
    expect(c).toEqual({ sources: ['default'], chat_pages: 3, channels: 2, chat_sources: ['default'] });
    await engine.setConfig('search.remote_private_pages', 'visible');
    __resetPrivateVisibilityCacheForTests();
    expect((await chatChannelCensus(engine, ['default'])).channels).toBe(3);
  });

  test('unlabelled chat in one source is one channel; each DM page is its own channel', async () => {
    await reset();
    await chat('chats/u1', 'Jul 2 log');
    await chat('chats/u2', 'Jul 3 log');
    expect((await chatChannelCensus(engine, ['default'])).channels).toBe(1);
    await chat('dms/d1', 'DMs Jul 2', {}, 'slack-dm-day');
    await chat('dms/d2', 'DMs Jul 3', {}, 'slack-dm-day');
    expect((await chatChannelCensus(engine, ['default'])).channels).toBe(3);
    expect(CHAT_PAGE_TYPES).toContain('slack-thread');
  });

  test('the census counts only the sources it is given', async () => {
    await reset();
    await runSources(engine, ['add', 'chan-a', '--no-federated']);
    await runSources(engine, ['add', 'chan-b', '--no-federated']);
    await chat('chats/a', 'A log', {}, 'slack', 'chan-a');
    await chat('chats/b', 'B log', {}, 'slack', 'chan-b');
    expect((await chatChannelCensus(engine, ['chan-a'])).channels).toBe(1);
    expect(await chatChannelCensus(engine, ['chan-a', 'chan-b'])).toMatchObject({ channels: 2, chat_sources: ['chan-a', 'chan-b'] });
    expect((await chatChannelCensus(engine, [])).channels).toBe(0);
  });
});

describe('read sets', () => {
  test('an unscoped legacy token reads default plus every federated source; scalar and federated grants read what they name', async () => {
    await reset();
    await runSources(engine, ['add', 'fed-a', '--federated']);
    await runSources(engine, ['add', 'solo', '--no-federated']);
    expect((await credentialReadSources(engine, await token('open'))).sort()).toEqual(['default', 'fed-a']);
    expect(await credentialReadSources(engine, await token('one', ['solo']))).toEqual(['solo']);
    expect(await credentialReadSources(engine, await token('two', ['solo', 'fed-a']))).toEqual(['solo', 'fed-a']);
  });

  test('an unscoped OAuth client reads default only, a client without read scope nothing', async () => {
    await reset();
    await runSources(engine, ['add', 'fed-a', '--federated']);
    const client = { principal: { kind: 'oauth_client' as const, id: 'c1' }, scopes: ['read'], sources: { kind: 'default' as const } };
    expect(await credentialReadSources(engine, client)).toEqual(['default']);
    expect(await credentialReadSources(engine, { ...client, scopes: ['write_only_scope_x'] })).toEqual([]);
  });

  test('a stdio server pinned with GBRAIN_SOURCE reads that source alone', async () => {
    await reset();
    await runSources(engine, ['add', 'fed-a', '--federated']);
    expect((await withEnv({ GBRAIN_SOURCE: undefined }, () => stdioReadSources(engine, tmp()))).sort()).toEqual(['default', 'fed-a']);
    expect(await withEnv({ GBRAIN_SOURCE: 'fed-a' }, () => stdioReadSources(engine, tmp()))).toEqual(['fed-a']);
  });
});

describe('signals and the warning', () => {
  test('reasons: bot harness, channel plugin, multi-channel chat', () => {
    const two = { sources: ['default'], chat_pages: 2, channels: 2, chat_sources: ['default'] };
    expect(exposureReasons({ harness: 'claude-code' })).toEqual([]);
    for (const h of BOT_HARNESSES) expect(exposureReasons({ harness: h })).toEqual(['bot_harness']);
    expect(exposureReasons({ channelPlugins: ['telegram@claude-plugins-official'], census: two })).toEqual(['channel_plugin', 'multi_channel_chat']);
    expect(exposureReasons({ census: { ...two, channels: 1 } })).toEqual([]);
  });

  test('chat split across sources gets the rescope fix; chat inside one source gets no rescope command', () => {
    const across = { sources: ['a', 'b'], chat_pages: 2, channels: 2, chat_sources: ['a', 'b'] };
    const within = { sources: ['default'], chat_pages: 2, channels: 2, chat_sources: ['default'] };
    const split = sharedTokenNotice({ kind: 'legacy_token', name: 'bot' }, { census: across })!;
    expect(split.code).toBe('unscoped_multi_user_token');
    expect(split.kind).toBe('safety');
    expect(split.why).toContain('another person\'s messages');
    expect(split.why).toContain('gbrain auth rescope --token bot --sources <source>');
    expect(split.why).toContain('gbrain sources unfederate <id>');
    expect(split.fix).toMatchObject({ ask_user: true, argv: ['gbrain', 'auth', 'rescope', '--token', 'bot', '--sources', '<source>'], consent: ['credentials'] });
    const one = sharedTokenNotice({ kind: 'oauth_client', id: 'c1' }, { census: within })!;
    expect(one.why).toContain('the chat sits in one source (default), so a source grant cannot separate it');
    expect(one.why).not.toContain('auth rescope');
    expect(one.fix!.argv).toBeUndefined();
    for (const n of [split, one]) {
      expect(n.why).toContain('visibility: private');
      expect(n.why).toContain('source_ids on search and query (MCP) or --source (CLI)');
      expect(n.why).toContain('gbrain auth create <name> --member <id>) arrive with gbrain#7812');
      expect(n.user_message).toBe(n.fix!.user_message);
    }
    const bot = sharedTokenNotice({ kind: 'stdio', harness: 'hermes' }, { harness: 'hermes' })!;
    expect(bot.why).toContain('GBRAIN_SOURCE=<source>');
    expect(sharedTokenNotice({ kind: 'stdio', harness: 'claude-code' }, { harness: 'claude-code' })).toBeNull();
    expect(exposureFix({ kind: 'stdio', harness: 'hermes' }).argv).toBeUndefined();
  });

  test('Claude Code channel plugins and bot workspaces are read from config paths', () => {
    const dir = tmp();
    expect(claudeCodeChannelPlugins(dir)).toEqual([]);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'telegram@claude-plugins-official': true, 'discord@x': false, 'github@x': true } }));
    expect(claudeCodeChannelPlugins(dir)).toEqual(['telegram@claude-plugins-official']);
    writeFileSync(join(dir, 'settings.json'), '{not json');
    expect(claudeCodeChannelPlugins(dir)).toEqual([]);
    const home = tmp();
    withEnv({ HERMES_HOME: undefined }, () => {
      expect(botHarnessForWorkspace(join(home, '.openclaw', 'workspace'), home)).toBe('openclaw');
      expect(botHarnessForWorkspace(join(home, '.openclaw-work', 'ws'), home)).toBe('openclaw');
      expect(botHarnessForWorkspace(join(home, '.hermes'), home)).toBe('hermes');
      expect(botHarnessForWorkspace(join(home, 'projects', 'repo'), home)).toBeNull();
    });
  });
});

describe('doctor unscoped_multi_user_token', () => {
  test('an unscoped token over chat from two channels warns with an ask-user fix; scoping it to one channel source clears it', async () => {
    await reset();
    await runSources(engine, ['add', 'chan-a', '--federated']);
    await runSources(engine, ['add', 'chan-b', '--federated']);
    await chat('chats/a', '#alpha, Jul 2', {}, 'slack', 'chan-a');
    await chat('chats/b', '#beta, Jul 2', {}, 'slack', 'chan-b');
    await token('team-bot');
    const warn = await doctor();
    expect(warn.status).toBe('warn');
    expect(warn.message).toContain('The token "team-bot" reaches 2 channels in chan-a, chan-b');
    expect(warn.fix).toMatchObject({ ask_user: true, argv: ['gbrain', 'auth', 'rescope', '--token', 'team-bot', '--sources', '<source>'] });
    expect(categorizeCheck('unscoped_multi_user_token')).toBeDefined();
    await engine.executeRaw('DELETE FROM access_tokens');
    await token('team-bot', ['chan-a']);
    expect((await doctor()).status).toBe('ok');
  });

  test('a remote caller gets a count, never credential names', async () => {
    await reset();
    await chat('chats/a', '#alpha, Jul 2');
    await chat('chats/b', '#beta, Jul 2');
    await token('team-bot');
    const remote = await doctor({ remote: true });
    expect(remote.status).toBe('warn');
    expect(remote.message).not.toContain('team-bot');
    expect(remote.details).toEqual({ flagged_count: 1 });
    expect(remote.fix).toBeUndefined();
  });

  test('a wired bot harness with no multi-channel chat is information; with it, a warning', async () => {
    await reset();
    const home = tmp();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'agent-instructions.json'), JSON.stringify({ entries: [{ harness: 'hermes', path: join(home, '.hermes', 'SOUL.md'), status: 'installed', block_version: 1, access: { kind: 'mcp', server: 'gbrain' }, writer: 'gbrain setup hermes' }] }));
    const info = await doctor({}, home);
    expect(info).toMatchObject({ status: 'ok', severity: 'info' });
    expect(info.message).toContain('hermes serves a chat agent');
    await chat('chats/a', '#alpha, Jul 2');
    await chat('chats/b', '#beta, Jul 2');
    const warn = await doctor({}, home);
    expect(warn.status).toBe('warn');
    expect(warn.message).toContain('The gbrain access hermes uses reaches 2 channels');
  });

  test('a brain with no chat and no credentials is ok', async () => {
    await reset();
    await token('laptop');
    expect(await doctor()).toMatchObject({ status: 'ok' });
  });
});
