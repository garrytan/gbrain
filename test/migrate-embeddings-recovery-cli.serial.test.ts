import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { GLOBAL_MIGRATION_LOCK_ID, MIGRATION_STATE_KEY, runMigrateEmbeddings, parseMigrateEmbeddingsFlags } from '../src/commands/migrate-embeddings.ts';
import { runSchemaTransition } from '../src/core/embedding-migration.ts';
import { migrationCliArgumentError } from '../src/core/embedding-migration-cli.ts';
import { parseGlobalFlags } from '../src/core/cli-options.ts';
import { withEnv } from './helpers/with-env.ts';

const MODEL = 'openai:text-embedding-3-small';
const DOCS = 'https://github.com/garrytan/gbrain/blob/master/docs/guides/embedding-migration.md#recovery';
const SECRET = 'synthetic-credential-never-print';
const PRIVATE_BODY = 'SYNTHETIC_PRIVATE_BODY_NEVER_PRINT';
const cliPath = join(import.meta.dir, '../src/cli.ts');
const gatewayPath = join(import.meta.dir, '../src/core/ai/gateway.ts');
const invalidControls = [
  ['--source', 'default'], ['--source=default'], ['--slugs', 'notes/scope-a'], ['--slugs=notes/scope-a'],
  ['--facts'], ['--facts=true'], ['--timeout', '30s'], ['--timeout=30s'],
  ['--limit', '1'], ['--background'], ['--type', 'note'], ['--include-null-signature'], ['--all'],
  ['--to'], ['--to=example:model'], ['--reranker'], ['--reranker=off'], ['--yes=false'], ['--json=false'],
  ['--dim'], ['--dim=8'], ...['0', '-1', '1.5', '8oops', 'NaN', 'Infinity', '100001', '9007199254740993'].map(v => ['--dim', v]),
  ['--batch-size'], ['--batch-size=2'], ...['0', '-1', '1.5', '2oops', 'NaN', 'Infinity', '10001'].map(v => ['--batch-size', v]),
  ['--max-cost-usd'], ['--max-cost-usd=1'], ...['-1', 'NaN', 'Infinity', '1oops'].map(v => ['--max-cost-usd', v]),
  ['--pace='], ['--pace=typo'], ['--pace', 'gentle'], ['--pace-max-concurrency'], ['--pace-max-concurrency=2oops'],
  ...['0', '-1', '1.5', '2oops', 'Infinity'].map(v => ['--pace-max-concurrency', v]),
  ['--progress-interval=0.5'], ['--progress-interval', '-1'], ['--quiet=true'],
  ['--dim', '8', '--dim', '16'], ['--', '--facts'],
];

test.each(invalidControls.map(args => [args.join(' '), args] as const))('direct migration parser rejects %s', (_label, args) => {
  expect(() => parseMigrateEmbeddingsFlags([...args])).toThrow();
});

test('the shared migration contract preserves supported pacing, globals and exact numeric values', () => {
  expect(parseMigrateEmbeddingsFlags(['--to', MODEL, '--dim', '8', '--batch-size', '1', '--max-cost-usd', '0.25',
    '--non-interactive', '--pace=gentle', '--pace-max-concurrency=2'])).toMatchObject({
    to: MODEL, dim: 8, batchSize: 1, maxCostUsd: 0.25, yes: true,
    pace: { perCallMode: 'gentle', perCall: { maxConcurrency: 2 } },
  });
  expect(parseMigrateEmbeddingsFlags(['--pace', '--pace-max-concurrency', '3']).pace).toEqual({ perCallMode: 'balanced', perCall: { maxConcurrency: 3 } });
  expect(parseMigrateEmbeddingsFlags(['--pace=off']).pace).toEqual({ perCallMode: 'off' });
  expect(parseMigrateEmbeddingsFlags(['--dim', '100000', '--batch-size', '10000', '--max-cost-usd', '0'])).toMatchObject({ dim: 100000, batchSize: 10000, maxCostUsd: 0 });
  for (const route of [['migrate', 'embeddings'], ['retrieval-upgrade']]) {
    const raw = ['--brain=host', '--quiet', ...route, '--progress-json', '--progress-interval=0', '--status', '--json'];
    const parsed = parseGlobalFlags(raw);
    expect(migrationCliArgumentError(parsed.rest[0], parsed.rest.slice(1), raw)).toBeNull();
    for (const timeout of [['--timeout', '30s'], ['--timeout=30s']]) {
      const rawTimeout = [...timeout, ...route, '--status'];
      const stripped = parseGlobalFlags(rawTimeout);
      expect(stripped.cliOpts.timeoutMs).toBe(30000);
      expect(stripped.rest).not.toContain(timeout[0]);
      expect(migrationCliArgumentError(stripped.rest[0], stripped.rest.slice(1), rawTimeout)?.flag).toBe('--timeout');
    }
  }
});

