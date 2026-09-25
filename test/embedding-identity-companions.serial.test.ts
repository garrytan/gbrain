import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setEmbedTransportForTests, __setRerankTransportForTests,
  configureGateway, getEmbeddingModel, resetGateway,
} from '../src/core/ai/gateway.ts';
import {
  applyEmbeddingMigration, MIGRATION_STATE_KEY, planEmbeddingMigration,
  readMigrationState, readMigrationStatus,
} from '../src/core/embedding-migration.ts';
import { initPGLite, initPostgresCore } from '../src/commands/init.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const OLD = 'fixture-unsupported:embedding-v1';
const TARGET = 'voyage:voyage-4';
const DIMS = 1024;
const VECTOR = new Float32Array(DIMS).fill(0.125);
const VECTOR_TEXT = JSON.stringify(Array.from(VECTOR));
type Kind = 'pglite' | 'postgres';
type Store = 'facts' | 'query_cache' | 'takes';
let providerCalls = 0;
let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  providerCalls = 0;
  const refuse = async () => { providerCalls++; throw new Error('Unexpected provider/network call'); };
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(refuse, { preconnect: globalThis.fetch.preconnect }));
  __setEmbedTransportForTests(refuse);
  __setRerankTransportForTests(refuse);
});

afterEach(() => {
  fetchSpy.mockRestore();
  __setEmbedTransportForTests(null);
  __setRerankTransportForTests(null);
  resetGateway();
  expect(providerCalls).toBe(0);
});

