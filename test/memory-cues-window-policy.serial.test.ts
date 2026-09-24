import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { cueSignature, getMemoryCueStatus, loadMemoryCueSettings, memoryCueColumn, previewMemoryCueBuild,
  recallMemoryCues, resumeMemoryCueBuild, revalidateMemoryCueCandidates, runMemoryCueBuild } from '../src/core/memory-cues/index.ts';
import { MAX_CUE_WINDOW_BYTES } from '../src/core/memory-cues/windows.ts';
import { formatCueEvidence } from '../src/core/memory-cues/evidence.ts';
import { MEMORY_CUE_PROMPT_VERSION } from '../src/core/memory-cues/types.ts';
import { scheduleMemoryCuePage } from '../src/core/memory-cues/scheduling.ts';
import { maximumInvocationCents } from '../src/core/minions/delegated-spend.ts';
import { digest } from '../src/core/persistence/digest.ts';
import { memoryCueOperations } from '../src/core/ops/memory-cues.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { cueEvidence, cueProviders, cueVector, enrollCues, seedCuePage, startCueBuild } from './helpers/memory-cues.ts';

const model = 'openrouter:anthropic/claude-sonnet-4.6';
let engine: PGLiteEngine;
let ctx: OperationContext;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  ctx = { engine, config: { engine: 'pglite' }, remote: false, sourceId: 'default', dryRun: false,
    logger: { info() {}, warn() {}, error() {} } };
});
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM memory_cue_builds');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'memory.cues.%'");
  await engine.setConfig('chat_model', model);
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
  await engine.setConfig('embedding_dimensions', '1536');
  await seedCuePage(engine);
  await enrollCues(engine);
});
afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});
afterAll(async () => { await engine.disconnect(); });

async function legacySignature(version: string) {
  const column = await memoryCueColumn(engine);
  const descriptor = [column.name, column.type, column.dimensions, column.embeddingModel];
  return digest(version === 'situation-v2' ? descriptor : [version, ...descriptor]);
}
const configure = (params: Record<string, unknown>) => memoryCueOperations[0]!.handler(ctx, { action: 'configure', apply: true, ...params });
const recall = async () => recallMemoryCues(engine, cueVector(), { embeddingColumn: await memoryCueColumn(engine), sourceIds: ['default'] });

