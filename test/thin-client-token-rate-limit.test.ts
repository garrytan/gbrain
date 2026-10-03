/**
 * A /token 429 is the host's mint budget running out, not a discovery or
 * connectivity fault. The probe, the MCP client and the thin-client CLI must
 * all name it and carry the server's Retry-After (express-rate-limit sends it
 * on every 429), and any other /token failure must not read as "discovery".
 *
 * Loopback OAuth fixture only: no datastore, no keys, no outside network.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callRemoteTool, _clearMcpClientTokenCache } from '../src/core/mcp-client.ts';
import { mintClientCredentialsToken } from '../src/core/remote-mcp-probe.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let server: ReturnType<typeof Bun.serve>;
let base: string;
let tokenResponse: () => Response;
const roots: string[] = [];

/** The 429 the host's /token limiter sends (express-rate-limit, standardHeaders). */
function rateLimited(retryAfter: string | null): () => Response {
  return () => Response.json(
    { error: 'too_many_requests', error_description: 'Rate limit exceeded. Try again later.' },
    { status: 429, headers: {
      'RateLimit-Limit': '50', 'RateLimit-Remaining': '0',
      ...(retryAfter === null ? {} : { 'Retry-After': retryAfter }),
    } },
  );
}

beforeAll(() => {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/.well-known/oauth-authorization-server') return Response.json({ issuer: base, token_endpoint: `${base}/token` });
    if (path === '/token') return tokenResponse();
    return new Response(null, { status: 404 });
  } });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => { await server.stop(true); });

afterEach(() => {
  _clearMcpClientTokenCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(): GBrainConfig {
  return { engine: 'pglite', remote_mcp: {
    issuer_url: base, mcp_url: `${base}/mcp`, oauth_client_id: 'fixture', oauth_client_secret: 'fixture',
  } };
}

describe('mintClientCredentialsToken on a 429', () => {
  test('classifies it as rate_limited with the Retry-After seconds', async () => {
    tokenResponse = rateLimited('900');
    const res = await mintClientCredentialsToken(`${base}/token`, 'fixture', 'fixture');
    expect(res).toMatchObject({ ok: false, reason: 'rate_limited', status: 429, retry_after_s: 900 });
    expect(res.ok ? '' : res.message).toContain('retry in 900s');
  });

  test('reads an HTTP-date Retry-After as seconds from now', async () => {
    tokenResponse = rateLimited(new Date(Date.now() + 120_000).toUTCString());
    const res = await mintClientCredentialsToken(`${base}/token`, 'fixture', 'fixture');
    expect(res).toMatchObject({ ok: false, reason: 'rate_limited' });
    const wait = res.ok ? undefined : res.retry_after_s;
    expect(wait).toBeGreaterThanOrEqual(118);
    expect(wait).toBeLessThanOrEqual(120);
  });

  test('clamps an absurd Retry-After to one day', async () => {
    tokenResponse = rateLimited('31536000');
    expect(await mintClientCredentialsToken(`${base}/token`, 'fixture', 'fixture'))
      .toMatchObject({ ok: false, reason: 'rate_limited', retry_after_s: 86_400 });
  });

  for (const header of [null, 'soon']) {
    test(`stays rate_limited without a usable Retry-After (${header ?? 'absent'})`, async () => {
      tokenResponse = rateLimited(header);
      const res = await mintClientCredentialsToken(`${base}/token`, 'fixture', 'fixture');
      expect(res).toMatchObject({ ok: false, reason: 'rate_limited', status: 429 });
      expect(res.ok ? 'ok' : res.retry_after_s).toBeUndefined();
    });
  }
});

describe('callRemoteTool when /token fails after discovery succeeded', () => {
  test('a 429 surfaces as rate_limited, not discovery', async () => {
    tokenResponse = rateLimited('900');
    await expect(callRemoteTool(config(), 'get_brain_identity')).rejects.toMatchObject({
      reason: 'rate_limited', detail: { status: 429, retry_after_s: 900 },
    });
  });

  test('a 500 surfaces as a /token failure with its status, not discovery', async () => {
    tokenResponse = () => new Response('boom', { status: 500 });
    await expect(callRemoteTool(config(), 'get_brain_identity')).rejects.toMatchObject({
      reason: 'token', detail: { status: 500 },
    });
  });
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-token-429-'));
  roots.push(root);
  mkdirSync(join(root, '.gbrain'));
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify(config()));
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: root, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' };
  for (const name of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_REMOTE_CLIENT_SECRET']) delete env[name];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
    cwd: root, env, stdout: 'pipe', stderr: 'pipe',
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } finally { clearTimeout(watchdog); }
}

describe('thin-client CLI rendering', () => {
  test('a rate-limited mint names the limit, the wait and the host knob', async () => {
    tokenResponse = rateLimited('900');
    const r = await runCli(['search', 'anything']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('OAuth /token is rate-limited by the server (HTTP 429); retry in 900s.');
    expect(r.stderr).toContain('GBRAIN_OAUTH_TOKEN_RATE_LIMIT_MAX');
    expect(r.stderr).not.toContain('OAuth discovery failed');
  }, 30_000);

  test('another /token failure keeps its status instead of blaming discovery', async () => {
    tokenResponse = () => new Response('boom', { status: 503 });
    const r = await runCli(['search', 'anything']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`OAuth /token failed: OAuth /token returned 503 (issuer ${base}).`);
    expect(r.stderr).not.toContain('OAuth discovery failed');
  }, 30_000);
});