async function withBrain(kind: Kind, fn: (fixture: {
  engine: BrainEngine;
  file: string;
  reopen: () => Promise<void>;
  resumeInFreshProcess: () => Promise<{ status: string; schema_transitioned: boolean }>;
  reinit: (skipEmbedCheck?: boolean) => Promise<void>;
}) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-companion-identity-'));
  try {
    await withEnv({
      GBRAIN_HOME: home, GBRAIN_PGLITE_SNAPSHOT: undefined,
      GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined,
      VOYAGE_API_KEY: 'fixture-key', GBRAIN_NO_AUTO_SYNC: '1',
    }, async () => {
      configureGateway({ embedding_model: OLD, embedding_dimensions: DIMS, env: {} });
      const pg = kind === 'postgres' ? await isolatedPersistencePostgres(process.env.DATABASE_URL!) : null;
      const engine = pg?.engine ?? new PGLiteEngine();
      let databaseUrl: string | undefined;
      const databasePath = join(home, 'brain');
      if (pg) {
        const rows = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${rows[0].name}`;
        databaseUrl = url.toString();
      } else {
        await engine.connect({ database_path: databasePath });
        await engine.initSchema();
      }
      const connection = pg ? { database_url: databaseUrl!, poolSize: 4 } : { database_path: databasePath };
      const file = join(home, '.gbrain', 'config.json');
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(file, JSON.stringify({ engine: kind, ...connection }));
      try {
        for (const table of ['facts', 'query_cache']) {
          const rows = await engine.executeRaw<{ udt_name: string }>(
            "SELECT udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'embedding'", [table],
          );
          expect(rows).toHaveLength(1);
          expect(['vector', 'halfvec']).toContain(rows[0].udt_name);
          await engine.executeRaw(`ALTER TABLE ${table} ALTER COLUMN embedding TYPE ${rows[0].udt_name}(${DIMS})`);
        }
        await fn({
          engine, file,
          reopen: async () => { await engine.disconnect(); await engine.connect(connection); },
          resumeInFreshProcess: async () => {
            await engine.disconnect();
            try {
              const code = `
                let calls = 0;
                globalThis.fetch = async () => { calls++; throw new Error('UNEXPECTED_NETWORK'); };
                const { createEngine } = await import(${JSON.stringify(new URL('../src/core/engine-factory.ts', import.meta.url).href)});
                const { configureGateway, __setEmbedTransportForTests } = await import(${JSON.stringify(new URL('../src/core/ai/gateway.ts', import.meta.url).href)});
                const { planEmbeddingMigration, applyEmbeddingMigration } = await import(${JSON.stringify(new URL('../src/core/embedding-migration.ts', import.meta.url).href)});
                configureGateway({ embedding_model: ${JSON.stringify(TARGET)}, embedding_dimensions: ${DIMS}, env: {} });
                __setEmbedTransportForTests(async () => { calls++; throw new Error('UNEXPECTED_PROVIDER'); });
                const engine = await createEngine({ engine: ${JSON.stringify(kind)} });
                await engine.connect(${JSON.stringify(connection)});
                try {
                  const plan = await planEmbeddingMigration(engine, { to: ${JSON.stringify(TARGET)}, dim: ${DIMS} });
                  const result = await applyEmbeddingMigration(engine, plan);
                  if (calls !== 0) throw new Error('UNEXPECTED_PROVIDER');
                  console.log(JSON.stringify(result));
                } finally { await engine.disconnect(); }
              `;
              const child = spawnSync(process.execPath, ['--eval', code], {
                env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_NO_AUTO_SYNC: '1' },
                encoding: 'utf8', timeout: 30_000,
              });
              expect(child.error).toBeUndefined();
              expect(child.status, child.stderr).toBe(0);
              expect(child.stderr).not.toContain('UNEXPECTED_');
              return JSON.parse(child.stdout.trim().split('\n').at(-1)!);
            } finally {
              await engine.connect(connection);
            }
          },
          reinit: async (skipEmbedCheck = false) => {
            await engine.disconnect();
            try {
              const opts = {
                jsonOutput: true, apiKey: null, skipEmbedCheck,
                aiOpts: { embedding_model: TARGET, embedding_dimensions: DIMS },
                content: { dbOnly: true },
              };
              if (kind === 'pglite') await initPGLite({ ...opts, customPath: databasePath });
              else await initPostgresCore({ ...opts, databaseUrl: databaseUrl! });
            } finally {
              await engine.connect(connection);
            }
          },
        });
      } finally {
        if (pg) await pg.close();
        else await engine.disconnect();
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function seedStore(engine: BrainEngine, table: Store) {
  if (table === 'facts') {
    await engine.executeRaw(
      "INSERT INTO facts(source_id, entity_slug, fact, source, embedding) VALUES ('default', 'people/example', 'A synthetic durable fact.', 'manual', $1::vector)", [VECTOR_TEXT],
    );
  } else if (table === 'query_cache') {
    await engine.executeRaw(
      "INSERT INTO query_cache(id, query_text, embedding, results) VALUES ('fixture-cache', 'synthetic query', $1::vector, '[{\"slug\":\"fixture-result\"}]'::jsonb)", [VECTOR_TEXT],
    );
  } else {
    await engine.putPage('notes/take-fixture', { type: 'note', title: 'Take fixture', compiled_truth: '' });
    await engine.executeRaw(
      "INSERT INTO takes(page_id, row_num, claim, kind, holder, embedding, embedded_at) SELECT id, 1, 'A synthetic take.', 'take', 'fixture', $1::vector, now() FROM pages WHERE slug = 'notes/take-fixture'", [VECTOR_TEXT],
    );
  }
  const rows = await snapshotStore(engine, table);
  expect(rows).toHaveLength(1);
  expect(rows[0].embedding).toBe(VECTOR_TEXT);
  return rows;
}

async function snapshotStore(engine: BrainEngine, table: Store) {
  return engine.executeRaw<{ id: unknown; embedding: string | null; row: Record<string, unknown> }>(
    `SELECT id, embedding::text AS embedding, to_jsonb(t) - 'embedding' AS row FROM ${table} t ORDER BY id`,
  );
}

async function seedRaw(engine: BrainEngine) {
  await engine.putPage('notes/raw-fixture', { type: 'note', title: 'Raw fixture', compiled_truth: 'A synthetic vector fixture.' });
  const chunk = { chunk_index: 0, chunk_source: 'compiled_truth' as const, chunk_text: 'A synthetic vector fixture.', embedding: VECTOR };
  await engine.upsertChunks('notes/raw-fixture', [{ ...chunk, model: OLD }]);
  return chunk;
}

for (const kind of ['pglite', 'postgres'] as const) {
  describe.skipIf(kind === 'postgres' && !process.env.DATABASE_URL)(`${kind}: companion embedding identity`, () => {
    test.each(['facts', 'query_cache', 'takes'] as const)('reinit refuses a %s-only model change before provider probing or config writes', async (table) => {
      await withBrain(kind, async ({ engine, file, reinit }) => {
        const before = await seedStore(engine, table);
        expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE embedding IS NOT NULL')).toHaveLength(0);
        const configBefore = await engine.executeRaw('SELECT key, value FROM config ORDER BY key');
        const fileBefore = readFileSync(file);
        await expect(reinit()).rejects.toThrow(/re-initialization cannot change their identity/i);
        expect(providerCalls).toBe(0);
        expect(getEmbeddingModel()).toBe(OLD);
        expect(readFileSync(file)).toEqual(fileBefore);
        expect(await engine.executeRaw('SELECT key, value FROM config ORDER BY key')).toEqual(configBefore);
        expect(await snapshotStore(engine, table)).toEqual(before);
        await engine.setConfig('embedding_model', TARGET);
        await reinit(true);
        expect(JSON.parse(readFileSync(file, 'utf8')).embedding_model).toBe(TARGET);
        expect(await snapshotStore(engine, table)).toEqual(before);
      });
    }, 60000);

    test('same-width migration invalidates companions before publication and preserves regenerated vectors after restart', async () => {
      await withBrain(kind, async ({ engine, reopen, resumeInFreshProcess }) => {
        const facts = await seedStore(engine, 'facts');
        const takes = await seedStore(engine, 'takes');
        await seedStore(engine, 'query_cache');
        expect((await engine.findCandidateDuplicates('default', 'people/example', 'Another fact', { embedding: VECTOR })).map(row => String(row.id))).toEqual([String(facts[0].id)]);
        await seedRaw(engine);
        await engine.executeRaw('UPDATE content_chunks SET embedding_image = $1::vector, embedding_multimodal = $1::vector', [VECTOR_TEXT]);
        const independent = await engine.executeRaw('SELECT embedding_image::text AS image, embedding_multimodal::text AS multimodal FROM content_chunks');
        expect(independent).toEqual([{ image: VECTOR_TEXT, multimodal: VECTOR_TEXT }]);
        const plan = await planEmbeddingMigration(engine, { to: TARGET, dim: DIMS });
        expect(plan.from_model).toBe(OLD);
        const result = await applyEmbeddingMigration(engine, plan, {
          persistConfig: async () => {
            expect(await engine.getConfig('embedding_model')).toBe(TARGET);
            expect(await snapshotStore(engine, 'facts')).toEqual(facts.map(row => ({ ...row, embedding: null })));
            expect(await snapshotStore(engine, 'takes'))
              .toEqual(takes.map(row => ({ ...row, embedding: null, row: { ...row.row, embedded_at: null } })));
            expect(await engine.executeRaw('SELECT id FROM query_cache')).toHaveLength(0);
            expect((await readMigrationStatus(engine)).facts_pending).toBe(1);
            expect(await engine.findCandidateDuplicates('default', 'people/example', 'Another fact', { embedding: VECTOR })).toHaveLength(0);
            throw new Error('fixture publication interruption');
          },
        });
        expect(result).toEqual({ status: 'failed', reason: 'fixture publication interruption' });
        expect((await readMigrationState(engine)).state?.companion_vectors_invalidated).toBe(true);
        expect(await engine.executeRaw('SELECT embedding_image::text AS image, embedding_multimodal::text AS multimodal FROM content_chunks')).toEqual(independent);
        await reopen();
        const regenerated = JSON.stringify(new Array(DIMS).fill(0.25));
        await engine.executeRaw('UPDATE facts SET embedding = $1::vector', [regenerated]);
        await engine.executeRaw('UPDATE takes SET embedding = $1::vector, embedded_at = now()', [regenerated]);
        const regeneratedFacts = await snapshotStore(engine, 'facts');
        const regeneratedTakes = await snapshotStore(engine, 'takes');
        const resumed = await resumeInFreshProcess();
        expect(resumed.status).toBe('applied');
        if (resumed.status === 'applied') expect(resumed.schema_transitioned).toBe(false);
        expect(await snapshotStore(engine, 'facts')).toEqual(regeneratedFacts);
        expect(await snapshotStore(engine, 'takes')).toEqual(regeneratedTakes);
        expect((await readMigrationStatus(engine)).facts_pending).toBe(0);
      });
    }, 60000);

    test.each(['config', 'query_cache'] as const)('a real %s failure rolls back companion invalidation and permits a safe restart', async (failureTable) => {
      await withBrain(kind, async ({ engine, reopen }) => {
        const facts = await seedStore(engine, 'facts');
        const cache = await seedStore(engine, 'query_cache');
        const takes = await seedStore(engine, 'takes');
        await engine.executeRaw(`CREATE FUNCTION fixture_reject_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture identity interruption'; END $$`);
        const event = failureTable === 'config'
          ? `BEFORE INSERT OR UPDATE ON config FOR EACH ROW WHEN (NEW.key = 'embedding_model' AND NEW.value = '${TARGET}')`
          : 'BEFORE DELETE ON query_cache FOR EACH ROW';
        await engine.executeRaw(`CREATE TRIGGER fixture_reject_identity ${event} EXECUTE FUNCTION fixture_reject_identity()`);
        let published = false;
        const result = await applyEmbeddingMigration(engine, await planEmbeddingMigration(engine, { to: TARGET, dim: DIMS }), {
          persistConfig: () => { published = true; },
        });
        expect(result.status).toBe('failed');
        if (result.status === 'failed') expect(result.reason).toContain('fixture identity interruption');
        expect(published).toBe(false);
        expect(await engine.getConfig('embedding_model')).toBe(OLD);
        expect(await snapshotStore(engine, 'facts')).toEqual(facts);
        expect(await snapshotStore(engine, 'query_cache')).toEqual(cache);
        expect(await snapshotStore(engine, 'takes')).toEqual(takes);
        expect((await readMigrationState(engine)).state?.companion_vectors_invalidated).not.toBe(true);
        await reopen();
        await engine.executeRaw(`DROP TRIGGER fixture_reject_identity ON ${failureTable}`);
        const resumed = await applyEmbeddingMigration(engine, await planEmbeddingMigration(engine, { to: TARGET, dim: DIMS }));
        expect(resumed.status).toBe('applied');
        expect(await snapshotStore(engine, 'facts')).toEqual(facts.map(row => ({ ...row, embedding: null })));
        expect(await engine.executeRaw('SELECT id FROM query_cache')).toHaveLength(0);
        expect((await readMigrationStatus(engine)).facts_pending).toBe(1);
        expect(await engine.getConfig('embedding_model')).toBe(TARGET);
      });
    }, 60000);

    test('implicit SDK defaults cannot relabel raw vectors; explicit models and columns remain usable', async () => {
      await withBrain(kind, async ({ engine }) => {
        const chunk = await seedRaw(engine);
        const snapshot = () => engine.executeRaw('SELECT model, embedding::text AS embedding FROM content_chunks');
        const before = await snapshot();
        expect(before).toEqual([{ model: OLD, embedding: VECTOR_TEXT }]);
        configureGateway({ env: {} });
        expect(getEmbeddingModel()).toBe(TARGET);
        await engine.upsertChunks('notes/raw-fixture', [chunk]);
        expect(await snapshot()).toEqual(before);
        await engine.unsetConfig('embedding_model');
        await expect(engine.upsertChunks('notes/raw-fixture', [chunk])).rejects.toThrow(/provenance is unknown/i);
        expect(await snapshot()).toEqual(before);
        await engine.upsertChunks('notes/raw-fixture', [{ ...chunk, model: OLD }]);
        expect(await snapshot()).toEqual(before);
        configureGateway({ embedding_model: 'fixture-explicit:model', embedding_dimensions: DIMS, env: {} });
        await engine.upsertChunks('notes/raw-fixture', [chunk]);
        expect(await snapshot()).toEqual([{ model: 'fixture-explicit:model', embedding: VECTOR_TEXT }]);
        configureGateway({ env: {} });
        await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_fixture vector(3)');
        await engine.upsertChunks('notes/raw-fixture', [{ ...chunk, embedding: new Float32Array([1, 2, 3]) }], {
          embeddingColumn: { name: 'embedding_fixture', type: 'vector', dimensions: 3, embeddingModel: 'fixture-column:model' },
        });
        expect(await engine.executeRaw('SELECT model, embedding_fixture::text AS embedding FROM content_chunks'))
          .toEqual([{ model: 'fixture-column:model', embedding: '[1,2,3]' }]);
      });
    }, 60000);

    test('unknown identity refusal leaves an incomplete schema and vector bytes unchanged', async () => {
      await withBrain(kind, async ({ engine }) => {
        await seedRaw(engine);
        await engine.unsetConfig('embedding_model');
        await engine.executeRaw('ALTER TABLE pages DROP COLUMN ingested_at');
        const columns = () => engine.executeRaw("SELECT table_name, column_name, udt_name, ordinal_position FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position");
        const beforeColumns = await columns();
        expect(beforeColumns.some((row: any) => row.table_name === 'pages' && row.column_name === 'ingested_at')).toBe(false);
        const before = await engine.executeRaw('SELECT model, embedding::text AS embedding FROM content_chunks');
        expect(before).toEqual([{ model: OLD, embedding: VECTOR_TEXT }]);
        configureGateway({ env: {} });
        await expect(engine.initSchema()).rejects.toThrow(/stored embedding model is unknown/i);
        expect(await columns()).toEqual(beforeColumns);
        expect(await engine.getConfig('embedding_model')).toBeNull();
        expect(await engine.executeRaw('SELECT model, embedding::text AS embedding FROM content_chunks')).toEqual(before);
        await engine.setConfig('embedding_model', OLD);
        await engine.initSchema();
        expect((await columns()).some((row: any) => row.table_name === 'pages' && row.column_name === 'ingested_at')).toBe(true);
        expect(await engine.executeRaw('SELECT model, embedding::text AS embedding FROM content_chunks')).toEqual(before);
        expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeNull();
      });
    }, 60000);
  });
}
