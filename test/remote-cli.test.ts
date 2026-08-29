/**
 * `gbrain remote` CLI (src/commands/remote.ts) — ping poll loop, --timeout
 * parsing, doctor exit codes, thin-client gate.
 *
 * Seam: runRemote() reads config via loadConfig() (GBRAIN_HOME-routed
 * config.json) and talks to the host through callRemoteTool's REAL HTTP
 * transport. So we run the same in-process HTTP fixture as
 * test/mcp-client.test.ts (OAuth discovery + /token + minimal /mcp JSON-RPC)
 * and point a thin-client config.json at it. No mock.module anywhere →
 * non-serial file.
 *
 * --timeout parsing is pinned BEHAVIORALLY: parseFlags/parseDuration are
 * module-private, but the timeout branch prints `Math.round(timeoutMs/1000)`
 * verbatim. A never-terminal job plus a Date.now offset (bumped by the
 * fixture on the first get_job poll, +4h > every tested budget) drives the
 * loop into that branch after ONE real 1s poll sleep, so the printed seconds
 * reveal the parsed budget without waiting it out. Date.now is stubbed with
 * try/finally restore (same class of global stub as the repo-wide
 * process.exit pattern; bun runs tests in a file sequentially).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRemote } from '../src/commands/remote.ts';
import { _clearMcpClientTokenCache } from '../src/core/mcp-client.ts';
import { withEnv } from './helpers/with-env.ts';

let server: Server;
let port: number;
let thinHome: string;
let localHome: string;

// ─── Per-test fixture control ───
/** tools/call dispatcher: returns the JSON-RPC `result` for a named tool. */
let toolHandler: (name: string, args: Record<string, unknown>) => unknown;
let toolCalls: Record<string, number>;
/** Added to Date.now() while a test's stub is active (see stubDateNow). */
let dateOffsetMs = 0;

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ token_endpoint: `http://127.0.0.1:${port}/token`, issuer: `http://127.0.0.1:${port}` }));
      return;
    }
    if (req.url === '/token') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        access_token: `token-${Math.random().toString(36).slice(2)}`,
        token_type: 'bearer',
        expires_in: 3600,
        scope: 'read write admin',
      }));
      return;
    }
    if (req.url === '/mcp' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      if (body.id === undefined) { // notification (initialized)
        res.statusCode = 202;
        res.end();
        return;
      }
      let result: unknown;
      if (body.method === 'initialize') {
        result = {
          protocolVersion: body.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'remote-cli-test-fixture', version: '1' },
        };
      } else if (body.method === 'tools/call') {
        const name = body.params?.name as string;
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        result = toolHandler(name, (body.params?.arguments ?? {}) as Record<string, unknown>);
      } else {
        result = {};
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind fixture');
  port = addr.port;

  // Thin-client home: config.json with remote_mcp pointed at the fixture.
  thinHome = mkdtempSync(join(tmpdir(), 'remote-cli-thin-'));
  const thinDir = join(thinHome, '.gbrain');
  mkdirSync(thinDir, { recursive: true });
  writeFileSync(join(thinDir, 'config.json'), JSON.stringify({
    remote_mcp: {
      issuer_url: `http://127.0.0.1:${port}`,
      mcp_url: `http://127.0.0.1:${port}/mcp`,
      oauth_client_id: 'cid',
      oauth_client_secret: 'csecret',
    },
  }) + '\n');

  // Local (NON-thin-client) home: a plain PGLite config, no remote_mcp.
  localHome = mkdtempSync(join(tmpdir(), 'remote-cli-local-'));
  const localDir = join(localHome, '.gbrain');
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(localDir, 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: join(localDir, 'brain.pglite'),
  }) + '\n');
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(thinHome, { recursive: true, force: true });
  rmSync(localHome, { recursive: true, force: true });
});

beforeEach(() => {
  _clearMcpClientTokenCache();
  toolCalls = {};
  dateOffsetMs = 0;
  toolHandler = () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] });
});

