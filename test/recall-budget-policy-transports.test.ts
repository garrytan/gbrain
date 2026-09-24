import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { ERROR_SCHEMA } from '../src/core/verbs.ts';
import { validateAgainstSchema } from '../src/core/verbs/conformance.ts';

let engine: PGLiteEngine;
let home: string;
let env: Record<string, string>;
const cli = resolve('src/cli.ts');
const params = { query: 'zebra telescope', budget_tokens: 75, budget_policy: 'query_first' };

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  home = mkdtempSync(join(tmpdir(), 'gbrain-recall-budget-transport-'));
  const brain = join(home, '.gbrain');
  mkdirSync(brain, { recursive: true });
  const databasePath = join(brain, 'brain.pglite');
  writeFileSync(join(brain, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: databasePath }));
  env = keylessBrainEnv(process.env, home, {
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined,
    GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_MODEL_DISCOVERY: 'off',
  });
  engine = new PGLiteEngine();
  await engine.connect({ database_path: databasePath });
  await engine.initSchema();
  await engine.setConfig('search.track_retrieval', 'false');
  const text = 'The zebra telescope calibration code is QX-17. Store it in the blue case.';
  await engine.putPage('notes/telescope', { type: 'note', title: 'Zebra telescope', compiled_truth: text });
  await installFixtureChunks(engine, 'notes/telescope', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text }]);
  for (let i = 0; i < 4; i++) {
    await engine.insertFact({
      fact: `Garden observation ${i}: `.padEnd(144, 'x'), source: 'synthetic', visibility: 'world',
      entity_slug: 'topics/garden', source_session: `garden-session-${i}`, valid_from: new Date(`2026-09-01T00:00:0${i}Z`),
    }, { source_id: 'default' });
  }
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('peer','peer'),('archived-example','archived-example')");
  await engine.executeRaw("UPDATE sources SET config=jsonb_build_object('federated',false) WHERE id='peer'");
  await engine.executeRaw("UPDATE sources SET archived=true, archived_at=now() WHERE id='archived-example'");
  await engine.putPage('notes/telescope', { type: 'note', title: 'Zebra telescope', compiled_truth: 'Peer telescope evidence.' }, { sourceId: 'peer' });
  await installFixtureChunks(engine, 'notes/telescope', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Peer telescope evidence.' }], { sourceId: 'peer' });
  await engine.insertFact({ fact: 'Peer source fact.', source: 'synthetic', visibility: 'world' }, { source_id: 'peer' });
  await engine.disconnect();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (home) rmSync(home, { recursive: true, force: true });
  resetGateway();
});

function call(args: string[], overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--no-env-file', cli, ...args], {
    cwd: home, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 60_000,
  });
}

