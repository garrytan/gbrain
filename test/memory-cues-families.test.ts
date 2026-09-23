import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { cueEvidence, cueProviders, cueVector, enrollCues, seedCuePage } from './helpers/memory-cues.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';
import { loadMemoryCueSettings, memoryCueColumn, previewMemoryCueBuild, recallMemoryCues, revalidateMemoryCueCandidates,
  runMemoryCueBuild, submitMemoryCueBuild, MEMORY_CUE_SOURCE_LIMIT } from '../src/core/memory-cues/index.ts';

let engine: PGLiteEngine;
let generations = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('chat_model', 'openai:gpt-4o-mini');
  await seedCuePage(engine);
  await enrollCues(engine);
  const build = await submitMemoryCueBuild(engine, { sourceIds: ['default'], trustedLocal: true, maxUsd: 1, includeBridge: true });
  expect(await runMemoryCueBuild(engine, { buildId: build.buildId, providers: {
    generate: async ({ includeBridge }) => {
      generations++;
      expect(includeBridge).toBe(true);
      return { actualUsd: 0.001, output: [
        { family: 'scene', relation: 'situation_description', quote: cueEvidence, text: 'A morning scheduling constraint' },
        { family: 'horizon', relation: 'explicit_constraint_applies', quote: cueEvidence, text: 'Scheduling an early meeting' },
        { family: 'bridge', relation: 'explicit_constraint_applies', quote: cueEvidence, text: 'Choosing appointment times' },
      ] };
    },
    embed: cueProviders.embed,
  } })).toMatchObject({ status: 'complete' });
});

beforeEach(async () => {
  await engine.setConfig('memory.cues.sources', '["default"]');
  await engine.unsetConfig('memory.cues.families');
});

afterAll(async () => { await engine.disconnect(); });

const recall = async () => {
  const column = await memoryCueColumn(engine);
  return recallMemoryCues(engine, cueVector(column.dimensions), { embeddingColumn: column, sourceIds: ['default'] });
};

