/**
 * #9307: `gbrain migrate embeddings` built its lock set from a JavaScript-sorted source list and compared it with
 * `SELECT ... FROM sources ORDER BY id`, which Postgres orders by the database collation. Under a linguistic
 * collation (en_US.utf8, the pgvector image's default) hyphens are ignored at the first level, so ids such as
 * `auto-memory` and `automax-notes` come back in the other order and every apply refused with "Source census
 * changed while acquiring locks". The census is now compared as a set, so the migration runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runSchemaTransition } from '../../src/core/embedding-migration.ts';
import { executeMigrationFlow, planMigrationFlow } from '../../src/commands/migrate-embeddings.ts';
import { migrationWaveFixture } from '../helpers/migration-wave-fixture.ts';
import { withEnv } from '../helpers/with-env.ts';

const model = 'openai:text-embedding-3-small';
for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`migrate embeddings source census under the database collation (${kind})`, () => {
    let fixture: Awaited<ReturnType<typeof migrationWaveFixture>>;
    let engine: BrainEngine;
    let home: string;
    beforeAll(async () => {
      fixture = await migrationWaveFixture(kind); engine = fixture.engine;
      home = mkdtempSync(join(tmpdir(), 'migration-census-collation-')); mkdirSync(join(home, '.gbrain'));
      await runSchemaTransition(engine, 8);
      await engine.setConfig('embedding_model', model); await engine.setConfig('embedding_dimensions', '8');
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: kind, embedding_model: model, embedding_dimensions: 8, openai_api_key: 'synthetic-only' }));
    }, 60_000);
    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await fixture?.close(); rmSync(home, { recursive: true, force: true }); });

    test('ids a linguistic collation orders differently from code-unit order do not refuse the apply', async () => {
      for (const id of ['auto-memory', 'automax-notes']) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [id]);
      configureGateway({ embedding_model: model, embedding_dimensions: 16, env: { OPENAI_API_KEY: 'synthetic-only' } });
      __setEmbedTransportForTests(async ({ values }) => ({ values, warnings: [], embeddings: values.map(() => Array(16).fill(0.25)), usage: { tokens: values.length * 8 } }));
      const result = await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
        const opts = { to: model, dim: 16, reranker: 'off', maxCostUsd: 1, quiet: true };
        return executeMigrationFlow(engine, await planMigrationFlow(engine, opts), opts);
      });
      expect(JSON.stringify(result)).not.toContain('Source census changed');
      expect(result.status).toBe('completed');
    }, 120_000);
  });
}
