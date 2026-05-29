import { describe, test as testRaw, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';

function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, fn, 30000);
}

const CLI = join(__dirname, '..', 'src', 'cli.ts');

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-connect-'));
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

interface RunResult { exitCode: number; stdout: string; stderr: string; }

async function run(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GBRAIN_HOME = tmp;
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  delete env.GBRAIN_REMOTE_CLIENT_SECRET;
  delete env.GBRAIN_REMOTE_ISSUER_URL;
  delete env.GBRAIN_REMOTE_MCP_URL;
  delete env.GBRAIN_REMOTE_CLIENT_ID;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const proc = Bun.spawn({
    cmd: ['bun', 'run', CLI, ...args],
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function configPath(): string { return join(tmp, '.gbrain', 'config.json'); }

function onboardingUrl(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `https://brain.example.com/admin/onboarding?invite=${encoded}`;
}

describe('gbrain connect', () => {
  test('decodes onboarding URL and writes thin-client config', async () => {
    const url = onboardingUrl({
      org_id: 'org_123',
      email: 'ada@example.com',
      role: 'member',
      scopes: 'read write',
      source_id: 'engineering',
      federated_read: ['engineering', 'default'],
      server_url: 'https://brain.example.com/mcp',
      token_url: 'https://brain.example.com/token',
      client_id: 'cortex_cl_123',
    });

    const r = await run(['connect', url, '--client-secret', 'csecret', '--no-smoke', '--json']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(configPath())).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(cfg.remote_mcp).toBeDefined();
    expect(cfg.remote_mcp.issuer_url).toBe('https://brain.example.com');
    expect(cfg.remote_mcp.mcp_url).toBe('https://brain.example.com/mcp');
    expect(cfg.remote_mcp.oauth_client_id).toBe('cortex_cl_123');
    expect(cfg.remote_mcp.oauth_client_secret).toBe('csecret');
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.status).toBe('success');
    expect(parsed.mode).toBe('thin-client');
    expect(parsed.smoke).toBe('skipped');
  });

  test('explains signup receipts that are still provisioning', async () => {
    const url = onboardingUrl({
      org_id: 'org_123',
      brain_id: 'brain_123',
      email: 'owner@example.com',
      role: 'owner',
      status: 'provisioning',
    });

    const r = await run(['connect', url, '--json']);
    expect(r.exitCode).toBe(1);
    expect(existsSync(configPath())).toBe(false);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('provisioning_pending');
    expect(parsed.message).toContain('signup receipt');
  });
});
