import { describe, expect, test as bunTest } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';

const d = hasDatabase() ? describe : describe.skip;
let engine: PostgresEngine;
let root: string;
let registration: LocalRegistration;
const config = { engine: 'postgres' as const, embedding_disabled: true };
const slug = 'notes/persistence-example';
const content = (body: string) => `---\ntitle: Example\ntype: note\n---\n\n${body}`;

// Each case owns a new database. Permanent receipt IDs and ownership records are
// never truncated, and the explicitly supplied test URL is only the admin route.
function test(name: string, run: () => Promise<void>) {
  bunTest(name, async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-put-pg-'));
    // Pin the fresh schema before initialization; embedding cases seed 1536-d vectors.
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine;
    config.embedding_disabled = true;
    root = join(fixtureDir, 'brain'); mkdirSync(root);
    resetGateway(); _resetWriteThroughCacheForTest();
    try {
      await withEnv({ GBRAIN_HOME: join(fixtureDir, 'home') }, async () => {
        await engine.setConfig('sync.repo_path', root);
        await claimWorktree(engine, 'default', root);
        registration = await registerLocalWriter(engine, 'stdio', {
          sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'],
        });
        try { await run(); } finally { await disposePersistenceConsumer(engine); }
      });
    } finally {
      __setEmbedTransportForTests(null); resetGateway(); _resetWriteThroughCacheForTest();
      await pg.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 30_000);
}

async function dispatch(name: string, params: Record<string, unknown>) {
  const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, name, params, {
    remote: true, config, sourceId: 'default',
    auth: { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] },
    logger: { info() {}, warn() {}, error() {} },
  }));
  return { response, payload: JSON.parse((response.content[0] as { text: string }).text), params };
}
async function put(body: string, pageSlug = slug) {
  const current = await engine.readPageSnapshot(pageSlug, { sourceId: 'default', includeDeleted: true });
  return dispatch('put_page', { slug: pageSlug, content: content(body), request_id: randomUUID(),
    ...(current ? { expected_revision: current.revision } : {}) });
}
async function snapshot() {
  return engine.transaction(async tx => ({
    snapshot: await tx.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }),
    chunks: await tx.getChunks(slug, { sourceId: 'default' }),
    versions: await tx.executeRaw('SELECT * FROM page_versions ORDER BY id'),
  }));
}
async function embedding(result: Awaited<ReturnType<typeof put>>, expectedReason: string) {
  const deadline = Date.now() + 10_000;
  let receipt: Awaited<ReturnType<typeof dispatch>> | undefined;
  while (Date.now() < deadline) {
    receipt = await dispatch('get_write_request', { request_id: result.params.request_id });
    expect(receipt.response.isError).not.toBe(true);
    if (receipt.payload.effects?.some((effect: { kind: string; reason?: string }) =>
      effect.kind === 'embedding' && effect.reason === expectedReason)) return receipt;
    await Bun.sleep(25);
  }
  throw new Error(`Embedding effect did not settle: ${JSON.stringify(receipt?.payload.effects)}`);
}