for (const version of ['situation-v2', 'situation-v3']) {
test(`${version} calibrations fail closed and read/push must be renewed independently for v4`, async () => {
  const old = await legacySignature(version);
  await engine.setConfig('memory.cues.read_calibration_signature', old);
  await engine.setConfig('memory.cues.push', 'true');
  await engine.setConfig('memory.cues.push_min_similarity', '0.5');
  await engine.setConfig('memory.cues.push_calibration_signature', old);
  expect(await loadMemoryCueSettings(engine)).toMatchObject({ readMode: 'on', pushEnabled: true, minSimilarity: null, pushMinSimilarity: null });
  expect(await recall()).toMatchObject({ status: 'skipped', reason: 'uncalibrated', candidates: [] });
  await configure({ min_similarity: 0.6 });
  expect(await engine.getConfig('memory.cues.read_calibration_signature')).toBe(cueSignature(await memoryCueColumn(engine)));
  expect(await loadMemoryCueSettings(engine)).toMatchObject({ minSimilarity: 0.6, pushMinSimilarity: null });
  await configure({ push_min_similarity: 0.7 });
  expect(await engine.getConfig('memory.cues.push_calibration_signature')).toBe(cueSignature(await memoryCueColumn(engine)));
  expect(await loadMemoryCueSettings(engine)).toMatchObject({ minSimilarity: 0.6, pushMinSimilarity: 0.7 });
});

test(`${version} windows cannot return after recalibration; a fresh explicitly budgeted build is required`, async () => {
  const build = await startCueBuild(engine);
  expect((await runMemoryCueBuild(engine, { buildId: build.buildId, providers: cueProviders })).status).toBe('complete');
  const candidates = (await recall()).candidates;
  expect(candidates).toHaveLength(1);
  const old = await legacySignature(version);
  await engine.executeRaw('UPDATE memory_cue_builds SET signature=$2,prompt_version=$3 WHERE id=$1::uuid', [build.buildId, old, version]);
  await engine.executeRaw('UPDATE memory_cue_windows SET signature=$2,prompt_version=$3 WHERE build_id=$1::uuid', [build.buildId, old, version]);
  await engine.executeRaw('UPDATE memory_cues SET signature=$1', [old]);
  await engine.setConfig('memory.cues.read_calibration_signature', old);
  expect((await recall()).candidates).toHaveLength(0);
  await configure({ min_similarity: 0.5, push_enabled: true, push_min_similarity: 0.5 });
  expect((await recall()).candidates).toHaveLength(0);
  expect(await revalidateMemoryCueCandidates(engine, candidates, { sourceIds: ['default'] })).toHaveLength(0);
  expect(await revalidateMemoryCueCandidates(engine, candidates, { sourceIds: ['default'], purpose: 'push' })).toHaveLength(0);
  const current = cueSignature(await memoryCueColumn(engine));
  await engine.executeRaw('UPDATE memory_cue_windows SET signature=$2 WHERE build_id=$1::uuid', [build.buildId, current]);
  await engine.executeRaw('UPDATE memory_cues SET signature=$1', [current]);
  expect((await recall()).candidates).toHaveLength(0);
  expect((await getMemoryCueStatus(engine, { buildId: build.buildId })).coverage).toContainEqual({ status: 'stale', count: 1 });
  const [balance] = await engine.executeRaw('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [build.budgetOwnerJobId]);
  const replacement = await startCueBuild(engine);
  expect(replacement.budgetOwnerJobId).not.toBe(build.budgetOwnerJobId);
  expect((await runMemoryCueBuild(engine, { buildId: replacement.buildId, providers: cueProviders })).status).toBe('complete');
  expect((await recall()).candidates).toHaveLength(1);
  expect(await engine.executeRaw('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [build.budgetOwnerJobId])).toEqual([balance]);
  expect((await engine.getPage('cue-example', { sourceId: 'default' }))!.compiled_truth).toBe(cueEvidence);
});

test(`${version} build signatures and pipeline versions reject resume and execution without spending or resetting budgets`, async () => {
  const old = await legacySignature(version);
  const current = cueSignature(await memoryCueColumn(engine));
  for (const [signature, promptVersion] of [[old, version], [current, version], [old, MEMORY_CUE_PROMPT_VERSION]]) {
    const build = await startCueBuild(engine);
    await engine.executeRaw('UPDATE memory_cue_builds SET signature=$2,prompt_version=$3 WHERE id=$1::uuid', [build.buildId, signature, promptVersion]);
    await expect(resumeMemoryCueBuild(engine, { buildId: build.buildId, trustedLocal: true })).rejects.toThrow('model_changed');
    let generated = 0;
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId, providers: { ...cueProviders, generate: async input => {
      generated++;
      return cueProviders.generate(input);
    } } })).toMatchObject({ status: 'failed', reason: 'model_changed', windowsProcessed: 0 });
    expect(generated).toBe(0);
    expect(await engine.executeRaw('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [build.budgetOwnerJobId])).toEqual([{ budget_remaining_cents: 100 }]);
    expect(await engine.executeRaw('SELECT id FROM memory_cue_attempts WHERE build_id=$1::uuid', [build.buildId])).toHaveLength(0);
    const page = (await engine.getPage('cue-example', { sourceId: 'default' }))!;
    expect(await scheduleMemoryCuePage(engine, 'default', page.id)).toEqual({ reason: 'approval_inactive' });
  }
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(3);
});
}

test('preview bounds include full JSON framing and worst-case escaping at the active window size', async () => {
  const evidence = '\u0001'.repeat(MAX_CUE_WINDOW_BYTES);
  const column = await memoryCueColumn(engine);
  for (const includeBridge of [false, true]) {
    const preview = await previewMemoryCueBuild(engine, { sourceIds: ['default'], includeBridge });
    const chat = maximumInvocationCents({ operation: 'fixture', kind: 'chat', model,
      maxInputTokens: formatCueEvidence(evidence, includeBridge).inputTokenCeiling, maxOutputTokens: 1200 });
    const embedding = maximumInvocationCents({ operation: 'fixture', kind: 'embedding', model: column.embeddingModel, maxInputTokens: 4096, maxOutputTokens: 0 });
    expect(preview.costPreview.maximumReservationUsdPerWindow).toBeGreaterThanOrEqual((Math.max(1, Math.ceil(chat!)) + Math.max(1, Math.ceil(embedding!))) / 100);
    expect(preview.costPreview.maximumReservationUsdPerPass).toBe(preview.costPreview.maximumReservationUsdPerWindow! * 8);
    expect(preview.costPreview.assumptions).toContain(`${MAX_CUE_WINDOW_BYTES}-byte evidence with worst-case JSON escaping`);
  }
});

for (const kind of ['custom', 'live'] as const) {
  test(`${kind} provider reservation uses the exact serialized evidence-ref input including IDs and escaping`, async () => {
    const evidence = ('A fictional note with \\"quoted\\" content.\n').repeat(150);
    await seedCuePage(engine, 'cue-example', 'default', evidence);
    const formatted = formatCueEvidence(evidence, false);
    let generated = 0;
    configureGateway({ chat_model: model, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-key', OPENAI_API_KEY: 'test-fixture-not-a-key' } });
    __setChatTransportForTests(async opts => {
      generated++;
      expect(opts.messages[0]!.content).toBe(formatted.content);
      return { text: '[]', blocks: [], stopReason: 'end', model, providerId: 'openrouter',
        usage: { input_tokens: 20, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    });
    const build = await startCueBuild(engine);
    const providers = kind === 'custom' ? { generate: async ({ evidence: original }: { evidence: string }) => {
      generated++;
      expect(original).toBe(evidence);
      return { output: [], actualUsd: 0 };
    }, embed: async () => { throw new Error('unexpected_embedding'); } } : undefined;
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId, providers })).toMatchObject({ status: 'complete', windowsProcessed: 1 });
    const expected = maximumInvocationCents({ operation: 'fixture', kind: 'chat', model,
      maxInputTokens: formatted.inputTokenCeiling, maxOutputTokens: 1200 });
    expect(await engine.executeRaw('SELECT reserved_cents FROM memory_cue_attempts WHERE build_id=$1::uuid', [build.buildId]))
      .toEqual([{ reserved_cents: Math.max(1, Math.ceil(expected!)) }]);
    expect(generated).toBe(1);
  });

  test(`${kind} provider path denies an escaped large input before invocation using the exact JSON reservation ceiling`, async () => {
    const evidence = '\u0001'.repeat(MAX_CUE_WINDOW_BYTES - 40) + 'Complete source suffix.';
    await seedCuePage(engine, 'cue-example', 'default', evidence);
    let generated = 0;
    let embedded = 0;
    configureGateway({ chat_model: model, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-key', OPENAI_API_KEY: 'test-fixture-not-a-key' } });
    __setChatTransportForTests(async () => {
      generated++;
      return { text: '[]', blocks: [], stopReason: 'end', model, providerId: 'openrouter',
        usage: { input_tokens: 20, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    });
    __setEmbedTransportForTests(async ({ values }) => {
      embedded++;
      return { values, embeddings: values.map(() => Array.from(cueVector())), usage: { tokens: 20 }, warnings: [], response: { headers: {} } };
    });
    const build = await startCueBuild(engine, { maxUsd: 0.1 });
    const providers = kind === 'custom' ? { generate: async () => { generated++; return { output: [], actualUsd: 0 }; },
      embed: async () => { embedded++; return []; } } : undefined;
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId, providers }))
      .toMatchObject({ status: 'failed', reason: 'budget_exhausted', windowsProcessed: 0 });
    expect(generated).toBe(0);
    expect(embedded).toBe(0);
    expect(await engine.executeRaw('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [build.budgetOwnerJobId])).toEqual([{ budget_remaining_cents: 10 }]);
    expect(await engine.executeRaw('SELECT id FROM memory_cue_windows')).toHaveLength(0);
    expect((await engine.getPage('cue-example', { sourceId: 'default' }))!.compiled_truth).toBe(evidence);
  });
}
