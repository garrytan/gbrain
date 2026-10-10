/**
 * `gbrain recall --question` (W1): the value is the question, never an
 * entity (the parser used to skip the unknown flag and take its value as the
 * positional entity). Local in-process with question only and with question
 * plus query; `--question=` form; the human render; the thin-client route
 * sends `question` to the remote recall and notes an older server that
 * answered without `facts_order`. PGLite and a fixture MCP server; no keys.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { recallNeedsLocalEngine, runRecall } from '../src/commands/recall.ts';
import { validateCommandFlags } from '../src/cli/main.ts';
import { runCli } from './helpers/cli-spawn.ts';

let engine: PGLiteEngine;
const origWrite = process.stdout.write.bind(process.stdout);
let captured = '';
const QUESTION = 'Which kayak brand does Alice Example paddle?';

async function recall(args: string[]): Promise<string> {
  captured = '';
  await runRecall(engine, [...args, '--source', 'default']);
  return captured;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.insertFact({ fact: 'Alice Example paddles a Wavecraft kayak', kind: 'fact', entity_slug: 'alice-example', source: 'test', visibility: 'world', valid_from: new Date('2025-01-01T00:00:00Z') }, { source_id: 'default' });
  await engine.insertFact({ fact: 'The team offsite moved to Denver', kind: 'fact', entity_slug: null, source: 'test', visibility: 'world' }, { source_id: 'default' });
});
afterAll(async () => {
  process.stdout.write = origWrite;
  await engine.disconnect();
});
beforeEach(() => {
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
});

describe('gbrain recall --question', () => {
  test('the value is the question, not an entity: facts come back ranked, no page search', async () => {
    const out = JSON.parse(await recall(['--question', QUESTION, '--json']));
    expect(out.facts_order).toBe('relevance');
    expect(out.facts.map((f: { fact: string }) => f.fact)).toEqual(['Alice Example paddles a Wavecraft kayak']);
    expect(typeof out.facts[0].relevance).toBe('number');
    expect(out.results).toBeUndefined();
  });

  test('--question= form and question plus query (facts ranked and pages searched)', async () => {
    const eq = JSON.parse(await recall([`--question=${QUESTION}`, '--json']));
    expect(eq.facts_order).toBe('relevance');
    const both = JSON.parse(await recall(['--question', QUESTION, '--query', QUESTION, '--json']));
    expect(both.facts_order).toBe('relevance');
    expect(Array.isArray(both.results)).toBe(true);
  });

  test('human render names the ranking and each relevance; an unmatched question says so', async () => {
    const human = await recall(['--question', QUESTION]);
    expect(human).toContain('Facts (ranked by relevance to the question):');
    expect(human).toMatch(/Wavecraft kayak — test \(relevance \d\.\d\d\)/);
    expect(await recall(['--question', 'zymurgy quokka xylophone'])).toContain('No saved fact matched the question.');
  });

  test('routing: --question has a thin-client path; --query alone stays in-process; the flag registry accepts it', () => {
    expect(recallNeedsLocalEngine(['--question', QUESTION])).toBe(false);
    expect(recallNeedsLocalEngine(['--question', QUESTION, '--query', QUESTION])).toBe(false);
    expect(recallNeedsLocalEngine(['--query', QUESTION])).toBe(true);
    expect(validateCommandFlags('recall', ['--question', QUESTION, '--json'])).toBeNull();
  });

  test('--question refuses the watch, cursor, rollup and context renders', async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try { await recall(['--question', QUESTION, '--watch', '5']); } finally { console.error = origError; }
    expect(errors.join('\n')).toContain('Error [invalid_params]: --question cannot be combined with --watch');
  });
});

describe('gbrain recall --question on a thin client', () => {
  async function thinCall(args: string[], reply: Record<string, unknown>) {
    const calls: Array<{ name?: string; arguments?: Record<string, unknown> }> = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
      const path = new URL(request.url).pathname;
      const base = `http://127.0.0.1:${server.port}`;
      if (path === '/.well-known/oauth-authorization-server') return Response.json({ issuer: base, token_endpoint: `${base}/token` });
      if (path === '/token') return Response.json({ access_token: 'fixture', token_type: 'bearer', expires_in: 3600, scope: 'read' });
      if (path !== '/mcp' || request.method !== 'POST') return new Response(null, { status: 405 });
      const body = await request.json() as { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {
        protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
      } });
      calls.push({ name: body.params?.name, arguments: body.params?.arguments });
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } });
    } });
    const home = mkdtempSync(join(tmpdir(), 'gbrain-recall-question-thin-'));
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite'), remote_mcp: {
      issuer_url: `http://127.0.0.1:${server.port}`, mcp_url: `http://127.0.0.1:${server.port}/mcp`, oauth_client_id: 'fixture', oauth_client_secret: 'fixture',
    } }));
    try {
      const result = await runCli(['recall', ...args], { home, cwd: home, timeoutMs: 20_000, env: {
        GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1', GBRAIN_MODEL_DISCOVERY: 'off', ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined,
      } });
      return { ...result, calls };
    } finally {
      await server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  }

  test('sends question to the remote recall and renders the ranked facts', async () => {
    const r = await thinCall(['--question', QUESTION], { protocol_version: 1, total: 1, facts_order: 'relevance',
      facts: [{ fact_id: '7', fact: 'Alice Example paddles a Wavecraft kayak', kind: 'fact', entity_slug: 'alice-example', provenance: 'test', relevance: 1.25 }] });
    expect(r.exitCode).toBe(0);
    expect(r.calls.map(c => c.name)).toEqual(['recall']);
    expect(r.calls[0]!.arguments).toMatchObject({ question: QUESTION });
    expect(r.calls[0]!.arguments!.entity).toBeUndefined();
    expect(r.stdout).toContain('(relevance 1.25)');
  }, 30_000);

  test('an older server that answers without facts_order is reported as not ranked', async () => {
    const r = await thinCall(['--question', QUESTION], { protocol_version: 1, total: 1,
      facts: [{ fact_id: '8', fact: 'The team offsite moved to Denver', kind: 'fact', entity_slug: null, provenance: 'test' }] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('did not rank facts by the question');
  }, 30_000);
});
