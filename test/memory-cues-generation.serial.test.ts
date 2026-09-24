import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { cancelMemoryCueBuild, cueSignature, getMemoryCueStatus, loadMemoryCueSettings, memoryCueColumn, previewMemoryCueBuild,
  recallMemoryCues, revalidateMemoryCueCandidates, resumeMemoryCueBuild, runMemoryCueBuild } from '../src/core/memory-cues/index.ts';
import { cueEvidence, cueProviders, cueVector, enrollCues, seedCuePage, startCueBuild } from './helpers/memory-cues.ts';
import { settleCueAttempt } from '../src/core/memory-cues/budget.ts';
import type { CueBuildRow } from '../src/core/memory-cues/builds.ts';
import { scheduleMemoryCuePage } from '../src/core/memory-cues/scheduling.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { cueSlots } from './helpers/memory-cues-wire.ts';

describe('durable memory cue generation', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
  afterAll(async () => { await engine.disconnect(); });

  test('disabled preview and recall neither create jobs nor invoke providers', async () => {
    await seedCuePage(engine);
    const preview = await previewMemoryCueBuild(engine, { sourceIds: ['default'] });
    expect(preview.reason).toBe('generation_disabled');
    expect((await recallMemoryCues(engine, cueVector(), { embeddingColumn: await memoryCueColumn(engine) })).status).toBe('skipped');
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  });

  test('publishes complete windows, returns only source evidence and revalidates in batch', async () => {
    await enrollCues(engine);
    const build = await startCueBuild(engine);
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId, providers: cueProviders })).toEqual({ status: 'complete', windowsProcessed: 1 });
    const opts = { embeddingColumn: await memoryCueColumn(engine) };
    const recall = await recallMemoryCues(engine, cueVector(), opts);
    expect(recall.status).toBe('ready');
    expect(recall.candidates[0]!.result.chunk_text).toBe(cueEvidence);
    expect(recall.candidates[0]!.result.source_id).toBe('default');
    expect(recall.candidates[0]!.result.cosine).toBeUndefined();
    expect(JSON.stringify(recall.candidates[0]!.result)).not.toContain('Scheduling an early meeting');
    expect(await revalidateMemoryCueCandidates(engine, recall.candidates, {})).toHaveLength(1);
    expect((await recallMemoryCues(engine, cueVector(), { ...opts, sourceIds: [] })).candidates).toHaveLength(0);
    expect((await getMemoryCueStatus(engine)).coverage).toContainEqual({ status: 'ready', count: 1 });
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId, providers: cueProviders })).toEqual({ status: 'not_claimed', windowsProcessed: 0 });
  });

  test('partial embed never publishes, and retry preserves owner and spent reservation', async () => {
    const build = await startCueBuild(engine);
    const outcome = await runMemoryCueBuild(engine, { buildId: build.buildId, providers: { ...cueProviders, embed: async () => [] } });
    expect(outcome.reason).toBe('partial_embedding');
    expect(await engine.executeRaw('SELECT id FROM memory_cue_windows WHERE build_id=$1::uuid', [build.buildId])).toHaveLength(0);
    const [before] = await engine.executeRaw<{ budget_remaining_cents: number }>('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [build.budgetOwnerJobId]);
    const resumed = await resumeMemoryCueBuild(engine, { buildId: build.buildId, trustedLocal: true });
    expect(resumed.budgetOwnerJobId).toBe(build.budgetOwnerJobId);
    expect((await runMemoryCueBuild(engine, { buildId: build.buildId, providers: cueProviders })).status).toBe('complete');
    const [after] = await engine.executeRaw<{ budget_remaining_cents: number }>('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [build.budgetOwnerJobId]);
    expect(after!.budget_remaining_cents).toBeLessThan(before!.budget_remaining_cents);
  });

  test('cancel during provider wait prevents embedding and publication', async () => {
    const build = await startCueBuild(engine);
    let embedded = false;
    const result = await runMemoryCueBuild(engine, { buildId: build.buildId, providers: {
      generate: async input => { await cancelMemoryCueBuild(engine, { buildId: build.buildId, trustedLocal: true }); return cueProviders.generate(input); },
      embed: async () => { embedded = true; return []; },
    } });
    expect(result.reason).toBe('cancelled');
    expect(embedded).toBe(false);
    expect(await engine.executeRaw('SELECT id FROM memory_cue_windows WHERE build_id=$1::uuid', [build.buildId])).toHaveLength(0);
  });

  test('edit during generation loses guarded publication and invalidates previous readers', async () => {
    const candidates = (await recallMemoryCues(engine, cueVector(), { embeddingColumn: await memoryCueColumn(engine) })).candidates;
    const build = await startCueBuild(engine);
    const result = await runMemoryCueBuild(engine, { buildId: build.buildId, providers: { ...cueProviders,
      generate: async input => { await seedCuePage(engine, 'cue-example', 'default', 'Calls are welcome before 10.'); return cueProviders.generate(input); },
    } });
    expect(result.reason).toBe('snapshot_superseded');
    expect(await revalidateMemoryCueCandidates(engine, candidates, {})).toHaveLength(0);
    expect((await recallMemoryCues(engine, cueVector(), { embeddingColumn: await memoryCueColumn(engine) })).candidates).toHaveLength(0);
  });

  test('empty outputs complete without embedding and are not regenerated after retry', async () => {
    const build = await startCueBuild(engine);
    let generated = 0;
    const providers = { generate: async () => { generated++; return { output: [], actualUsd: 0.001 }; }, embed: async () => { throw new Error('must not embed'); } };
    expect((await runMemoryCueBuild(engine, { buildId: build.buildId, providers })).status).toBe('complete');
    await resumeMemoryCueBuild(engine, { buildId: build.buildId, trustedLocal: true });
    expect((await runMemoryCueBuild(engine, { buildId: build.buildId, providers })).status).toBe('complete');
    expect(generated).toBe(1);
  });

  test('exhausted budget denies provider admission and settlement refunds at most once', async () => {
    const build = await startCueBuild(engine, { maxUsd: 0.01 });
    let generated = false;
    expect((await runMemoryCueBuild(engine, { buildId: build.buildId, providers: { ...cueProviders, generate: async () => { generated = true; throw new Error('not reached'); } } })).reason).toBe('budget_exhausted');
    expect(generated).toBe(false);
    const [row] = await engine.executeRaw<CueBuildRow>('SELECT * FROM memory_cue_builds WHERE owner_job_id<>$1 LIMIT 1', [build.budgetOwnerJobId]);
    const [attempt] = await engine.executeRaw<{ id: string }>('SELECT id FROM memory_cue_attempts WHERE build_id=$1::uuid LIMIT 1', [row!.id]);
    const [before] = await engine.executeRaw<{ budget_remaining_cents: number }>('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [row!.owner_identity]);
    await settleCueAttempt(engine, row!, attempt!.id, 0);
    await settleCueAttempt(engine, row!, attempt!.id, 0);
    const [after] = await engine.executeRaw<{ budget_remaining_cents: number }>('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [row!.owner_identity]);
    expect(after!.budget_remaining_cents).toBe(before!.budget_remaining_cents);
  });

  test('model rotation invalidates calibration and source enrollment cancellation is immediate', async () => {
    const original = await memoryCueColumn(engine);
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: original.dimensions, env: {} });
    expect((await loadMemoryCueSettings(engine)).minSimilarity).toBeNull();
    resetGateway();
    expect((await loadMemoryCueSettings(engine)).minSimilarity).toBe(0.5);
    expect(cueSignature(await memoryCueColumn(engine))).toBe(cueSignature(original));
    const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages LIMIT 1');
    await engine.setConfig('memory.cues.generation_enabled', 'false');
    expect((await scheduleMemoryCuePage(engine, 'default', page!.id)).reason).toBe('approval_inactive');
  });

  test('live-default orchestration calls the gateway and reserves both provider attempts', async () => {
    await seedCuePage(engine);
    await enrollCues(engine);
    let generated = 0;
    let embedded = 0;
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test-fixture-not-a-key' } });
    __setChatTransportForTests(async opts => {
      generated++;
      return { text: JSON.stringify(cueSlots({ kind: 'horizon:explicit_constraint_applies', evidence_ref: 1, text: 'Scheduling an early meeting' })),
        blocks: [], stopReason: 'end', usage: { input_tokens: 20, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: opts.model!, providerId: 'anthropic' };
    });
    __setEmbedTransportForTests(async ({ values }) => {
      embedded++;
      return { values, embeddings: values.map(() => Array.from(cueVector())), usage: { tokens: 20 }, warnings: [], response: { headers: {} } };
    });
    try {
      const build = await startCueBuild(engine);
      expect(await runMemoryCueBuild(engine, { buildId: build.buildId })).toMatchObject({ status: 'complete' });
      expect(generated).toBe(1);
      expect(embedded).toBe(1);
      const attempts = await engine.executeRaw('SELECT id FROM memory_cue_attempts WHERE build_id=$1::uuid', [build.buildId]);
      expect(attempts).toHaveLength(2);
    } finally {
      __setChatTransportForTests(null);
      __setEmbedTransportForTests(null);
      resetGateway();
    }
  });

  test('provider failures retain unknown charges and never publish partial state', async () => {
    for (const message of ['missing API key', '429 rate limited', 'request timeout', 'provider_refusal']) {
      const build = await startCueBuild(engine);
      const result = await runMemoryCueBuild(engine, { buildId: build.buildId, providers: { ...cueProviders, generate: async () => { throw new Error(message); } } });
      expect(result.status).toBe('failed');
      expect(await engine.executeRaw('SELECT id FROM memory_cue_windows WHERE build_id=$1::uuid', [build.buildId])).toHaveLength(0);
      const attempts = await engine.executeRaw<{ settled: boolean }>('SELECT settled FROM memory_cue_attempts WHERE build_id=$1::uuid', [build.buildId]);
      expect(attempts).toEqual([{ settled: false }]);
      const [owner] = await engine.executeRaw<{ budget_remaining_cents: number }>('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [build.budgetOwnerJobId]);
      expect(owner!.budget_remaining_cents).toBeLessThan(100);
    }
  });

  test('duplicate delivery admits one worker and a deleted budget owner cannot bypass the cap', async () => {
    const build = await startCueBuild(engine);
    let calls = 0;
    const providers = { ...cueProviders, generate: async (input: Parameters<typeof cueProviders.generate>[0]) => { calls++; return cueProviders.generate(input); } };
    const outcomes = await Promise.all([runMemoryCueBuild(engine, { buildId: build.buildId, providers }), runMemoryCueBuild(engine, { buildId: build.buildId, providers })]);
    expect(outcomes.map(r => r.status).sort()).toEqual(['complete', 'not_claimed']);
    expect(calls).toBe(1);
    const missingOwner = await startCueBuild(engine);
    await engine.executeRaw('DELETE FROM minion_jobs WHERE id=$1', [missingOwner.budgetOwnerJobId]);
    expect((await runMemoryCueBuild(engine, { buildId: missingOwner.buildId, providers })).reason).toBe('budget_owner_missing');
    expect(calls).toBe(1);
  });

  test('final SQL rejects push revocation during an intermediate await and keeps search independent', async () => {
    await engine.setConfig('memory.cues.push', 'true');
    await engine.setConfig('memory.cues.push_min_similarity', '0.5');
    await engine.setConfig('memory.cues.push_calibration_signature', cueSignature(await memoryCueColumn(engine)));
    const candidates = (await recallMemoryCues(engine, cueVector(), { embeddingColumn: await memoryCueColumn(engine), purpose: 'push' })).candidates;
    expect(candidates.length).toBeGreaterThan(0);
    const original = engine.getAllConfig.bind(engine);
    let revoked = false;
    engine.getAllConfig = async () => {
      const values = await original();
      await engine.setConfig('memory.cues.push', 'false');
      revoked = true;
      return values;
    };
    try {
      expect(await revalidateMemoryCueCandidates(engine, candidates, { purpose: 'push' })).toHaveLength(0);
      expect(revoked).toBe(true);
    } finally { engine.getAllConfig = original; }
    expect((await recallMemoryCues(engine, cueVector(), { embeddingColumn: await memoryCueColumn(engine), purpose: 'search' })).candidates.length).toBeGreaterThan(0);
  });

  test('missing cue schema degrades read-only, while a core database failure propagates', async () => {
    await engine.executeRaw('ALTER TABLE memory_cues RENAME TO parked_memory_cues');
    try {
      const result = await recallMemoryCues(engine, cueVector(), { embeddingColumn: await memoryCueColumn(engine) });
      expect(result).toMatchObject({ status: 'degraded', reason: 'schema_missing', candidates: [] });
      expect(await engine.executeRaw("SELECT to_regclass('memory_cues') AS name")).toEqual([{ name: null }]);
    } finally { await engine.executeRaw('ALTER TABLE parked_memory_cues RENAME TO memory_cues'); }
    const original = engine.executeRaw.bind(engine);
    const column = await memoryCueColumn(engine);
    engine.executeRaw = async () => { throw Object.assign(new Error('fixture database unavailable'), { code: '08006' }); };
    try { await expect(recallMemoryCues(engine, cueVector(), { embeddingColumn: column })).rejects.toMatchObject({ code: '08006' }); }
    finally { engine.executeRaw = original; }
  });

  test('effective cue descriptors share file, environment and database-registry precedence with search', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cue-config-'));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
        mkdirSync(join(home, '.gbrain'));
        writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 256 }));
        expect(await memoryCueColumn(engine)).toEqual({ name: 'embedding', type: 'vector', dimensions: 256, embeddingModel: 'openai:text-embedding-3-small' });
        await withEnv({ GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large', GBRAIN_EMBEDDING_DIMENSIONS: '512' }, async () => {
          expect(await memoryCueColumn(engine)).toMatchObject({ dimensions: 512, embeddingModel: 'openai:text-embedding-3-large' });
        });
        await engine.setConfig('embedding_columns', JSON.stringify({ custom_cue: { provider: 'openai:text-embedding-3-large', dimensions: 128, type: 'halfvec' } }));
        await engine.setConfig('search_embedding_column', 'custom_cue');
        expect(await memoryCueColumn(engine)).toEqual({ name: 'custom_cue', type: 'halfvec', dimensions: 128, embeddingModel: 'openai:text-embedding-3-large' });
        writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', search_embedding_column: 'custom_cue', embedding_columns: {
          custom_cue: { provider: 'openai:text-embedding-3-small', dimensions: 64, type: 'vector' },
        } }));
        expect(await memoryCueColumn(engine)).toEqual({ name: 'custom_cue', type: 'vector', dimensions: 64, embeddingModel: 'openai:text-embedding-3-small' });
        writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
        expect((await previewMemoryCueBuild(engine, { sourceIds: ['default'] })).reason).toBe('embedding_disabled');
        await expect(startCueBuild(engine)).rejects.toThrow('embedding_disabled');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      await engine.executeRaw("DELETE FROM config WHERE key IN ('search_embedding_column','embedding_columns')");
    }
  });
});
