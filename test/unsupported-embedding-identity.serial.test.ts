import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  getEmbeddingModel,
  getEmbeddingDimensions,
  embedQuery,
  rerank,
  __setEmbedTransportForTests,
  __setRerankTransportForTests,
} from '../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { rerankerReadiness } from '../src/core/ai/reranker-readiness.ts';
import { resolveEmbeddingColumn } from '../src/core/search/embedding-column.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { readMigrationStatus, planEmbeddingMigration } from '../src/core/embedding-migration.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const STORED_MODEL = 'fixture-unsupported:embedding-v1';
const DIMS = 1024;

afterEach(() => {
  __setEmbedTransportForTests(null);
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('unsupported and unrecorded embedding identities', () => {
  test('a fresh gateway and schema use a supported 1024-dimensional default', async () => {
    configureGateway({ env: {} });
    expect(getEmbeddingModel()).toBe('voyage:voyage-4');
    expect(getEmbeddingDimensions()).toBe(DIMS);
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      expect(await engine.getConfig('embedding_model')).toBe('voyage:voyage-4');
      expect(await engine.getConfig('embedding_dimensions')).toBe(String(DIMS));
    } finally {
      await engine.disconnect();
    }
  });

  test('unknown embedding and reranker providers refuse before any provider transport', async () => {
    configureGateway({
      embedding_model: STORED_MODEL,
      embedding_dimensions: DIMS,
      reranker_model: 'fixture-unsupported:reranker-v1',
      env: { VOYAGE_API_KEY: 'fixture-voyage-key', OPENAI_API_KEY: 'fixture-openai-key' },
    });
    let calls = 0;
    __setEmbedTransportForTests(async () => {
      calls++;
      throw new Error('unexpected embedding transport');
    });
    __setRerankTransportForTests(async () => {
      calls++;
      throw new Error('unexpected reranker transport');
    });
    await expect(embedQuery('fixture query')).rejects.toThrow(/unknown provider/i);
    await expect(rerank({ query: 'fixture query', documents: ['fixture document'] })).rejects.toThrow(/unknown provider/i);
    expect(calls).toBe(0);
  });

  test('mixed-case and slash-form supported reranker ids retain parsing parity', () => {
    for (const model of ['VoYaGe:rerank-2.5', 'voyage/rerank-2.5', ' voyage:rerank-2.5 ']) {
      const readiness = rerankerReadiness(model, { VOYAGE_API_KEY: 'fixture-key' });
      expect(readiness.provider).toBe('voyage');
      expect(readiness.modelId).toBe('rerank-2.5');
      expect(readiness.ready).toBe(true);
    }
    expect(rerankerReadiness('voyage-fixture:rerank-2.5', { VOYAGE_API_KEY: 'fixture-key' }).ready).toBe(false);
  });

  test.each([false, true])('configless same-width brain preserves vectors and read access (missing stored model: %s)', async (missingStoredModel) => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-unverified-identity-'));
    const databasePath = join(home, 'brain');
    mkdirSync(join(home, '.gbrain'));
    const config = { engine: 'pglite' as const, database_path: databasePath };
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
    let engine: PGLiteEngine | undefined;
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => {
        configureGateway({ embedding_model: STORED_MODEL, embedding_dimensions: DIMS, env: {} });
        engine = new PGLiteEngine();
        await engine.connect({ database_path: databasePath });
        await engine.initSchema();
        await engine.putPage('fixture-memory', {
          type: 'note', title: 'Fixture memory', compiled_truth: 'Cobalt keeps a durable fixture memory.',
        });
        await installFixtureChunks(engine, 'fixture-memory', [{
          chunk_index: 0, chunk_text: 'Cobalt keeps a durable fixture memory.', chunk_source: 'compiled_truth',
          model: STORED_MODEL,
        }]);
        const vector = JSON.stringify(Array.from({ length: DIMS }, (_, i) => i === 0 ? 1 : 0));
        await engine.executeRaw('UPDATE content_chunks SET embedding = $1::vector, model = $2', [vector, STORED_MODEL]);
        await engine.executeRaw('UPDATE pages SET embedding_signature = $1', [`${STORED_MODEL}:${DIMS}`]);
        if (missingStoredModel) await engine.unsetConfig('embedding_model');
        const snapshot = await engine.executeRaw('SELECT model, embedding::text AS embedding FROM content_chunks');
        await engine.disconnect();

        configureGateway({ ...buildGatewayConfig(config), env: { VOYAGE_API_KEY: 'fixture-key' } });
        let providerCalls = 0;
        __setEmbedTransportForTests(async () => {
          providerCalls++;
          return { embeddings: [new Array(DIMS).fill(0.1)] } as any;
        });
        __setRerankTransportForTests(async () => {
          providerCalls++;
          return new Response(JSON.stringify({ data: [] }));
        });
        engine = new PGLiteEngine();
        await engine.connect({ database_path: databasePath });
        if (missingStoredModel) {
          await expect(engine.initSchema()).rejects.toThrow(/stored embedding model is unknown/i);
          expect(await engine.executeRaw('SELECT model, embedding::text AS embedding FROM content_chunks')).toEqual(snapshot);
          expect(await engine.getConfig('embedding_model')).toBeNull();
        } else {
          await engine.initSchema();
        }
        expect(() => getEmbeddingModel()).toThrow(/no explicit embedding model/i);
        expect(resolveEmbeddingColumn(undefined, config).embeddingModel).not.toBe('voyage:voyage-4');
        const results = await hybridSearch(engine, 'Cobalt', { limit: 5 });
        expect(results.map(r => r.slug)).toContain('fixture-memory');
        expect((await engine.getPage('fixture-memory'))?.compiled_truth).toContain('Cobalt');
        const status = await readMigrationStatus(engine);
        expect(status.db_plane.model).toBe(missingStoredModel ? null : STORED_MODEL);
        expect(status.column_dims).toBe(DIMS);
        const plan = await planEmbeddingMigration(engine, { to: 'voyage:voyage-4', dim: DIMS });
        expect(plan.from_model).toBe(missingStoredModel ? 'unrecorded' : STORED_MODEL);
        expect(plan.from_dims).toBe(DIMS);
        expect(providerCalls).toBe(0);
        expect(await engine.executeRaw('SELECT model, embedding::text AS embedding FROM content_chunks')).toEqual(snapshot);
        expect(await engine.executeRaw('SELECT embedding_signature FROM pages WHERE slug = $1', ['fixture-memory']))
          .toEqual([{ embedding_signature: `${STORED_MODEL}:${DIMS}` }]);
        expect(await engine.getConfig('embedding_model')).toBe(missingStoredModel ? null : STORED_MODEL);
        await engine.disconnect();
        engine = undefined;
        const networkGuard = join(home, 'network-guard.ts');
        writeFileSync(networkGuard, "globalThis.fetch = (() => { process.stderr.write('UNEXPECTED_PROVIDER_CALL\\n'); throw new Error('network disabled in fixture'); }) as typeof fetch;\n");
        for (const args of [['migrate', 'embeddings', '--status', '--json'], ['get', 'fixture-memory', '--json']]) {
          const child = spawnSync(process.execPath, ['--preload', networkGuard, join(import.meta.dir, '../src/cli.ts'), ...args], {
            env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_NO_AUTO_SYNC: '1' },
            encoding: 'utf8', timeout: 30_000,
          });
          expect(child.error).toBeUndefined();
          expect(child.status, child.stderr).toBe(0);
          expect(child.stderr).not.toContain('UNEXPECTED_PROVIDER_CALL');
          expect(child.stdout).toContain(args[0] === 'get' ? 'Cobalt' : 'column_dims');
        }
      });
    } finally {
      await engine?.disconnect();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);
});

