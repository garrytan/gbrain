import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { memoryCueOperations } from '../src/core/ops/memory-cues.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';
import { cueEvidence, cueVector, enrollCues, seedCuePage } from './helpers/memory-cues.ts';
import { withEnv } from './helpers/with-env.ts';
import { runPendingMemoryCueJob, submitMemoryCueBuild } from '../src/core/memory-cues/index.ts';

let engine: PGLiteEngine;
let home: string;
let ctx: OperationContext;
const operation = memoryCueOperations[0];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-cue-admin-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  ctx = { engine, config: { engine: 'pglite' }, remote: false, sourceId: 'default', dryRun: false,
    logger: { info() {}, warn() {}, error() {} } };
});

afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

beforeEach(async () => {
  rmSync(join(home, '.gbrain', 'config.json'), { force: true });
  await engine.executeRaw('DELETE FROM memory_cue_builds');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM pages');
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
  await engine.setConfig('embedding_dimensions', '1536');
  await engine.setConfig('chat_model', 'openai:gpt-4o-mini');
  await seedCuePage(engine);
  await enrollCues(engine);
});

async function withProviders(run: (calls: { chat: number; embed: number }) => Promise<void>) {
  const calls = { chat: 0, embed: 0 };
  await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: 'test-fixture-not-a-key' }, async () => {
    __setChatTransportForTests(async opts => {
      calls.chat++;
      return { text: JSON.stringify([{ family: 'horizon', relation: 'explicit_constraint_applies', evidence_ref: 1, text: 'Scheduling an early meeting' }]), blocks: [], stopReason: 'end',
        usage: { input_tokens: 20, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: opts.model!, providerId: 'openai' };
    });
    __setEmbedTransportForTests(async ({ values }) => {
      calls.embed++;
      return { values, embeddings: values.map(() => Array.from(cueVector())), usage: { tokens: 20 }, warnings: [], response: { headers: {} } };
    });
    try { await run(calls); }
    finally { __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway(); }
  });
}

describe('local PGLite cue administration executes accepted jobs', () => {
  test('build without apply remains a read-only preview', async () => {
    await withProviders(async calls => {
      expect(await operation.handler(ctx, { action: 'build', source_ids: ['default'], max_usd: 1 })).toMatchObject({ ready: true });
      expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toEqual([]);
      expect(calls).toEqual({ chat: 0, embed: 0 });
    });
  });

  test('explicit build drains its own bounded job and reports real progress', async () => {
    await withProviders(async calls => {
      const result = await operation.handler(ctx, { action: 'build', source_ids: ['default'], max_usd: 1, apply: true }) as {
        buildId: string; jobId: number; budgetOwnerJobId: number; status: string; progress: { windowsProcessed: number };
      };
      expect(result.status).toBe('complete');
      expect(result.progress.windowsProcessed).toBe(1);
      expect(calls).toEqual({ chat: 1, embed: 1 });
      expect(await engine.executeRaw('SELECT status FROM minion_jobs WHERE id=$1', [result.jobId])).toEqual([{ status: 'completed' }]);
      expect((await engine.getPage('cue-example', { sourceId: 'default' }))?.compiled_truth).toBe(cueEvidence);
    });
  });

  test('resume keeps its original allowance and drains without regenerating finished windows', async () => {
    await withProviders(async calls => {
      const created = await operation.handler(ctx, { action: 'build', max_usd: 1, apply: true }) as { buildId: string; budgetOwnerJobId: number };
      const balance = await engine.executeRaw('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [created.budgetOwnerJobId]);
      await operation.handler(ctx, { action: 'cancel', build_id: created.buildId, apply: true });
      const resumed = await operation.handler(ctx, { action: 'resume', build_id: created.buildId, apply: true }) as { budgetOwnerJobId: number; status: string };
      expect(resumed.status).toBe('complete');
      expect(resumed.budgetOwnerJobId).toBe(created.budgetOwnerJobId);
      expect(await engine.executeRaw('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [created.budgetOwnerJobId])).toEqual(balance);
      expect(calls).toEqual({ chat: 1, embed: 1 });
    });
  });

  test('invalid spend caps never admit a job or provider call', async () => {
    await withProviders(async calls => {
      for (const max_usd of [undefined, 0, 0.001, -1, NaN, Infinity, 10001]) {
        await expect(operation.handler(ctx, { action: 'build', max_usd, apply: true })).rejects.toMatchObject({ code: 'invalid_params' });
      }
      expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toEqual([]);
      expect(calls).toEqual({ chat: 0, embed: 0 });
    });
  });

  test('a failed bounded pass reports an error while preserving its durable receipt', async () => {
    await withProviders(async calls => {
      await expect(operation.handler(ctx, { action: 'build', max_usd: 0.01, apply: true })).rejects.toMatchObject({ code: 'unavailable' });
      const builds = await engine.executeRaw<{ id: string; status: string; reason: string }>('SELECT id,status,reason FROM memory_cue_builds');
      expect(builds).toHaveLength(1);
      expect(builds[0]).toMatchObject({ status: 'failed', reason: 'budget_exhausted' });
      expect(calls.embed).toBe(0);
      expect(await engine.executeRaw('SELECT id FROM memory_cue_windows')).toEqual([]);
    });
  });

  test('global embedding disable blocks new builds and previously admitted provider work', async () => {
    await withProviders(async calls => {
      const receipt = await submitMemoryCueBuild(engine, { sourceIds: ['default'], maxUsd: 1, trustedLocal: true });
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
      expect(await operation.handler(ctx, { action: 'preview' })).toMatchObject({ ready: false, reason: 'embedding_disabled' });
      await expect(operation.handler(ctx, { action: 'build', max_usd: 1, apply: true })).rejects.toThrow('embedding_disabled');
      expect(await runPendingMemoryCueJob(engine, { jobId: receipt.jobId })).toMatchObject({ status: 'failed', reason: 'embedding_disabled' });
      expect(await engine.executeRaw('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [receipt.budgetOwnerJobId])).toEqual([{ budget_remaining_cents: 100 }]);
      expect(calls).toEqual({ chat: 0, embed: 0 });
      expect(await engine.executeRaw('SELECT id FROM memory_cue_windows')).toEqual([]);
    });
  });
});
