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

import { describe, test, expect, afterEach } from 'bun:test';
import { __setChatTransportForTests, resetGateway } from '../../src/core/ai/gateway.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesize, renderPageToMarkdown, TRIAGE_VERSION, __testing as synthTesting } from '../../src/core/cycle/synthesize.ts';
import { TIER_DEFAULTS } from '../../src/core/model-config.ts';

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
 * Run `body` with ANTHROPIC_API_KEY temporarily cleared AND GBRAIN_HOME
 * pointed at a fresh tmpdir, restoring both on return — even on throw — so
 * the developer's real ~/.gbrain/config.json never leaks the anthropic_api_key
 * into the test's hasAnthropicKey() probe. Required after the v0.41 gateway-
 * adapter rework: makeJudgeClient now checks BOTH env AND config file (the
 * same hasAnthropicKey() pattern think/index.ts uses since v0.35.5.0), so
 * clearing only the env var is insufficient hermeticity.
 */
async function withoutAnthropicKey<T>(body: () => Promise<T>): Promise<T> {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedHome = process.env.GBRAIN_HOME;
  const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-synth-isol-'));
  delete process.env.ANTHROPIC_API_KEY;
  process.env.GBRAIN_HOME = tmpHome;
  try {
    return await body();
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = savedHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
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
  }, 30_000);

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
  }, 30_000);
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
  }, 30_000);
});