describe('recall policy through actual CLI and stdio MCP', () => {
  test.each(['ghost-example', 'archived-example'])('local policy refuses an unavailable concrete source: %s', source => {
    const result = call(['recall', '--budget-policy', 'query_first', '--source', source, '--json']);
    expect(result.status).not.toBe(0);
    const error = JSON.parse(result.stdout);
    expect(error).toMatchObject({ error: 'not_found', detail: 'unknown_source', protocol_version: 1 });
    expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
  });

  test('local policy refuses an unknown ambient source instead of falling back to default', () => {
    const result = call(['recall', '--budget-policy', 'query_first', '--json'], { GBRAIN_SOURCE: 'ghost-example' });
    expect(result.status).not.toBe(0);
    const error = JSON.parse(result.stdout);
    expect(error).toMatchObject({ error: 'not_found', detail: 'unknown_source', protocol_version: 1 });
    expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
  });

  test.each(['__all__', 'Bad Source'])('local policy renders invalid explicit and ambient selector %s as v1 JSON', source => {
    for (const result of [
      call(['recall', '--budget-policy', 'query_first', '--source', source, '--json']),
      call(['recall', '--budget-policy', 'query_first', '--json'], { GBRAIN_SOURCE: source }),
    ]) {
      expect(result.status).not.toBe(0);
      const error = JSON.parse(result.stdout);
      expect(error).toMatchObject({ error: 'invalid_params', protocol_version: 1 });
      expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
      expect(result.stdout).not.toContain('Garden observation');
    }
  });

  test('local fallback source failures are v1 JSON while omitted-policy fallback stays unchanged', async () => {
    const database_path = join(home, '.gbrain', 'brain.pglite');
    await engine.connect({ database_path });
    await engine.setConfig('sources.default', 'archived-example');
    await engine.disconnect();
    try {
      const result = call(['recall', '--budget-policy', 'query_first', '--json']);
      expect(result.status).not.toBe(0);
      const error = JSON.parse(result.stdout);
      expect(error).toMatchObject({ error: 'not_found', detail: 'unknown_source', protocol_version: 1 });
      expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
      const legacy = call(['recall', '--query', 'zebra telescope', '--json']);
      expect(legacy.status).toBe(0);
      expect(JSON.parse(legacy.stdout).facts).toHaveLength(4);
      expect(legacy.stderr).toContain('Falling back to literal value');
    } finally {
      await engine.connect({ database_path });
      await engine.setConfig('sources.default', 'default');
      await engine.disconnect();
    }
  });

  test('local policy explicit default overrides an ambient peer for both arms', () => {
    const result = call(['recall', '--query', 'zebra telescope', '--budget-policy', 'query_first', '--source', 'default', '--json'],
      { GBRAIN_SOURCE: 'peer' });
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.facts).toHaveLength(4);
    expect(body.facts.some((row: any) => row.fact === 'Peer source fact.')).toBe(false);
    expect(body.results.map((row: any) => row.chunk)).toEqual(['The zebra telescope calibration code is QX-17. Store it in the blue case.']);
  });

  test('gbrain protocol --json advertises optional recall input and response policy fields', () => {
    const result = call(['protocol', '--json']);
    expect(result.status).toBe(0);
    const document = JSON.parse(result.stdout);
    expect(document.protocol_version).toBe(1);
    expect(document.verbs.recall.input_schema.properties.budget_policy.enum).toEqual(['facts_first', 'query_first']);
    expect(document.verbs.recall.response_schema.required).toEqual(['facts', 'total', 'protocol_version']);
    expect(document.verbs.recall.response_schema.properties.budget_packing.properties.policy.enum).toEqual(['facts_first', 'query_first']);
  });

  test.each([
    ['--budget-policy', 'query_first', '--query', 'zebra telescope', '--budget-tokens', '75'],
    ['--budget-tokens', '75', '--query', 'zebra telescope', '--budget-policy', 'query_first'],
    ['--query', 'zebra telescope', '--budget-policy=query_first', '--budget-tokens', '75'],
  ].map(args => [args]))('named recall forwards policy regardless of option order: %j', args => {
    const result = call(['recall', ...args, '--json']);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.results.map((r: any) => r.slug)).toEqual(['notes/telescope']);
    expect(body.budget_used).toBe(59);
    expect(body.budget_packing).toMatchObject({ policy: 'query_first', applied: true });
  });

  test.each([
    ['--budget-policy', 'query_first', '--budget-tokens', '0.5', '--query', 'zebra telescope'],
    ['--budget-tokens', '0.5', '--query', 'zebra telescope', '--budget-policy', 'query_first'],
  ].map(args => [args]))('named query-first retains a positive sub-one budget until the operation floors it: %j', args => {
    const result = call(['recall', ...args, '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      facts: [], results: [], total: 0, budget_tokens: 0, budget_used: 0, dropped_count: 5,
      budget_packing: { policy: 'query_first', applied: true, reason: 'budget_below_one' },
    });
  });

  test.each(['0.5', '75.9', '5e1', '75junk'])('omitted and explicit facts_first retain legacy budget parsing for %s', budget => {
    const args = ['recall', '--query', 'zebra telescope', '--budget-tokens', budget, '--json'];
    const omitted = call(args);
    const explicit = call([...args, '--budget-policy', 'facts_first']);
    expect(omitted.status).toBe(0);
    expect(explicit.status).toBe(0);
    const legacy = JSON.parse(omitted.stdout);
    const { budget_packing, ...body } = JSON.parse(explicit.stdout);
    expect(body).toEqual(legacy);
    expect(budget_packing.policy).toBe('facts_first');
    expect(legacy.budget_tokens).toBe(parseInt(budget, 10) || undefined);
    expect(legacy).not.toHaveProperty('budget_packing');
  });

  test('no-query opt-in keeps the legacy CLI sub-one normalization and the filtered fact route', () => {
    const result = call(['recall', 'topics/garden', '--budget-tokens', '0.5', '--budget-policy', 'query_first', '--json']);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.facts).toHaveLength(4);
    expect(body).not.toHaveProperty('budget_tokens');
    expect(body).not.toHaveProperty('results');
    expect(body.budget_packing).toMatchObject({ policy: 'facts_first', applied: false, reason: 'no_query' });
  });

  test('opt-in named recall forwards entity, since, session and grep before packing', () => {
    const result = call(['recall', 'topics/garden', '--query', 'zebra telescope', '--budget-tokens', '75',
      '--budget-policy', 'query_first', '--session-id', 'garden-session-1', '--since', '2026-09-01', '--grep', 'observation', '--json']);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.facts).toHaveLength(1);
    expect(body.facts[0].source_session).toBe('garden-session-1');
    expect(body.budget_packing.facts.candidates).toBe(1);
    expect(body.results).toHaveLength(1);
  });

  test.each([
    ['--budget-policy', 'unknown'], ['--budget-policy', 'QUERY_FIRST'], ['--budget-policy', ''],
    ['--budget-policy'], ['--budget-policy', '--json'], ['--budget-policy='],
  ].map(args => [args]))('named recall rejects invalid or missing policy values: %j', args => {
    const result = call(['recall', '--json', ...args]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: 'invalid_params', protocol_version: 1 });
    expect(result.stderr).toContain('invalid_params');
    expect(result.stderr).toContain('facts_first');
    expect(result.stderr).toContain('query_first');
  });

  test.each(['--watch', '--since-last-run', '--rollup', '--as-context'])('policy opt-in refuses unsupported CLI-only %s instead of silently ignoring it', flag => {
    const result = call(['recall', '--budget-policy', 'query_first', flag]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid_params');
    expect(result.stderr).toContain('--budget-policy cannot be combined');
  });

  test('a missing policy value preserves a following JSON flag', () => {
    const result = call(['recall', '--budget-policy', '--json']);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: 'invalid_params', protocol_version: 1 });
  });

  test('gbrain call forwards query_first and preserves the legacy control on the same stored corpus', () => {
    const legacy = call(['call', 'recall', JSON.stringify({ ...params, budget_policy: 'facts_first' })]);
    expect(legacy.status).toBe(0);
    const baseline = JSON.parse(legacy.stdout);
    expect(baseline.results).toEqual([]);
    expect(baseline.budget_used).toBe(72);
    const candidate = call(['call', 'recall', JSON.stringify(params)]);
    expect(candidate.status).toBe(0);
    const result = JSON.parse(candidate.stdout);
    expect(result.results.map((r: any) => r.slug)).toEqual(['notes/telescope']);
    expect(result.budget_packing).toMatchObject({ policy: 'query_first', applied: true, reason: 'packed' });
    expect(result.budget_used).toBe(59);
  });

  test('a fresh stdio process advertises the enum and returns identical packed evidence', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--no-env-file', cli, 'serve', '--surface', 'verbs'],
      cwd: home, env, stderr: 'pipe',
    });
    const client = new Client({ name: 'recall-budget-policy-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const schema: any = tools.find(tool => tool.name === 'recall')!.inputSchema;
      expect(schema.properties.budget_policy.enum).toEqual(['facts_first', 'query_first']);
      const response = await client.callTool({ name: 'recall', arguments: params });
      expect(response.isError).toBeFalsy();
      const content = response.content as Array<{ type: string; text: string }>;
      const result = JSON.parse(content.find(item => item.type === 'text')!.text);
      expect(result.results.map((r: any) => r.slug)).toEqual(['notes/telescope']);
      expect(result.budget_packing).toMatchObject({ policy: 'query_first', applied: true, reason: 'packed' });
      expect(result.budget_used).toBe(59);
      expect(result.dropped_count).toBe(3);
      for (const [source_id, code] of [['ghost-example', 'scope_denied'], ['__all__', 'invalid_params'], ['Bad Source', 'invalid_params']]) {
        const failure = await client.callTool({ name: 'recall', arguments: { source_id, budget_policy: 'query_first' } });
        expect(failure.isError).toBe(true);
        const error = JSON.parse((failure.content as Array<{ text: string }>)[0].text);
        expect(error).toMatchObject({ error: code, protocol_version: 1 });
        expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
        expect(JSON.stringify(error)).not.toContain('Garden observation');
      }
    } finally {
      await client.close();
      await transport.close();
    }
  });
});
