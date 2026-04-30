/**
 * E2E synthesize phase — PGLite, no API key required.
 *
 * Each test creates and tears down its own PGLite engine to avoid
 * cross-test contention. Trades startup cost for isolation — required
 * because PGLite's WASM instance has been observed to wedge under
 * sustained concurrent-test pressure on macOS (CLAUDE.md issue #223).
 *
 * Mirrors the per-test-rig pattern used in
 * test/e2e/dream-allow-list-pglite.test.ts.
 *
 * Run: bun test test/e2e/dream-synthesize-pglite.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../../src/core/cycle/synthesize.ts';

interface TestRig {
  engine: PGLiteEngine;
  brainDir: string;
  corpusDir: string;
  cleanup: () => Promise<void>;
}

async function setupRig(): Promise<TestRig> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-brain-'));
  const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-corpus-'));
  return {
    engine,
    brainDir,
    corpusDir,
    cleanup: async () => {
      try { await engine.disconnect(); } catch { /* best-effort */ }
      try { rmSync(brainDir, { recursive: true, force: true }); } catch { /* */ }
      try { rmSync(corpusDir, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

/**
 * Run `body` with ANTHROPIC_API_KEY temporarily cleared, restoring the
 * prior value (set or unset) on return — even on throw — so this never
 * leaks state to sibling test files in the suite.
 */
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

describe('E2E synthesize — disabled / not_configured', () => {
  test('not_configured when enabled=false (default)', async () => {
    const rig = await setupRig();
    try {
      const result = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('not_configured');
    } finally {
      await rig.cleanup();
    }
  });

  test('not_configured when enabled=true but session_corpus_dir is empty', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      const result = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('not_configured');
    } finally {
      await rig.cleanup();
    }
  });
});

describe('E2E synthesize — empty corpus', () => {
  test('ok status with zero transcripts when corpus dir is empty', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      const result = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('ok');
      expect((result.details as { transcripts_processed: number }).transcripts_processed).toBe(0);
      expect((result.details as { pages_written: number }).pages_written).toBe(0);
    } finally {
      await rig.cleanup();
    }
  });
});

describe('E2E synthesize — no API key skip path', () => {
  test('without ANTHROPIC_API_KEY, every transcript verdict is "no key" and zero pages written', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      writeFileSync(
        join(rig.corpusDir, '2026-04-25-session.txt'),
        'a meaningful conversation\n'.repeat(200),
      );
      await withoutAnthropicKey(async () => {
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });
        expect(result.status).toBe('ok');
        expect((result.details as { transcripts_processed: number }).transcripts_processed).toBe(0);
        expect((result.details as { pages_written: number }).pages_written).toBe(0);
        const verdicts = (result.details as { verdicts: Array<{ worth: boolean; reasons: string[] }> }).verdicts;
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].worth).toBe(false);
        expect(verdicts[0].reasons[0]).toMatch(/ANTHROPIC_API_KEY/);
      });
    } finally {
      await rig.cleanup();
    }
  });
});

describe('E2E synthesize — dry-run skips Sonnet (Codex finding #8)', () => {
  test('dry-run reports planned action with zero pages_written', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      writeFileSync(
        join(rig.corpusDir, '2026-04-25-session.txt'),
        'a meaningful conversation\n'.repeat(200),
      );
      await withoutAnthropicKey(async () => {
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: true,
        });
        expect(result.status).toBe('ok');
        expect((result.details as { dryRun: boolean }).dryRun).toBe(true);
        expect((result.details as { pages_written: number }).pages_written).toBe(0);
        expect(result.summary).toMatch(/dry-run/);
      });
    } finally {
      await rig.cleanup();
    }
  });
});

describe('E2E synthesize — cooldown', () => {
  test('cooldown_active when last_completion_ts is fresh', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      await rig.engine.setConfig('dream.synthesize.last_completion_ts', new Date().toISOString());
      await rig.engine.setConfig('dream.synthesize.cooldown_hours', '12');
      const result = await runPhaseSynthesize(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('cooldown_active');
    } finally {
      await rig.cleanup();
    }
  });

  test('explicit --input bypasses cooldown', async () => {
    // Two engine setups + a synth run; default 5s is tight under full-suite pressure.
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      await rig.engine.setConfig('dream.synthesize.last_completion_ts', new Date().toISOString());
      const adHoc = join(tmpdir(), `gbrain-synth-ad-hoc-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      writeFileSync(adHoc, 'hello world '.repeat(300));
      try {
        await withoutAnthropicKey(async () => {
          const result = await runPhaseSynthesize(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
            inputFile: adHoc,
          });
          expect(result.status).toBe('ok');
          expect((result.details as { reason?: string }).reason).toBeUndefined();
        });
      } finally {
        rmSync(adHoc, { force: true });
      }
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E synthesize — verdict cache (Q-2)', () => {
  test('subsequent run with same content reads from dream_verdicts cache', async () => {
    // Two synth runs through the verdict-cache path; default 5s is tight.
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      const filePath = join(rig.corpusDir, '2026-04-25-session.txt');
      const body = 'a meaningful conversation\n'.repeat(200);
      writeFileSync(filePath, body);
      await withoutAnthropicKey(async () => {
        await runPhaseSynthesize(rig.engine, { brainDir: rig.brainDir, dryRun: false });
        const { createHash } = await import('node:crypto');
        const hash = createHash('sha256').update(body, 'utf8').digest('hex');
        await rig.engine.putDreamVerdict(filePath, hash, {
          worth_processing: false,
          reasons: ['cached test verdict'],
        });
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });
        expect(result.status).toBe('ok');
        const verdicts = (result.details as { verdicts: Array<{ cached: boolean }> }).verdicts;
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].cached).toBe(true);
      });
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});
