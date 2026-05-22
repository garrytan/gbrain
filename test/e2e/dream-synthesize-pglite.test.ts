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
import { runPhaseSynthesize, renderPageToMarkdown } from '../../src/core/cycle/synthesize.ts';

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

describe('E2E synthesize — round-trip self-consumption guard (v0.23.2)', () => {
  /**
   * Capture stderr writes during a single synthesize run, restoring the
   * original writer afterward (even on throw). Returns the captured chunks.
   */
  async function captureStderr<T>(body: () => Promise<T>): Promise<{ result: T; stderr: string }> {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: any, ..._args: any[]): boolean => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString();
      chunks.push(s);
      return true;
    };
    try {
      const result = await body();
      return { result, stderr: chunks.join('') };
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    }
  }

  test('round-trip: synthesize-rendered dream output is skipped on the next run', async () => {
    // Production-realistic recursion:
    //   1. The synthesize phase wrote a reflection (DB + reverseWriteSlugs).
    //   2. A workflow downstream moved that .md content into the corpus dir
    //      as a .txt (or symlinked, or the dirs overlap, or someone copied
    //      OpenClaw session output over the top of a brain page export).
    //   3. The next overnight cycle reads the corpus dir.
    //
    // Without the guard, step 3 re-synthesizes the page, paying Sonnet costs
    // and corrupting provenance. With the v0.23.2 guard, the file is detected
    // by the `dream_generated: true` frontmatter marker and skipped silently
    // (with a stderr log so the operator can debug).
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);

      // 1. Insert a reflection page in the DB the way the subagent would.
      const slug = 'wiki/personal/reflections/2026-04-30-test-roundtrip-abc123';
      await rig.engine.putPage(slug, {
        type: 'note',
        title: 'Test reflection (E2E round-trip)',
        compiled_truth: 'I noticed something. Cross-references to [Alice](people/alice).',
        timeline: '',
        frontmatter: {},
      });

      // 2. Reverse-render via the real synthesize-phase helper. This is the
      //    code path that stamps `dream_generated: true` into frontmatter.
      const page = await rig.engine.getPage(slug);
      expect(page).not.toBeNull();
      const md = renderPageToMarkdown(page!, ['dream-cycle']);
      // Sanity: the marker must actually be in the rendered output.
      expect(md).toMatch(/dream_generated:\s*true/);
      expect(md.length).toBeGreaterThan(100);

      // 3. Drop the rendered content into the corpus dir as a .txt file —
      //    pad to clear the 2000-char minChars threshold so we don't get
      //    short-circuited before the guard even runs.
      writeFileSync(
        join(rig.corpusDir, '2026-04-30-leaked-reflection.txt'),
        md + '\n' + '\nfollow-up notes that the operator scribbled.\n'.repeat(50),
      );

      // 4. Run synthesize. Capture stderr so we can prove the guard logged
      //    its skip line (no-more-silent-skips contract).
      await withoutAnthropicKey(async () => {
        const { result, stderr } = await captureStderr(() =>
          runPhaseSynthesize(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
          }),
        );

        expect(result.status).toBe('ok');
        // Discovery skipped the file → the no-transcripts short-circuit fires.
        expect(result.summary).toMatch(/no transcripts to process/);
        expect((result.details as { transcripts_processed: number }).transcripts_processed).toBe(0);
        expect((result.details as { pages_written: number }).pages_written).toBe(0);
        // No verdicts entry: the file never made it past discovery, so the
        // verdict cache stays untouched (this matters because a cached "false"
        // would shadow a future legit edit of a real conversation transcript).
        const verdicts = (result.details as { verdicts?: unknown[] }).verdicts;
        expect(verdicts === undefined || (Array.isArray(verdicts) && verdicts.length === 0)).toBe(true);
        // Stderr log fired — operator can see the skip when debugging.
        expect(stderr).toMatch(/\[dream\] skipped 2026-04-30-leaked-reflection: dream_generated marker/);
      });
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('round-trip: bypassDreamGuard=true re-enables ingestion of marked output', async () => {
    // Power-user escape hatch (`gbrain dream --unsafe-bypass-dream-guard`).
    // The same marked file that was skipped above now gets discovered when
    // bypassDreamGuard is set at the phase entry. Proves the bypass plumbing
    // reaches discoverTranscripts at phase scope, not just at the
    // function-pair level the unit tests cover.
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);

      const slug = 'wiki/personal/reflections/2026-04-30-bypass-test-def456';
      await rig.engine.putPage(slug, {
        type: 'note',
        title: 'Bypass test',
        compiled_truth: 'Some content. ' + 'x '.repeat(500),
        timeline: '',
        frontmatter: {},
      });
      const page = await rig.engine.getPage(slug);
      const md = renderPageToMarkdown(page!, ['dream-cycle']);
      writeFileSync(join(rig.corpusDir, '2026-04-30-bypass.txt'), md + '\n' + 'x '.repeat(500));

      await withoutAnthropicKey(async () => {
        const { result, stderr } = await captureStderr(() =>
          runPhaseSynthesize(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
            bypassDreamGuard: true,
          }),
        );

        expect(result.status).toBe('ok');
        // File was discovered — verdict array has the entry, even though
        // the no-key path makes it worth=false.
        const verdicts = (result.details as { verdicts: Array<{ worth: boolean; reasons: string[] }> }).verdicts;
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].reasons[0]).toMatch(/ANTHROPIC_API_KEY/);
        // Loud warning fired at phase entry so the operator never wonders
        // why the guard quietly let dream output through.
        expect(stderr).toMatch(/\[dream\] WARNING: --unsafe-bypass-dream-guard set/);
        // The standard "skipped" log must NOT have fired (the bypass kicks
        // in inside isDreamOutput before the log path runs).
        expect(stderr).not.toMatch(/\[dream\] skipped .*: dream_generated marker/);
      });
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('round-trip: dream output + real transcript → only the real one is discovered', async () => {
    // Mixed corpus: a leaked dream-output file alongside a legitimate
    // conversation transcript. The guard must skip exactly the marked file
    // and let the real one through.
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);

      // Leaked reflection.
      const slug = 'wiki/personal/reflections/2026-04-30-mixed-ghi789';
      await rig.engine.putPage(slug, {
        type: 'note',
        title: 'Leaked',
        compiled_truth: 'leaked body. ' + 'x '.repeat(500),
        timeline: '',
        frontmatter: {},
      });
      const md = renderPageToMarkdown((await rig.engine.getPage(slug))!, ['dream-cycle']);
      writeFileSync(join(rig.corpusDir, '2026-04-30-leaked.txt'), md + '\n' + 'x '.repeat(500));

      // Real conversation transcript (no frontmatter, plain prose).
      writeFileSync(
        join(rig.corpusDir, '2026-04-30-real-convo.txt'),
        'User: today I want to think about wiki/personal/reflections/identity.\n' +
        'Agent: ' + 'meaningful conversation '.repeat(200),
      );

      await withoutAnthropicKey(async () => {
        const { result, stderr } = await captureStderr(() =>
          runPhaseSynthesize(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
          }),
        );

        expect(result.status).toBe('ok');
        const verdicts = (result.details as { verdicts: Array<{ filePath: string; worth: boolean }> }).verdicts;
        // Exactly one verdict — the real transcript. The leaked file was
        // dropped at discovery before the verdict pass even started.
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].filePath).toMatch(/2026-04-30-real-convo\.txt$/);
        // Stderr log fired for the leaked file specifically.
        expect(stderr).toMatch(/\[dream\] skipped 2026-04-30-leaked: dream_generated marker/);
        // ... and only the leaked file. A legitimate transcript that merely
        // mentions a reflection slug (codex finding #1's headline false-positive)
        // must not be skipped.
        expect(stderr).not.toMatch(/\[dream\] skipped 2026-04-30-real-convo/);
      });
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