describe.skipIf(!process.env.DATABASE_URL)('PostgreSQL stored embedding identity', () => {
  test.each([false, true])('same-width reconnect preserves vectors and read access (missing stored model: %s)', async (missingStoredModel) => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-postgres-identity-'));
    configureGateway({ embedding_model: STORED_MODEL, embedding_dimensions: DIMS, env: {} });
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const engine = fixture.engine;
    try {
      const rows = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${rows[0].name}`;
      const config = { engine: 'postgres' as const, database_url: url.toString() };
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await engine.putPage('fixture-memory', {
          type: 'note', title: 'Fixture memory', compiled_truth: 'Cobalt keeps a durable fixture memory.',
        });
        await installFixtureChunks(engine, 'fixture-memory', [{
          chunk_index: 0, chunk_text: 'Cobalt keeps a durable fixture memory.', chunk_source: 'compiled_truth',
          model: STORED_MODEL,
        }]);
        const vector = JSON.stringify(Array.from({ length: DIMS }, (_, i) => i === 0 ? 1 : 0));
        await engine.executeRaw('UPDATE content_chunks SET embedding = $1::vector, model = $2', [vector, STORED_MODEL]);
        await engine.executeRaw('UPDATE pages SET embedding_signature = $1', [`${STORED_MODEL}:${DIMS}`]);
        if (missingStoredModel) await engine.unsetConfig('embedding_model');
        const snapshot = await engine.executeRaw('SELECT model, embedding::text AS embedding FROM content_chunks');
        await engine.disconnect();
        configureGateway({ ...buildGatewayConfig(config), env: { VOYAGE_API_KEY: 'fixture-key' } });
        let providerCalls = 0;
        __setEmbedTransportForTests(async () => {
          providerCalls++;
          return { embeddings: [new Array(DIMS).fill(0.1)] } as any;
        });
        __setRerankTransportForTests(async () => {
          providerCalls++;
          return new Response(JSON.stringify({ data: [] }));
        });
        await engine.connect({ database_url: url.toString(), poolSize: 4 });
        if (missingStoredModel) {
          await expect(engine.initSchema()).rejects.toThrow(/stored embedding model is unknown/i);
          expect(await engine.executeRaw('SELECT model, embedding::text AS embedding FROM content_chunks')).toEqual(snapshot);
          expect(await engine.getConfig('embedding_model')).toBeNull();
        } else {
          await engine.initSchema();
        }
        expect(() => getEmbeddingModel()).toThrow(/no explicit embedding model/i);
        expect(resolveEmbeddingColumn(undefined, config).embeddingModel).not.toBe('voyage:voyage-4');
        expect((await hybridSearch(engine, 'Cobalt', { limit: 5 })).map(r => r.slug)).toContain('fixture-memory');
        expect((await engine.getPage('fixture-memory'))?.compiled_truth).toContain('Cobalt');
        const status = await readMigrationStatus(engine);
        expect(status.db_plane.model).toBe(missingStoredModel ? null : STORED_MODEL);
        expect(status.column_dims).toBe(DIMS);
        const plan = await planEmbeddingMigration(engine, { to: 'voyage:voyage-4', dim: DIMS });
        expect(plan.from_model).toBe(missingStoredModel ? 'unrecorded' : STORED_MODEL);
        expect(plan.from_dims).toBe(DIMS);
        expect(providerCalls).toBe(0);
        expect(await engine.executeRaw('SELECT model, embedding::text AS embedding FROM content_chunks')).toEqual(snapshot);
        expect(await engine.executeRaw('SELECT embedding_signature FROM pages WHERE slug = $1', ['fixture-memory']))
          .toEqual([{ embedding_signature: `${STORED_MODEL}:${DIMS}` }]);
        expect(await engine.getConfig('embedding_model')).toBe(missingStoredModel ? null : STORED_MODEL);
      });
    } finally {
      await fixture.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);
});
