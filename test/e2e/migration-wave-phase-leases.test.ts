import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runSchemaTransition } from '../../src/core/embedding-migration.ts';
import { executeMigrationFlow, planMigrationFlow } from '../../src/commands/migrate-embeddings.ts';
import { migrationWaveFixture, observeMigrationEngine } from '../helpers/migration-wave-fixture.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { withEnv } from '../helpers/with-env.ts';

const model = 'openai:text-embedding-3-small';
const boundaries = {
  schema: 'DROP INDEX IF EXISTS idx_chunks_embedding',
  projection: 'await installPageProjection',
  reconcile: 'return reconcilePageSignatures',
  completion: 'MIGRATION_COMPLETED_KEY',
};
for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`migration wave whole-flow source lease phases (${kind})`, () => {
    let fixture: Awaited<ReturnType<typeof migrationWaveFixture>>;
    let engine: BrainEngine;
    let home: string;
    beforeAll(async () => {
      fixture = await migrationWaveFixture(kind); engine = fixture.engine;
      home = mkdtempSync(join(tmpdir(), 'migration-wave-lease-home-')); mkdirSync(join(home, '.gbrain'));
    }, 60_000);
    beforeEach(async () => {
      await engine.executeRaw('TRUNCATE pages,facts,fact_withdrawals,page_projection_jobs,gbrain_cycle_locks CASCADE');
      await engine.executeRaw("DELETE FROM config WHERE key LIKE 'embedding_migration.%'");
      await runSchemaTransition(engine, 8);
      await engine.setConfig('embedding_model', model); await engine.setConfig('embedding_dimensions', '8');
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: kind, embedding_model: model, embedding_dimensions: 8, openai_api_key: 'synthetic-only' }));
    });
    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await fixture?.close(); rmSync(home, { recursive: true, force: true }); });
    for (const [phase, marker] of Object.entries(boundaries)) {
      test(`source lease takeover immediately before ${phase} transaction prevents every subsequent durable mutation`, async () => {
        const dim = phase === 'schema' ? 16 : 8;
        configureGateway({ embedding_model: model, embedding_dimensions: dim, env: { OPENAI_API_KEY: 'synthetic-only' } });
        await engine.putPage('synthetic-phase', { type: 'note', title: 'Synthetic phase', compiled_truth: 'Synthetic current canonical body' });
        const chunk = { chunk_index: 0, chunk_source: 'compiled_truth' as const, chunk_text: 'Synthetic current canonical body' };
        if (phase === 'projection') await engine.upsertChunks('synthetic-phase', [chunk]);
        else await installFixtureChunks(engine, 'synthetic-phase', [chunk]);
        await engine.insertFact({ fact: 'Synthetic phase fact', source: 'synthetic' }, { source_id: 'default' });
        let injected = false, calls = 0, callsAtLoss = -1;
        let atLoss: Record<string, unknown> = {};
        const snapshot = async () => {
          const state: Record<string, unknown> = {};
          for (const table of ['pages', 'content_chunks', 'facts', 'page_projection_jobs', 'config']) {
            state[table] = await engine.executeRaw(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`);
          }
          state.columns = await engine.executeRaw("SELECT attrelid::regclass::text AS table_name,attname,atttypmod FROM pg_attribute WHERE attrelid IN ('content_chunks'::regclass,'facts'::regclass) AND attname='embedding' ORDER BY attrelid");
          return state;
        };
        __setEmbedTransportForTests(async ({ values }) => { calls++; return { values, warnings: [], embeddings: values.map(() => Array(dim).fill(0.25)), usage: { tokens: values.length * 8 } }; });
        const observed = observeMigrationEngine(engine, async () => {}, async (_tx, method, args) => {
          if (injected || method !== 'transaction' || !String(args[0]).includes(marker)) return;
          injected = true;
          const changed = await engine.executeRaw("UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id='gbrain-embed-backfill:default' RETURNING id");
          expect(changed).toHaveLength(1);
          callsAtLoss = calls;
          atLoss = await snapshot();
        });
        const result = await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
          const opts = { to: model, dim, reranker: 'off', maxCostUsd: 1, quiet: true };
          return executeMigrationFlow(observed, await planMigrationFlow(observed, opts), opts);
        });
        expect(injected).toBe(true);
        expect(result.status).toBe('apply_failed');
        expect(JSON.stringify(result)).toMatch(/lease lost/);
        expect(calls).toBe(callsAtLoss);
        expect(await snapshot()).toEqual(atLoss);
        expect(await engine.getConfig('embedding_migration.completed')).toBeNull();
      });
    }
  });
}
