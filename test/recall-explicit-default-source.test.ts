/**
 * #5535 — an explicit `--source default` must select the `default` source.
 *
 * parseFlags defaults flags.source to the literal 'default', so the VALUE
 * alone cannot distinguish "user asked for the default source" from "user
 * passed no source flag". recall's resolver mapped the literal away
 * (`flagValue !== 'default' ? flagValue : null`) and the thin-client wire
 * call omitted `source_id` when it equalled 'default' — so an explicit
 * `--source default` fell through to GBRAIN_SOURCE / sources.default /
 * the server's own default, and facts in `default` became unreachable
 * ("No matching facts." that reads as missing data).
 *
 * Two halves, both against the REAL CLI (helpers/cli-spawn.ts):
 *   - local engine: the per-source `--since-last-run` cursor file names the
 *     source that was actually queried (~/.gbrain/recall-cursors/<id>.json).
 *   - thin client: a fixture MCP server records the forwarded tool call.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const ENV = {
  GBRAIN_NO_BANNER: '1',
  GBRAIN_MODEL_DISCOVERY: 'off',
  GBRAIN_SKIP_STARTUP_HOOKS: '1',
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  VOYAGE_API_KEY: undefined,
} as const;

function cursorDir(home: string): string {
  return join(home, '.gbrain', 'recall-cursors');
}

describe('#5535 explicit --source default (local engine)', () => {
  let home: string;

  beforeAll(async () => {
    // A throwaway PGLite brain created in-process (config-set-unknown-flag's
    // pattern) — `gbrain init` would also run the shared-skills/managed
    // marker writes, which this test does not exercise.
    home = mkdtempSync(join(tmpdir(), 'gbrain-recall-5535-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const dbPath = join(home, '.gbrain', 'brain.pglite');
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: dbPath, embedding_dimensions: 1536 }) + '\n',
    );
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    await engine.initSchema();
    await engine.disconnect();
    // A second REGISTERED source the env tier can resolve to.
    mkdirSync(join(home, 'otherrepo'), { recursive: true });
    const add = await runCli(['sources', 'add', 'other', '--path', join(home, 'otherrepo'), '--force'], {
      home, cwd: home, timeoutMs: 60_000, env: ENV,
    });
    expect(add.exitCode).toBe(0);
  }, 240_000);

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('the explicit flag beats GBRAIN_SOURCE; omitting it keeps the env tier', async () => {
    // 1. Unscoped: GBRAIN_SOURCE still wins (unchanged pre-fix behavior).
    const unscoped = await runCli(['recall', 'topics/example', '--since-last-run'], {
      home, cwd: home, timeoutMs: 60_000, env: { ...ENV, GBRAIN_SOURCE: 'other' },
    });
    expect(unscoped.exitCode).toBe(0);
    expect(existsSync(join(cursorDir(home), 'other.json'))).toBe(true);
    rmSync(cursorDir(home), { recursive: true, force: true });

    // 2. Explicit --source default: the literal id wins over the env tier.
    // Pre-fix this queried `other` (cursor other.json) — the #5535 bug.
    const explicit = await runCli(['recall', 'topics/example', '--since-last-run', '--source', 'default'], {
      home, cwd: home, timeoutMs: 60_000, env: { ...ENV, GBRAIN_SOURCE: 'other' },
    });
    expect(explicit.exitCode).toBe(0);
    expect(explicit.stderr).not.toContain('source not registered');
    expect(existsSync(join(cursorDir(home), 'default.json'))).toBe(true);
    expect(existsSync(join(cursorDir(home), 'other.json'))).toBe(false);
    rmSync(cursorDir(home), { recursive: true, force: true });

    // 3. Explicit --source-id default (the sibling spelling) behaves the same.
    const byId = await runCli(['recall', 'topics/example', '--since-last-run', '--source-id', 'default'], {
      home, cwd: home, timeoutMs: 60_000, env: { ...ENV, GBRAIN_SOURCE: 'other' },
    });
    expect(byId.exitCode).toBe(0);
    expect(existsSync(join(cursorDir(home), 'default.json'))).toBe(true);
  }, 180_000);
});

describe('#5535 explicit --source default (thin client wire call)', () => {
  test('an explicit default is forwarded as source_id; the env fallback still applies when omitted', async () => {
    const calls: Array<{ name?: string; arguments?: Record<string, unknown> }> = [];
    const response = {
      facts: [], results: [], total: 0, pending_consolidation_count: 0,
    };
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
        const path = new URL(request.url).pathname;
        const base = `http://127.0.0.1:${server.port}`;
        if (path === '/.well-known/oauth-authorization-server') {
          return Response.json({ issuer: base, token_endpoint: `${base}/token` });
        }
        if (path === '/token') {
          return Response.json({ access_token: 'fixture', token_type: 'bearer', expires_in: 3600, scope: 'read' });
        }
        if (path !== '/mcp' || request.method !== 'POST') return new Response(null, { status: 405 });
        const body = await request.json() as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
        if (body.id === undefined) return new Response(null, { status: 202 });
        if (body.method === 'initialize') {
          return Response.json({ jsonrpc: '2.0', id: body.id, result: {
            protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
          } });
        }
        if (body.method !== 'tools/call') return new Response(null, { status: 400 });
        calls.push({ name: body.params?.name, arguments: body.params?.arguments });
        return Response.json({ jsonrpc: '2.0', id: body.id,
          result: { content: [{ type: 'text', text: JSON.stringify(response) }] } });
      },
    });

    const home = mkdtempSync(join(tmpdir(), 'gbrain-recall-5535-thin-'));
    const brain = join(home, '.gbrain');
    mkdirSync(brain);
    // pglite-shaped thin client (the recall-budget-policy-thin-cli pattern):
    // a valid local database_path satisfies connectEngine, while remote_mcp
    // keeps isThinClient() true so the recall path forwards over the wire.
    // A postgres-shaped config without database_url dies in connectEngine
    // before the thin-client branch — plain recall (no --budget-policy) has
    // no engine bypass.
    const databasePath = join(brain, 'brain.pglite');
    writeFileSync(join(brain, 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: databasePath,
      remote_mcp: {
        issuer_url: `http://127.0.0.1:${server.port}`, mcp_url: `http://127.0.0.1:${server.port}/mcp`,
        oauth_client_id: 'fixture', oauth_client_secret: 'fixture',
      },
    }));
    try {
      // Explicit --source default: the wire call MUST carry source_id
      // 'default' even though GBRAIN_SOURCE names another source. Pre-fix
      // the literal was mapped away and the server applied its own default.
      const explicit = await runCli(['recall', 'topics/example', '--source', 'default'], {
        home, cwd: home, timeoutMs: 60_000,
        env: { ...ENV, GBRAIN_SOURCE: 'other', GBRAIN_BRAIN_ID: 'host' },
      });
      expect(explicit.exitCode).toBe(0);
      expect(calls.at(-1)).toMatchObject({ name: 'recall', arguments: { source_id: 'default' } });

      // Omitted flag: the env tier still decides (unchanged behavior).
      const unscoped = await runCli(['recall', 'topics/example'], {
        home, cwd: home, timeoutMs: 60_000,
        env: { ...ENV, GBRAIN_SOURCE: 'other', GBRAIN_BRAIN_ID: 'host' },
      });
      expect(unscoped.exitCode).toBe(0);
      expect(calls.at(-1)).toMatchObject({ name: 'recall', arguments: { source_id: 'other' } });
    } finally {
      await server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