function textResult(payload: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

/** Drive runRemote with captured console + throwing process.exit stub. */
async function runRemoteCli(args: string[], home: string = thinHome): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  (process.exit as unknown) = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__EXIT__');
  }) as never;
  try {
    await withEnv(
      {
        GBRAIN_HOME: home,
        DATABASE_URL: undefined,
        GBRAIN_DATABASE_URL: undefined,
        GBRAIN_REMOTE_CLIENT_SECRET: undefined,
      },
      () => runRemote(args),
    );
  } catch (e) {
    if (!(e instanceof Error) || e.message !== '__EXIT__') throw e;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

/** Run fn with Date.now offset by the test-controlled dateOffsetMs. */
async function stubDateNow<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + dateOffsetMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/**
 * Runs `remote ping --json --timeout <arg>` against a never-completing job;
 * the fixture bumps the Date.now offset on the first get_job poll so the
 * NEXT loop-condition check trips the timeout branch. Returns the parsed
 * seconds from "ping timed out after Ns" — i.e. Math.round(timeoutMs/1000).
 */
async function pingParsedTimeoutSeconds(timeoutArg: string): Promise<{ seconds: number; result: RunResult; json: Record<string, unknown> }> {
  toolHandler = (name) => {
    if (name === 'submit_job') return textResult({ id: 7, name: 'autopilot-cycle', status: 'queued' });
    if (name === 'get_job') {
      dateOffsetMs = 4 * 3_600_000; // 4h — past every budget under test
      return textResult({ id: 7, status: 'running' });
    }
    throw new Error(`unexpected tool ${name}`);
  };
  const result = await stubDateNow(() =>
    runRemoteCli(['ping', '--json', '--timeout', timeoutArg]),
  );
  const json = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  const m = String(json.message ?? '').match(/timed out after (\d+)s/);
  if (!m) throw new Error(`no timeout message in: ${result.stdout}`);
  return { seconds: Number(m[1]), result, json };
}

describe('remote ping --timeout parsing (behavioral, via the timeout banner)', () => {
  test('--timeout 90s → 90,000ms budget', async () => {
    const { seconds, result, json } = await pingParsedTimeoutSeconds('90s');
    expect(seconds).toBe(90);
    expect(json.status).toBe('error');
    expect(json.reason).toBe('timeout');
    expect(json.last_state).toBe('running');
    expect(result.exitCode).toBe(1);
    expect(toolCalls.get_job).toBe(1); // loop entered exactly once before the virtual-clock jump
  }, 20_000);

  test('--timeout 5m → 300,000ms budget', async () => {
    const { seconds } = await pingParsedTimeoutSeconds('5m');
    expect(seconds).toBe(300);
  }, 20_000);

  test('--timeout 2h → 7,200,000ms budget', async () => {
    const { seconds } = await pingParsedTimeoutSeconds('2h');
    expect(seconds).toBe(7200);
  }, 20_000);

  test('malformed --timeout abc falls back to the 15m default — never 0/NaN', async () => {
    const { seconds } = await pingParsedTimeoutSeconds('abc');
    // 15 * 60 = 900s: the default survived the bad parse.
    expect(seconds).toBe(900);
    // A 0/NaN budget would fail `Date.now() - startMs < timeoutMs` on entry
    // and never poll at all; one poll proves the loop actually ran.
    expect(toolCalls.get_job).toBe(1);
  }, 20_000);
});

describe('remote ping poll loop', () => {
  test('a poll that throws once then returns completed survives the blip → exit 0', async () => {
    toolHandler = (name) => {
      if (name === 'submit_job') return textResult({ id: 9, name: 'autopilot-cycle', status: 'queued' });
      if (name === 'get_job') {
        if (toolCalls.get_job === 1) {
          // isError tool result → callRemoteTool throws RemoteMcpError; the
          // poll loop must log-and-continue, not die.
          return { isError: true, content: [{ type: 'text', text: 'transient blip' }] };
        }
        return textResult({ id: 9, status: 'completed' });
      }
      throw new Error(`unexpected tool ${name}`);
    };
    const r = await runRemoteCli(['ping']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('poll #1 failed');
    expect(r.stderr).toContain('continuing');
    expect(r.stdout).toContain('autopilot-cycle complete');
    expect(toolCalls.get_job).toBe(2);
  }, 30_000);

  test('job failed → exit 1 with failed_reason surfaced in --json', async () => {
    toolHandler = (name) => {
      if (name === 'submit_job') return textResult({ id: 11, name: 'autopilot-cycle', status: 'queued' });
      if (name === 'get_job') return textResult({ id: 11, status: 'failed', failed_reason: 'sync exploded' });
      throw new Error(`unexpected tool ${name}`);
    };
    const r = await runRemoteCli(['ping', '--json']);
    expect(r.exitCode).toBe(1);
    const json = JSON.parse(r.stdout.trim());
    expect(json.status).toBe('error');
    expect(json.state).toBe('failed');
    expect(json.job_id).toBe(11);
    expect(json.failed_reason).toBe('sync exploded');
  }, 20_000);
});

describe('remote — thin-client gate', () => {
  test('a NON-thin-client config exits 1 with the init --mcp-only hint', async () => {
    const r = await runRemoteCli(['ping'], localHome);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('requires thin-client mode');
    expect(r.stderr).toContain('gbrain init --mcp-only');
    expect(toolCalls.submit_job ?? 0).toBe(0); // never reached the host
  });
});

describe('remote doctor exit codes', () => {
  test('warnings report → exit 0 (JSON passthrough of the host report)', async () => {
    const report = {
      schema_version: 2,
      status: 'warnings',
      health_score: 85,
      checks: [{ name: 'chunk_count', status: 'warn', message: 'low chunk count' }],
    };
    toolHandler = (name) => {
      if (name === 'run_doctor') return textResult(report);
      throw new Error(`unexpected tool ${name}`);
    };
    const r = await runRemoteCli(['doctor', '--json']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.stdout.trim());
    expect(json.status).toBe('warnings');
    expect(json.health_score).toBe(85);
  }, 20_000);

  test('unhealthy report → exit 1, human render lists the failures', async () => {
    toolHandler = (name) => {
      if (name === 'run_doctor') {
        return textResult({
          schema_version: 2,
          status: 'unhealthy',
          health_score: 40,
          checks: [
            { name: 'db_connect', status: 'fail', message: 'cannot reach db' },
            { name: 'embed_coverage', status: 'ok', message: 'fine' },
          ],
        });
      }
      throw new Error(`unexpected tool ${name}`);
    };
    const r = await runRemoteCli(['doctor']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('[FAIL] db_connect');
    expect(r.stdout).toContain('Status: unhealthy');
    expect(r.stdout).toContain('Failures:');
  }, 20_000);
});