describe('controlled cue family ablations', () => {
  test('construction respects the effective file-model pin over an older database pin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cue-model-'));
    try {
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', chat_model: 'anthropic:claude-haiku-4-5-20251001' }));
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const preview = await previewMemoryCueBuild(engine, { sourceIds: ['default'] });
        expect(preview.generationModel).toBe('anthropic:claude-haiku-4-5-20251001');
      });
      expect((await previewMemoryCueBuild(engine, { sourceIds: ['default'] })).generationModel).toBe('openai:gpt-4o-mini');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('defaults select scene and horizon, not experimental bridges', async () => {
    expect((await loadMemoryCueSettings(engine)).families).toEqual(['scene', 'horizon']);
    const rows = await recall();
    expect(rows.candidates).toHaveLength(1);
    expect(['scene', 'horizon']).toContain(rows.candidates[0].family);
  });

  test('the priced OpenRouter cue route has a bounded preview while unlisted routes refuse admission', async () => {
    const originalModel = await engine.getConfig('chat_model');
    const builds = await engine.executeRaw('SELECT id FROM memory_cue_builds ORDER BY id');
    try {
      await engine.setConfig('chat_model', 'openrouter:anthropic/claude-sonnet-4.6');
      const preview = await previewMemoryCueBuild(engine, { sourceIds: ['default'] });
      expect(preview).toMatchObject({ ready: true, generationModel: 'openrouter:anthropic/claude-sonnet-4.6' });
      expect(preview.costPreview.maximumReservationUsdPerWindow).toBeGreaterThan(0);
      expect(Number.isFinite(preview.costPreview.maximumReservationUsdPerPass)).toBe(true);
      for (const model of ['openrouter:anthropic/claude-sonnet-4-6', 'openrouter:anthropic/claude-sonnet-5']) {
        await engine.setConfig('chat_model', model);
        expect(await previewMemoryCueBuild(engine, { sourceIds: ['default'] }))
          .toMatchObject({ ready: false, reason: 'pricing_unknown', costPreview: { maximumReservationUsdPerWindow: null } });
        await expect(submitMemoryCueBuild(engine, { sourceIds: ['default'], trustedLocal: true, maxUsd: 1 })).rejects.toThrow('pricing_unknown');
      }
      expect(await engine.executeRaw('SELECT id FROM memory_cue_builds ORDER BY id')).toEqual(builds);
      expect(generations).toBe(1);
    } finally {
      if (originalModel === null) await engine.unsetConfig('chat_model');
      else await engine.setConfig('chat_model', originalModel);
    }
  });

  test('each family selects frozen production cues without another generation call', async () => {
    for (const family of ['scene', 'horizon', 'bridge'] as const) {
      await engine.setConfig('memory.cues.families', JSON.stringify([family]));
      const rows = await recall();
      expect(rows.candidates).toHaveLength(1);
      expect(rows.candidates[0].family).toBe(family);
      expect(rows.candidates[0].result.chunk_text).toBe(cueEvidence);
    }
    expect(generations).toBe(1);
  });

  test('family removal takes effect during final revalidation', async () => {
    await engine.setConfig('memory.cues.families', '["scene"]');
    const rows = await recall();
    await engine.setConfig('memory.cues.families', '["horizon"]');
    expect(await revalidateMemoryCueCandidates(engine, rows.candidates, { sourceIds: ['default'] })).toEqual([]);
  });

  test('malformed or empty family selection is fail closed', async () => {
    for (const raw of ['not-json', '{}', '[]', '["invented"]']) {
      await engine.setConfig('memory.cues.families', raw);
      expect(await recall()).toMatchObject({ candidates: [], status: 'skipped', reason: 'no_families' });
    }
  });

  test('the bounded public builder accepts a complete 250-source evaluation corpus', async () => {
    expect(MEMORY_CUE_SOURCE_LIMIT).toBe(1000);
    const ids = Array.from({ length: 250 }, (_, i) => `family-${i}`);
    await engine.executeRaw('INSERT INTO sources(id,name) SELECT id,id FROM unnest($1::text[]) id', [ids]);
    await engine.setConfig('memory.cues.sources', JSON.stringify(ids));
    const preview = await previewMemoryCueBuild(engine, { sourceIds: ids });
    expect(preview).toMatchObject({ ready: true, eligiblePages: 0 });
    expect(preview.sourceIds).toHaveLength(250);
    const build = await submitMemoryCueBuild(engine, { sourceIds: ids, maxUsd: 1, trustedLocal: true });
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId, providers: cueProviders })).toMatchObject({ status: 'complete', windowsProcessed: 0 });
    await expect(previewMemoryCueBuild(engine, { sourceIds: Array(1001).fill('default') })).rejects.toThrow('explicit_sources_required');
  });

  test('preview and submitted page lists share quarantine and lifecycle eligibility', async () => {
    for (const [slug, frontmatter] of [
      ['superseded-example', { status: 'superseded' }],
      ['withdrawn-example', { status: 'withdrawn' }],
      ['quarantined-example', { quarantine: true }],
    ] as const) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: cueEvidence, frontmatter }, { sourceId: 'default' });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: cueEvidence, chunk_source: 'compiled_truth' }], { sourceId: 'default' });
    }
    expect(await previewMemoryCueBuild(engine, { sourceIds: ['default'] })).toMatchObject({ eligiblePages: 1 });
    const build = await submitMemoryCueBuild(engine, { sourceIds: ['default'], maxUsd: 1, trustedLocal: true });
    expect(await engine.executeRaw('SELECT p.slug FROM memory_cue_pages cp JOIN pages p ON p.id=cp.page_id WHERE cp.build_id=$1::uuid', [build.buildId])).toEqual([{ slug: 'cue-example' }]);
    expect(await runMemoryCueBuild(engine, { buildId: build.buildId, providers: cueProviders })).toMatchObject({ status: 'complete' });
  });
});
