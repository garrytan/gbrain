import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { ERROR_SCHEMA } from '../src/core/verbs.ts';
import { validateAgainstSchema } from '../src/core/verbs/conformance.ts';

const response = { facts: [], results: [], total: 0, protocol_version: 1,
  budget_tokens: 0, budget_used: 0, dropped_count: 0,
  budget_packing: { policy: 'query_first', applied: true, reason: 'budget_below_one',
    facts: { candidates: 0, kept: 0, dropped: 0, used: 0 },
    results: { candidates: 0, kept: 0, dropped: 0, used: 0 } } };

async function thinCall(engine: 'postgres' | 'pglite', args: string[], options: {
  source?: string; dispatch?: (args: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const calls: Array<{ name?: string; arguments?: Record<string, unknown> }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const base = `http://127.0.0.1:${server.port}`;
    if (path === '/.well-known/oauth-authorization-server') return Response.json({ issuer: base, token_endpoint: `${base}/token` });
    if (path === '/token') return Response.json({ access_token: 'fixture', token_type: 'bearer', expires_in: 3600, scope: 'read' });
    if (path !== '/mcp' || request.method !== 'POST') return new Response(null, { status: 405 });
    const body = await request.json() as { id?: number; method: string;
      params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {
      protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
    } });
    if (body.method !== 'tools/call') return new Response(null, { status: 400 });
    calls.push({ name: body.params?.name, arguments: body.params?.arguments });
    return Response.json({ jsonrpc: '2.0', id: body.id,
      result: options.dispatch ? await options.dispatch(body.params?.arguments ?? {})
        : { content: [{ type: 'text', text: JSON.stringify(response) }] } });
  } });
  const home = mkdtempSync(join(tmpdir(), 'gbrain-recall-thin-cli-'));
  const brain = join(home, '.gbrain');
  const databasePath = join(brain, 'brain.pglite');
  mkdirSync(brain);
  writeFileSync(join(brain, 'config.json'), JSON.stringify({ engine, database_path: databasePath, remote_mcp: {
    issuer_url: `http://127.0.0.1:${server.port}`, mcp_url: `http://127.0.0.1:${server.port}/mcp`,
    oauth_client_id: 'fixture', oauth_client_secret: 'fixture',
  } }));
  try {
    const result = await runCli(['recall', ...args], { home, cwd: home, timeoutMs: 20_000, env: {
      GBRAIN_SOURCE: options.source, GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1', GBRAIN_MODEL_DISCOVERY: 'off',
      ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined,
    } });
    return { ...result, calls, localStoreCreated: existsSync(databasePath) };
  } finally {
    await server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

for (const engine of ['postgres', 'pglite'] as const) {
  test(`${engine}-shaped thin CLI forwards opted-in recall before opening a local database`, async () => {
    const policy = engine === 'postgres' ? ['--budget-policy', 'query_first'] : ['--budget-policy=query_first'];
    const result = await thinCall(engine, ['topics/example', '--query', 'zebra telescope', '--budget-tokens', '0.5',
      ...policy, '--session-id', 'session-example', '--since', '2026-09-01', '--grep', 'needle',
      '--supersessions', '--include-expired', '--pending', '--source', 'example', '--json']);
    expect({ code: result.exitCode, stderr: result.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(result.stdout)).toEqual(response);
    expect(result.calls).toEqual([{ name: 'recall', arguments: {
      entity: 'topics/example', query: 'zebra telescope', budget_tokens: 0.5, budget_policy: 'query_first',
      session_id: 'session-example', since: '2026-09-01T00:00:00.000Z', grep: 'needle',
      supersessions: true, include_expired: true, include_pending: true, source_id: 'example', limit: 50,
    } }]);
    expect(result.localStoreCreated).toBe(false);
    expect(result.stdout + result.stderr).not.toContain('Setting up brain schema');
  });
}

test.each([
  ['--budget-policy', '--json'],
  ['--budget-policy=unknown', '--json'],
  ['--budget-policy', 'query_first', '--watch', '10', '--json'],
].map(args => [args]))('thin CLI rejects invalid policy requests before local or remote work: %j', async args => {
  const result = await thinCall('postgres', args);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ error: 'invalid_params' });
  expect(result.calls).toEqual([]);
  expect(result.localStoreCreated).toBe(false);
});

