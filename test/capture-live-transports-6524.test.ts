/**
 * #6524: `gbrain capture` was dead on every brain with a running `gbrain
 * serve` and on every thin client. Both transports reach the capture op
 * through `dispatchToolCall`, whose unknown-parameter check (#5970) rejects a
 * write carrying any undeclared key, and the CLI has sent its provenance trio
 * (`source_kind`, `source_uri`, `ingested_via`; #5622) since before that
 * check existed. The direct-handler path (no serve, or Postgres) bypassed
 * dispatch, which is why the breakage never reproduced locally.
 *
 * Both probes drive the real CLI subprocess:
 *   - resident owner: a stdio `gbrain serve` holds the PGLite brain and the
 *     CLI's capture is delegated to it over IPC; the stored row keeps the
 *     trusted local provenance (`capture-cli` / `cli-positional`);
 *   - thin client: a `gbrain serve --http` subprocess plus a thin-client
 *     home whose CLI reaches it through `callRemoteTool`; the capture is
 *     admitted and the owner stamps `mcp:capture` (remote provenance is
 *     server-owned).
 * On the #5970..#6524 range both exit 1 with "3 unknown parameters".
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const baseEnv = { GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_UPDATE_CHECK: '0', GBRAIN_SWEEP: '0', GBRAIN_NON_INTERACTIVE: '1',
  GBRAIN_NO_BANNER: '1', NO_COLOR: '1', NODE_ENV: 'test', GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: undefined };

let home: string;

const gbrain = (cwd: string, args: string[]) => runCli(args, { home: cwd, cwd, env: baseEnv, timeoutMs: 90_000 });
const ok = (result: CliResult) => {
  expect({ exit: result.exitCode, failure: result.exitCode ? result.stdout + result.stderr : '' }).toEqual({ exit: 0, failure: '' });
  return JSON.parse(result.stdout) as Record<string, any>;
};
const provenance = (page: Record<string, any>) => ({ source_kind: page.source_kind, source_uri: page.source_uri, ingested_via: page.ingested_via });

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-capture-6524-'));
  ok(await gbrain(home, ['init', '--pglite', '--no-embedding', '--non-interactive', '--json']));
}, 120_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test('a capture delegated to a running stdio serve (resident PGLite owner) commits with the trusted CLI provenance', async () => {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_UPDATE_CHECK: '0', GBRAIN_SWEEP: '0', NODE_ENV: 'test' };
  const client = new Client({ name: 'capture-6524-owner', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-env-file', CLI, 'serve'], cwd: home, env, stderr: 'pipe' });
  try {
    await client.connect(transport, { signal: AbortSignal.timeout(30_000) });
    const captured = ok(await gbrain(home, ['capture', 'Captured through the resident owner.', '--slug', 'inbox/owner-example-6524', '--json']));
    expect(captured).toMatchObject({ slug: 'inbox/owner-example-6524' });
    const page = ok(await gbrain(home, ['get', 'inbox/owner-example-6524', '--json']));
    expect(provenance(page)).toEqual({ source_kind: 'capture-cli', source_uri: 'cli-positional', ingested_via: 'capture-cli' });
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}, 180_000);

test('a thin-client capture against a running `gbrain serve --http` commits with the server-stamped provenance', async () => {
  const reg = await gbrain(home, ['auth', 'register-client', 'capture-6524-thin', '--grant-types', 'client_credentials',
    '--scopes', 'read write', '--token-endpoint-auth-method', 'client_secret_post']);
  const clientId = /Client ID:\s+(\S+)/.exec(reg.stdout)?.[1];
  const clientSecret = /Client Secret:\s+(\S+)/.exec(reg.stdout)?.[1];
  if (!clientId || !clientSecret) throw new Error(`register-client yielded no credentials:\n${reg.stdout}\n${reg.stderr}`);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const serverEnv: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_UPDATE_CHECK: '0', GBRAIN_SWEEP: '0', NODE_ENV: 'test' };
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_REMOTE_CLIENT_SECRET', 'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID']) delete serverEnv[key];
  const server: ChildProcess = spawn(process.execPath, ['--no-env-file', CLI, 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), '--public-url', base],
    { cwd: home, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverErr = '';
  server.stderr?.on('data', (d: Buffer) => { serverErr += d.toString(); });
  const thinHome = mkdtempSync(join(tmpdir(), 'gbrain-capture-6524-thin-'));
  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      try { ready = (await fetch(`${base}/health`)).ok; } catch { /* not up yet */ }
      if (!ready) await Bun.sleep(500);
    }
    if (!ready) throw new Error(`serve --http did not become ready:\n${serverErr}`);
    mkdirSync(join(thinHome, '.gbrain'), { recursive: true });
    writeFileSync(join(thinHome, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'postgres', remote_mcp: { issuer_url: base, mcp_url: `${base}/mcp`, oauth_client_id: clientId, oauth_client_secret: clientSecret },
    }));
    const captured = ok(await gbrain(thinHome, ['capture', 'Captured from a thin client.', '--slug', 'inbox/thin-example-6524', '--json']));
    expect(captured).toMatchObject({ slug: 'inbox/thin-example-6524' });
    const page = ok(await gbrain(home, ['get', 'inbox/thin-example-6524', '--json']));
    expect(provenance(page)).toEqual({ source_kind: 'mcp:capture', source_uri: null, ingested_via: 'mcp:capture' });
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(null); else server.once('exit', resolve); });
    rmSync(thinHome, { recursive: true, force: true });
  }
}, 180_000);
