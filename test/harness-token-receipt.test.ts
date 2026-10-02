/** #5775: an inline-token install names where the token lives and how to replace it, never the token. */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installHarnessConnection } from '../src/core/harness/install.ts';
import { writeCredentials, type HarnessCredentials } from '../src/core/harness/credentials.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'gbrain-token-receipt-')); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const TOKEN = 'fixture-access-private-value';
const creds = (): HarnessCredentials => ({ version: 1, mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com', client_id: 'gbrain_cl_fixture',
  access_token: TOKEN, client_secret: 'fixture-client-private-value', profile: 'memory-writer', source_id: 'default', expires_at: Date.now() / 1000 + 3600 });
const CONFIG = { codex: 'config.toml', 'claude-code': 'claude.json', opencode: 'opencode.jsonc' } as const;
const RELOAD = { codex: 'Start a new Codex session and inspect /mcp.', 'claude-code': 'Restart Claude Code and inspect /mcp.', opencode: 'Restart opencode and inspect its MCP connections.' } as const;

describe('inline bearer token receipt (#5775)', () => {
  for (const harness of ['codex', 'claude-code', 'opencode'] as const) test(`${harness} receipt names storage, renewal and exposure recovery without the token`, async () => {
    const dir = temp(), configPath = join(dir, CONFIG[harness]), handoff = join(dir, 'handoff.json');
    const receipt = await installHarnessConnection(creds(), { harness, configPath, credentialsFile: handoff, name: 'example-brain' }) as Record<string, any>;
    const renew = `gbrain connect https://brain.example.com/mcp --harness ${harness} --credentials-file ${handoff} --name example-brain --install --fresh-token`;
    expect(receipt).toMatchObject({ status: 'installed', token_storage: 'inline', config_path: configPath, renew_command: renew });
    expect(receipt.if_exposed).toEqual({
      steps: [
        'On the brain host, preview: gbrain mcp admin invalidate-tokens gbrain_cl_fixture --url https://brain.example.com/mcp --admin-token-file <owner-admin-token-file> --json',
        'Apply with the previewed revision: gbrain mcp admin invalidate-tokens gbrain_cl_fixture --yes --if-version <revision> --url https://brain.example.com/mcp --admin-token-file <owner-admin-token-file> --json',
        `Write a freshly exchanged token here: ${renew}`,
        RELOAD[harness],
      ],
      docs_url: 'docs/mcp/ADMIN.md#invalidate-tokens-revoke-or-delete',
    });
    expect(receipt.token_warning).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toContain(TOKEN);
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(readFileSync(join(dir, `.gbrain-connection-${harness}-example-brain.json`), 'utf8')).not.toContain(TOKEN);
  });

  test('exposure recovery exchanges a new token instead of reinstalling the cached one', async () => {
    const dir = temp(), configPath = join(dir, 'config.toml');
    const issued = 'fixture-fresh-token-value-0001';
    let exchanges = 0;
    const server = Bun.serve({ port: 0, fetch: () => { exchanges++; return Response.json({ access_token: issued, token_type: 'Bearer', expires_in: 3600 }); } });
    try {
      const c = { ...creds(), issuer_url: `http://127.0.0.1:${server.port}` };
      await installHarnessConnection(c, { harness: 'codex', configPath });
      expect(exchanges).toBe(0);
      expect(readFileSync(configPath, 'utf8')).toContain(TOKEN);
      await installHarnessConnection(c, { harness: 'codex', configPath, freshToken: true });
      expect(exchanges).toBe(1);
      expect(readFileSync(configPath, 'utf8')).toContain(issued);
      expect(readFileSync(configPath, 'utf8')).not.toContain(TOKEN);
    } finally { server.stop(true); }
  });

  test('a handoff without a client secret points recovery at a new handoff', async () => {
    const dir = temp(), configPath = join(dir, 'config.toml');
    const { client_secret: _secret, ...staticCreds } = creds();
    const receipt = await installHarnessConnection(staticCreds, { harness: 'codex', configPath }) as Record<string, any>;
    expect(receipt.if_exposed.steps[2]).toBe('This handoff cannot exchange a new token; get a new private handoff from the brain owner (gbrain mcp grant on the brain host), then run: '
      + 'gbrain connect https://brain.example.com/mcp --harness codex --credentials-file <private-handoff-file> --install');
  });

  test('a configuration inside a Git working tree warns with the fix until it is ignored', async () => {
    const repo = temp(), configPath = join(repo, '.codex', 'config.toml');
    execFileSync('git', ['init', '--quiet', repo]);
    mkdirSync(join(repo, '.codex'));
    const first = await installHarnessConnection(creds(), { harness: 'codex', configPath }) as Record<string, any>;
    expect(first.renew_command).toBe('gbrain connect https://brain.example.com/mcp --harness codex --credentials-file <private-handoff-file> --install --fresh-token');
    expect(first.token_warning).toBe(`${configPath} is inside the Git working tree ${execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()}, `
      + "so committing there would publish this bearer token. Add .codex/config.toml to that repository's .gitignore or move the configuration; if it was already committed, follow if_exposed.");
    writeFileSync(join(repo, '.gitignore'), '.codex/config.toml\n');
    const ignored = await installHarnessConnection(creds(), { harness: 'codex', configPath }) as Record<string, any>;
    expect(ignored.token_warning).toBeUndefined();
  });

  test('connect --install human output says where the token lives and never prints it', async () => {
    const dir = temp(), handoff = join(dir, 'handoff.json');
    writeCredentials(handoff, { ...creds(), harness: 'codex' });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL']) delete env[key];
    Object.assign(env, { HOME: dir, GBRAIN_HOME: dir, CODEX_HOME: join(dir, '.codex'), GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1' });
    const proc = Bun.spawn(['bun', 'run', join(REPO_ROOT, 'src', 'cli.ts'), 'connect', 'https://brain.example.com/mcp', '--harness', 'codex', '--credentials-file', handoff, '--install'],
      { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    const configPath = join(dir, '.codex', 'config.toml');
    expect(JSON.parse(stdout)).toMatchObject({ status: 'installed', token_storage: 'inline', config_path: configPath });
    expect(stderr).toContain(`The bearer token is stored inline in ${configPath}; this output never prints it. Renew it with: gbrain connect https://brain.example.com/mcp --harness codex --credentials-file ${handoff} --install --fresh-token`);
    expect(stderr).toContain('If it was exposed: On the brain host, preview: gbrain mcp admin invalidate-tokens gbrain_cl_fixture');
    expect(stderr).toContain('docs/mcp/ADMIN.md#invalidate-tokens-revoke-or-delete');
    expect(stdout + stderr).not.toContain(TOKEN);
    expect(readFileSync(configPath, 'utf8')).toContain(TOKEN);
  }, 60_000);

  test('connect --install --fresh-token is accepted by the CLI and installs a newly exchanged token', async () => {
    const dir = temp(), handoff = join(dir, 'handoff.json');
    const issued = 'fixture-fresh-token-value-0002';
    let exchanges = 0;
    const server = Bun.serve({ port: 0, fetch: () => { exchanges++; return Response.json({ access_token: issued, token_type: 'Bearer', expires_in: 3600 }); } });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      writeCredentials(handoff, { ...creds(), harness: 'codex', issuer_url: origin, mcp_url: `${origin}/mcp` });
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
      for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL']) delete env[key];
      Object.assign(env, { HOME: dir, GBRAIN_HOME: dir, CODEX_HOME: join(dir, '.codex'), GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1' });
      const proc = Bun.spawn(['bun', 'run', join(REPO_ROOT, 'src', 'cli.ts'), 'connect', `${origin}/mcp`, '--harness', 'codex', '--credentials-file', handoff, '--install', '--fresh-token', '--json'],
        { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ code, stderr }).toMatchObject({ code: 0 });
      expect(JSON.parse(stdout)).toMatchObject({ status: 'installed', token_storage: 'inline' });
      expect(exchanges).toBe(1);
      const config = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8');
      expect(config).toContain(issued);
      expect(config).not.toContain(TOKEN);
      expect(stdout + stderr).not.toContain(issued);
    } finally { server.stop(true); }
  }, 60_000);
});