d('Postgres put_page persistence', () => {
  test('native lock contention preserves the prior revision and returns a durable same-ID receipt', async () => {
    const first = await put('Original canonical revision.');
    expect(first.payload.state).toBe('committed');
    await disposePersistenceConsumer(engine);
    const before = await snapshot();
    const disk = readFileSync(join(root, `${slug}.md`), 'utf8');
    const binding = await getWorktreeBinding(engine, 'default');
    expect(binding).not.toBeNull();
    const holder = await acquireWorktree(binding!, 5000);
    expect(holder).not.toBeNull();
    let accepted: Awaited<ReturnType<typeof put>>;
    try {
      accepted = await put('Queued replacement revision.');
      expect(await snapshot()).toEqual(before);
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe(disk);
      expect(accepted.response.isError).toBe(true);
      expect(accepted.payload.error).toBe('write_pending');
      expect(accepted.payload.write_request.request_id).toBe(accepted.params.request_id);
      expect(['queued', 'running']).toContain(accepted.payload.write_request.state);
    } finally {
      await holder!.release();
    }
    const committed = await dispatch('put_page', accepted!.params);
    expect(committed.response.isError).not.toBe(true);
    expect(committed.payload.state).toBe('committed');
    expect(committed.payload.request_id).toBe(accepted!.params.request_id);
    expect(committed.payload.revision).not.toBe(first.payload.revision);
    expect((await dispatch('put_page', accepted!.params)).payload.revision).toBe(committed.payload.revision);
    expect((await snapshot()).versions).toHaveLength(1);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Queued replacement revision.');
  });

  test('file rename failure rolls back page, tags, chunks, and version in the real transaction', async () => {
    expect((await put('Before failed rename.')).payload.state).toBe('committed');
    const before = await snapshot();
    const file = join(root, `${slug}.md`);
    const bytes = readFileSync(file, 'utf8');
    renameSync(file, `${file}.original`);
    mkdirSync(file);
    const failed = await put('Rejected replacement.');
    expect(failed.response.isError).toBe(true);
    expect(failed.payload.error).toBe('storage_error');
    expect(failed.payload.write_request.state).toBe('failed');
    expect(JSON.stringify(failed.response)).not.toContain(root);
    expect(await snapshot()).toEqual(before);
    expect(readFileSync(`${file}.original`, 'utf8')).toBe(bytes);
  });

  test('pgvector failure is reported after the canonical write without rolling back its receipt', async () => {
    config.embedding_disabled = false;
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    await engine.executeRaw('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(2)');
    __setEmbedTransportForTests(async ({ values }) => {
      expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth).toBe('Persists before vector validation.');
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Persists before vector validation.');
      return { values, warnings: [], embeddings: values.map(() => Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const result = await put('Persists before vector validation.');
    expect(result.response.isError).not.toBe(true);
    expect(result.payload.status).toBe('created_or_updated');
    expect(result.payload.write_through.written).toBe(true);
    const observed = await embedding(result, 'effect_unavailable');
    expect(observed.payload.state).toBe('committed');
    expect(observed.payload.revision).toBe(result.payload.revision);
    expect(observed.payload.effects).toContainEqual({ kind: 'embedding', state: 'queued', reason: 'effect_unavailable' });
    expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
    expect((await dispatch('put_page', result.params)).payload.revision).toBe(result.payload.revision);
  });

  test('provider dimension mismatch fails its effect once without changing the committed canonical receipt', async () => {
    config.embedding_disabled = false;
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    let calls = 0;
    __setEmbedTransportForTests(async ({ values }) => {
      calls++;
      return { values, warnings: [], embeddings: values.map(() => [0.1, 0.2]), usage: { tokens: 1 } };
    });
    const result = await put('Canonical content survives an invalid provider dimension.');
    expect(result.response.isError).not.toBe(true);
    expect(result.payload.write_through.written).toBe(true);
    const observed = await embedding(result, 'embedding_configuration');
    expect(observed.payload.state).toBe('committed');
    expect(observed.payload.revision).toBe(result.payload.revision);
    expect(observed.payload.effects).toContainEqual({ kind: 'embedding', state: 'failed', reason: 'embedding_configuration' });
    expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
    await disposePersistenceConsumer(engine);
    await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 20 });
    expect(calls).toBe(1);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Canonical content survives an invalid provider dimension.');
    expect((await dispatch('put_page', result.params)).payload.revision).toBe(result.payload.revision);
    expect(calls).toBe(1);
  });

  test('slow embedding releases the worktree before other writes and rejects superseded vectors', async () => {
    config.embedding_disabled = false;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      if (values.some(value => value.includes('Older pending revision.'))) {
        started.resolve();
        await release.promise;
      }
      return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const pending = put('Older pending revision.');
    await started.promise;
    try {
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Older pending revision.');
      expect((await put('Independent saved page.', 'notes/independent')).payload.state).toBe('committed');
      expect((await put('Replacement saved revision.')).payload.state).toBe('committed');
    } finally {
      release.resolve();
      await pending;
    }
    const original = await pending;
    const observed = await embedding(original, 'revision_changed');
    expect(observed.payload.state).toBe('committed');
    expect(observed.payload.revision).toBe(original.payload.revision);
    expect(observed.payload.effects).toContainEqual({ kind: 'embedding', state: 'committed', reason: 'revision_changed' });
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth).toBe('Replacement saved revision.');
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Replacement saved revision.');
    expect((await engine.getChunks(slug, { sourceId: 'default' })).map(chunk => chunk.chunk_text)).toEqual(['Replacement saved revision.']);
    expect((await dispatch('put_page', original.params)).payload.revision).toBe(original.payload.revision);
  });
});
