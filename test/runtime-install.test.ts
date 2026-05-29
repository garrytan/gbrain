import { afterEach, beforeEach, describe, expect, test as testRaw } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, fn, 30000);
}

const CLI = join(__dirname, '..', 'src', 'cli.ts');

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-runtime-install-'));
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

interface RunResult { exitCode: number; stdout: string; stderr: string; }

async function run(args: string[]): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GBRAIN_HOME = tmp;
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  delete env.GBRAIN_REMOTE_CLIENT_SECRET;

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

function seedThinClientConfig() {
  const dir = join(tmp, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    engine: 'postgres',
    remote_mcp: {
      issuer_url: 'https://brain.example.com',
      mcp_url: 'https://brain.example.com/mcp',
      oauth_client_id: 'cortex_cl_123',
      oauth_client_secret: 'super-secret',
    },
  }, null, 2));
}

describe('cortex runtime install', () => {
  test('writes Cursor config from the connected hosted profile without secrets', async () => {
    seedThinClientConfig();
    const outDir = join(tmp, 'workspace');

    const r = await run(['runtime', 'install', 'cursor', '--config-dir', outDir, '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed).toMatchObject({
      status: 'success',
      runtime: 'cursor',
      mcp_url: 'https://brain.example.com/mcp',
    });

    const file = join(outDir, '.cursor', 'mcp.json');
    expect(existsSync(file)).toBe(true);
    const config = JSON.parse(readFileSync(file, 'utf-8'));
    expect(config.mcpServers.cortex).toEqual({
      url: 'https://brain.example.com/mcp',
      transport: 'sse',
    });
    expect(JSON.stringify(config)).not.toContain('super-secret');
  });

  test('writes Claude Desktop config under an explicit config directory', async () => {
    seedThinClientConfig();
    const outDir = join(tmp, 'claude');

    const r = await run(['runtime', 'install', 'claude-desktop', '--config-dir', outDir, '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.runtime).toBe('claude_desktop');

    const file = join(outDir, 'claude_desktop_config.json');
    expect(existsSync(file)).toBe(true);
    const config = JSON.parse(readFileSync(file, 'utf-8'));
    expect(config.mcpServers.cortex.url).toBe('https://brain.example.com/mcp');
    expect(JSON.stringify(config)).not.toContain('super-secret');
  });

  test('can emit runtime instructions from an explicit MCP URL for agents', async () => {
    const r = await run(['runtime', 'install', 'claude-code', '--mcp-url', 'https://tenant.example.com/mcp', '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed).toMatchObject({
      status: 'success',
      runtime: 'claude_code',
      mcp_url: 'https://tenant.example.com/mcp',
      command: 'claude mcp add --transport http cortex https://tenant.example.com/mcp',
    });
  });

  test('can install a runtime directly from the hosted runtime manifest URL', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== '/runtime-manifest.json') {
          return new Response('not found', { status: 404 });
        }
        return Response.json({
          schema: 'cortex.runtime-manifest.v1',
          endpoints: {
            mcp_url: 'https://tenant.example.com/mcp/',
          },
        });
      },
    });
    try {
      const outDir = join(tmp, 'manifest-workspace');
      const r = await run([
        'runtime',
        'install',
        'cursor',
        '--manifest-url',
        `${server.url}runtime-manifest.json`,
        '--config-dir',
        outDir,
        '--json',
      ]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
      expect(parsed).toMatchObject({
        status: 'success',
        runtime: 'cursor',
        mcp_url: 'https://tenant.example.com/mcp',
      });
      const config = JSON.parse(readFileSync(join(outDir, '.cursor', 'mcp.json'), 'utf-8'));
      expect(config.mcpServers.cortex).toEqual({
        url: 'https://tenant.example.com/mcp',
        transport: 'sse',
      });
    } finally {
      server.stop(true);
    }
  });

  test('fails clearly when no hosted profile or MCP URL is available', async () => {
    const r = await run(['runtime', 'install', 'cursor', '--json']);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('missing_mcp_url');
  });
});
