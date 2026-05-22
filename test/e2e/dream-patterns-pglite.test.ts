/**
 * E2E patterns phase — PGLite, no API key required.
 *
 * Mirrors the per-test-rig pattern from dream-synthesize-pglite.test.ts.
 * Each test creates and tears down its own PGLite engine to avoid
 * cross-test contention (CLAUDE.md issue #223 macOS WASM bug).
 *
 * Covers the runPhasePatterns skip paths that don't require a real
 * Anthropic call:
 *   - disabled: dream.patterns.enabled=false → skipped
 *   - insufficient_evidence: <min_evidence reflections → skipped
 *   - no_api_key: enough reflections, no ANTHROPIC_API_KEY → skipped
 *   - dry-run: passes through with reflections_considered + zero pages
 *
 * The Sonnet detection path is structurally covered in
 * test/cycle-patterns.test.ts (asserts queue + waitForCompletion are
 * wired, allow-list reads from filing-rules JSON, slug provenance from
 * subagent_tool_executions, no raw_data dependency).
 *
 * Run: bun test test/e2e/dream-patterns-pglite.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhasePatterns } from '../../src/core/cycle/patterns.ts';

interface TestRig {
  engine: PGLiteEngine;
  brainDir: string;
  cleanup: () => Promise<void>;
}

async function setupRig(): Promise<TestRig> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  return {
    engine,
    brainDir: '/tmp/gbrain-patterns-test',
    cleanup: async () => {
      try { await engine.disconnect(); } catch { /* */ }
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

/**
 * Insert N reflection pages directly via engine.putPage so the patterns
 * gather query has data without going through the synthesize phase.
 * Slugs follow the v0.23 wiki/personal/reflections/<topic>-<hash> shape.
 */
async function seedReflections(engine: PGLiteEngine, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const slug = `wiki/personal/reflections/2026-04-${String(15 + i).padStart(2, '0')}-test-pattern-aaa${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Reflection ${i}`,
      compiled_truth: `Sample reflection content ${i} discussing recurring theme of work-life balance.`,
      timeline: '',
      frontmatter: { type: 'note', title: `Reflection ${i}` },
    });
  }
}

describe('E2E patterns — disabled', () => {
  test('skipped when dream.patterns.enabled=false', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.patterns.enabled', 'false');
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('disabled');
    } finally {
      await rig.cleanup();
    }
  });

  test('default-enabled when config key unset', async () => {
    const rig = await setupRig();
    try {
      // No reflections seeded → falls through to insufficient_evidence,
      // not disabled. Confirms the default-true semantics.
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('insufficient_evidence');
    } finally {
      await rig.cleanup();
    }
  });
});

describe('E2E patterns — insufficient_evidence', () => {
  test('skipped with 0 reflections', async () => {
    const rig = await setupRig();
    try {
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('insufficient_evidence');
    } finally {
      await rig.cleanup();
    }
  });

  test('skipped with reflections below min_evidence', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.patterns.min_evidence', '5');
      await seedReflections(rig.engine, 3); // below 5
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('insufficient_evidence');
    } finally {
      await rig.cleanup();
    }
  });
});

describe('E2E patterns — no API key', () => {
  test('enough reflections, no ANTHROPIC_API_KEY → skipped no_api_key', async () => {
    const rig = await setupRig();
    try {
      await seedReflections(rig.engine, 5); // above default min_evidence (3)
      await withoutAnthropicKey(async () => {
        const result = await runPhasePatterns(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });
        expect(result.status).toBe('skipped');
        expect((result.details as { reason?: string }).reason).toBe('no_api_key');
      });
    } finally {
      await rig.cleanup();
    }
  });
});

describe('E2E patterns — dry-run', () => {
  test('dry-run returns ok with reflections_considered and zero patterns_written', async () => {
    const rig = await setupRig();
    try {
      await seedReflections(rig.engine, 5);
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect((result.details as { dryRun: boolean }).dryRun).toBe(true);
      expect((result.details as { reflections_considered: number }).reflections_considered).toBe(5);
      expect((result.details as { patterns_written: number }).patterns_written).toBe(0);
    } finally {
      await rig.cleanup();
    }
  });
});
