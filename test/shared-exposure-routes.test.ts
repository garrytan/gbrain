/**
 * GST-363: every install route prints the unscoped_multi_user_token warning
 * when the serve is likely multi-user, and stays quiet otherwise. Spawns the
 * CLI against a temp HOME / GBRAIN_HOME; the brain routes run on a keyless
 * PGLite brain with no repository (gbrain init --pglite --no-embedding).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const CODE = 'unscoped_multi_user_token';
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function box() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-shared-routes-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const env = { HOME: home, GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), HERMES_HOME: undefined, OPENCLAW_STATE_DIR: undefined,
    OPENCLAW_WORKSPACE_DIR: undefined, OPENCLAW_PROFILE: undefined, GBRAIN_SOURCE: undefined, GBRAIN_AGENT_INSTRUCTIONS: undefined };
  return { root, home, env };
}
const json = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
const codes = (list: any[] | undefined) => (list ?? []).map((n) => n.code);

describe('setup routes', () => {
  test('setup openclaw and setup hermes carry the warning; --remove does not', async () => {
    const b = box();
    const ws = join(b.home, '.openclaw', 'workspace');
    mkdirSync(ws, { recursive: true });
    const openclaw = await runCli(['setup', 'openclaw', '--workspace', ws, '--dry-run', '--json'], { env: b.env, cwd: b.root });
    const doc = json(openclaw.stdout);
    expect(codes(doc?.notices)).toEqual([CODE]);
    expect(doc.notices[0].why).toContain('another person\'s messages');
    expect(doc.notices[0].why).toContain('GBRAIN_SOURCE=<source>');
    expect(doc.notices[0].fix.next).toBe('ask_user');
    const hermes = json((await runCli(['setup', 'hermes', '--dry-run', '--json'], { env: b.env, cwd: b.root })).stdout);
    expect(codes(hermes?.notices)).toEqual([CODE]);
    const removed = json((await runCli(['setup', 'openclaw', '--workspace', ws, '--remove', '--dry-run', '--json'], { env: b.env, cwd: b.root })).stdout);
    expect(codes(removed?.notices)).toEqual([]);
  }, 60_000);

  test('setup hermes in human mode prints an [AGENT] block on stderr when not a terminal', async () => {
    const b = box();
    const r = await runCli(['setup', 'hermes', '--dry-run'], { env: b.env, cwd: b.root });
    expect(r.stderr).toContain('[AGENT]');
    expect(r.stderr).toContain(`[${CODE}] WARNING`);
    expect(r.stdout).not.toContain(CODE);
  }, 60_000);

  test('setup grok-bot --instructions-only (the paste branch) carries the warning', async () => {
    const b = box();
    const doc = json((await runCli(['setup', 'grok-bot', '--instructions-only', '--json'], { env: b.env, cwd: b.root })).stdout);
    expect(codes(doc?.notices)).toEqual([CODE]);
  }, 60_000);

  test('setup claude-code warns only when a chat-channel plugin is enabled', async () => {
    const b = box();
    const bin = join(b.root, 'gbrain');
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, '..', 'src', 'cli.ts')}' "$@"\n`);
    chmodSync(bin, 0o755);
    const setup = async () => json((await runCli(['setup', 'claude-code', '--gbrain-bin', bin, '--dry-run', '--json'], { env: b.env, cwd: b.root })).stdout);
    const quiet = await setup();
    expect(quiet?.harness).toBe('claude-code');
    expect(codes(quiet.notices)).not.toContain(CODE);
    mkdirSync(join(b.home, '.claude'), { recursive: true });
    writeFileSync(join(b.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'telegram@claude-plugins-official': true } }));
    const loud = await setup();
    expect(codes(loud?.notices)).toContain(CODE);
    expect(loud.notices.find((n: any) => n.code === CODE).why).toContain('telegram@claude-plugins-official');
  }, 60_000);
});

describe('harness-side routes', () => {
  test('skillpack scaffold --harness openclaw warns on stderr and keeps stdout for its JSON', async () => {
    const b = box();
    const r = await runCli(['skillpack', 'scaffold', '--harness', 'openclaw', '--workspace', join(b.home, '.openclaw', 'workspace'), '--dry-run', '--json'], { env: b.env, cwd: b.root });
    expect(r.stderr).toContain(CODE);
    expect(r.stdout).not.toContain(`[${CODE}]`);
  }, 60_000);

  test('connect --harness hermes adds warnings to its receipt; --harness claude-code does not', async () => {
    const b = box();
    const file = join(b.root, 'creds.json');
    writeFileSync(file, JSON.stringify({ version: 1, mcp_url: 'https://brain.example.ts.net/mcp', client_id: 'client-a', client_secret: 'secretvalue0123456789abcdef' }));
    chmodSync(file, 0o600);
    const hermes = await runCli(['connect', 'https://brain.example.ts.net/mcp', '--harness', 'hermes', '--credentials-file', file, '--json'], { env: b.env, cwd: b.root });
    const doc = json(hermes.stdout);
    expect(doc?.status).toBe('prepared');
    expect(codes(doc.warnings)).toEqual([CODE]);
    expect(hermes.stderr).toContain(CODE);
    const cc = json((await runCli(['connect', 'https://brain.example.ts.net/mcp', '--harness', 'claude-code', '--credentials-file', file, '--json'], { env: b.env, cwd: b.root })).stdout);
    expect(cc?.warnings).toBeUndefined();
  }, 60_000);
});

describe('brain routes on a repo-less keyless brain', () => {
  const page = (title: string) => `---\ntitle: "${title}"\ntype: slack\n---\nhello\n`;
  async function brain(titles: string[]) {
    const b = box();
    expect((await runCli(['init', '--pglite', '--no-embedding', '--non-interactive'], { env: b.env, cwd: b.root, timeoutMs: 120_000 })).exitCode).toBe(0);
    for (const [i, title] of titles.entries()) {
      const file = join(b.root, `p${i}.md`);
      writeFileSync(file, page(title));
      const put = Bun.spawnSync(['sh', '-c', `'${process.execPath}' '${join(import.meta.dir, '..', 'src', 'cli.ts')}' put chats/p${i} < '${file}'`], { env: Object.fromEntries(Object.entries({ ...process.env, ...b.env }).filter(([, v]) => v !== undefined)) as Record<string, string> });
      expect(put.exitCode).toBe(0);
    }
    return b;
  }

  test('auth create, register-client, mcp grant and doctor all flag chat from two channels in default', async () => {
    const b = await brain(['#alpha-team, Jul 2', '#beta-team, Jul 3']);
    const token = await runCli(['auth', 'create', 'team-bot'], { env: b.env, cwd: b.root });
    expect(token.stdout).toMatch(/gbrain_[0-9a-f]+/);
    expect(token.stdout).not.toContain(CODE);
    expect(token.stderr).toContain('The token "team-bot" is not scoped to a person (it reads chat from 2 channels in default)');
    expect(token.stderr).toContain('the chat sits in one source (default)');
    const client = await runCli(['auth', 'register-client', 'team-client'], { env: b.env, cwd: b.root });
    expect(client.stdout).toContain('Client ID:');
    expect(client.stderr).toContain(CODE);
    const grant = await runCli(['mcp', 'grant', 'laptop', '--harness', 'claude-code', '--source', 'default', '--url', 'https://brain.example.ts.net/mcp', '--dry-run', '--json'], { env: b.env, cwd: b.root });
    const receipt = json(grant.stdout);
    expect(receipt?.status).toBe('preview');
    expect(codes(receipt.warnings)).toEqual([CODE]);
    const doctor = json((await runCli(['doctor', '--only', CODE, '--json'], { env: b.env, cwd: b.root, timeoutMs: 120_000 })).stdout);
    const check = doctor?.checks?.find((c: any) => c.name === CODE);
    expect(check?.status).toBe('warn');
    expect(check.fix.next).toBe('ask_user');
  }, 240_000);

  test('a brain whose chat comes from one channel mints a token silently', async () => {
    const b = await brain(['#alpha-team, Jul 2', '#alpha-team, Jul 3']);
    const token = await runCli(['auth', 'create', 'solo-bot'], { env: b.env, cwd: b.root });
    expect(token.stdout).toMatch(/gbrain_[0-9a-f]+/);
    expect(token.stderr).not.toContain(CODE);
  }, 240_000);
});