test('a query value spelling the policy flag does not opt a legacy thin call into new routing', async () => {
  const result = await thinCall('postgres', ['--query', '--budget-policy', '--json']);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('database_url is missing');
  expect(result.calls).toEqual([]);
  expect(result.localStoreCreated).toBe(false);
});

test('explicit thin brain selection fails before remote or local work', async () => {
  const result = await thinCall('postgres', ['--budget-policy', 'query_first', '--brain', 'unregistered-example', '--json']);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('--brain is not supported on a thin-client install');
  expect(result.calls).toEqual([]);
  expect(result.localStoreCreated).toBe(false);
});

test.each(['query_first', 'facts_first'])('thin %s JSON preserves a remote read error envelope without a mutation receipt', async policy => {
  const error = { error: 'unavailable', message: 'Synthetic service unavailable', suggestion: 'Retry this read later.',
    detail: 'fixture_read_failure', docs: 'https://example.test/help', protocol_version: 1 };
  const result = await thinCall('postgres', ['--budget-policy', policy, '--json'], {
    dispatch: async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] }),
  });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual(error);
  expect(validateAgainstSchema(JSON.parse(result.stdout), ERROR_SCHEMA)).toEqual([]);
  expect(result.stderr).toContain('Synthetic service unavailable');
  expect(result.calls).toHaveLength(1);
  expect(result.localStoreCreated).toBe(false);
});

test('thin policy renders an unstructured remote failure as a stamped unavailable error', async () => {
  const result = await thinCall('postgres', ['--budget-policy', 'query_first', '--json'], {
    dispatch: async () => ({ isError: true, content: [{ type: 'text', text: 'Synthetic unstructured failure' }] }),
  });
  expect(result.exitCode).toBe(1);
  const error = JSON.parse(result.stdout);
  expect(error).toMatchObject({ error: 'unavailable', protocol_version: 1 });
  expect(error.message).toContain('Synthetic unstructured failure');
  expect(error.suggestion).toBeTruthy();
  expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
  expect(result.localStoreCreated).toBe(false);
});

