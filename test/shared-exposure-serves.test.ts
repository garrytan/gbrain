/**
 * GST-363 follow-up (GBRA-108 ruling on Train A): the unscoped_multi_user_token
 * warning applies only to a brain that serves several people (access.serves,
 * src/core/access/serves.ts). On a one-person brain every credential reads that
 * person's own pages, so the doctor check is not applicable and the install
 * routes stay silent, including a bot harness on the owner's brain (R94). On a
 * brain that serves several people the fix leads with binding the credential
 * to a member; a source rescope is named only as a narrowing that leaves the
 * token unbound. Repo-less PGLite brains throughout.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { insertUnifiedToken } from '../src/core/token-mint.ts';
import { sharedTokenNotice } from '../src/core/grants/shared-exposure.ts';
import { unscopedMultiUserTokenEntry } from '../src/commands/doctor/checks/unscoped-multi-user-token.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCli } from './helpers/cli-spawn.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

const CODE = 'unscoped_multi_user_token';
let engine: PGLiteEngine;
const roots: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gbrain-exposure-serves-')); roots.push(d); return d; };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { if (engine) await engine.disconnect(); for (const r of roots) rmSync(r, { recursive: true, force: true }); }, 60_000);

async function brainWithTwoChannels(serves: 'one' | 'several' | null) {
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw('DELETE FROM access_tokens');
  await engine.executeRaw('DELETE FROM access_members');
  if (serves) await engine.setConfig('access.serves', serves); else await engine.executeRaw("DELETE FROM config WHERE key = 'access.serves'");
  await engine.setConfig('search.remote_private_pages', 'hidden');
  __resetPrivateVisibilityCacheForTests();
  for (const [slug, title] of [['chats/a', '#alpha, Jul 2'], ['chats/b', '#beta, Jul 2']]) {
    await engine.putPage(slug!, { type: 'slack' as any, title: title!, compiled_truth: 'hello', frontmatter: {} });
  }
  await insertUnifiedToken(engine, { name: 'team-bot', tokenHash: 'hash-team-bot', grant: { sources: { kind: 'default' }, takesHolders: ['world'], allowedOperations: null } });
}
const doctor = async (home = tmp()) => withEnv({ GBRAIN_HOME: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }, async () =>
  (await unscopedMultiUserTokenEntry.run({ engine, args: [] } as unknown as DoctorContext) as any[])[0]);
const census = { sources: ['default'], chat_pages: 2, channels: 2, chat_sources: ['default'] };
const across = { sources: ['a', 'b'], chat_pages: 2, channels: 2, chat_sources: ['a', 'b'] };

describe('one-person brain', () => {
  test('doctor: not applicable when the member count says one person', async () => {
    await brainWithTwoChannels(null);
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('owner-example')");
    const check = await doctor();
    expect(check).toMatchObject({ name: CODE, status: 'ok', readiness_state: 'not_applicable' });
    expect(check.message).toContain('serves one person');
    expect(check.fix).toBeUndefined();
  });

  test('doctor: not applicable when access.serves is one, even with a wired bot harness (R94)', async () => {
    await brainWithTwoChannels('one');
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('owner-example'), ('bob-example')");
    const home = tmp();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'agent-instructions.json'), JSON.stringify({ entries: [{ harness: 'openclaw', path: join(home, 'SOUL.md'), status: 'installed', block_version: 1, access: { kind: 'mcp', server: 'gbrain' }, writer: 'gbrain setup openclaw' }] }));
    const check = await doctor(home);
    expect(check).toMatchObject({ status: 'ok', readiness_state: 'not_applicable' });
    expect(check.message).toContain('config access.serves is one');
  });

  test('the notice is silent for every subject when the brain serves one person', () => {
    expect(sharedTokenNotice({ kind: 'legacy_token', name: 'team-bot' }, { census, serves: 'one' })).toBeNull();
    expect(sharedTokenNotice({ kind: 'oauth_client', id: 'c1' }, { census, serves: 'one' })).toBeNull();
    expect(sharedTokenNotice({ kind: 'stdio', harness: 'openclaw' }, { harness: 'openclaw', serves: 'one' })).toBeNull();
  });
});

describe('brain that serves several people', () => {
  test('doctor warns and its fix binds the credential to a member', async () => {
    await brainWithTwoChannels('several');
    const check = await doctor();
    expect(check.status).toBe('warn');
    expect(check.fix).toMatchObject({ ask_user: true, argv: ['gbrain', 'auth', 'rescope', '--token', 'team-bot', '--member', '<member>'] });
  });

  test('the fix text leads with binding and names a source rescope only as an unbound narrowing', () => {
    for (const c of [census, across]) {
      const n = sharedTokenNotice({ kind: 'legacy_token', name: 'team-bot' }, { census: c, serves: 'several' })!;
      const fix = n.why.slice(n.why.indexOf('Fix: '));
      expect(fix.startsWith('Fix: bind the credential to the person who uses this agent (gbrain auth rescope --token team-bot --member <id>)')).toBe(true);
      expect(fix).toContain('gbrain auth rescope --token team-bot --may-act-for <members>');
      expect(fix.indexOf('--member <id>')).toBeLessThan(fix.indexOf('--may-act-for'));
      if (c === across) {
        expect(fix).toContain('narrowing only, which leaves the token unbound: gbrain auth rescope --token team-bot --sources <source>');
        expect(fix.indexOf('--may-act-for')).toBeLessThan(fix.indexOf('--sources'));
      } else {
        expect(fix).not.toContain('--sources');
      }
      expect(n.fix!.argv).toEqual(['gbrain', 'auth', 'rescope', '--token', 'team-bot', '--member', '<member>']);
    }
    const client = sharedTokenNotice({ kind: 'oauth_client', id: 'c1' }, { census, serves: 'several' })!;
    expect(client.fix!.argv).toEqual(['gbrain', 'auth', 'rescope', '--client', 'c1', '--member', '<member>']);
    const bot = sharedTokenNotice({ kind: 'stdio', harness: 'openclaw' }, { harness: 'openclaw', serves: 'several' })!;
    expect(bot.why).toContain('Fix: label each person and bind this harness\'s server (gbrain setup openclaw --serves several --members <id,...>');
  });
});

describe('install routes on a one-person brain', () => {
  const page = (title: string) => '---\ntitle: "' + title + '"\ntype: slack\n---\nhello\n';
  function box() {
    const root = tmp();
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const env = { HOME: home, GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), HERMES_HOME: undefined, OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_WORKSPACE_DIR: undefined, OPENCLAW_PROFILE: undefined, GBRAIN_SOURCE: undefined, GBRAIN_AGENT_INSTRUCTIONS: undefined };
    const bin = join(root, 'gbrain');
    writeFileSync(bin, '#!/bin/sh\nexec \'' + process.execPath + '\' \'' + join(import.meta.dir, '..', 'src', 'cli.ts') + '\' "$@"\n');
    chmodSync(bin, 0o755);
    return { root, home, env, bin };
  }

  test('auth create and setup openclaw (a bot harness on the owner brain, R94) stay silent', async () => {
    const b = box();
    expect((await runCli(['init', '--pglite', '--no-embedding', '--non-interactive'], { env: b.env, cwd: b.root, timeoutMs: 120_000 })).exitCode).toBe(0);
    for (const [i, title] of ['#alpha-team, Jul 2', '#beta-team, Jul 3'].entries()) {
      const file = join(b.root, 'p' + i + '.md');
      writeFileSync(file, page(title));
      const put = Bun.spawnSync(['sh', '-c', '\'' + b.bin + '\' put chats/p' + i + ' < \'' + file + '\''], { env: Object.fromEntries(Object.entries({ ...process.env, ...b.env }).filter(([, v]) => v !== undefined)) as Record<string, string> });
      expect(put.exitCode).toBe(0);
    }
    const token = await runCli(['auth', 'create', 'owner-bot'], { env: b.env, cwd: b.root });
    expect(token.stdout).toMatch(/gbrain_[0-9a-f]+/);
    expect(token.stderr).not.toContain(CODE);
    const ws = join(b.home, '.openclaw', 'workspace');
    mkdirSync(ws, { recursive: true });
    const setup = JSON.parse((await runCli(['setup', 'openclaw', '--workspace', ws, '--gbrain-bin', b.bin, '--dry-run', '--json'], { env: b.env, cwd: b.root })).stdout);
    expect((setup.notices ?? []).map((n: any) => n.code)).not.toContain(CODE);
    const several = await runCli(['config', 'set', 'access.serves', 'several'], { env: b.env, cwd: b.root });
    expect(several.exitCode).toBe(0);
    expect((await runCli(['auth', 'create', 'shared-bot', '--reads-unscoped', '--yes'], { env: b.env, cwd: b.root })).stderr).toContain(CODE);
  }, 240_000);
});