describe('E2E synthesize — gateway-adapter mid-run AIConfigError catch (v0.41 T5 rework)', () => {
  test('AIConfigError thrown by gateway.chat is caught per-transcript; phase continues', async () => {
    // Exercises the new try/catch in the verdict loop. Stubs the gateway
    // chat transport to throw AIConfigError on every call (simulates a
    // revoked key surfacing mid-run). The expected behavior: each
    // transcript records a "gateway error: ..." reason, worth=false, and
    // the phase completes with status='ok' (NOT a crash).
    const { __setChatTransportForTests, resetGateway } = await import('../../src/core/ai/gateway.ts');
    const { AIConfigError } = await import('../../src/core/ai/errors.ts');

    const rig = await setupRig();
    try {
      // Make hasAnthropicKey() return true (a fake key is enough — the
      // gateway transport stub throws below regardless).
      const savedKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-mid-run-throw';

      __setChatTransportForTests(async () => {
        throw new AIConfigError('simulated mid-run provider auth failure');
      });

      try {
        await rig.engine.setConfig('dream.synthesize.enabled', 'true');
        await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
        writeFileSync(
          join(rig.corpusDir, '2026-04-25-mid-run.txt'),
          'a meaningful conversation\n'.repeat(200),
        );

        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });

        // The phase did NOT throw; it converted the AIConfigError into a
        // per-transcript "worth=false, reasons=['gateway error: ...']"
        // verdict and moved on.
        expect(result.status).toBe('ok');
        const verdicts = (result.details as { verdicts: Array<{ worth: boolean; reasons: string[] }> }).verdicts;
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].worth).toBe(false);
        expect(verdicts[0].reasons[0]).toMatch(/gateway error:.*simulated mid-run provider auth failure/);
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
        __setChatTransportForTests(null);
        resetGateway();
      }
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
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
        // v0.41 gateway-adapter rework: reason text now names the verdict
        // model so the user can see WHICH provider was missing. Pre-rework
        // string was 'no ANTHROPIC_API_KEY for significance judge'; post-
        // rework is 'no configured provider for verdict model: <model>'.
        expect(verdicts[0].reasons[0]).toMatch(/no configured provider for verdict model/);
        // CX7: a provider outage is DEGRADED, never "below threshold" — an
        // all-outage run must say so in both the counters and the headline.
        const triage = (result.details as { triage: { degraded: number; below_threshold: number } }).triage;
        expect(triage.degraded).toBe(1);
        expect(triage.below_threshold).toBe(0);
        expect(result.summary).toContain('triage degraded');
        expect(result.summary).not.toContain('below triage threshold');
      });
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('3A: a time-boxed cold pass labels deferred files "not yet triaged" in the headline', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      // A 1ms budget + 25 uncached files: the budget check runs after each
      // per-file cache lookup, and 25 PGLite roundtrips take well over 1ms,
      // so at least the tail of the corpus is guaranteed to defer (exact
      // count depends on wall-clock — assert >= 1, not equality).
      await rig.engine.setConfig('dream.triage.max_ms', '1');
      for (let i = 0; i < 25; i++) {
        writeFileSync(
          join(rig.corpusDir, `2026-04-26-cold-${String(i).padStart(2, '0')}.txt`),
          `an untriaged conversation ${i}\n`.repeat(200),
        );
      }
      await withoutAnthropicKey(async () => {
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: true,
        });
        expect(result.status).toBe('ok');
        const triage = (result.details as { triage: { deferred: number; degraded: number } }).triage;
        expect(triage.deferred).toBeGreaterThanOrEqual(1);
        expect(triage.deferred + triage.degraded).toBe(25);
        expect(result.summary).toContain('not yet triaged');
        expect(result.summary).toContain('dream retriage');
      });
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
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
  }, 30_000);
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
  }, 30_000);

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
        // v0.41 gateway-adapter rework: reason text now names the verdict
        // model so the user can see WHICH provider was missing. Pre-rework
        // string was 'no ANTHROPIC_API_KEY for significance judge'; post-
        // rework is 'no configured provider for verdict model: <model>'.
        expect(verdicts[0].reasons[0]).toMatch(/no configured provider for verdict model/);
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
        // Triage-v1 cache validity: a below-threshold score with matching
        // (model, triage_version) is a HIT that gates the file out.
        await rig.engine.putDreamVerdict(filePath, hash, {
          worth_processing: false,
          reasons: ['cached test verdict'],
          score: 0.1,
          content_type: null,
          segments: [],
          entities: [],
          model: TIER_DEFAULTS.utility,
          triage_version: TRIAGE_VERSION,
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

describe('E2E synthesize — degenerate verdicts are NOT cached in dream_verdicts', () => {
  // A truncated (stop_reason=length) or unparseable judge response used to be
  // banked as a permanent `worth_processing: false` row — a brain whose
  // verdict model reliably truncates (e.g. a reasoning model whose reasoning
  // tokens ate the old 200-token budget) silently rejected every transcript
  // forever. These tests pin the fix: degenerate verdicts skip the cache
  // write (with a stderr warning) so the next cycle re-judges.

  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
  });

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

  /** Run body with a fake ANTHROPIC_API_KEY so makeJudgeClient constructs; the
   * transport stub means no network call ever happens. */
  async function withFakeAnthropicKey<T>(body: () => Promise<T>): Promise<T> {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-degenerate-verdict';
    try {
      return await body();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  }

  async function runWithStubbedJudge(opts: {
    text: string;
    stopReason: 'end' | 'length';
  }): Promise<{ verdictRow: unknown; stderr: string }> {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      const filePath = join(rig.corpusDir, '2026-05-01-session.txt');
      const body = 'a meaningful conversation\n'.repeat(200);
      writeFileSync(filePath, body);

      __setChatTransportForTests(async () => ({
        text: opts.text,
        blocks: [],
        stopReason: opts.stopReason,
        usage: { input_tokens: 10, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      }));

      const { stderr } = await withFakeAnthropicKey(() =>
        captureStderr(() =>
          runPhaseSynthesize(rig.engine, { brainDir: rig.brainDir, dryRun: true }),
        ),
      );

      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256').update(body, 'utf8').digest('hex');
      const verdictRow = await rig.engine.getDreamVerdict(filePath, hash);
      return { verdictRow, stderr };
    } finally {
      await rig.cleanup();
    }
  }

  test('truncated judge response (stop_reason=length) → no dream_verdicts row + warning', async () => {
    const { verdictRow, stderr } = await runWithStubbedJudge({
      text: '{"scor', // reasoning ate the budget; partial JSON
      stopReason: 'length',
    });
    expect(verdictRow).toBeNull();
    expect(stderr).toMatch(/\[dream\] triage for 2026-05-01-session was truncated/);
    expect(stderr).toMatch(/not caching in dream_verdicts/);
  }, 30_000);

  test('unparseable judge response → no dream_verdicts row + warning', async () => {
    const { verdictRow, stderr } = await runWithStubbedJudge({
      text: 'not json at all',
      stopReason: 'end',
    });
    expect(verdictRow).toBeNull();
    expect(stderr).toMatch(/\[dream\] triage for 2026-05-01-session was unparseable/);
    expect(stderr).toMatch(/not caching in dream_verdicts/);
  }, 30_000);

  test('boolean-era judge output (no score) is unparseable — never cached', async () => {
    // The old `{"worth_processing": ...}` shape has no score; under triage-v1
    // it must NOT become a cacheable rejection.
    const { verdictRow, stderr } = await runWithStubbedJudge({
      text: '{"worth_processing": false, "reasons": ["routine ops"]}',
      stopReason: 'end',
    });
    expect(verdictRow).toBeNull();
    expect(stderr).toMatch(/\[dream\] triage for 2026-05-01-session was unparseable/);
  }, 30_000);

  test('control: clean scored verdict is cached with score + model + triage_version', async () => {
    const { verdictRow, stderr } = await runWithStubbedJudge({
      text: '{"score": 0.1, "content_type": "routine", "segments": [], "entities": [], "reasons": ["routine ops"]}',
      stopReason: 'end',
    });
    expect(verdictRow).not.toBeNull();
    const row = verdictRow as { worth_processing: boolean; score: number | null; content_type: string | null; model: string | null; triage_version: number | null };
    expect(row.worth_processing).toBe(false); // derived: 0.1 < DEFAULT_TRIAGE_THRESHOLD
    expect(row.score).toBe(0.1);
    expect(row.content_type).toBe('routine');
    expect(row.model).toBe(TIER_DEFAULTS.utility);
    expect(row.triage_version).toBe(TRIAGE_VERSION);
    expect(stderr).not.toMatch(/not caching in dream_verdicts/);
  }, 30_000);

  test('legacy boolean-era cached row (score NULL) is a MISS — re-judged and overwritten', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      const filePath = join(rig.corpusDir, '2026-05-02-legacy.txt');
      const body = 'a meaningful conversation\n'.repeat(200);
      writeFileSync(filePath, body);
      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256').update(body, 'utf8').digest('hex');
      // Seed a boolean-era row directly (score NULL — pre-v129 shape).
      await rig.engine.executeRaw(
        `INSERT INTO dream_verdicts (file_path, content_hash, worth_processing, reasons)
         VALUES ($1, $2, true, '["legacy row"]'::jsonb)`,
        [filePath, hash],
      );
      __setChatTransportForTests(async () => ({
        text: '{"score": 0.9, "content_type": "reflection", "segments": [], "entities": [], "reasons": ["re-judged"]}',
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      }));
      await withFakeAnthropicKey(() =>
        runPhaseSynthesize(rig.engine, { brainDir: rig.brainDir, dryRun: true }),
      );
      const row = await rig.engine.getDreamVerdict(filePath, hash);
      expect(row).not.toBeNull();
      expect(row!.score).toBe(0.9);
      expect(row!.triage_version).toBe(TRIAGE_VERSION);
      expect(row!.reasons).toEqual(['re-judged']);
    } finally {
      __setChatTransportForTests(null);
      resetGateway();
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E synthesize — PGLite inline subagent drain (takeover of #2699)', () => {
  test('drains private subagent queue inline so the parent can observe completion', async () => {
    const rig = await setupRig();
    try {
      const { MinionQueue } = await import('../../src/core/minions/queue.ts');
      const queue = new MinionQueue(rig.engine);
      const queueName = `dream-inline-test-${Date.now()}`;
      const child = await queue.add(
        'subagent',
        { prompt: 'test', model: 'anthropic:claude-sonnet-4-6', max_turns: 1 },
        { queue: queueName, max_attempts: 1 },
        { allowProtectedSubmit: true },
      );

      let ticks = 0;
      await synthTesting.runSubagentsInline(
        rig.engine,
        queue,
        queueName,
        async () => { ticks++; },
        async (ctx) => {
          await ctx.log('inline child ran');
          await ctx.updateProgress({ step: 'done' });
          return { ok: true };
        },
      );
      expect(ticks).toBe(0); // 60s keepalive never fires for a fast child

      const final = await queue.getJob(child.id);
      expect(final?.status).toBe('completed');
      expect(final?.result).toEqual({ ok: true });
      expect(final?.progress).toEqual({ step: 'done' });

      const waiting = await rig.engine.executeRaw<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM minion_jobs WHERE queue = $1 AND status = 'waiting'`,
        [queueName],
      );
      expect(waiting[0]?.count).toBe('0');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('terminally marks failed inline children so synth parent will not hang', async () => {
    const rig = await setupRig();
    try {
      const { MinionQueue } = await import('../../src/core/minions/queue.ts');
      const queue = new MinionQueue(rig.engine);
      const queueName = `dream-inline-test-fail-${Date.now()}`;
      const child = await queue.add(
        'subagent',
        { prompt: 'test', model: 'anthropic:claude-sonnet-4-6', max_turns: 1 },
        { queue: queueName, max_attempts: 1 },
        { allowProtectedSubmit: true },
      );

      await synthTesting.runSubagentsInline(
        rig.engine,
        queue,
        queueName,
        undefined,
        async () => {
          throw new Error('synthetic child failure');
        },
      );

      const final = await queue.getJob(child.id);
      expect(final?.status).toBe('dead');
      expect(final?.error_text).toContain('synthetic child failure');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('enforces per-job timeout_ms inline: aborts the child and dead-letters it', async () => {
    const rig = await setupRig();
    try {
      const { MinionQueue } = await import('../../src/core/minions/queue.ts');
      const queue = new MinionQueue(rig.engine);
      const queueName = `dream-inline-test-timeout-${Date.now()}`;
      const child = await queue.add(
        'subagent',
        { prompt: 'test', model: 'anthropic:claude-sonnet-4-6', max_turns: 1 },
        { queue: queueName, max_attempts: 3, timeout_ms: 100 },
        { allowProtectedSubmit: true },
      );

      // Handler only ends when ctx.signal fires — like the real subagent
      // handler mid-LLM-call. Without the inline timeout timer this awaits
      // forever and the drain (and the whole cycle) wedges.
      await synthTesting.runSubagentsInline(
        rig.engine,
        queue,
        queueName,
        undefined,
        async (ctx) => {
          await new Promise((_, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      );

      // Timeout is terminal (dead), never a delayed retry, despite max_attempts: 3.
      const final = await queue.getJob(child.id);
      expect(final?.status).toBe('dead');
      expect(final?.error_text).toBe('timeout exceeded');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});