describe('actual remote source selection', () => {
  let remote: PGLiteEngine;
  beforeAll(async () => {
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    remote = new PGLiteEngine();
    await remote.connect({});
    await remote.initSchema();
  });
  afterAll(async () => {
    await remote.disconnect();
    resetGateway();
  });
  test('thin recall actually narrows both evidence arms on the remote dispatcher', async () => {
    await remote.setConfig('search.track_retrieval', 'false');
    await remote.setConfig('mcp.strict_params', 'reject');
    for (const source of ['default', 'peer', 'denied']) {
      if (source !== 'default') await remote.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
      const text = `Telescope evidence from ${source}.`;
      await remote.putPage('notes/telescope', { type: 'note', title: 'Telescope', compiled_truth: text }, { sourceId: source });
      await installFixtureChunks(remote, 'notes/telescope', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text }], { sourceId: source });
      await remote.insertFact({ fact: text, source: 'synthetic', visibility: 'world' }, { source_id: source });
    }
    await remote.executeRaw("INSERT INTO sources(id,name,archived) VALUES('archived-example','archived-example',true)");
    const dispatch = (args: Record<string, unknown>) => dispatchToolCall(remote, 'recall', args, {
      remote: true, sourceId: 'default', auth: { allowedSources: ['default', 'peer', 'ghost-example', 'archived-example'] }, config: {},
    } as never);
    const cases = [
      { flags: [], ambient: undefined, expected: ['default', 'peer'], wire: undefined },
      { flags: ['--source', 'default'], ambient: 'peer', expected: ['default'], wire: 'default' },
      { flags: ['--source', 'peer'], ambient: undefined, expected: ['peer'], wire: 'peer' },
      { flags: ['--source-id=peer'], ambient: undefined, expected: ['peer'], wire: 'peer' },
      { flags: [], ambient: 'peer', expected: ['peer'], wire: 'peer' },
    ];
    for (const entry of cases) {
      const result = await thinCall('postgres', ['--query', 'telescope', '--budget-policy', 'query_first', '--budget-tokens', '1000', '--json', ...entry.flags], { dispatch, source: entry.ambient });
      expect({ code: result.exitCode, stderr: result.stderr }).toMatchObject({ code: 0 });
      const body = JSON.parse(result.stdout);
      const expected = entry.expected.map(source => `Telescope evidence from ${source}.`).sort();
      expect(body.facts.map((row: any) => row.fact).sort()).toEqual(expected);
      expect(body.results.map((row: any) => row.chunk).sort()).toEqual(expected);
      expect(result.calls[0].arguments?.source_id).toBe(entry.wire);
      expect(result.localStoreCreated).toBe(false);
    }
    const denied = await thinCall('postgres', ['--budget-policy', 'query_first', '--source', 'denied', '--json'], { dispatch });
    expect(denied.exitCode).not.toBe(0);
    expect(JSON.parse(denied.stdout)).toMatchObject({ error: 'scope_denied', detail: 'permission_denied', protocol_version: 1 });
    expect(validateAgainstSchema(JSON.parse(denied.stdout), ERROR_SCHEMA)).toEqual([]);
    expect(denied.stdout + denied.stderr).not.toContain('Telescope evidence from denied.');
    expect(denied.localStoreCreated).toBe(false);
    const allAmbient = await thinCall('postgres', ['--budget-policy', 'query_first', '--json'], { dispatch, source: '__all__' });
    expect(allAmbient.exitCode).not.toBe(0);
    expect(JSON.parse(allAmbient.stdout)).toMatchObject({ error: 'invalid_params', protocol_version: 1 });
    expect(validateAgainstSchema(JSON.parse(allAmbient.stdout), ERROR_SCHEMA)).toEqual([]);
    expect(allAmbient.stdout + allAmbient.stderr).toContain('invalid_params');
    expect(allAmbient.stdout + allAmbient.stderr).not.toContain('Telescope evidence');
    expect(allAmbient.localStoreCreated).toBe(false);
    const allExplicit = await thinCall('postgres', ['--budget-policy', 'query_first', '--source', '__all__', '--json'], { dispatch });
    expect(allExplicit.exitCode).not.toBe(0);
    expect(JSON.parse(allExplicit.stdout)).toMatchObject({ error: 'invalid_params', protocol_version: 1 });
    expect(validateAgainstSchema(JSON.parse(allExplicit.stdout), ERROR_SCHEMA)).toEqual([]);
    expect(allExplicit.calls).toEqual([]);
    expect(allExplicit.localStoreCreated).toBe(false);
    for (const source of ['ghost-example', 'archived-example']) {
      const missing = await thinCall('postgres', ['--budget-policy', 'query_first', '--source', source, '--json'], { dispatch });
      expect(missing.exitCode).not.toBe(0);
      const error = JSON.parse(missing.stdout);
      expect(error).toMatchObject({ error: 'not_found', detail: 'unknown_source', protocol_version: 1 });
      expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
      expect(missing.stdout + missing.stderr).not.toContain('Telescope evidence');
      expect(missing.localStoreCreated).toBe(false);
    }
    for (const source of ['Bad Source', '__all__']) {
      const invalid = await thinCall('postgres', ['--budget-policy', 'query_first', '--json'], { dispatch, source });
      expect(invalid.exitCode).not.toBe(0);
      const error = JSON.parse(invalid.stdout);
      expect(error).toMatchObject({ error: 'invalid_params', protocol_version: 1 });
      expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
      expect(invalid.calls).toEqual([]);
      expect(invalid.localStoreCreated).toBe(false);
    }
  }, 90_000);
});
