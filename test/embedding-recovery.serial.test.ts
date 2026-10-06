import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { setupDB, teardownDB } from './e2e/helpers.ts';
import { testBackends } from './helpers/test-backends.ts';
import { resetPgliteState, truncateCascade } from './helpers/reset-pglite.ts';
import { configureGateway, getEmbeddingModel, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { applyEmbeddingMigration, planEmbeddingMigration, runSchemaTransition, verifyMigrationComplete, readMigrationState, reconcilePageSignatures, verifySearchRoundTrip } from '../src/core/embedding-migration.ts';
import { readContentChunksEmbeddingDim } from '../src/core/embedding-dim-check.ts';
import { installPageProjection, readProjectionSnapshot, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import { embedStaleFacts } from '../src/core/embed-facts.ts';
import { countStaleFactEmbeddings } from '../src/core/facts/embedding-identity.ts';
import { authorizeMigrationBudget, assertMigrationLeases } from '../src/core/embedding-migration-budget.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { invokeAI, withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';
import { planMigrationFlow, executeMigrationFlow, persistEmbeddingFileConfig } from '../src/commands/migrate-embeddings.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { prepareEmbeddingProjections } from '../src/core/embedding-readiness.ts';
import { makeEmbedBackfillHandler } from '../src/core/minions/handlers/embed-backfill.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { loadConfigFileOnly } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIT_ROW_SOURCES } from '../src/core/facts/audit-sources.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { softDeleteSource } from '../src/core/destructive-guard.ts';
import { assertRetainedEmbeddingRebuildability } from '../src/core/embedding-migration-retention.ts';
import { importImageFile } from '../src/core/import-file.ts';
import { clearFalseStampedSignatures, countFalseStampedChunks, invalidateStaleSignatureEmbeddingsGuarded } from '../src/core/embedding-invalidation.ts';

const model = 'openai:text-embedding-3-small';
const dimensions = 8;
const backends = testBackends();
for (const kind of backends) {
  describe(`embedding recovery safety (${kind})`, () => {
    let engine: BrainEngine;
    let originalDimensions: number;
    let originalIdentity: Array<{ key: string; value: string }>;
    async function flow(maxCostUsd = 1, to = model, targetDimensions = dimensions, retarget = false) {
      const home = mkdtempSync(join(tmpdir(), 'migration-recovery-'));
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: kind, embedding_model: model, embedding_dimensions: dimensions, openai_api_key: 'synthetic-only' }));
      try {
        return await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
          const options = { to, dim: targetDimensions, reranker: 'off', maxCostUsd, quiet: true, retarget };
          return executeMigrationFlow(engine, await planMigrationFlow(engine, options), options);
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
    beforeAll(async () => {
      if (kind === 'postgres') engine = await setupDB();
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
      originalDimensions = (await readContentChunksEmbeddingDim(engine)).dims!;
      originalIdentity = await engine.executeRaw("SELECT key,value FROM config WHERE key IN ('embedding_model','embedding_dimensions')");
      await runSchemaTransition(engine, dimensions);
    }, 60_000);
    beforeEach(async () => {
      if (kind === 'pglite') await resetPgliteState(engine as PGLiteEngine);
      else {
        await truncateCascade(engine, ['facts', 'pages', 'fact_withdrawals', 'page_projection_jobs']);
        await engine.executeRaw("DELETE FROM config WHERE key LIKE 'embedding_migration.%'");
      }
      await engine.setConfig('embedding_model', model);
      await engine.setConfig('embedding_dimensions', String(dimensions));
      resetGateway();
      configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: { OPENAI_API_KEY: 'synthetic-only' } });
      __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
        embeddings: values.map(() => Array.from({ length: dimensions }, (_, i) => (i+1)/10)), usage: { tokens: values.length * 8 },
      }) as never);
    });
    afterAll(async () => {
      __setEmbedTransportForTests(null); resetGateway();
      await runSchemaTransition(engine, originalDimensions);
      await engine.executeRaw("DELETE FROM config WHERE key IN ('embedding_model','embedding_dimensions')");
      for (const row of originalIdentity) await engine.setConfig(row.key, row.value);
      if (kind === 'postgres') {
        await engine.executeRaw("DELETE FROM config WHERE key LIKE 'embedding_migration.%'");
        await teardownDB();
      } else await engine.disconnect();
    });
    async function seedArchivedEligibility(scenario: string) {
      const sourceId = 'synthetic-cycle6-archive';
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT(id) DO UPDATE SET archived=false', [sourceId]);
      for (const source of ['default', sourceId]) {
        const text = source === sourceId ? 'Synthetic archived eligibility payload.' : 'Synthetic active eligibility payload.';
        await engine.putPage('eligibility', { type: 'note', title: 'Synthetic eligibility', compiled_truth: text }, { sourceId: source });
        await installFixtureChunks(engine, 'eligibility', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text,
          ...(source === sourceId && !['null', 'unsealed', 'chunkless'].includes(scenario)
            && { embedding: new Float32Array(dimensions).fill(0.1) }) }], { sourceId: source });
      }
      await engine.executeRaw('UPDATE pages SET embedding_signature=$1', [`${model}:${dimensions}`]);
      await engine.executeRaw(`UPDATE content_chunks cc SET model=$1,embedded_at='2025-01-01'::timestamptz,
        embedded_text_hash=md5(cc.chunk_text) FROM pages p WHERE p.id=cc.page_id AND p.source_id=$2`, [model, sourceId]);
      if (scenario === 'drift') await engine.executeRaw(`UPDATE content_chunks cc SET embedded_text_hash=md5('Synthetic obsolete content')
        FROM pages p WHERE p.id=cc.page_id AND p.source_id=$1`, [sourceId]);
      if (scenario === 'null-hash') await engine.executeRaw(`UPDATE content_chunks cc SET embedded_text_hash=NULL
        FROM pages p WHERE p.id=cc.page_id AND p.source_id=$1`, [sourceId]);
      if (scenario === 'signature') await engine.executeRaw("UPDATE pages SET embedding_signature='old:model:8' WHERE source_id=$1", [sourceId]);
      if (scenario === 'false-stamp') await engine.executeRaw(`UPDATE content_chunks cc SET model='old:model'
        FROM pages p WHERE p.id=cc.page_id AND p.source_id=$1`, [sourceId]);
      if (scenario === 'unsealed') await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1', [sourceId]);
      if (scenario === 'chunkless') await engine.executeRaw('DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [sourceId]);
      await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
      const snapshot = () => engine.executeRaw(`SELECT to_jsonb(p) AS page,
        (SELECT jsonb_agg(to_jsonb(cc) ORDER BY cc.id) FROM content_chunks cc WHERE cc.page_id=p.id) AS chunks
        FROM pages p WHERE p.source_id=$1 ORDER BY p.id`, [sourceId]);
      return { sourceId, snapshot };
    }
    describe('archived eligibility boundary', () => {
    afterEach(async () => {
      await truncateCascade(engine, ['pages']);
      await engine.executeRaw("UPDATE sources SET archived=false WHERE id='default'");
    });
    for (const scenario of ['drift', 'null', 'unsealed', 'chunkless', 'signature', 'false-stamp']) {
      test(`archived eligibility: migration refuses ${scenario} before authorization on repeated same-target attempts`, async () => {
        const { snapshot } = await seedArchivedEligibility(scenario);
        const before = await snapshot();
        const pages = await engine.executeRaw('SELECT to_jsonb(p) AS page FROM pages p ORDER BY id');
        const chunks = await engine.executeRaw('SELECT to_jsonb(cc) AS chunk FROM content_chunks cc ORDER BY id');
        const config = await engine.executeRaw('SELECT key,value FROM config ORDER BY key');
        let calls = 0;
        __setEmbedTransportForTests(async () => { calls++; throw new Error('Archived work must refuse before transport'); });
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await flow();
          expect(result.status).toBe('apply_failed');
          expect(JSON.stringify(result)).toContain('retained_vectors_blocked');
          expect(JSON.stringify(result)).toContain('gbrain sources restore');
          expect(calls).toBe(0);
          expect(await snapshot()).toEqual(before);
          expect(await engine.executeRaw('SELECT to_jsonb(p) AS page FROM pages p ORDER BY id')).toEqual(pages);
          expect(await engine.executeRaw('SELECT to_jsonb(cc) AS chunk FROM content_chunks cc ORDER BY id')).toEqual(chunks);
          expect(await engine.executeRaw('SELECT key,value FROM config ORDER BY key')).toEqual(config);
        }
      });
    }
    for (const scenario of ['unsealed', 'null', 'drift', 'signature', 'chunkless']) {
      test(`archived eligibility: plain stale repairs active work and honestly skips archived ${scenario}`, async () => {
        const { sourceId, snapshot } = await seedArchivedEligibility(scenario);
        const before = await snapshot();
        const inputs: string[] = [];
        __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
          inputs.push(...values);
          return { values, warnings: [], embeddings: values.map(() => Array.from({ length: dimensions }, () => 0.1)), usage: { tokens: 8 } };
        });
        const result = await runEmbedCore(engine, { stale: true, quiet: true, catchUp: true });
        expect(result.embedded).toBe(1);
        expect(result.failures).toBeGreaterThan(0);
        expect(result.failure_samples.join(' ')).toContain('archived');
        expect(inputs).toHaveLength(1);
        expect(inputs[0]).toContain('Synthetic active eligibility payload.');
        expect(await snapshot()).toEqual(before);
        const drainedInputs: string[] = [];
        const drained = await embedStaleForSource(engine, sourceId, { embeddingSignature: `${model}:${dimensions}`,
          embedFn: async texts => { drainedInputs.push(...texts); return texts.map(() => new Float32Array(dimensions).fill(0.1)); } });
        expect(drained.complete).toBe(false);
        expect(drained.blocked).toBeGreaterThan(0);
        expect(drainedInputs).toEqual([]);
        expect(await snapshot()).toEqual(before);
      });
    }
    test('archived eligibility: existing same-target authorization and uncertain debits survive repeated refusal', async () => {
      const { snapshot } = await seedArchivedEligibility('null');
      const plan = await planEmbeddingMigration(engine, { to: model, dim: dimensions });
      const debit = await authorizeMigrationBudget(engine, plan, 1);
      await debit({ kind: 'embedding', operation: 'synthetic-prior-attempt', model, maxInputTokens: 100 });
      const before = await snapshot();
      const config = await engine.executeRaw('SELECT key,value FROM config ORDER BY key');
      const budget = (await readMigrationState(engine)).state!.budget!;
      expect(budget.requests).toBe(1);
      expect(budget.debited_usd).toBeGreaterThan(0);
      let calls = 0;
      __setEmbedTransportForTests(async () => { calls++; throw new Error('Refusal must precede transport'); });
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await flow()).status).toBe('apply_failed');
        expect(calls).toBe(0);
        expect((await readMigrationState(engine)).state!.budget).toEqual(budget);
        expect(await engine.executeRaw('SELECT key,value FROM config ORDER BY key')).toEqual(config);
        expect(await snapshot()).toEqual(before);
      }
    });
    for (const scenario of ['current', 'null-hash']) {
      test(`archived eligibility: ${scenario} retained control permits live migration without archived smoke input`, async () => {
        const { snapshot } = await seedArchivedEligibility(scenario);
        const before = await snapshot();
        const inputs: string[] = [];
        __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
          inputs.push(...values);
          return { values, warnings: [], embeddings: values.map(() => Array.from({ length: dimensions }, (_, i) => (i + 1) / 10)), usage: { tokens: 8 } };
        });
        expect((await flow()).status).toBe('completed');
        expect(inputs.some(text => text.includes('Synthetic archived eligibility payload.'))).toBe(false);
        expect(inputs.some(text => text.includes('Synthetic active eligibility payload.'))).toBe(true);
        expect(await snapshot()).toEqual(before);
      });
    }
    for (const operation of ['drift', 'raw-signature', 'guarded-signature', 'guarded-restamp', 'false-stamp', 'reconcile'] as const) {
      for (const scoped of [false, true]) {
        test(`archived eligibility: ${operation} preserves raw archived rows with ${scoped ? 'active source scope' : 'brain scope'}`, async () => {
          const { snapshot } = await seedArchivedEligibility('current');
          await engine.executeRaw(`UPDATE content_chunks SET embedding=$1::vector, model=$2,
            embedded_at='2025-01-01'::timestamptz,embedded_text_hash=md5(chunk_text)`, ['[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]', model]);
          if (operation === 'drift') await engine.executeRaw("UPDATE content_chunks SET embedded_text_hash=md5('Synthetic obsolete content')");
          if (['raw-signature', 'guarded-signature', 'false-stamp'].includes(operation)) await engine.executeRaw("UPDATE content_chunks SET model='old:model'");
          if (operation !== 'drift' && operation !== 'false-stamp') await engine.executeRaw("UPDATE pages SET embedding_signature='old:model:8'");
          const before = await snapshot();
          const options = { signature: `${model}:${dimensions}`, ...(scoped && { sourceId: 'default' }) };
          if (operation === 'drift') expect(await engine.invalidateContentDriftEmbeddings(options)).toBe(1);
          if (operation === 'raw-signature') expect(await engine.invalidateStaleSignatureEmbeddings(options)).toBe(1);
          if (operation === 'guarded-signature') expect(await invalidateStaleSignatureEmbeddingsGuarded(engine, options)).toBe(1);
          if (operation === 'guarded-restamp') expect(await invalidateStaleSignatureEmbeddingsGuarded(engine, options)).toBe(0);
          if (operation === 'false-stamp') {
            expect((await countFalseStampedChunks(engine, model, dimensions)).pages).toBe(2);
            expect(await clearFalseStampedSignatures(engine, model, dimensions)).toBe(1);
            expect((await countFalseStampedChunks(engine, model, dimensions)).pages).toBe(1);
          }
          if (operation === 'reconcile') {
            const plan = await planEmbeddingMigration(engine, { to: model, dim: dimensions });
            expect(await reconcilePageSignatures(engine, plan)).toBe(1);
          }
          expect(await snapshot()).toEqual(before);
          const [active] = await engine.executeRaw<{ signature: string | null; embedded: boolean }>(`SELECT
            p.embedding_signature AS signature,cc.embedding IS NOT NULL AS embedded FROM pages p
            JOIN content_chunks cc ON cc.page_id=p.id WHERE p.source_id='default'`);
          if (['drift', 'raw-signature', 'guarded-signature'].includes(operation)) expect(active.embedded).toBe(false);
          if (['guarded-restamp', 'reconcile'].includes(operation)) expect(active.signature).toBe(options.signature);
          if (operation === 'false-stamp') expect(active.signature).toBeNull();
        });
      }
    }
    test('archived eligibility: smoke verification never sends archived-only current content', async () => {
      const { snapshot } = await seedArchivedEligibility('current');
      const before = await snapshot();
      let calls = 0;
      __setEmbedTransportForTests(async () => { calls++; throw new Error('No runnable smoke candidate'); });
      expect((await verifySearchRoundTrip(engine)).status).toBe('skipped');
      expect(calls).toBe(0);
      expect(await snapshot()).toEqual(before);
    });
    test('archived eligibility: smoke rechecks a candidate archived after selection without dispatching it', async () => {
      await seedArchivedEligibility('current');
      await engine.executeRaw(`UPDATE content_chunks cc SET embedding=$1::vector,model=$2,
        embedded_text_hash=md5(cc.chunk_text),embedded_at=now() FROM pages p WHERE p.id=cc.page_id AND p.source_id='default'`,
      ['[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]', model]);
      const before = await engine.executeRaw('SELECT to_jsonb(p) AS page FROM pages p ORDER BY id');
      const chunks = await engine.executeRaw('SELECT to_jsonb(cc) AS chunk FROM content_chunks cc ORDER BY id');
      let selected = false, calls = 0;
      const original = engine.executeRaw;
      engine.executeRaw = async function(this: BrainEngine, sql, params) {
        const rows = await original.call(this, sql, params);
        if (!selected && sql.includes('ORDER BY cc.id DESC')) {
          selected = true;
          await original.call(this, "UPDATE sources SET archived=true WHERE id='default'");
        }
        return rows;
      } as BrainEngine['executeRaw'];
      __setEmbedTransportForTests(async () => { calls++; throw new Error('Stale smoke candidate must not dispatch'); });
      try {
        expect((await verifySearchRoundTrip(engine)).status).toBe('skipped');
        expect(selected).toBe(true);
        expect(calls).toBe(0);
        expect(await engine.executeRaw('SELECT to_jsonb(p) AS page FROM pages p ORDER BY id')).toEqual(before);
        expect(await engine.executeRaw('SELECT to_jsonb(cc) AS chunk FROM content_chunks cc ORDER BY id')).toEqual(chunks);
      } finally { engine.executeRaw = original; }
    });
    test('archived eligibility: active unsealed recovery progresses without repairing archived unsupported media', async () => {
      const { sourceId, snapshot } = await seedArchivedEligibility('unsealed');
      await engine.executeRaw("UPDATE pages SET page_kind='image' WHERE source_id=$1", [sourceId]);
      await engine.executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE source_id='default'");
      const before = await snapshot();
      const inputs: string[] = [];
      __setEmbedTransportForTests(async ({ values }) => {
        inputs.push(...values);
        return { values, warnings: [], embeddings: values.map(() => Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
      });
      expect((await prepareEmbeddingProjections(engine)).blocked).toBe(2);
      const result = await runEmbedCore(engine, { stale: true, quiet: true, catchUp: true });
      expect(result.embedded).toBe(1);
      expect(result.failures).toBe(1);
      expect(inputs).toHaveLength(2);
      expect(inputs.some(text => text.includes('Synthetic archived eligibility payload.'))).toBe(false);
      expect((await prepareEmbeddingProjections(engine)).blocked).toBe(1);
      expect(await snapshot()).toEqual(before);
    });
    for (const guarded of [false, true]) {
      for (const includeNullSignature of [false, true]) {
        test(`archived eligibility: ${guarded ? 'guarded' : 'raw'} NULL-signature invalidation with includeNull=${includeNullSignature}`, async () => {
          const { snapshot } = await seedArchivedEligibility('current');
          await engine.executeRaw('UPDATE pages SET embedding_signature=NULL');
          await engine.executeRaw(`UPDATE content_chunks SET embedding=$1::vector,model='old:model'`, ['[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]']);
          const before = await snapshot();
          const opts = { signature: `${model}:${dimensions}`, includeNullSignature };
          expect(await (guarded ? invalidateStaleSignatureEmbeddingsGuarded(engine, opts) : engine.invalidateStaleSignatureEmbeddings(opts))).toBe(includeNullSignature ? 1 : 0);
          expect(await snapshot()).toEqual(before);
          expect(await engine.countStaleChunks({ signature: opts.signature, includeNullSignature: true })).toBe(2);
        });
      }
    }
    for (const path of ['plain', 'source', 'smoke'] as const) {
      test(`archived eligibility: ${path} provider runs without a source lock and archive wins final installation`, async () => {
        await seedArchivedEligibility('current');
        if (path === 'smoke') await engine.executeRaw(`UPDATE content_chunks cc SET embedding=$1::vector,model=$2,
          embedded_text_hash=md5(cc.chunk_text),embedded_at=now() FROM pages p WHERE p.id=cc.page_id AND p.source_id='default'`,
        ['[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]', model]);
        const before = await engine.executeRaw(`SELECT to_jsonb(p) AS page,
          (SELECT jsonb_agg(to_jsonb(cc) ORDER BY cc.id) FROM content_chunks cc WHERE cc.page_id=p.id) AS chunks
          FROM pages p WHERE source_id='default'`);
        let calls = 0;
        const archive = async (values: string[]) => {
          calls++;
          expect(values.some(text => text.includes('Synthetic archived eligibility payload.'))).toBe(false);
          await engine.transaction(async tx => {
            await tx.executeRaw("SET LOCAL statement_timeout='1s'");
            await tx.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
          });
        };
        __setEmbedTransportForTests(async ({ values }) => {
          await archive(values);
          return { values, warnings: [], embeddings: values.map(() => Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
        });
        if (path === 'plain') {
          const result = await runEmbedCore(engine, { stale: true, quiet: true, catchUp: true });
          expect(result.embedded).toBe(0);
          expect(result.failures).toBe(1);
          expect(result.failure_samples.join(' ')).toContain('archived');
        } else if (path === 'source') {
          const result = await embedStaleForSource(engine, 'default', { embeddingSignature: `${model}:${dimensions}`,
            embedFn: async texts => { await archive(texts); return texts.map(() => new Float32Array(dimensions).fill(0.1)); } });
          expect(result.embedded).toBe(0);
          expect(result.complete).toBe(false);
          expect(result.blocked).toBe(1);
        } else await verifySearchRoundTrip(engine);
        expect(calls).toBe(1);
        expect(await engine.executeRaw(`SELECT to_jsonb(p) AS page,
          (SELECT jsonb_agg(to_jsonb(cc) ORDER BY cc.id) FROM content_chunks cc WHERE cc.page_id=p.id) AS chunks
          FROM pages p WHERE source_id='default'`)).toEqual(before);
      });
    }
    for (const archiveFirst of [true, false]) {
      test.skipIf(kind !== 'postgres')(`archived eligibility: PostgreSQL serializes ${archiveFirst ? 'archive before invalidation' : 'invalidation before archive'}`, async () => {
        const { sourceId, snapshot } = await seedArchivedEligibility('drift');
        await engine.executeRaw('UPDATE sources SET archived=false WHERE id=$1', [sourceId]);
        const before = await snapshot();
        const other = new PostgresEngine();
        await other.connect({ database_url: process.env.DATABASE_URL! });
        const original = engine.executeRaw;
        const started = Promise.withResolvers<number>();
        let mutation: Promise<number> | undefined;
        let archive: Promise<void> | undefined;
        let blocked = false;
        const observeWait = async (tx: BrainEngine, pid: number) => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const [row] = await original.call(tx, 'SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS blocked', [pid]) as Array<{ blocked: boolean }>;
            if (row.blocked) return true;
            await Bun.sleep(10);
          }
          return false;
        };
        engine.executeRaw = async function(this: BrainEngine, sql, params) {
          if (!sql.startsWith('SELECT id FROM sources WHERE ($1::text')) return original.call(this, sql, params);
          if (archiveFirst) {
            const [backend] = await original.call(this, 'SELECT pg_backend_pid() AS pid') as Array<{ pid: number }>;
            started.resolve(backend.pid);
            return original.call(this, sql, params);
          }
          const rows = await original.call(this, sql, params);
          archive = other.transaction(async tx => {
            const [backend] = await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
            started.resolve(backend.pid);
            await tx.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
          });
          blocked = await observeWait(this, await started.promise);
          return rows;
        } as BrainEngine['executeRaw'];
        try {
          if (archiveFirst) {
            await other.transaction(async tx => {
              await tx.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
              mutation = engine.invalidateContentDriftEmbeddings({ sourceId });
              const pid = await Promise.race([started.promise, mutation.then(() => null)]);
              expect(pid).not.toBeNull();
              if (pid !== null) blocked = await observeWait(tx, pid);
            });
          } else mutation = engine.invalidateContentDriftEmbeddings({ sourceId });
          expect(await mutation).toBe(archiveFirst ? 0 : 1);
          await archive;
          expect(blocked).toBe(true);
          if (archiveFirst) expect(await snapshot()).toEqual(before);
          else expect((await engine.executeRaw<{ present: boolean }>(`SELECT cc.embedding IS NOT NULL AS present
            FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.source_id=$1`, [sourceId]))[0].present).toBe(false);
          expect((await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [sourceId]))[0].archived).toBe(true);
        } finally {
          await mutation?.catch(() => {});
          await archive?.catch(() => {});
          engine.executeRaw = original;
          await other.disconnect();
        }
      }, 20_000);
    }
    });
    describe('explicit archived admission', () => {
      afterEach(async () => {
        await truncateCascade(engine, ['pages']);
        await engine.executeRaw("UPDATE sources SET archived=false WHERE id='default'");
      });
      async function seedExplicit(scenario: string) {
        const sourceId = 'synthetic-explicit-archive';
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT(id) DO UPDATE SET archived=false', [sourceId]);
        for (const source of ['default', sourceId]) {
          const slug = source === sourceId ? 'archived-target' : 'eligibility';
          const text = source === sourceId ? 'Synthetic archived eligibility payload.' : 'Synthetic active eligibility payload.';
          await engine.putPage(slug, { type: 'note', title: 'Synthetic eligibility', compiled_truth: text }, { sourceId: source });
          await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text,
            ...(source === sourceId && scenario === 'current' && { embedding: new Float32Array(dimensions).fill(0.1) }) }], { sourceId: source });
        }
        await engine.executeRaw('UPDATE pages SET embedding_signature=$1', [`${model}:${dimensions}`]);
        if (scenario === 'unsealed') await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1', [sourceId]);
        if (scenario === 'chunkless') await engine.executeRaw('DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [sourceId]);
        await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
        const snapshot = () => engine.executeRaw(`SELECT to_jsonb(p) AS page,
          (SELECT jsonb_agg(to_jsonb(cc) ORDER BY cc.id) FROM content_chunks cc WHERE cc.page_id=p.id) AS chunks
          FROM pages p WHERE p.source_id=$1 ORDER BY p.id`, [sourceId]);
        return { sourceId, snapshot };
      }
      for (const route of ['slug', 'slugs', 'all'] as const) {
        for (const scenario of ['null', 'current', 'unsealed', 'chunkless']) {
          for (const scoped of [false, true]) {
            test(`${route} refuses ${scenario} archived work ${scoped ? 'within its source' : 'without hiding active work'}`, async () => {
              const { sourceId, snapshot } = await seedExplicit(scenario);
              const before = await snapshot();
              const inputs: string[] = [];
              __setEmbedTransportForTests(async ({ values }) => {
                inputs.push(...values);
                return { values, warnings: [], embeddings: values.map(() => Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
              });
              const target = route === 'all' ? { all: true } : route === 'slugs'
                ? { slugs: scoped ? ['archived-target'] : ['archived-target', 'eligibility'] } : { slug: 'archived-target' };
              const result = await runEmbedCore(engine, { ...target, ...(scoped && { sourceId }), quiet: true });
              expect(result.failures).toBe(1);
              expect(result.failure_samples.join(' ')).toContain('archived');
              expect(result.failure_samples.join(' ')).toContain('gbrain sources restore');
              expect(result.failure_samples.join(' ')).not.toContain('Synthetic archived eligibility payload.');
              const live = !scoped && route !== 'slug';
              expect(result.embedded).toBe(live ? 1 : 0);
              expect(inputs).toHaveLength(live ? 1 : 0);
              if (live) expect(inputs[0]).toContain('Synthetic active eligibility payload.');
              expect(await snapshot()).toEqual(before);
              expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks cc
                JOIN pages p ON p.id=cc.page_id WHERE p.source_id='default' AND cc.embedding IS NOT NULL`))[0].n).toBe(live ? 1 : 0);
            });
          }
          test(`${route} preserves dry-run counts and archived ${scenario} bytes`, async () => {
            const { sourceId, snapshot } = await seedExplicit(scenario);
            const before = await snapshot();
            let calls = 0;
            __setEmbedTransportForTests(async () => { calls++; throw new Error('Dry run must not dispatch'); });
            const target = route === 'all' ? { all: true } : route === 'slugs' ? { slugs: ['archived-target'] } : { slug: 'archived-target' };
            const result = await runEmbedCore(engine, { ...target, sourceId, dryRun: true, quiet: true });
            expect(result.failures).toBe(0);
            expect(result.embedded).toBe(0);
            expect(result.would_embed).toBe(route === 'all' ? (['null', 'current'].includes(scenario) ? 1 : 0) : scenario === 'current' ? 0 : 1);
            expect(calls).toBe(0);
            expect(await snapshot()).toEqual(before);
          });
        }
        test(`${route} preserves active source-scoped admission with an identically named archive`, async () => {
          const { snapshot } = await seedArchivedEligibility('null');
          const before = await snapshot();
          const inputs: string[] = [];
          __setEmbedTransportForTests(async ({ values }) => {
            inputs.push(...values);
            return { values, warnings: [], embeddings: values.map(() => Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
          });
          const target = route === 'all' ? { all: true } : route === 'slugs' ? { slugs: ['eligibility'] } : { slug: 'eligibility' };
          const result = await runEmbedCore(engine, { ...target, sourceId: 'default', quiet: true });
          expect(result.embedded).toBe(1);
          expect(result.failures).toBe(0);
          expect(inputs).toHaveLength(1);
          expect(inputs[0]).toContain('Synthetic active eligibility payload.');
          expect(await snapshot()).toEqual(before);
        });
        test(`${route} reports an archive racing installation without holding provider locks`, async () => {
          await seedArchivedEligibility('null');
          const before = await engine.executeRaw(`SELECT to_jsonb(p) AS page,
            (SELECT jsonb_agg(to_jsonb(cc) ORDER BY cc.id) FROM content_chunks cc WHERE cc.page_id=p.id) AS chunks
            FROM pages p WHERE p.source_id='default'`);
          let calls = 0;
          __setEmbedTransportForTests(async ({ values }) => {
            calls++;
            await engine.transaction(async tx => {
              await tx.executeRaw("SET LOCAL statement_timeout='1s'");
              await tx.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
            });
            return { values, warnings: [], embeddings: values.map(() => Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
          });
          const target = route === 'all' ? { all: true } : route === 'slugs' ? { slugs: ['eligibility'] } : { slug: 'eligibility' };
          const result = await runEmbedCore(engine, { ...target, sourceId: 'default', quiet: true });
          expect(calls).toBe(1);
          expect(result.embedded).toBe(0);
          expect(result.failures).toBe(1);
          expect(result.failure_samples.join(' ')).toContain('archived');
          expect(await engine.executeRaw(`SELECT to_jsonb(p) AS page,
            (SELECT jsonb_agg(to_jsonb(cc) ORDER BY cc.id) FROM content_chunks cc WHERE cc.page_id=p.id) AS chunks
            FROM pages p WHERE p.source_id='default'`)).toEqual(before);
        });
      }
      for (const route of ['slug', 'slugs'] as const) {
        for (const chunkless of [false, true]) {
          test(`${route} reports archive after ${chunkless ? 'chunkless' : 'sealed'} preparation before dispatch`, async () => {
            await seedArchivedEligibility('null');
            if (chunkless) await engine.executeRaw("DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE source_id='default')");
            const before = await engine.executeRaw(`SELECT to_jsonb(p) AS page,
              (SELECT jsonb_agg(to_jsonb(cc) ORDER BY cc.id) FROM content_chunks cc WHERE cc.page_id=p.id) AS chunks
              FROM pages p WHERE p.source_id='default'`);
            const original = engine.transaction;
            let archived = false, calls = 0;
            engine.transaction = async function<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
              const result = await original.call(this, run) as T;
              if (!archived && (result as { snapshot?: { page: { source_id: string } } })?.snapshot?.page.source_id === 'default') {
                archived = true;
                await engine.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
              }
              return result;
            };
            __setEmbedTransportForTests(async () => { calls++; throw new Error('Prepared archived work must not dispatch'); });
            try {
              const target = route === 'slugs' ? { slugs: ['eligibility'] } : { slug: 'eligibility' };
              const result = await runEmbedCore(engine, { ...target, sourceId: 'default', quiet: true });
              expect(archived).toBe(true);
              expect(calls).toBe(0);
              expect(result.embedded).toBe(0);
              expect(result.failures).toBe(1);
              expect(result.failure_samples.join(' ')).toContain('archived');
              expect(await engine.executeRaw(`SELECT to_jsonb(p) AS page,
                (SELECT jsonb_agg(to_jsonb(cc) ORDER BY cc.id) FROM content_chunks cc WHERE cc.page_id=p.id) AS chunks
                FROM pages p WHERE p.source_id='default'`)).toEqual(before);
            } finally { engine.transaction = original; }
          });
        }
      }
    });
    describe('chunkless embed racing the resident projection rebuild', () => {
      /** Runs `intervene` after each of the next `times` projection reads of `slug`, once the read released its guard. */
      function afterProjectionReads(slug: string, times: number, intervene: () => Promise<void>): () => void {
        const original = engine.transaction;
        let left = times, busy = false;
        engine.transaction = async function<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
          const result = await original.call(this, run) as T;
          const read = result as { indexingContext?: string; snapshot?: { page: { slug: string } } };
          if (!busy && left > 0 && read?.indexingContext !== undefined && read.snapshot?.page.slug === slug) {
            left--; busy = true;
            try { await intervene(); } finally { busy = false; }
          }
          return result;
        };
        return () => { engine.transaction = original; };
      }
      const slug = 'resident-race';
      const seedChunkless = () => engine.putPage(slug, { type: 'note', title: 'Resident race', compiled_truth: 'Synthetic resident race payload.' });

      test('the embed re-reads and embeds the chunks the resident sealed instead of recording an unavailable page', async () => {
        await seedChunkless();
        const restore = afterProjectionReads(slug, 1, async () => {
          expect((await rebuildPendingPageProjections(engine, 100, { pages: { sourceId: 'default', slugs: [slug] } })).rebuilt).toBe(1);
        });
        try {
          const result = await runEmbedCore(engine, { slug, sourceId: 'default', quiet: true });
          expect(result.failure_samples).toEqual([]);
          expect(result.failures).toBe(0);
          expect(result.embedded).toBeGreaterThan(0);
        } finally { restore(); }
        const chunks = await engine.getChunks(slug, { sourceId: 'default' });
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.every(c => c.embedded_at)).toBe(true);
      });

      test('an embed that keeps losing reports page_projection_conflict after the bounded retries', async () => {
        await seedChunkless();
        let competing = 0;
        const restore = afterProjectionReads(slug, 4, async () => {
          const read = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
          await installPageProjection(engine, read, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `competing ${++competing}` }]);
        });
        try {
          const result = await runEmbedCore(engine, { slug, sourceId: 'default', quiet: true });
          expect(competing).toBe(4);
          expect(result.failures).toBe(1);
          expect(result.failure_samples).toHaveLength(1);
          expect(result.failure_samples[0]).toStartWith(`${slug}: [page_projection_conflict] The search projection of ${slug} (source default) changed during preparation (chunk_digest)`);
          expect(result.failure_samples[0]).toContain('Re-run gbrain embed; it re-reads the current projection.');
        } finally { restore(); }
      });
    });
    async function seedLegacyContentDrift() {
      const otherSource = 'synthetic-legacy-drift';
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [otherSource]);
      for (const sourceId of ['default', otherSource]) {
        for (const slug of ['deleted-drift', 'live-drift', 'current-hash', 'null-hash', 'skipped-drift']) {
          await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Synthetic ${slug}`,
            ...(slug === 'skipped-drift' && { frontmatter: { embed_skip: true } }) }, { sourceId });
          await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `Synthetic ${slug}`,
            embedding: new Float32Array(dimensions).fill(0.1) }], { sourceId });
        }
        await engine.softDeletePages(['deleted-drift'], { sourceId });
      }
      await engine.executeRaw('UPDATE pages SET embedding_signature=$1', [`${model}:${dimensions}`]);
      await engine.executeRaw(`UPDATE content_chunks cc SET model=$1,embedded_at='2025-01-01'::timestamptz,
        embedded_text_hash=CASE p.slug WHEN 'null-hash' THEN NULL WHEN 'current-hash' THEN md5(cc.chunk_text)
          ELSE md5('Synthetic prior legacy content') END FROM pages p WHERE p.id=cc.page_id`, [model]);
      return () => engine.executeRaw<{ source_id: string; slug: string; chunk: Record<string, unknown> }>(`SELECT
        p.source_id,p.slug,to_jsonb(cc) AS chunk FROM content_chunks cc JOIN pages p ON p.id=cc.page_id ORDER BY p.source_id,p.slug`);
    }
    for (const sourceId of [undefined, 'default']) {
      test(`deleted legacy drift: ${sourceId ? 'scoped' : 'unscoped'} invalidation preserves retained bytes and grandfathered controls`, async () => {
        try {
          const snapshot = await seedLegacyContentDrift();
          const before = await snapshot();
          expect(await engine.invalidateContentDriftEmbeddings({ sourceId: 'missing-source' })).toBe(0);
          expect(await snapshot()).toEqual(before);
          const invalidated = await engine.invalidateContentDriftEmbeddings({ sourceId });
          const after = await snapshot();
          const protectedRow = (row: typeof before[number]) => row.slug !== 'live-drift' || sourceId !== undefined && row.source_id !== sourceId;
          expect(after.filter(protectedRow)).toEqual(before.filter(protectedRow));
          expect(invalidated).toBe(sourceId === undefined ? 2 : 1);
          for (const row of after.filter(row => !protectedRow(row))) {
            expect(row.chunk.embedding).toBeNull();
            expect(row.chunk.embedded_text_hash).toBeNull();
            expect(row.chunk.embedded_at).toBeNull();
          }
          expect(await engine.invalidateContentDriftEmbeddings({ sourceId })).toBe(0);
        } finally { await truncateCascade(engine, ['pages']); }
      });
    }
    test('deleted legacy drift: same-width migration completes and preserves deleted vector hash and timestamp', async () => {
      try {
        const snapshot = await seedLegacyContentDrift();
        const before = (await snapshot()).filter(row => row.slug === 'deleted-drift');
        const result = await flow(1, 'openai:text-embedding-3-large');
        expect(result.status).toBe('completed');
        expect((await snapshot()).filter(row => row.slug === 'deleted-drift')).toEqual(before);
        expect(await engine.countStaleChunks({ signature: `openai:text-embedding-3-large:${dimensions}`, includeNullSignature: true })).toBe(0);
        const live = await engine.executeRaw<{ correct: boolean }>(`SELECT cc.embedding IS NOT NULL
          AND cc.embedded_text_hash=md5(cc.chunk_text) AND cc.model=$1 AS correct
          FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.slug='live-drift'`, ['openai:text-embedding-3-large']);
        expect(live).toEqual([{ correct: true }, { correct: true }]);
      } finally { await truncateCascade(engine, ['pages']); }
    });
    for (const retained of [true, false]) {
      const label = retained ? 'retained vector' : 'NULL vector';
      const otherSource = 'synthetic-deleted-parity';
      const liveTexts = ['Synthetic live-a 0', 'Synthetic live-a 1', 'Synthetic live-b 0'];
      async function seedDeletedRows() {
        await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING", [otherSource]);
        for (const sourceId of ['default', otherSource]) {
          for (const slug of ['live-a', 'deleted-target', 'live-b']) {
            await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Synthetic ${slug}` }, { sourceId });
            const texts = slug === 'live-a' ? liveTexts.slice(0, 2) : slug === 'live-b' ? liveTexts.slice(2) : ['Synthetic deleted target'];
            await installFixtureChunks(engine, slug, texts.map((chunk_text, chunk_index) => ({
              chunk_index, chunk_source: 'compiled_truth', chunk_text,
              ...(slug === 'deleted-target' && retained && { embedding: new Float32Array(dimensions).fill(0.1) }),
            })), { sourceId });
          }
          await engine.softDeletePages(['deleted-target'], { sourceId });
        }
        await engine.executeRaw('UPDATE pages SET embedding_signature=$1', [`${model}:${dimensions}`]);
        await engine.executeRaw("UPDATE pages SET updated_at=CASE slug WHEN 'live-a' THEN '2025-03-01'::timestamptz WHEN 'deleted-target' THEN '2025-02-01'::timestamptz ELSE '2025-01-01'::timestamptz END");
        await engine.executeRaw('UPDATE content_chunks SET model=$1,embedded_text_hash=md5(chunk_text),embedded_at=now()', [model]);
        return () => engine.executeRaw("SELECT to_jsonb(p) AS page,to_jsonb(cc) AS chunk FROM pages p JOIN content_chunks cc ON cc.page_id=p.id WHERE p.slug='deleted-target' ORDER BY p.source_id,cc.chunk_index");
      }
      test(`deleted completion ${label}: stale count and cost exclude only deleted rows`, async () => {
        const snapshot = await seedDeletedRows();
        const before = await snapshot();
        for (const sourceId of [undefined, 'default', otherSource, 'missing-source']) {
          const multiplier = sourceId === undefined ? 2 : sourceId === 'missing-source' ? 0 : 1;
          for (const signature of [undefined, `${model}:${dimensions}`, `openai:text-embedding-3-large:${dimensions}`]) {
            for (const includeNullSignature of [false, true]) {
              const opts = { sourceId, signature, includeNullSignature };
              expect(await engine.countStaleChunks(opts)).toBe(liveTexts.length * multiplier);
              expect(await engine.sumStaleChunkChars(opts)).toBe(liveTexts.reduce((sum, text) => sum + text.length, 0) * multiplier);
            }
          }
        }
        expect(await snapshot()).toEqual(before);
      });
      test(`deleted completion ${label}: stale listing preserves all cursor branches and scopes`, async () => {
        const snapshot = await seedDeletedRows();
        const before = await snapshot();
        for (const sourceId of [undefined, 'default', otherSource, 'missing-source']) {
          for (const orderBy of ['page_id', 'updated_desc'] as const) {
            const expected = await engine.executeRaw<{ page_id: number; chunk_index: number }>(`SELECT p.id AS page_id,cc.chunk_index
              FROM pages p JOIN content_chunks cc ON cc.page_id=p.id WHERE p.slug IN ('live-a','live-b')
              AND ($1::text IS NULL OR p.source_id=$1)
              ORDER BY ${orderBy === 'updated_desc' ? 'p.updated_at DESC NULLS LAST,' : ''} p.id,cc.chunk_index`, [sourceId ?? null]);
            const seen: Array<{ page_id: number; chunk_index: number }> = [];
            let cursor: { afterPageId?: number; afterChunkIndex?: number; afterUpdatedAt?: string } = {};
            for (let batch = 0; batch < 10; batch++) {
              const rows = await engine.listStaleChunks({ sourceId, orderBy, batchSize: 1, ...cursor });
              if (!rows.length) break;
              const row = rows[0] as typeof rows[number] & { updated_at?: string | Date };
              expect(row.slug).not.toBe('deleted-target');
              seen.push({ page_id: row.page_id, chunk_index: row.chunk_index });
              cursor = { afterPageId: row.page_id, afterChunkIndex: row.chunk_index,
                ...(row.updated_at && { afterUpdatedAt: new Date(row.updated_at).toISOString() }) };
            }
            expect(seen).toEqual(expected);
          }
        }
        expect(await snapshot()).toEqual(before);
      });
      test(`deleted completion ${label}: missing embedding health respects live and source scopes`, async () => {
        const snapshot = await seedDeletedRows();
        const before = await snapshot();
        const scopes: Array<[{ sourceId?: string; sourceIds?: string[] }, number]> = [
          [{}, 6], [{ sourceId: 'default' }, 3], [{ sourceId: otherSource }, 3],
          [{ sourceIds: ['default', otherSource] }, 6], [{ sourceId: 'missing-source' }, 0], [{ sourceIds: [] }, 0],
        ];
        for (const [scope, expected] of scopes) {
          expect((await engine.getHealth(scope)).missing_embeddings).toBe(expected);
        }
        expect(await snapshot()).toEqual(before);
      });
      test(`deleted completion ${label}: same-width migration completes without changing deleted bytes`, async () => {
        const snapshot = await seedDeletedRows();
        const before = await snapshot();
        const result = await flow(1, 'openai:text-embedding-3-large');
        expect(await snapshot()).toEqual(before);
        expect(result.status).toBe('completed');
        expect(await engine.countStaleChunks({ signature: `openai:text-embedding-3-large:${dimensions}`, includeNullSignature: true })).toBe(0);
        expect(await engine.listStaleChunks()).toEqual([]);
        expect((await engine.getHealth()).missing_embeddings).toBe(0);
        expect(await engine.getConfig('embedding_model')).toBe('openai:text-embedding-3-large');
      });
    }
    for (const widthChange of [false, true]) {
      test(`retention mutation parity: imported sealed image migrates ${widthChange ? 'width' : 'model'} after stale embedding`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'synthetic-image-retention-'));
        const image = join(dir, 'pixel.png');
        writeFileSync(image, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex'));
        try {
          await importImageFile(engine, image, 'media/pixel.png', { noEmbed: true });
          await runEmbedCore(engine, { stale: true, includeNullSignature: true, quiet: true });
          const [before] = await engine.executeRaw<{ sealed: boolean; embedded: boolean }>(`SELECT
            p.text_projection_revision=p.knowledge_revision AS sealed,cc.embedding IS NOT NULL AS embedded
            FROM pages p JOIN content_chunks cc ON cc.page_id=p.id WHERE p.page_kind='image'`);
          expect(before).toEqual({ sealed: true, embedded: true });
          const targetDimensions = widthChange ? dimensions * 2 : dimensions;
          const targetModel = widthChange ? model : 'openai:text-embedding-3-large';
          __setEmbedTransportForTests(async ({ values }) => ({ values, warnings: [],
            embeddings: values.map(() => Array(targetDimensions).fill(0.2)), usage: { tokens: 8 } }));
          const result = await flow(1, targetModel, targetDimensions);
          expect(result.status).toBe('completed');
          const [after] = await engine.executeRaw<{ width: number; model: string; sealed: boolean }>(`SELECT
            vector_dims(cc.embedding) AS width,cc.model,p.text_projection_revision=p.knowledge_revision AS sealed
            FROM pages p JOIN content_chunks cc ON cc.page_id=p.id WHERE p.page_kind='image'`);
          expect(after).toEqual({ width: targetDimensions, model: targetModel, sealed: true });
        } finally {
          rmSync(dir, { recursive: true, force: true });
          await truncateCascade(engine, ['pages']);
          await runSchemaTransition(engine, dimensions);
        }
      });
    }
    for (const scenario of ['same-target', 'resume-cleared', 'resume-first-clear', 'resume-first-width-clear', 'retarget-cleared-marker', 'pinned-fact-width'] as const) {
      test(`retention mutation parity: archived companions ${scenario}`, async () => {
        const archivedSource = 'synthetic-retained-companions';
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [archivedSource]);
        await engine.putPage('retained-companion', { type: 'note', title: 'Synthetic retained companion', compiled_truth: '' }, { sourceId: archivedSource });
        await installFixtureChunks(engine, 'retained-companion', [], { sourceId: archivedSource });
        await engine.insertFact({ fact: 'Synthetic retained companion fact', source: 'synthetic', embedding_model: model,
          embedding: new Float32Array(dimensions).fill(0.2) }, { source_id: archivedSource });
        await engine.executeRaw(`INSERT INTO takes(page_id,row_num,claim,kind,holder,embedding)
          SELECT id,0,'Synthetic retained take','take','self',
            ('[' || array_to_string(array_fill(0.1::real, ARRAY[(SELECT atttypmod FROM pg_attribute WHERE attrelid='takes'::regclass AND attname='embedding')]), ',') || ']')::vector
          FROM pages WHERE source_id=$1`, [archivedSource]);
        await softDeleteSource(engine, archivedSource);
        await engine.putPage('live-companion-work', { type: 'note', title: 'Synthetic live work', compiled_truth: 'Synthetic live page work' });
        await installFixtureChunks(engine, 'live-companion-work', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic live page work' }]);
        if (scenario !== 'same-target') await engine.setConfig('embedding_migration.state', JSON.stringify({
          to_model: model, to_dims: dimensions, from_model: scenario === 'resume-first-width-clear' ? model : 'openai:text-embedding-3-large',
          from_dims: scenario === 'resume-first-width-clear' ? dimensions * 2 : dimensions,
          started_at: new Date().toISOString(), companion_vectors_invalidated: !scenario.startsWith('resume-first-'),
        }));
        if (scenario === 'pinned-fact-width') {
          await engine.executeRaw('DROP INDEX IF EXISTS idx_facts_embedding_hnsw');
          await engine.executeRaw(`ALTER TABLE facts ALTER COLUMN embedding TYPE vector(${dimensions * 2}) USING
            ('[' || array_to_string(array_fill(0.2::real, ARRAY[${dimensions * 2}]), ',') || ']')::vector`);
        }
        const snapshot = () => Promise.all(['facts', 'takes'].map(table => engine.executeRaw(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)));
        const before = await snapshot();
        try {
          const blocked = ['resume-first-clear', 'resume-first-width-clear', 'retarget-cleared-marker', 'pinned-fact-width'].includes(scenario);
          const result = await flow(1, scenario === 'retarget-cleared-marker' ? 'openai:text-embedding-3-large' : model, dimensions, scenario === 'retarget-cleared-marker');
          expect(await snapshot()).toEqual(before);
          expect(result.status).toBe(blocked ? 'apply_failed' : 'completed');
          if (blocked && result.status === 'apply_failed') expect(result.reason).toContain('retained_vectors_blocked');
          if (!blocked) expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
        } finally {
          await engine.executeRaw('UPDATE sources SET archived=false,archived_at=NULL,archive_expires_at=NULL WHERE id=$1', [archivedSource]);
          await truncateCascade(engine, ['facts', 'pages']);
          await runSchemaTransition(engine, dimensions);
        }
      });
    }
    test('retention mutation parity: target-stamped archived legacy alias is not invalidated', async () => {
      await engine.putPage('legacy-archived', { type: 'note', title: 'Synthetic legacy alias', compiled_truth: 'Synthetic legacy alias' });
      await installFixtureChunks(engine, 'legacy-archived', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic legacy alias', embedding: new Float32Array(dimensions).fill(0.1) }]);
      await engine.executeRaw('UPDATE pages SET embedding_signature=$1', [`${model}:${dimensions}`]);
      await engine.executeRaw('UPDATE content_chunks SET model=$1,embedded_text_hash=md5(chunk_text)', [model.split(':')[1]]);
      await softDeleteSource(engine, 'default');
      const snapshot = () => engine.executeRaw('SELECT to_jsonb(cc) AS row FROM content_chunks cc');
      const before = await snapshot();
      try {
        const result = await applyEmbeddingMigration(engine, await planEmbeddingMigration(engine, { to: model, dim: dimensions }));
        expect(await snapshot()).toEqual(before);
        expect(result.status).toBe('applied');
      } finally { await engine.executeRaw("UPDATE sources SET archived=false,archived_at=NULL,archive_expires_at=NULL WHERE id='default'"); }
    });
    test('legacy unsealed and already-zero pages recover through canonical projection before embedding', async () => {
      await engine.putPage('synthetic-recovery', { type: 'note', title: 'Synthetic recovery', compiled_truth: 'Canonical synthetic recovery content.' });
      await engine.upsertChunks('synthetic-recovery', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Obsolete projection content', token_count: 4 }]);
      expect(await readProjectionSnapshot(engine, 'synthetic-recovery', 'default')).toBeNull();
      const plan = await planEmbeddingMigration(engine, { to: model, dim: dimensions });
      expect(plan.blocked_projection_pages).toBe(1);
      expect((await applyEmbeddingMigration(engine, plan)).status).toBe('applied');
      const ready = await readProjectionSnapshot(engine, 'synthetic-recovery', 'default');
      expect(ready).not.toBeNull();
      expect(ready!.chunks.map(c => c.chunk_text).join(' ')).toContain('Canonical synthetic recovery content.');
      expect(ready!.chunks.map(c => c.chunk_text).join(' ')).not.toContain('Obsolete');
      const result = await embedStaleForSource(engine, 'default', { embeddingSignature: `${model}:${dimensions}` });
      expect(result.embedded).toBeGreaterThan(0);
      expect(result.done).toBe(true);
      expect(result.remaining).toBe(0);
    });
    test('same-width migration counts and repairs facts with unknown generation, but skips TTL and audit rows', async () => {
      const fact = await engine.insertFact({ fact: 'Synthetic active claim', source: 'synthetic', embedding: new Float32Array(dimensions).fill(0.1) }, { source_id: 'default' });
      await engine.insertFact({ fact: 'Synthetic expired claim', source: 'synthetic', valid_until: new Date(0) }, { source_id: 'default' });
      await engine.insertFact({ fact: 'Synthetic audit row', source: AUDIT_ROW_SOURCES[0] }, { source_id: 'default' });
      const plan = await planEmbeddingMigration(engine, { to: model, dim: dimensions });
      expect(plan.facts_to_embed).toBe(1);
      expect((await verifyMigrationComplete(engine, { toModel: model, toDims: dimensions }, { envMatchesTarget: true })).complete).toBe(false);
      const result = await embedStaleFacts(engine, { sourceId: 'default', yes: true, maxCostUsd: 1 });
      expect(result).toMatchObject({ embedded: 1, remaining: 0, stopped: 'complete' });
      const [row] = await engine.executeRaw<{ embedding_model: string; current: boolean }>('SELECT embedding_model, embedded_text_hash=md5(fact) AS current FROM facts WHERE id=$1', [fact.id]);
      expect(row).toEqual({ embedding_model: model, current: true });
      expect((await countStaleFactEmbeddings(engine, model, dimensions)).count).toBe(0);
    });
    test('fact changes during provider work cannot install a late vector', async () => {
      const fact = await engine.insertFact({ fact: 'Synthetic concurrent claim', source: 'synthetic' }, { source_id: 'default' });
      __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
        await engine.expireFact(fact.id);
        return { values, warnings: [], embeddings: values.map(() => new Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
      });
      const result = await embedStaleFacts(engine, { sourceId: 'default', yes: true, maxCostUsd: 1 });
      expect(result.embedded).toBe(0);
      expect(result.stopped).toBe('failed');
      expect((await engine.executeRaw<{ absent: boolean }>('SELECT embedding IS NULL AS absent FROM facts WHERE id=$1', [fact.id]))[0].absent).toBe(true);
    });
    test('nonfinite vectors never install and provider failure remains incomplete', async () => {
      await engine.insertFact({ fact: 'Synthetic invalid-vector claim', source: 'synthetic' }, { source_id: 'default' });
      __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({ values, warnings: [], embeddings: values.map(() => new Array(dimensions).fill(NaN)), usage: { tokens: 8 } }));
      const result = await embedStaleFacts(engine, { sourceId: 'default', yes: true, maxCostUsd: 1 });
      expect(result).toMatchObject({ embedded: 0, remaining: 1, stopped: 'failed' });
    });
    test('duplicate cosine lookup withholds unknown and incompatible same-width generations', async () => {
      for (const embedding_model of [undefined, 'other:model', model]) {
        await engine.insertFact({ fact: `Synthetic ${embedding_model ?? 'unknown'} generation`, entity_slug: 'synthetic-entity', source: 'synthetic', embedding: new Float32Array(dimensions).fill(0.1), embedding_model }, { source_id: 'default' });
      }
      const found = await engine.findCandidateDuplicates('default', 'synthetic-entity', 'Synthetic query', { embedding: new Float32Array(dimensions).fill(0.1), embeddingModel: model });
      expect(found).toHaveLength(1);
      expect(found[0].embedding_model).toBe(model);
      expect(await engine.findCandidateDuplicates('default', 'synthetic-entity', 'Synthetic query', { embedding: new Float32Array(dimensions).fill(0.1) })).toEqual([]);
    });
    test('authorization debits before dispatch and an interrupted request cannot reset on resume', async () => {
      const plan = await planEmbeddingMigration(engine, { to: model, dim: dimensions });
      const debit = await authorizeMigrationBudget(engine, plan, 0.001);
      await debit({ kind: 'embedding', operation: 'synthetic', model, maxInputTokens: 40_000 });
      const before = (await readMigrationState(engine)).state!.budget!;
      expect(before.requests).toBe(1);
      expect(before.debited_usd).toBeGreaterThan(0);
      const resume = await authorizeMigrationBudget(engine, plan, 0.001);
      await expect(resume({ kind: 'embedding', operation: 'synthetic', model, maxInputTokens: 40_000 })).rejects.toThrow();
      expect((await readMigrationState(engine)).state!.budget).toEqual(before);
    });
    test('facts-only brain completes through the full orchestrator and records authorization', async () => {
      await engine.insertFact({ fact: 'Synthetic facts-only claim', source: 'synthetic' }, { source_id: 'default' });
      const result = await flow();
      expect(result.status).toBe('completed');
      expect((await countStaleFactEmbeddings(engine, model, dimensions)).count).toBe(0);
      const receipt = JSON.parse((await engine.getConfig('embedding_migration.completed'))!);
      expect(receipt.budget.requests).toBeGreaterThan(0);
      expect(receipt.budget.debited_usd).toBeGreaterThan(0);
    });
    test('provider preflight outage preserves blocked page vectors and durable uncertain debit', async () => {
      await engine.putPage('synthetic-provider-outage', { type: 'note', title: 'Synthetic outage', compiled_truth: 'Synthetic content' });
      await engine.upsertChunks('synthetic-provider-outage', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic old projection', token_count: 4, embedding: new Float32Array(dimensions).fill(0.1) }]);
      const before = await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks ORDER BY id');
      __setEmbedTransportForTests(async () => { throw new Error('Synthetic provider unavailable'); });
      expect((await flow()).status).toBe('probe_failed');
      expect(await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks ORDER BY id')).toEqual(before);
      expect((await readMigrationState(engine)).state!.budget!.requests).toBe(1);
    });
    test('losing migration ownership during provider work refuses schema or fact installation', async () => {
      await engine.insertFact({ fact: 'Synthetic lease-loss claim', source: 'synthetic' }, { source_id: 'default' });
      __setEmbedTransportForTests(async ({ values }) => {
        await engine.executeRaw("UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id='gbrain-embedding-migration'");
        return { values, warnings: [], embeddings: values.map(() => new Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
      });
      expect((await flow()).status).toBe('probe_failed');
      expect((await countStaleFactEmbeddings(engine, model, dimensions)).count).toBe(1);
      await engine.executeRaw("DELETE FROM gbrain_cycle_locks WHERE id='gbrain-embedding-migration'");
    });
    test('source-enumeration failure never becomes an empty-brain migration', async () => {
      const original = engine.listAllSources.bind(engine);
      let calls = 0;
      __setEmbedTransportForTests(async () => { calls++; throw new Error('No provider calls permitted'); });
      engine.listAllSources = async () => { throw new Error('Synthetic census outage'); };
      try { expect((await flow()).status).toBe('apply_failed'); }
      finally { engine.listAllSources = original; }
      expect(calls).toBe(0);
      expect((await readMigrationState(engine)).state).toBeNull();
    });
    test('source creation during preflight stops the flow before destructive work', async () => {
      __setEmbedTransportForTests(async ({ values }) => {
        await engine.executeRaw("INSERT INTO sources(id,name) VALUES('synthetic-new-source','Synthetic source')");
        return { values, warnings: [], embeddings: values.map(() => new Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
      });
      try {
        expect((await flow()).status).toBe('probe_failed');
        expect(await engine.getConfig('embedding_migration.completed')).toBeNull();
      } finally { await engine.executeRaw("DELETE FROM sources WHERE id='synthetic-new-source'"); }
    });
    test('lease loss during the fact phase cannot install or mark complete', async () => {
      await engine.insertFact({ fact: 'Synthetic fact-phase claim', source: 'synthetic' }, { source_id: 'default' });
      let calls = 0;
      __setEmbedTransportForTests(async ({ values }) => {
        if (++calls === 2) await engine.executeRaw("UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id='gbrain-embedding-migration'");
        return { values, warnings: [], embeddings: values.map(() => new Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
      });
      try {
        expect((await flow()).status).toBe('apply_failed');
        expect(calls).toBe(2);
        expect((await countStaleFactEmbeddings(engine, model, dimensions)).count).toBe(1);
        expect(await engine.getConfig('embedding_migration.completed')).toBeNull();
      } finally { await engine.executeRaw("DELETE FROM gbrain_cycle_locks WHERE id='gbrain-embedding-migration'"); }
    });
    test('uncertain attempts remain charged while unknown pricing refuses dispatch', async () => {
      const plan = await planEmbeddingMigration(engine, { to: model, dim: dimensions });
      const debit = await authorizeMigrationBudget(engine, plan, 1, [], 'synthetic:unpriced');
      let calls = 0;
      for (const failure of ['Synthetic timeout', 'Synthetic 429']) {
        await expect(withAIInvocationGuard(debit, () => invokeAI({ kind: 'embedding', operation: 'synthetic', model, maxInputTokens: 100 }, async () => {
          calls++;
          throw new Error(failure);
        }, () => null))).rejects.toThrow(failure);
      }
      const before = (await readMigrationState(engine)).state!.budget!;
      expect(before.requests).toBe(2);
      expect(before.debited_usd).toBeGreaterThan(0);
      await expect(withAIInvocationGuard(debit, () => invokeAI({ kind: 'rerank', operation: 'synthetic', model: 'synthetic:unpriced', maxInputTokens: 100 }, async () => { calls++; }, () => null))).rejects.toThrow();
      expect(calls).toBe(2);
      expect((await readMigrationState(engine)).state!.budget).toEqual(before);
    });
    test('actual page vector search withholds incompatible and unknown same-width generations', async () => {
      for (const [slug, generation] of [['synthetic-current', model], ['synthetic-old', 'other:model'], ['synthetic-unknown', '']] as const) {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: slug, token_count: 4, embedding: new Float32Array(dimensions).fill(0.1) }]);
        await engine.executeRaw('UPDATE content_chunks SET model=$1,embedded_text_hash=md5(chunk_text) WHERE page_id=(SELECT id FROM pages WHERE source_id=$2 AND slug=$3)', [generation, 'default', slug]);
      }
      const query = () => engine.searchVector(new Float32Array(dimensions).fill(0.1), {
        sourceId: 'default', embeddingColumn: { name: 'embedding', type: 'vector', dimensions, embeddingModel: model },
      });
      expect((await query()).map(row => row.slug)).toEqual(['synthetic-current']);
      await engine.setConfig('embedding_migration.state', JSON.stringify({ to_model: model, to_dims: dimensions }));
      expect((await query()).map(row => row.slug)).toEqual(['synthetic-current']);
    });
    test('unsupported projection refuses invalidation while preserving existing vectors', async () => {
      await engine.putPage('synthetic-media', { type: 'note', title: 'Synthetic media', compiled_truth: 'Synthetic retained content' });
      await engine.upsertChunks('synthetic-media', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic retained projection', token_count: 4, embedding: new Float32Array(dimensions).fill(0.1) }]);
      await engine.executeRaw("UPDATE pages SET page_kind='image' WHERE source_id='default' AND slug='synthetic-media'");
      const before = await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks ORDER BY id');
      const result = await applyEmbeddingMigration(engine, await planEmbeddingMigration(engine, { to: model, dim: dimensions }));
      expect(result.status).toBe('failed');
      expect(await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks ORDER BY id')).toEqual(before);
    });
    test('a text migration does not suppress the independent image vector column', async () => {
      await engine.putPage('synthetic-image-vector', { type: 'note', title: 'Synthetic image vector', compiled_truth: 'Synthetic image-vector holder' });
      await installFixtureChunks(engine, 'synthetic-image-vector', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic image-vector holder', token_count: 4 }]);
      const [column] = await engine.executeRaw<{ dimensions: number }>("SELECT atttypmod AS dimensions FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding_image'");
      const vector = new Float32Array(column.dimensions).fill(0.1);
      await engine.executeRaw("UPDATE content_chunks SET embedding_image=$1::vector,modality='image'", [`[${Array.from(vector).join(',')}]`]);
      await engine.setConfig('embedding_migration.state', JSON.stringify({ to_model: model, to_dims: dimensions }));
      const found = await engine.searchVector(vector, { sourceId: 'default', embeddingColumn: { name: 'embedding_image', type: 'vector', dimensions: column.dimensions, embeddingModel: 'synthetic:image-model' } });
      expect(found.map(row => row.slug)).toEqual(['synthetic-image-vector']);
    });
    test('archived unsealed projections refuse a destructive transition without losing vectors', async () => {
      await engine.putPage('synthetic-archived', { type: 'note', title: 'Synthetic archived', compiled_truth: 'Synthetic archived content' });
      await engine.upsertChunks('synthetic-archived', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic archived projection', embedding: new Float32Array(dimensions).fill(0.1) }]);
      await engine.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
      const before = await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks');
      try {
        const plan = await planEmbeddingMigration(engine, { to: model, dim: dimensions * 2 });
        expect((await applyEmbeddingMigration(engine, plan)).status).toBe('failed');
        expect(await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks')).toEqual(before);
      } finally { await engine.executeRaw("UPDATE sources SET archived=false WHERE id='default'"); }
    });
    for (const scenario of ['archived-page-same-width', 'archived-page-width', 'archived-fact-same-width', 'archived-fact-width', 'skip-page-width', 'media-page-width', 'deleted-page-width']) {
      test(`retained vector refusal: ${scenario}`, async () => {
        const archived = scenario.startsWith('archived');
        const factOnly = scenario.includes('fact');
        const targetDim = scenario.endsWith('same-width') ? dimensions : dimensions * 2;
        if (factOnly) {
          await engine.insertFact({ fact: 'Synthetic retained archived claim', source: 'synthetic', embedding: new Float32Array(dimensions).fill(0.2) }, { source_id: 'default' });
        } else {
          await engine.putPage('synthetic-retained', { type: 'note', title: 'Synthetic retained', compiled_truth: 'Synthetic retained content',
            ...(scenario.startsWith('skip') && { frontmatter: { embed_skip: true } }) });
          if (scenario.startsWith('media')) await engine.executeRaw("UPDATE pages SET page_kind='image'");
          await installFixtureChunks(engine, 'synthetic-retained', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic retained content', embedding: new Float32Array(dimensions).fill(0.1) }]);
          await engine.executeRaw('UPDATE pages SET embedding_signature=$1', [`${model}:${dimensions}`]);
          await engine.executeRaw('UPDATE content_chunks SET model=$1,embedded_text_hash=md5(chunk_text)', [model]);
          expect((await engine.executeRaw('SELECT id FROM pages WHERE text_projection_revision=knowledge_revision')).length).toBe(1);
          if (scenario.startsWith('media')) await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL');
          if (scenario.startsWith('deleted')) await engine.executeRaw('UPDATE pages SET deleted_at=now()');
        }
        if (archived) await engine.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
        const snapshot = async () => Promise.all(['pages', 'content_chunks', 'facts', 'config'].map(table =>
          engine.executeRaw(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)));
        try {
          expect((await prepareEmbeddingProjections(engine)).blocked).toBe(scenario.startsWith('media') ? 1 : 0);
          if (factOnly) expect((await countStaleFactEmbeddings(engine, 'openai:text-embedding-3-large', targetDim)).count).toBe(0);
          const before = await snapshot();
          let fileWrites = 0;
          const result = await applyEmbeddingMigration(engine,
            await planEmbeddingMigration(engine, { to: 'openai:text-embedding-3-large', dim: targetDim }),
            { persistConfig: () => { fileWrites++; } });
          expect(await snapshot()).toEqual(before);
          expect(fileWrites).toBe(0);
          expect(result.status).toBe('failed');
          if (result.status === 'failed') expect(result.reason).toContain('retained_vectors_blocked');
          expect((await readContentChunksEmbeddingDim(engine)).dims).toBe(dimensions);
        } finally {
          await engine.executeRaw("UPDATE sources SET archived=false WHERE id='default'");
          await truncateCascade(engine, ['facts', 'pages']);
          await runSchemaTransition(engine, dimensions);
        }
      });
    }
    for (const phase of ['after-plan', 'before-ddl', 'before-companions']) {
      test(`retained vector refusal after normal archive ${phase}`, async () => {
        const factOnly = phase === 'before-companions';
        if (factOnly) await engine.insertFact({ fact: 'Synthetic late archive fact', source: 'synthetic', embedding: new Float32Array(dimensions).fill(0.2) }, { source_id: 'default' });
        else {
          await engine.putPage('late-archive', { type: 'note', title: 'Synthetic late archive', compiled_truth: 'Synthetic late archive' });
          await installFixtureChunks(engine, 'late-archive', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic late archive', embedding: new Float32Array(dimensions).fill(0.1) }]);
        }
        const plan = await planEmbeddingMigration(engine, { to: 'openai:text-embedding-3-large', dim: factOnly ? dimensions : dimensions * 2 });
        const vectors = async () => Promise.all([
          engine.executeRaw('SELECT embedding::text,model,embedded_text_hash FROM content_chunks ORDER BY id'),
          engine.executeRaw('SELECT embedding::text,embedding_model,embedded_text_hash FROM facts ORDER BY id'),
          engine.executeRaw("SELECT key,value FROM config WHERE key IN ('embedding_model','embedding_dimensions') ORDER BY key"),
        ]);
        const before = await vectors();
        const identity = await engine.executeRaw("SELECT incarnation::text FROM sources WHERE id='default'");
        let archived = false, fileWrites = 0;
        const archive = async () => { expect(await softDeleteSource(engine, 'default')).not.toBeNull(); archived = true; };
        const raced = new Proxy(engine, { get(target, key) {
          if (key === 'executeRaw' && phase === 'before-ddl') return async (sql: string, params?: unknown[]) => {
            if (!archived && sql.includes('format_type') && await target.getConfig('embedding_migration.state')) await archive();
            return target.executeRaw(sql, params);
          };
          if (key === 'transaction' && phase === 'before-companions') return async (fn: (tx: BrainEngine) => Promise<unknown>) => {
            let invalidation = false;
            const observe = (tx: BrainEngine): BrainEngine => new Proxy(tx, { get(inner, field) {
              if (field === 'executeRaw') return async (sql: string, params?: unknown[]) => {
                if (sql.includes('UPDATE content_chunks cc')) invalidation = true;
                return inner.executeRaw(sql, params);
              };
              if (field === 'transaction') return (nested: (tx: BrainEngine) => Promise<unknown>) =>
                inner.transaction(tx => nested(observe(tx)));
              const value = Reflect.get(inner, field); return typeof value === 'function' ? value.bind(inner) : value;
            } });
            const result = await target.transaction(tx => fn(observe(tx)));
            if (invalidation && !archived) await archive();
            return result;
          };
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
        try {
          if (phase === 'after-plan') await archive();
          const result = await applyEmbeddingMigration(raced, plan, { persistConfig: () => { fileWrites++; } });
          expect(archived).toBe(true);
          expect(await vectors()).toEqual(before);
          expect(await engine.executeRaw("SELECT incarnation::text FROM sources WHERE id='default'")).toEqual(identity);
          expect(result).toMatchObject({ status: 'failed' });
          if (result.status === 'failed') expect(result.reason).toContain('retained_vectors_blocked');
          expect(fileWrites).toBe(0);
          expect((await readContentChunksEmbeddingDim(engine)).dims).toBe(dimensions);
        } finally { await engine.executeRaw("UPDATE sources SET archived=false,archived_at=NULL,archive_expires_at=NULL WHERE id='default'"); }
      });
    }
    for (const phase of ['before-provider', 'during-provider']) {
      test(`retained vector flow refusal ${phase} preserves vectors and configuration`, async () => {
        await engine.insertFact({ fact: 'Synthetic guarded flow fact', source: 'synthetic', embedding: new Float32Array(dimensions).fill(0.2) }, { source_id: 'default' });
        const before = await engine.executeRaw('SELECT to_jsonb(f) AS row FROM facts f');
        const beforeConfig = await engine.executeRaw('SELECT key,value FROM config ORDER BY key');
        if (phase === 'before-provider') await softDeleteSource(engine, 'default');
        let calls = 0;
        __setEmbedTransportForTests(async ({ values }) => {
          calls++;
          if (phase === 'during-provider') await softDeleteSource(engine, 'default');
          return { values, warnings: [], embeddings: values.map(() => Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
        });
        try {
          const result = await flow(1, 'openai:text-embedding-3-large');
          expect(result.status).toBe(phase === 'before-provider' ? 'apply_failed' : 'probe_failed');
          expect(calls).toBe(phase === 'before-provider' ? 0 : 1);
          expect(await engine.executeRaw('SELECT to_jsonb(f) AS row FROM facts f')).toEqual(before);
          expect(await engine.getConfig('embedding_model')).toBe(model);
          expect(await engine.getConfig('embedding_dimensions')).toBe(String(dimensions));
          if (phase === 'before-provider') expect(await engine.executeRaw('SELECT key,value FROM config ORDER BY key')).toEqual(beforeConfig);
          else expect((await readMigrationState(engine)).state?.budget?.requests).toBe(1);
        } finally { await engine.executeRaw("UPDATE sources SET archived=false,archived_at=NULL,archive_expires_at=NULL WHERE id='default'"); }
      });
    }
    test('retained vector guard preserves archived takes and refuses destructive companion changes', async () => {
      await engine.putPage('retained-take', { type: 'note', title: 'Synthetic retained take', compiled_truth: '' });
      await engine.executeRaw(`INSERT INTO takes(page_id,row_num,claim,kind,holder,embedding)
        SELECT id,0,'Synthetic retained take','take','self',
          ('[' || array_to_string(array_fill(0.1::real, ARRAY[(SELECT atttypmod FROM pg_attribute WHERE attrelid='takes'::regclass AND attname='embedding')]), ',') || ']')::vector
        FROM pages WHERE slug='retained-take' AND source_id='default'`);
      await softDeleteSource(engine, 'default');
      const before = await engine.executeRaw('SELECT embedding::text FROM takes');
      try {
        const result = await applyEmbeddingMigration(engine, await planEmbeddingMigration(engine, { to: 'openai:text-embedding-3-large', dim: dimensions * 2 }));
        expect(result).toMatchObject({ status: 'failed' });
        if (result.status === 'failed') expect(result.reason).toContain('retained_vectors_blocked');
        expect(await engine.executeRaw('SELECT embedding::text FROM takes')).toEqual(before);
        expect((await readContentChunksEmbeddingDim(engine)).dims).toBe(dimensions);
        // #5885: takes.embedding moves with the text columns, so a raw width
        // transition refuses to drop a retained (archived) take vector.
        await expect(runSchemaTransition(engine, dimensions * 2)).rejects.toThrow('retained_vectors_blocked');
        expect(await engine.executeRaw('SELECT embedding::text FROM takes')).toEqual(before);
        expect((await readContentChunksEmbeddingDim(engine)).dims).toBe(dimensions);
      } finally {
        await engine.executeRaw("UPDATE sources SET archived=false,archived_at=NULL,archive_expires_at=NULL WHERE id='default'");
        await runSchemaTransition(engine, dimensions);
      }
    });
    test('retained vector guard distinguishes intentionally retired fact vectors', async () => {
      for (const [fact, source, valid_until] of [['Synthetic expired', 'synthetic', new Date(0)], ['Synthetic audit', AUDIT_ROW_SOURCES[0], undefined], ['Synthetic withdrawn', 'synthetic', undefined]] as const) {
        await engine.insertFact({ fact, source, valid_until, embedding: new Float32Array(dimensions).fill(0.2) }, { source_id: 'default' });
      }
      await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) SELECT source_id,visibility,gbrain_fact_fingerprint(fact) FROM facts WHERE fact='Synthetic withdrawn'");
      await softDeleteSource(engine, 'default');
      try {
        const result = await applyEmbeddingMigration(engine, await planEmbeddingMigration(engine, { to: 'openai:text-embedding-3-large', dim: dimensions * 2 }));
        expect(result.status).toBe('applied');
        expect((await engine.executeRaw('SELECT id FROM facts WHERE embedding IS NOT NULL')).length).toBe(0);
        expect((await countStaleFactEmbeddings(engine, 'openai:text-embedding-3-large', dimensions * 2)).count).toBe(0);
      } finally {
        await engine.executeRaw("UPDATE sources SET archived=false,archived_at=NULL,archive_expires_at=NULL WHERE id='default'");
        await truncateCascade(engine, ['facts', 'fact_withdrawals', 'pages']);
        await runSchemaTransition(engine, dimensions);
      }
    });
    test('retained vector guard fails closed on unreadable registry or unknown counts', async () => {
      for (const failure of ['registry', 'catalog', 'dimension', 'census', 'missing-key', 'negative', 'nonnumeric']) {
        const before = await engine.executeRaw('SELECT key,value FROM config ORDER BY key');
        await expect(engine.transaction(tx => assertRetainedEmbeddingRebuildability(new Proxy(tx, { get(target, key) {
          if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
            if (failure === 'registry' && sql.includes("SELECT key,value FROM config WHERE key IN")) throw new Error('Synthetic registry failure');
            if (failure === 'catalog' && sql.includes("FROM pg_attribute WHERE attrelid='content_chunks'")) return [];
            if (failure === 'dimension' && sql.includes("FROM pg_attribute WHERE attrelid='content_chunks'")) return [{ name: 'page_id', type: 'integer' }, { name: 'embedding', type: 'text' }];
            if (failure === 'census' && sql.includes('AS pages')) return [];
            if (failure === 'missing-key' && sql.includes('AS pages')) return [{ pages: 0, facts: 0, wrong: 0 }];
            if (failure === 'negative' && sql.includes('AS pages')) return [{ pages: -1, facts: 0, takes: 0 }];
            if (failure === 'nonnumeric' && sql.includes('AS pages')) return [{ pages: '0', facts: 0, takes: 0 }];
            return target.executeRaw(sql, params);
          };
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } }), dimensions, model))).rejects.toThrow('retained_vector_check_failed');
        expect(await engine.executeRaw('SELECT key,value FROM config ORDER BY key')).toEqual(before);
      }
    });
    test('cursor EOF does not masquerade as completed work after a provider failure', async () => {
      await engine.putPage('synthetic-failed', { type: 'note', title: 'Synthetic failed', compiled_truth: 'Synthetic pending content' });
      await installFixtureChunks(engine, 'synthetic-failed', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic pending content', token_count: 4 }]);
      const result = await embedStaleForSource(engine, 'default', { embedFn: async () => { throw new Error('Synthetic provider failure'); } });
      expect(result).toMatchObject({ done: true, complete: false, embedded: 0, failures: 1, remaining: 1 });
    });
    test('a lowered authorization never silently reuses the previous higher cap', async () => {
      const plan = await planEmbeddingMigration(engine, { to: model, dim: dimensions });
      const debit = await authorizeMigrationBudget(engine, plan, 1);
      await debit({ kind: 'embedding', operation: 'synthetic', model, maxInputTokens: 100 });
      const before = (await readMigrationState(engine)).state!.budget!.debited_usd;
      const paused = await authorizeMigrationBudget(engine, plan, 0);
      await expect(paused({ kind: 'embedding', operation: 'synthetic', model, maxInputTokens: 100 })).rejects.toThrow();
      expect((await readMigrationState(engine)).state!.budget).toMatchObject({ max_cost_usd: 0, debited_usd: before, requests: 1 });
    });
    test('fresh cycle facts retain their captured vector identity and enter dedup without repair', async () => {
      const slug = 'people/synthetic-cycle-identity';
      await engine.putPage(slug, { type: 'person', title: 'Synthetic cycle identity', compiled_truth: renderFactsTable([{
        rowNum: 1, claim: 'Synthetic cycle-produced claim', kind: 'fact', confidence: 1,
        visibility: 'world', notability: 'medium', source: 'synthetic', active: true,
      }]) });
      let calls = 0;
      const vector = new Float32Array(dimensions).fill(0.1);
      __setEmbedTransportForTests(async ({ values, model: provider, providerOptions }) => {
        calls++;
        expect(typeof provider === 'string' ? provider : provider.modelId).toBe('text-embedding-3-small');
        expect(providerOptions?.openai?.dimensions).toBe(dimensions);
        configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dimensions * 2, env: { OPENAI_API_KEY: 'synthetic-only' } });
        return { values, warnings: [], embeddings: values.map(() => Array.from(vector)), usage: { tokens: 8 } };
      });
      const result = await runExtractFacts(engine, { slugs: [slug], sourceId: 'default' });
      expect(result.factsInserted).toBe(1);
      expect(result.warnings).toEqual([]);
      expect(calls).toBe(1);
      const [fact] = await engine.executeRaw<{ present: boolean; embedding_model: string; current: boolean; dimensions: number }>(
        'SELECT embedding IS NOT NULL AS present,embedding_model,embedded_text_hash=md5(fact) AS current,vector_dims(embedding) AS dimensions FROM facts WHERE source_id=$1 AND entity_slug=$2', ['default', slug]);
      expect(fact).toEqual({ present: true, embedding_model: model, current: true, dimensions });
      expect((await countStaleFactEmbeddings(engine, model, dimensions)).count).toBe(0);
      expect(await engine.findCandidateDuplicates('default', slug, 'Synthetic query', { embedding: vector, embeddingModel: model })).toHaveLength(1);
    });
    test('stale projection recovery preserves grandfathered vectors until explicitly widened', async () => {
      const slug = 'synthetic-grandfathered-projection';
      await engine.putPage(slug, { type: 'note', title: 'Synthetic grandfathered projection', compiled_truth: 'Synthetic current canonical body' });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic legacy projected body', embedding: new Float32Array(dimensions).fill(0.1) }]);
      const before = await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks');
      let calls = 0;
      __setEmbedTransportForTests(async ({ values }) => {
        calls++;
        return { values, warnings: [], embeddings: values.map(() => Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
      });
      expect((await runEmbedCore(engine, { stale: true, quiet: true })).embedded).toBe(0);
      expect(calls).toBe(0);
      expect(await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks')).toEqual(before);
      expect(await readProjectionSnapshot(engine, slug, 'default')).toBeNull();
      expect((await runEmbedCore(engine, { stale: true, quiet: true, includeNullSignature: true })).embedded).toBeGreaterThan(0);
      expect(calls).toBeGreaterThan(0);
      expect(await readProjectionSnapshot(engine, slug, 'default')).not.toBeNull();
    });
    test.each(['before preflight', 'during probe'] as const)('stale projection recovery stops when aborted %s', async phase => {
      const slug = 'synthetic-aborted-projection';
      await engine.putPage(slug, { type: 'note', title: 'Synthetic aborted projection', compiled_truth: 'Synthetic current canonical body' });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic pending projected body' }]);
      const before = await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks');
      const jobs = await engine.executeRaw('SELECT * FROM page_projection_jobs');
      const controller = new AbortController();
      let calls = 0;
      if (phase === 'before preflight') controller.abort();
      __setEmbedTransportForTests(async ({ values }) => {
        calls++;
        controller.abort();
        return { values, warnings: [], embeddings: values.map(() => Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
      });
      const result = await runEmbedCore(engine, { stale: true, quiet: true, signal: controller.signal });
      expect(result.embedded).toBe(0);
      expect(result.failures).toBe(0);
      expect(calls).toBe(phase === 'before preflight' ? 0 : 1);
      expect(await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks')).toEqual(before);
      expect(await engine.executeRaw('SELECT * FROM page_projection_jobs')).toEqual(jobs);
      expect(await readProjectionSnapshot(engine, slug, 'default')).toBeNull();
    });
    test.each(['stale', 'migration', 'standalone'] as const)('one %s invocation repairs and embeds more than one bounded projection batch', async mode => {
      for (let i = 0; i < 103; i++) {
        const slug = `synthetic-multi-batch-${i}`;
        await engine.putPage(slug, { type: 'note', title: 'Synthetic recovery batch', compiled_truth: `Synthetic canonical batch body ${i}` });
        await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `Synthetic obsolete projected body ${i}` }]);
      }
      if (mode === 'stale') {
        const result = await runEmbedCore(engine, { stale: true, quiet: true, catchUp: true });
        expect(result.embedded).toBe(103);
        expect(result.failures).toBe(0);
      } else if (mode === 'migration') {
        expect((await flow()).status).toBe('completed');
      } else {
        const result = await embedStaleForSource(engine, 'default', { embeddingSignature: `${model}:${dimensions}` });
        expect(result.embedded).toBe(103);
        expect(result.complete).toBe(true);
      }
      expect(await prepareEmbeddingProjections(engine)).toEqual({ rebuilt: 0, blocked: 0 });
      expect(await engine.countStaleChunks()).toBe(0);
    }, 60_000);
    test.each([false, true])('standalone recovery refuses grandfathered paid work with signature=%s', async withSignature => {
      const slug = 'synthetic-standalone-grandfather';
      await engine.putPage(slug, { type: 'note', title: 'Synthetic legacy page', compiled_truth: 'Synthetic current body' });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic prior body', embedding: new Float32Array(dimensions).fill(0.1) }]);
      const before = await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks');
      let calls = 0;
      const result = await embedStaleForSource(engine, 'default', {
        embeddingSignature: withSignature ? `${model}:${dimensions}` : undefined,
        embedFn: async texts => { calls++; return texts.map(() => new Float32Array(dimensions).fill(0.1)); },
      });
      expect(result.embedded).toBe(0);
      expect(calls).toBe(0);
      expect(await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks')).toEqual(before);
      expect(await readProjectionSnapshot(engine, slug, 'default')).toBeNull();
    });
    test.each(['before preflight', 'during probe', 'expired deadline'] as const)('standalone recovery honors cancellation %s', async phase => {
      const slug = 'synthetic-standalone-abort';
      await engine.putPage(slug, { type: 'note', title: 'Synthetic pending page', compiled_truth: 'Synthetic current body' });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic prior body' }]);
      const before = await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks');
      const jobs = await engine.executeRaw('SELECT * FROM page_projection_jobs');
      const controller = new AbortController();
      if (phase === 'before preflight') controller.abort();
      const executeRaw = engine.executeRaw;
      let queries = 0;
      let calls = 0;
      engine.executeRaw = async function (...args: Parameters<BrainEngine['executeRaw']>) {
        queries++;
        return executeRaw.apply(this, args) as never;
      };
      try {
        const result = await embedStaleForSource(engine, 'default', {
          embeddingSignature: `${model}:${dimensions}`, signal: controller.signal,
          deadline: phase === 'expired deadline' ? Date.now() - 1 : undefined,
          embedFn: async texts => { calls++; controller.abort(); return texts.map(() => new Float32Array(dimensions).fill(0.1)); },
        });
        expect(result.aborted).toBe(true);
        expect(result.embedded).toBe(0);
        expect(calls).toBe(phase === 'during probe' ? 1 : 0);
        if (phase !== 'during probe') expect(queries).toBe(0);
      } finally { engine.executeRaw = executeRaw; }
      expect(await engine.executeRaw('SELECT embedding::text,chunk_text FROM content_chunks')).toEqual(before);
      expect(await engine.executeRaw('SELECT * FROM page_projection_jobs')).toEqual(jobs);
      expect(await readProjectionSnapshot(engine, slug, 'default')).toBeNull();
    });
    test('standalone recovery refuses installation after its source lease is lost during the probe', async () => {
      const slug = 'synthetic-standalone-lease';
      await engine.putPage(slug, { type: 'note', title: 'Synthetic lease page', compiled_truth: 'Synthetic current body' });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic prior body' }]);
      const lock = (await tryAcquireDbLock(engine, 'synthetic-standalone-lease', 1))!;
      let calls = 0;
      try {
        await expect(embedStaleForSource(engine, 'default', {
          embeddingSignature: `${model}:${dimensions}`,
          assertOwned: tx => assertMigrationLeases(tx ?? engine, [lock]),
          embedFn: async texts => {
            calls++;
            await engine.executeRaw('UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id=$1', [lock.id]);
            return texts.map(() => new Float32Array(dimensions).fill(0.1));
          },
        })).rejects.toThrow('lease lost');
        expect(calls).toBe(1);
        expect(await readProjectionSnapshot(engine, slug, 'default')).toBeNull();
        expect((await engine.getChunks(slug, { includeUnsealed: true }))[0].chunk_text).toBe('Synthetic prior body');
      } finally { await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [lock.id]); }
    });
    test('background handler repairs and embeds pending pages under its actual source lease', async () => {
      for (let i = 0; i < 3; i++) {
        const slug = `synthetic-background-recovery-${i}`;
        await engine.putPage(slug, { type: 'note', title: 'Synthetic background page', compiled_truth: `Synthetic current body ${i}` });
        await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `Synthetic prior body ${i}` }]);
      }
      const controller = new AbortController();
      const result = await makeEmbedBackfillHandler(engine)({
        id: 1, name: 'embed-backfill', data: { sourceId: 'default' }, attempts_made: 0,
        signal: controller.signal, shutdownSignal: controller.signal, deadlineAtMs: Date.now() + 60_000,
        isActive: async () => true, updateProgress: async () => {}, updateTokens: async () => {},
        log: async () => {}, readInbox: async () => [],
      });
      expect(result.status).toBe('success');
      expect(result.embedded).toBe(3);
      expect(await engine.countStaleChunks()).toBe(0);
      expect(await prepareEmbeddingProjections(engine)).toEqual({ rebuilt: 0, blocked: 0 });
      expect(await engine.executeRaw("SELECT id FROM gbrain_cycle_locks WHERE id='gbrain-embed-backfill:default'")).toHaveLength(0);
    });
    test('an expired stale budget prevents probing or repairing pending projections', async () => {
      const slug = 'synthetic-expired-projection';
      await engine.putPage(slug, { type: 'note', title: 'Synthetic deadline', compiled_truth: 'Synthetic current canonical body' });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic obsolete projected body' }]);
      let calls = 0;
      __setEmbedTransportForTests(async ({ values }) => {
        calls++;
        return { values, warnings: [], embeddings: values.map(() => Array(dimensions).fill(0.1)), usage: { tokens: 8 } };
      });
      const result = await withEnv({ GBRAIN_EMBED_TIME_BUDGET_MS: '0' }, () => runEmbedCore(engine, { stale: true, quiet: true }));
      expect(result.embedded).toBe(0);
      expect(calls).toBe(0);
      expect(await prepareEmbeddingProjections(engine, { repair: true, deadline: Date.now() - 1 })).toEqual({ rebuilt: 0, blocked: 1 });
      expect(await readProjectionSnapshot(engine, slug, 'default')).toBeNull();
      expect((await engine.getChunks(slug, { includeUnsealed: true }))[0].chunk_text).toBe('Synthetic obsolete projected body');
    });
    test('multi-batch projection recovery stops on cancellation and resumes the remaining work', async () => {
      for (let i = 0; i < 103; i++) {
        const slug = `synthetic-cancel-batch-${i}`;
        await engine.putPage(slug, { type: 'note', title: 'Synthetic cancellable batch', compiled_truth: `Synthetic canonical batch body ${i}` });
        await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `Synthetic obsolete projected body ${i}` }]);
      }
      const controller = new AbortController();
      let installed = 0;
      const interrupted = await prepareEmbeddingProjections(engine, { repair: true, signal: controller.signal, assertOwned: async tx => {
        if (!tx) return;
        const [row] = await tx.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE text_projection_revision=knowledge_revision');
        installed = Math.max(installed, row.n);
        if (row.n >= 101) controller.abort();
      } });
      expect(controller.signal.aborted).toBe(true);
      expect(installed).toBe(101);
      expect(interrupted).toEqual({ rebuilt: 100, blocked: 3 });
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE chunk_text LIKE $1', ['Synthetic obsolete%']))[0].n).toBe(3);
      const resumed = await runEmbedCore(engine, { stale: true, quiet: true, catchUp: true });
      expect(resumed.embedded).toBe(103);
      expect(resumed.failures).toBe(0);
      expect(await prepareEmbeddingProjections(engine)).toEqual({ rebuilt: 0, blocked: 0 });
    }, 60_000);
    test.skipIf(kind !== 'postgres')('file publication holds the lease against a second PostgreSQL owner through the real publisher', async () => {
      const other = new PostgresEngine();
      await other.connect({ database_url: process.env.DATABASE_URL! });
      const home = mkdtempSync(join(tmpdir(), 'migration-publication-'));
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: kind, embedding_model: model, embedding_dimensions: dimensions }));
      const leaseId = 'synthetic-migration-publication';
      const lease = (await tryAcquireDbLock(engine, leaseId, 1))!;
      let takeover: Promise<void> | undefined;
      try {
        await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
          let publicationTx: BrainEngine | undefined;
          let blockedAtPublication = false;
          const winnerModel = 'openai:text-embedding-3-large';
          const result = await applyEmbeddingMigration(engine, await planEmbeddingMigration(engine, { to: model, dim: dimensions }), {
            assertOwned: async tx => {
              publicationTx = tx;
              await assertMigrationLeases(tx ?? engine, [lease]);
            },
            persistConfig: async (toModel, toDims) => {
              const started = Promise.withResolvers<number>();
              let takeoverFinished = false;
              takeover = other.transaction(async tx => {
                const [backend] = await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
                started.resolve(backend.pid);
                await tx.executeRaw('UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id=$1', [leaseId]);
                await tx.setConfig('embedding_model', winnerModel);
                await tx.setConfig('embedding_dimensions', String(dimensions));
                await persistEmbeddingFileConfig(winnerModel, dimensions);
              }).finally(() => { takeoverFinished = true; });
              const pid = await started.promise;
              for (let attempt = 0; attempt < 100; attempt++) {
                const [waiting] = await (publicationTx ?? engine).executeRaw<{ blocked: boolean }>(
                  'SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS blocked', [pid]);
                blockedAtPublication = waiting.blocked;
                if (blockedAtPublication || takeoverFinished) break;
                await Bun.sleep(10);
              }
              await persistEmbeddingFileConfig(toModel, toDims);
            },
          });
          await takeover;
          expect(result.status).toBe('applied');
          expect(loadConfigFileOnly()?.embedding_model).toBe(winnerModel);
          expect(getEmbeddingModel()).toBe(winnerModel);
          expect(await engine.getConfig('embedding_model')).toBe(winnerModel);
          expect(blockedAtPublication).toBe(true);
        });
      } finally {
        await takeover;
        await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [leaseId]);
        await other.disconnect();
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
}

if (backends.includes('pglite')) {
test('explicit archived admission: actual CLI refuses all three routes without leaking content or dispatching archives', async () => {
  const home = mkdtempSync(join(tmpdir(), 'explicit-archive-cli-'));
  const data = join(home, '.gbrain');
  mkdirSync(data);
  const database = join(data, 'brain.pglite');
  const calls = join(home, 'calls.jsonl');
  const preload = join(home, 'provider.ts');
  const privateBody = 'SYNTHETIC_ARCHIVED_CLI_BODY_NEVER_PRINT';
  const credential = 'synthetic-only-never-print';
  writeFileSync(join(data, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: database,
    embedding_model: model, embedding_dimensions: dimensions, openai_api_key: credential }));
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';
    import { __setEmbedTransportForTests } from ${JSON.stringify(join(import.meta.dir, '../src/core/ai/gateway.ts'))};
    globalThis.fetch = async () => { throw new Error('Synthetic fixture forbids network'); };
    __setEmbedTransportForTests(async ({values}) => {
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify(values)+'\\n');
      return { values, warnings: [], embeddings: values.map(() => Array(8).fill(0.1)), usage: { tokens: 8 } };
    });`);
  const engine = new PGLiteEngine();
  const snapshot = () => engine.executeRaw(`SELECT to_jsonb(p) AS page,
    (SELECT jsonb_agg(to_jsonb(cc) ORDER BY cc.id) FROM content_chunks cc WHERE cc.page_id=p.id) AS chunks
    FROM pages p WHERE source_id='synthetic-archive'`);
  const env = { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1' };
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', preload,
      join(import.meta.dir, '../src/cli.ts'), 'embed', ...args], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      resetGateway();
      configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: { OPENAI_API_KEY: credential } });
      await engine.connect({ database_path: database, embedding_dimensions: dimensions } as never);
      await engine.initSchema();
      await runSchemaTransition(engine, dimensions);
      await engine.setConfig('embedding_model', model);
      await engine.setConfig('embedding_dimensions', String(dimensions));
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('synthetic-archive','Synthetic archive')");
      for (const [sourceId, slug, text] of [['synthetic-archive', 'archived-target', privateBody], ['default', 'active-target', 'Synthetic active CLI control.']]) {
        await engine.putPage(slug, { type: 'note', title: 'Synthetic CLI control', compiled_truth: text }, { sourceId });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text }], { sourceId });
      }
      await engine.executeRaw("UPDATE sources SET archived=true WHERE id='synthetic-archive'");
      const before = await snapshot();
      await engine.disconnect();
      for (const args of [['archived-target'], ['--slugs', 'archived-target'], ['--all']]) {
        writeFileSync(calls, '');
        const dryRun = await run([...args, '--dry-run']);
        expect(dryRun.code).toBe(0);
        expect(readFileSync(calls, 'utf8')).toBe('');
        // An explicit backfill is paid work: authorized here so the archived-source refusal is what the run hits.
        const result = await run([...args, '--yes']);
        expect({ code: result.code, diagnostic: result.code === 1 ? '' : result.stderr }).toEqual({ code: 1, diagnostic: '' });
        expect(result.stderr).toContain('gbrain sources restore');
        expect(result.stdout + result.stderr).not.toContain(privateBody);
        expect(result.stdout + result.stderr).not.toContain(credential);
        const inputs: string[][] = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        expect(inputs.flat().some(text => text.includes(privateBody))).toBe(false);
        expect(inputs.length).toBe(args[0] === '--all' ? 1 : 0);
        await engine.connect({ database_path: database });
        expect(await snapshot()).toEqual(before);
        await engine.disconnect();
      }
      expect((await run(['active-target', '--yes'])).code).toBe(0);
    });
  } finally {
    await engine.disconnect();
    resetGateway();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);
}
