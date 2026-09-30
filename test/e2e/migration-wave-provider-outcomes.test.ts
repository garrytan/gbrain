import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runSchemaTransition, readMigrationState } from '../../src/core/embedding-migration.ts';
import { executeMigrationFlow, planMigrationFlow } from '../../src/commands/migrate-embeddings.ts';
import { migrationWaveFixture } from '../helpers/migration-wave-fixture.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { withEnv } from '../helpers/with-env.ts';

const model = 'openai:text-embedding-3-small';
const dimensions = 8;
const valid = () => Array(dimensions).fill(0.25) as number[];

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`migration wave malformed provider outcomes (${kind})`, () => {
    let fixture: Awaited<ReturnType<typeof migrationWaveFixture>>;
    let engine: BrainEngine;
    let home: string;
    beforeAll(async () => {
      fixture = await migrationWaveFixture(kind); engine = fixture.engine;
      await runSchemaTransition(engine, dimensions);
      home = mkdtempSync(join(tmpdir(), 'migration-wave-provider-home-'));
      mkdirSync(join(home, '.gbrain'));
    }, 60_000);
    beforeEach(async () => {
      await engine.executeRaw('TRUNCATE pages,facts,fact_withdrawals,page_projection_jobs CASCADE');
      await engine.executeRaw("DELETE FROM config WHERE key LIKE 'embedding_migration.%'");
      await engine.setConfig('embedding_model', model);
      await engine.setConfig('embedding_dimensions', String(dimensions));
      resetGateway();
      configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: { OPENAI_API_KEY: 'synthetic-only' } });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: kind, embedding_model: model, embedding_dimensions: dimensions, openai_api_key: 'synthetic-only' }));
    });
    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await fixture?.close(); rmSync(home, { recursive: true, force: true }); });
    async function flow() {
      return withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
        const opts = { to: model, dim: dimensions, reranker: 'off', maxCostUsd: 1, quiet: true };
        return executeMigrationFlow(engine, await planMigrationFlow(engine, opts), opts);
      });
    }
    for (const path of ['page', 'fact'] as const) {
      for (const malformed of ['empty', 'count', 'width', 'nonfinite', 'partial'] as const) {
        test(`${path} ${malformed} batch installs nothing, remains incomplete, and retries successfully`, async () => {
          const sentinel = `synthetic-${path}-${malformed}`;
          if (path === 'page') {
            await engine.putPage(sentinel, { type: 'note', title: sentinel, compiled_truth: `${sentinel} first. ${sentinel} second.` });
            await installFixtureChunks(engine, sentinel, [0, 1].map(i => ({ chunk_index: i, chunk_source: 'compiled_truth' as const, chunk_text: `${sentinel} ${i}` })));
          } else {
            for (const i of [0, 1]) await engine.insertFact({ fact: `${sentinel} ${i}`, entity_slug: sentinel, source: 'synthetic', visibility: 'world' }, { source_id: 'default' });
          }
          let faults = 0;
          __setEmbedTransportForTests(async ({ values }) => {
            let embeddings = values.map(valid);
            if (values.some(value => value.includes(sentinel))) {
              faults++;
              if (malformed === 'empty') embeddings = [];
              if (malformed === 'count') embeddings.push(valid());
              if (malformed === 'width') embeddings = values.map(() => [0.25]);
              if (malformed === 'nonfinite') embeddings = values.map(() => Array(dimensions).fill(NaN));
              if (malformed === 'partial') embeddings[embeddings.length - 1] = [0.25];
            }
            return { values, warnings: [], embeddings, usage: { tokens: values.length * 8 } };
          });
          const failed = await flow();
          expect(faults).toBeGreaterThan(0);
          expect(failed.status).toBe('incomplete');
          expect(await engine.getConfig('embedding_migration.completed')).toBeNull();
          expect((await readMigrationState(engine)).state).not.toBeNull();
          const table = path === 'page' ? 'content_chunks' : 'facts';
          expect(await engine.executeRaw(`SELECT id FROM ${table} WHERE embedding IS NOT NULL`)).toEqual([]);
          __setEmbedTransportForTests(async ({ values }) => ({ values, warnings: [], embeddings: values.map(valid), usage: { tokens: values.length * 8 } }));
          expect((await flow()).status).toBe('completed');
          expect(await engine.executeRaw(`SELECT id FROM ${table} WHERE embedding IS NOT NULL`)).toHaveLength(2);
          expect((await readMigrationState(engine)).state).toBeNull();
        });
      }
    }
  });
}
