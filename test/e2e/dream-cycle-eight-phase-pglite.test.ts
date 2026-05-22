/**
 * E2E full 8-phase cycle on PGLite, no API key required.
 *
 * Verifies that the v0.23 phase order — lint → backlinks → sync →
 * synthesize → extract → patterns → embed → orphans — is honored
 * end-to-end through runCycle when no API key is present (synthesize
 * + patterns skip cleanly, the other six phases run unchanged).
 *
 * Two regression-relevant invariants:
 *   1. CycleReport.phases preserves the 8-phase order — no future
 *      reorder regresses without breaking this test.
 *   2. CycleReport.totals carries the new v0.23 fields:
 *      transcripts_processed, synth_pages_written, patterns_written.
 *
 * No DATABASE_URL required. Mocks embedBatch so the embed phase doesn't
 * attempt OpenAI calls.
 *
 * Run: bun test test/e2e/dream-cycle-eight-phase-pglite.test.ts
 */

import { describe, test, expect, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

mock.module('../../src/core/embedding.ts', () => ({
  embed: async () => new Float32Array(1536),
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(1536)),
  EMBEDDING_MODEL: 'text-embedding-3-large',
  EMBEDDING_DIMENSIONS: 1536,
  EMBEDDING_COST_PER_1K_TOKENS: 0.00013,
  estimateEmbeddingCostUsd: (tokens: number) => (tokens / 1000) * 0.00013,
}));

const { runCycle, ALL_PHASES } = await import('../../src/core/cycle.ts');

interface TestRig {
  engine: PGLiteEngine;
  brainDir: string;
  cleanup: () => Promise<void>;
}

async function setupRig(): Promise<TestRig> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-cycle8-'));
  execSync('git init', { cwd: brainDir, stdio: 'pipe' });
  execSync('git config user.email test@test.co', { cwd: brainDir, stdio: 'pipe' });
  execSync('git config user.name test', { cwd: brainDir, stdio: 'pipe' });
  mkdirSync(join(brainDir, 'concepts'), { recursive: true });
  writeFileSync(
    join(brainDir, 'concepts/testing.md'),
    '---\ntype: concept\ntitle: Testing\n---\n\nTest body content.\n',
  );
  execSync('git add -A && git commit -m init', { cwd: brainDir, stdio: 'pipe' });
  await engine.setConfig('sync.repo_path', brainDir);

  return {
    engine,
    brainDir,
    cleanup: async () => {
      try { await engine.disconnect(); } catch { /* */ }
      try { rmSync(brainDir, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

async function withoutAnthropicKey<T>(body: () => Promise<T>): Promise<T> {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
}

describe('E2E v0.23 8-phase cycle', () => {
  test('ALL_PHASES is the 8-phase order in the documented sequence', () => {
    expect(ALL_PHASES).toEqual([
      'lint',
      'backlinks',
      'sync',
      'synthesize',
      'extract',
      'patterns',
      'embed',
      'orphans',
    ]);
  });

  test('full cycle on dry-run returns CycleReport.phases in v0.23 order with new totals fields', async () => {
    const rig = await setupRig();
    try {
      await withoutAnthropicKey(async () => {
        const report = await runCycle(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: true,
        });
        // Phase ordering preserved
        const phaseNames = report.phases.map(p => p.phase);
        expect(phaseNames).toEqual([
          'lint',
          'backlinks',
          'sync',
          'synthesize',
          'extract',
          'patterns',
          'embed',
          'orphans',
        ]);
        // New totals fields exist (v0.23 additive growth)
        expect(report.totals).toMatchObject({
          transcripts_processed: 0,
          synth_pages_written: 0,
          patterns_written: 0,
        });
        // Synthesize and patterns are skipped (not_configured / insufficient_evidence)
        const synth = report.phases.find(p => p.phase === 'synthesize');
        const patterns = report.phases.find(p => p.phase === 'patterns');
        expect(synth?.status).toBe('skipped');
        expect(patterns?.status).toBe('skipped');
      });
    } finally {
      await rig.cleanup();
    }
  });

  test('--phase synthesize alone runs only that phase, returns skipped/not_configured', async () => {
    const rig = await setupRig();
    try {
      await withoutAnthropicKey(async () => {
        const report = await runCycle(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
          phases: ['synthesize'],
        });
        expect(report.phases).toHaveLength(1);
        expect(report.phases[0].phase).toBe('synthesize');
        expect(report.phases[0].status).toBe('skipped');
      });
    } finally {
      await rig.cleanup();
    }
  });

  test('--phase patterns alone runs only that phase, returns skipped/insufficient_evidence', async () => {
    const rig = await setupRig();
    try {
      await withoutAnthropicKey(async () => {
        const report = await runCycle(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
          phases: ['patterns'],
        });
        expect(report.phases).toHaveLength(1);
        expect(report.phases[0].phase).toBe('patterns');
        expect(report.phases[0].status).toBe('skipped');
        expect((report.phases[0].details as { reason?: string }).reason).toBe('insufficient_evidence');
      });
    } finally {
      await rig.cleanup();
    }
  });

  test('synthInputFile flag is plumbed through runCycle to runPhaseSynthesize', async () => {
    const rig = await setupRig();
    try {
      const transcript = join(tmpdir(), `gbrain-e2e-cycle8-input-${Date.now()}.txt`);
      writeFileSync(transcript, 'sample conversation '.repeat(300));
      try {
        await withoutAnthropicKey(async () => {
          const report = await runCycle(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
            phases: ['synthesize'],
            synthInputFile: transcript,
          });
          // Without API key, synthesize falls through to no-key skip-path
          // and returns ok (NOT cooldown_active — explicit input bypasses).
          expect(report.phases[0].phase).toBe('synthesize');
          expect(report.phases[0].status).toBe('ok');
        });
      } finally {
        rmSync(transcript, { force: true });
      }
    } finally {
      await rig.cleanup();
    }
  });
});
