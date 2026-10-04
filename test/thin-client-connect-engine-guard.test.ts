/**
 * Thin-client installs (remote_mcp set, no database_url) must never fall
 * through to the local engine (#5102). A command that does died with
 * "No database URL ... Fix: Run gbrain init --supabase", and following that
 * hint replaces the remote config; a PGLite-keyed thin client instead opened
 * an empty in-memory brain and answered from it.
 *
 * Covers: every post-connect CLI-only command the table does not refuse
 * either routes or refuses (the connectEngine backstop closes the class for
 * commands added later); the handlers that already carry a thin-client
 * branch reach their MCP op engine-free; the rest refuse with a hint.
 *
 * Nothing leaves the machine: the unreachable rows point at 127.0.0.1:9 and
 * the routed rows at a loopback OAuth + MCP fixture.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_COMMANDS } from '../src/cli/command-table.ts';
import { runCliBatch, type CliResult } from './helpers/cli-spawn.ts';

const ENV = { GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_NO_BANNER: '1', GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: 'host' };
const NO_DATABASE = /No database URL|database_url is missing/;
const SCRATCH_STORE = /Setting up brain schema|migration\(s\) applied/;
const homes: string[] = [];

function thinHome(engine: 'postgres' | 'pglite', base: string): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-thin-guard-'));
  homes.push(home);
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine, remote_mcp: {
    issuer_url: base, mcp_url: `${base}/mcp`, oauth_client_id: 'fixture', oauth_client_secret: 'fixture',
  } }));
  return home;
}

function run(rows: string[][], home: string): Promise<CliResult[]> {
  return runCliBatch(rows, { home, cwd: home, env: ENV, timeoutMs: 30_000 });
}

afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

describe('no post-connect command reaches the local engine on a thin client', () => {
  const rows = CLI_COMMANDS.filter(c => c.phase === 'post-connect' && c.thinClient === 'none').map(c => [c.name]);
  let results: CliResult[];

  beforeAll(async () => {
    results = await run(rows, thinHome('postgres', 'http://127.0.0.1:9'));
  }, 180_000);

  test('the table still has unrefused post-connect commands to check', () => {
    expect(rows.length).toBeGreaterThan(20);
  });

  test('none of them dies asking for a database URL', () => {
    const fellThrough = rows.filter((_, i) => NO_DATABASE.test(results[i]!.stdout + results[i]!.stderr)).map(r => r[0]);
    expect(fellThrough).toEqual([]);
  });
});

describe('self-routing handlers reach their MCP op without opening an engine', () => {
  const calls: string[] = [];
  const replies: Record<string, unknown> = {
    get_recent_salience: [], find_anomalies: [], traverse_graph: [], find_experts: [],
    find_trajectory: { points: [] }, recall: { facts: [], total: 0 },
  };
  let server: ReturnType<typeof Bun.serve>;
  const routed: Array<[string[], string]> = [
    [['salience'], 'get_recent_salience'],
    [['anomalies'], 'find_anomalies'],
    [['graph-query', 'example-page'], 'traverse_graph'],
    [['whoknows', 'example topic'], 'find_experts'],
    [['founder', 'scorecard', 'example-co'], 'find_trajectory'],
    [['recall', '--grep', 'needle', '--json'], 'recall'],
  ];

  beforeAll(() => {
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
      const path = new URL(request.url).pathname;
      const base = `http://127.0.0.1:${server.port}`;
      if (path === '/.well-known/oauth-authorization-server') return Response.json({ issuer: base, token_endpoint: `${base}/token` });
      if (path === '/token') return Response.json({ access_token: 'fixture', token_type: 'bearer', expires_in: 3600, scope: 'read' });
      if (path !== '/mcp' || request.method !== 'POST') return new Response(null, { status: 405 });
      const body = await request.json() as { id?: number; method: string; params?: { protocolVersion?: string; name?: string } };
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {
        protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
      } });
      const name = body.params?.name ?? '';
      calls.push(name);
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(replies[name] ?? {}) }] } });
    } });
  });

  afterAll(async () => { await server.stop(true); });

  for (const engine of ['postgres', 'pglite'] as const) {
    test(`${engine}-keyed thin client: each command calls its op and exits 0`, async () => {
      calls.length = 0;
      const results = await run(routed.map(([argv]) => argv), thinHome(engine, `http://127.0.0.1:${server.port}`));
      results.forEach((r, i) => {
        const output = r.stdout + r.stderr;
        expect({ argv: routed[i]![0], code: r.exitCode, output: NO_DATABASE.test(output) || SCRATCH_STORE.test(output) })
          .toEqual({ argv: routed[i]![0], code: 0, output: false });
      });
      expect([...calls].sort()).toEqual(routed.map(([, op]) => op).sort());
    }, 120_000);
  }
});

describe('commands with no engine-free path refuse with a pinpoint hint', () => {
  const refused: Array<[string[], string]> = [
    [['advisor'], '`advisor` MCP tool'],
    [['export'], 'Run `gbrain export` on the host'],
    [['recall', '--query', 'example'], '--budget-policy facts_first'],
    [['schema', 'stats'], 'schema_stats'],
  ];

  for (const engine of ['postgres', 'pglite'] as const) {
    test(`${engine}-keyed thin client`, async () => {
      const results = await run(refused.map(([argv]) => argv), thinHome(engine, 'http://127.0.0.1:9'));
      results.forEach((r, i) => {
        expect({ argv: refused[i]![0], code: r.exitCode, hinted: r.stderr.includes(refused[i]![1]) })
          .toEqual({ argv: refused[i]![0], code: 1, hinted: true });
        expect(r.stdout + r.stderr).not.toMatch(SCRATCH_STORE);
      });
    }, 120_000);
  }
});