test.each(['apply_failed', 'probe_failed', 'incomplete', 'locked', 'refused', 'retarget_refused'] as const)('real migration CLI supplies private-safe recovery guidance for %s', async status => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-recovery-cli-'));
  const data = join(home, '.gbrain');
  const calls = join(home, 'synthetic-calls.txt');
  const preload = join(home, 'synthetic-provider.ts');
  mkdirSync(data);
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    engine: 'pglite', database_path: join(data, 'brain.pglite'),
    embedding_model: MODEL, embedding_dimensions: 8, openai_api_key: SECRET,
    embedding_disabled: status === 'apply_failed',
  }));
  writeFileSync(preload, `
    import { appendFileSync } from 'node:fs';
    import { __setEmbedTransportForTests } from ${JSON.stringify(gatewayPath)};
    globalThis.fetch = async () => { throw new Error('Synthetic fixture blocks external network'); };
    __setEmbedTransportForTests(async ({values}) => {
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      if (${JSON.stringify(status)} === 'probe_failed') throw new Error(${JSON.stringify(`${SECRET} ${PRIVATE_BODY}`)});
      return { embeddings: values.map(value => Array(8).fill(
        ${JSON.stringify(status)} === 'incomplete' && value !== 'gbrain embedding migration probe' ? NaN : 0.1
      )), usage: { tokens: 8 } };
    });
  `);
  const env: NodeJS.ProcessEnv = { ...process.env, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|TOKEN|SECRET|DATABASE_URL)$/.test(key) || key.startsWith('GBRAIN_') && !['GBRAIN_HOME', 'GBRAIN_SKIP_STARTUP_HOOKS'].includes(key)) delete env[key];
  }
  if (status === 'refused') env.GBRAIN_EMBEDDING_MODEL = 'openai:text-embedding-3-large';
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, '--preload', preload, cliPath, 'migrate', 'embeddings', ...args], {
      cwd: home, env, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  const engine = new PGLiteEngine();
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await engine.connect({ database_path: join(data, 'brain.pglite'), embedding_dimensions: 8 } as never);
      await engine.initSchema();
      await engine.setConfig('embedding_model', MODEL);
      await engine.setConfig('embedding_dimensions', '8');
      await engine.putPage('notes/recovery-fixture', { type: 'note', title: 'Synthetic recovery', compiled_truth: PRIVATE_BODY });
      await engine.upsertChunks('notes/recovery-fixture', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: PRIVATE_BODY }]);
      if (status === 'locked') expect(await tryAcquireDbLock(engine, GLOBAL_MIGRATION_LOCK_ID, 5)).not.toBeNull();
      if (status === 'retarget_refused') await engine.setConfig(MIGRATION_STATE_KEY, JSON.stringify({
        version: 2, to_model: 'openai:text-embedding-3-large', to_dims: 8,
        from_model: MODEL, from_dims: 8, started_at: '2026-09-01T00:00:00.000Z',
      }));
      await engine.disconnect();
    });
    const args = ['--to', MODEL, '--dim', '8', '--yes', '--max-cost-usd', '1', '--reranker', 'off'];
    const preview = await run([...args, '--dry-run', '--json']);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout).status).toBe('planned');
    expect(JSON.parse(preview.stdout).recovery).toBeUndefined();
    expect(preview.stderr).not.toContain('Recovery:');
    const json = await run([...args, '--json']);
    expect({ code: json.code, stderr: json.code !== 1 ? json.stderr : '' }).toEqual({ code: 1, stderr: '' });
    const envelope = JSON.parse(json.stdout);
    expect(envelope.status).toBe(status === 'retarget_refused' ? 'refused' : status);
    expect(envelope.plan).toBeDefined();
    expect(envelope.recovery).toEqual({
      status_command: 'gbrain migrate embeddings --status --json', docs: DOCS,
      partial_state: 'Previously committed progress and authorization debits may remain.',
      action: 'Inspect the selected brain using the same --brain selection before retrying. Do not blindly retry or reset the migration marker.',
      authorization: 'Increasing --max-cost-usd renews authorization for a larger total cap; it does not reset prior debits.',
    });
    if (status === 'refused') expect(envelope.reason).toBe('env_override');
    if (status === 'retarget_refused') expect(envelope.reason).toBe('retarget_required');
    if (status === 'apply_failed') expect(envelope.reason).toContain('Embedding is disabled');
    if (status === 'probe_failed') expect(envelope.message).toContain('Preflight embed');
    if (status === 'incomplete') expect(envelope.remaining).toBeGreaterThan(0);
    const human = await run(args);
    expect(human.code).toBe(1);
    for (const output of [json, human]) {
      for (const value of Object.values(envelope.recovery)) expect(output.stderr).toContain(String(value));
      expect(output.stdout + output.stderr).not.toContain(SECRET);
      expect(output.stdout + output.stderr).not.toContain(PRIVATE_BODY);
    }
    if (['apply_failed', 'locked', 'refused', 'retarget_refused'].includes(status)) expect(existsSync(calls)).toBe(false);
    else expect(readFileSync(calls, 'utf8')).toContain('call');
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(DOCS);
    expect(help.stdout).toContain('gbrain migrate embeddings --status --json');
    expect(help.stderr).not.toContain('Recovery:');
  } finally {
    await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

test('both actual migration CLI routes reject unsupported or malformed controls before connection, planning, or dispatch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-migration-scope-'));
  const data = join(home, '.gbrain');
  const calls = join(home, 'dispatch.txt');
  const preload = join(home, 'provider.ts');
  const database = { database_path: join(data, 'brain.pglite'), embedding_dimensions: 8 };
  const engine = new PGLiteEngine();
  mkdirSync(data);
  const config = JSON.stringify({ engine: 'pglite', ...database, embedding_model: MODEL, openai_api_key: SECRET });
  writeFileSync(join(data, 'config.json'), config);
  writeFileSync(preload, `
    import { appendFileSync } from 'node:fs';
    import { __setEmbedTransportForTests } from ${JSON.stringify(gatewayPath)};
    globalThis.fetch = async () => { throw new Error('Synthetic fixture blocks external network'); };
    __setEmbedTransportForTests(async () => { appendFileSync(${JSON.stringify(calls)}, 'dispatch'); throw new Error('Synthetic provider tripwire'); });
  `);
  const env: NodeJS.ProcessEnv = { ...process.env, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|TOKEN|SECRET|DATABASE_URL)$/.test(key) || key.startsWith('GBRAIN_') && !['GBRAIN_HOME', 'GBRAIN_SKIP_STARTUP_HOOKS'].includes(key)) delete env[key];
  }
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await engine.connect(database as never);
      await engine.initSchema();
      await runSchemaTransition(engine, 8);
      await engine.setConfig('embedding_model', MODEL);
      await engine.setConfig('embedding_dimensions', '8');
      for (const slug of ['notes/scope-a', 'notes/scope-b']) {
        await engine.putPage(slug, { type: 'note', title: 'Synthetic scope fixture', compiled_truth: PRIVATE_BODY });
        await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: PRIVATE_BODY, embedding: new Float32Array(8).fill(0.1) }]);
      }
      const snapshot = async () => Promise.all(['pages', 'content_chunks', 'facts', 'config', 'gbrain_cycle_locks'].map(table =>
        engine.executeRaw(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)));
      const before = await snapshot();
      await engine.disconnect();
      for (const route of [['migrate', 'embeddings'], ['retrieval-upgrade']]) {
        for (const narrowing of invalidControls) {
          const flag = narrowing[0].split('=')[0];
          const controls = [['--to', 'openai:text-embedding-3-large'], ['--dim', '8'], ['--yes'], ['--max-cost-usd', '1']]
            .filter(([name]) => name !== flag).flat();
          const child = Bun.spawn([process.execPath, '--preload', preload, cliPath, ...route,
            ...controls, '--json', ...narrowing], {
            cwd: home, env, stdout: 'pipe', stderr: 'pipe',
          });
          const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
          expect(code).toBe(2); // usage error (agent contract v1 A3); legacy keys kept, v1 envelope added
          expect(JSON.parse(stdout)).toMatchObject({ status: 'error', reason: 'invalid_flag', code: 'unknown_flag' });
          if (['--source', '--slugs'].includes(flag)) expect(stderr).toContain(`unknown flag ${flag}`);
          else expect(stderr).toContain(flag);
          expect(stderr).not.toContain('PGLite');
          expect(existsSync(calls)).toBe(false);
          expect(readFileSync(join(data, 'config.json'), 'utf8')).toBe(config);
          await engine.connect(database as never);
          expect(await snapshot()).toEqual(before);
          await engine.disconnect();
        }
        for (const supported of [
          ['--dry-run', '--pace=gentle', '--pace-max-concurrency=2', '--quiet', '--progress-json', '--progress-interval=0', '--brain=host'],
          ['--dry-run', '--pace', '--pace-max-concurrency', '3', '--quiet'], ['--status'], ['--help'],
        ]) {
          const child = Bun.spawn([process.execPath, '--preload', preload, cliPath, ...route,
            '--to', MODEL, '--dim', '8', '--yes', '--max-cost-usd', '1', '--json', ...supported], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
          const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
          expect({ code, stderr: code !== 0 ? stderr : '' }).toEqual({ code: 0, stderr: '' });
          if (supported.includes('--help')) {
            expect(stdout).toContain('without --no-embed using the same cap; prior debits remain');
            expect(stdout).not.toContain('gbrain embed --stale');
            expect(stdout).toContain(DOCS);
          } else expect(JSON.parse(stdout).status).toBe(supported.includes('--status') ? 'status' : 'planned');
          expect(existsSync(calls)).toBe(false);
          expect(readFileSync(join(data, 'config.json'), 'utf8')).toBe(config);
          await engine.connect(database as never);
          expect(await snapshot()).toEqual(before);
          await engine.disconnect();
        }
      }
      const inaccessible = new Proxy(engine, { get() { throw new Error('Planning touched the engine'); } });
      for (const flag of ['--source', '--source=default', '--slugs', '--slugs=notes/scope-a']) {
        await expect(runMigrateEmbeddings(inaccessible, ['--to', MODEL, '--yes', flag])).rejects.toThrow('brain-wide');
      }
    });
  } finally { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }
}, 180_000);
