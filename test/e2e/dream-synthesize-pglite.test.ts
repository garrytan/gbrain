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
import { runPhaseSynthesize, renderPageToMarkdown, __testing as synthTesting } from '../../src/core/cycle/synthesize.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../../src/commands/jobs.ts';
import { matchesSlugAllowList } from '../../src/core/operations.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';

const { buildTranscriptAllowedSlugPrefixes } = synthTesting;

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

describe('E2E synthesize — transcript-scoped allow-list', () => {
  test('rejects non-date stray slugs', () => {
    const prefixes = buildTranscriptAllowedSlugPrefixes({
      inferredDate: '2026-05-26',
    } as never, [
      'wiki/personal/reflections/*',
      'wiki/originals/ideas/*',
    ]);
    expect(prefixes).toEqual([
      'wiki/personal/reflections/2026-05-26-*',
      'wiki/originals/ideas/2026-05-26-*',
    ]);
    expect(
      matchesSlugAllowList(
        'wiki/personal/reflections/2026-05-26-stale-lease-heartbeat-restart-third-run-b300d2',
        prefixes,
      ),
    ).toBe(true);
    expect(matchesSlugAllowList('wiki/personal/reflections/test-f279b4', prefixes)).toBe(false);
    expect(buildTranscriptAllowedSlugPrefixes({
      inferredDate: '2026-05-26',
    } as never, ['wiki/originals/ideas/*'])).toEqual([
      'wiki/originals/ideas/2026-05-26-*',
    ]);
  });
});

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

        const { result, stderr } = await captureStderr(() =>
          runPhaseSynthesize(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
          }),
        );

        // The phase did NOT throw; it converted the AIConfigError into a
        // per-transcript "worth=false, reasons=['gateway error: ...']"
        // verdict and moved on.
        expect(result.status).toBe('ok');
        const verdicts = (result.details as { verdicts: Array<{ worth: boolean; reasons: string[] }> }).verdicts;
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].worth).toBe(false);
        expect(verdicts[0].reasons[0]).toMatch(/gateway error:.*simulated mid-run provider auth failure/);
        expect(stderr).toMatch(/\[dream\] skipped 2026-04-25-mid-run: gateway error while judging significance: simulated mid-run provider auth failure/);
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
        const { result, stderr } = await captureStderr(() =>
          runPhaseSynthesize(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
          }),
        );
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
        expect(stderr).toMatch(/\[dream\] skipped 2026-04-25-session: no configured provider for verdict model /);
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

describe('E2E synthesize — GLM dream replacement proof', () => {
  test('runPhaseSynthesize fans out through zai:glm-5.2 and writes a reflection page with Haiku still judging', async () => {
    const { __setChatTransportForTests, resetGateway } = await import('../../src/core/ai/gateway.ts');

    const rig = await setupRig();
    const worker = new MinionWorker(rig.engine, { pollInterval: 25, lockDuration: 30_000 });
    await registerBuiltinHandlers(worker, rig.engine);
    const runPromise = worker.start();

    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      await rig.engine.setConfig('models.dream.synthesize', 'zai:glm-5.2');
      await rig.engine.setConfig('models.dream.synthesize_verdict', 'anthropic:claude-haiku-4-5-20251001');
      await rig.engine.setConfig('agent.use_gateway_loop', 'true');

      writeFileSync(
        join(rig.corpusDir, '2026-06-23-glm-dream.txt'),
        'User: I want to capture a new reflection about decision quality.\n' +
        'Agent: ' + 'meaningful conversation '.repeat(220),
      );

      let glmTurn = 0;
      __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
        if ((opts.system ?? '').includes('You judge whether a conversation transcript is worth synthesizing')) {
          return {
            text: JSON.stringify({
              worth_processing: true,
              reasons: ['user reflects on decision quality'],
            }),
            blocks: [{
              type: 'text',
              text: JSON.stringify({
                worth_processing: true,
                reasons: ['user reflects on decision quality'],
              }),
            }],
            stopReason: 'end',
            usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'anthropic:claude-haiku-4-5-20251001',
            providerId: 'anthropic',
          };
        }

        if (opts.model === 'zai:glm-5.2') {
          glmTurn++;
          if (glmTurn === 1) {
            return {
              text: '',
              blocks: [{
                type: 'tool-call',
                toolCallId: 'glm-put-page-1',
                toolName: 'brain_put_page',
                input: {
                  slug: 'wiki/personal/reflections/2026-06-23-glm-replacement-proof',
                  content: [
                    '---',
                    'title: GLM replacement proof',
                    'type: note',
                    '---',
                    '',
                    '# GLM replacement proof',
                    '',
                    'GLM synthesized this reflection through the dream subagent path.',
                  ].join('\n'),
                },
              }],
              stopReason: 'tool_calls',
              usage: { input_tokens: 40, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
              model: 'zai:glm-5.2',
              providerId: 'zai',
            };
          }

          return {
            text: 'reflection written',
            blocks: [{ type: 'text', text: 'reflection written' }],
            stopReason: 'end',
            usage: { input_tokens: 30, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'zai:glm-5.2',
            providerId: 'zai',
          };
        }

        throw new Error(`unexpected chat transport model/system: ${opts.model ?? '<default>'}`);
      });

      const savedKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-glm-judge';
      try {
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });

        expect(result.status).toBe('ok');
        const details = result.details as {
          pages_written: number;
          written_slugs: string[];
          child_outcomes: Array<{ status: string }>;
          verdicts: Array<{ worth: boolean; reasons: string[] }>;
        };
        expect(details.pages_written).toBeGreaterThanOrEqual(1);
        expect(details.written_slugs).toContain('wiki/personal/reflections/2026-06-23-glm-replacement-proof');
        expect(details.child_outcomes.some(o => o.status === 'completed')).toBe(true);
        expect(details.verdicts).toHaveLength(1);
        expect(details.verdicts[0].worth).toBe(true);

        const page = await rig.engine.getPage('wiki/personal/reflections/2026-06-23-glm-replacement-proof');
        expect(page).not.toBeNull();
        expect(page!.compiled_truth).toContain('GLM synthesized this reflection');

        const reversePath = join(
          rig.brainDir,
          'wiki/personal/reflections/2026-06-23-glm-replacement-proof.md',
        );
        expect(await Bun.file(reversePath).exists()).toBe(true);
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
        __setChatTransportForTests(null);
        resetGateway();
      }
    } finally {
      worker.stop();
      await runPromise;
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E synthesize — child failures do not look successful', () => {
  test('dead synth children return warn and do not advance cooldown', async () => {
    const { __setChatTransportForTests, resetGateway } = await import('../../src/core/ai/gateway.ts');

    const rig = await setupRig();
    const worker = new MinionWorker(rig.engine, { pollInterval: 25, lockDuration: 30_000 });
    await registerBuiltinHandlers(worker, rig.engine);
    const runPromise = worker.start();

    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      await rig.engine.setConfig('models.dream.synthesize', 'zai:glm-5.2');
      await rig.engine.setConfig('models.dream.synthesize_verdict', 'anthropic:claude-haiku-4-5-20251001');
      await rig.engine.setConfig('agent.use_gateway_loop', 'true');
      await rig.engine.setConfig('dream.synthesize.last_completion_ts', '2000-01-01T00:00:00.000Z');

      writeFileSync(
        join(rig.corpusDir, '2026-06-23-glm-balance-fail.txt'),
        'User: keep testing GLM through the dream path.\n' +
        'Agent: ' + 'meaningful conversation '.repeat(220),
      );

      __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
        if ((opts.system ?? '').includes('You judge whether a conversation transcript is worth synthesizing')) {
          return {
            text: JSON.stringify({
              worth_processing: true,
              reasons: ['user wants to validate GLM on dream synthesis'],
            }),
            blocks: [{
              type: 'text',
              text: JSON.stringify({
                worth_processing: true,
                reasons: ['user wants to validate GLM on dream synthesis'],
              }),
            }],
            stopReason: 'end',
            usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'anthropic:claude-haiku-4-5-20251001',
            providerId: 'anthropic',
          };
        }

        if (opts.model === 'zai:glm-5.2') {
          throw new Error('Insufficient balance or no resource package. Please recharge.');
        }

        throw new Error(`unexpected chat transport model/system: ${opts.model ?? '<default>'}`);
      });

      const savedKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-glm-judge';
      try {
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });

        expect(result.status).toBe('warn');
        const details = result.details as {
          pages_written: number;
          child_outcomes: Array<{ status: string }>;
          completed_children: number;
          non_completed_children: number;
          summary_slug: string;
        };
        expect(details.pages_written).toBe(0);
        expect(details.child_outcomes).toHaveLength(1);
        expect(details.child_outcomes[0].status).toBe('dead');
        expect(details.completed_children).toBe(0);
        expect(details.non_completed_children).toBe(1);

        expect(await rig.engine.getConfig('dream.synthesize.last_completion_ts')).toBe('2000-01-01T00:00:00.000Z');

        const summaryPath = join(rig.brainDir, `${details.summary_slug}.md`);
        expect(await Bun.file(summaryPath).exists()).toBe(true);
        const summaryText = await Bun.file(summaryPath).text();
        expect(summaryText).toContain('0 completed, 1 not successful');
        expect(summaryText).toContain('**Pages written:** 0.');
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
        __setChatTransportForTests(null);
        resetGateway();
      }
    } finally {
      worker.stop();
      await runPromise;
      await rig.cleanup();
    }
  }, 30_000);

  test('completed synth children that write no page without the no-write marker return warn and do not advance cooldown', async () => {
    const { __setChatTransportForTests, resetGateway } = await import('../../src/core/ai/gateway.ts');

    const rig = await setupRig();
    const worker = new MinionWorker(rig.engine, { pollInterval: 25, lockDuration: 30_000 });
    await registerBuiltinHandlers(worker, rig.engine);
    const runPromise = worker.start();

    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      await rig.engine.setConfig('models.dream.synthesize', 'zai:glm-5.2');
      await rig.engine.setConfig('models.dream.synthesize_verdict', 'anthropic:claude-haiku-4-5-20251001');
      await rig.engine.setConfig('agent.use_gateway_loop', 'true');
      await rig.engine.setConfig('dream.synthesize.last_completion_ts', '2000-01-01T00:00:00.000Z');

      writeFileSync(
        join(rig.corpusDir, '2026-06-23-glm-no-write.txt'),
        'User: keep testing GLM through the dream path.\n' +
        'Agent: ' + 'meaningful conversation '.repeat(220),
      );

      __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
        if ((opts.system ?? '').includes('You judge whether a conversation transcript is worth synthesizing')) {
          return {
            text: JSON.stringify({
              worth_processing: true,
              reasons: ['user wants to validate GLM on dream synthesis'],
            }),
            blocks: [{
              type: 'text',
              text: JSON.stringify({
                worth_processing: true,
                reasons: ['user wants to validate GLM on dream synthesis'],
              }),
            }],
            stopReason: 'end',
            usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'anthropic:claude-haiku-4-5-20251001',
            providerId: 'anthropic',
          };
        }

        if (opts.model === 'zai:glm-5.2') {
          return {
            text: 'I am not confident enough to write a page yet.',
            blocks: [{
              type: 'text',
              text: 'I am not confident enough to write a page yet.',
            }],
            stopReason: 'end',
            usage: { input_tokens: 18, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'zai:glm-5.2',
            providerId: 'zai',
          };
        }

        throw new Error(`unexpected chat transport model/system: ${opts.model ?? '<default>'}`);
      });

      const savedKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-glm-judge';
      try {
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });

        expect(result.status).toBe('warn');
        const details = result.details as {
          pages_written: number;
          child_outcomes: Array<{ jobId: number; status: string }>;
          completed_children: number;
          completed_without_writes: number;
          completed_missing_write_contract: number;
          child_ids_without_writes: number[];
          child_queue: string;
          summary_slug: string;
        };
        expect(details.pages_written).toBe(0);
        expect(details.child_outcomes).toHaveLength(1);
        expect(details.child_outcomes[0].status).toBe('missing_write_contract');
        expect(details.completed_children).toBe(0);
        expect(details.completed_without_writes).toBe(1);
        expect(details.completed_missing_write_contract).toBe(1);
        expect(details.child_ids_without_writes).toHaveLength(1);
        expect(details.child_queue).toBe('default');

        expect(await rig.engine.getConfig('dream.synthesize.last_completion_ts')).toBe('2000-01-01T00:00:00.000Z');

        const summaryPath = join(rig.brainDir, `${details.summary_slug}.md`);
        expect(await Bun.file(summaryPath).exists()).toBe(true);
        const summaryText = await Bun.file(summaryPath).text();
        expect(summaryText).toContain('0 completed, 1 not successful');
        expect(summaryText).toContain('**Pages written:** 0.');
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
        __setChatTransportForTests(null);
        resetGateway();
      }
    } finally {
      worker.stop();
      await runPromise;
      await rig.cleanup();
    }
  }, 30_000);

  test('completed synth children with blank final output are not treated as successful completions', async () => {
    const { __setChatTransportForTests, resetGateway } = await import('../../src/core/ai/gateway.ts');

    const rig = await setupRig();
    const worker = new MinionWorker(rig.engine, { pollInterval: 25, lockDuration: 30_000 });
    await registerBuiltinHandlers(worker, rig.engine);
    const runPromise = worker.start();

    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      await rig.engine.setConfig('models.dream.synthesize', 'zai:glm-5.2');
      await rig.engine.setConfig('models.dream.synthesize_verdict', 'anthropic:claude-haiku-4-5-20251001');
      await rig.engine.setConfig('agent.use_gateway_loop', 'true');
      await rig.engine.setConfig('dream.synthesize.last_completion_ts', '2000-01-01T00:00:00.000Z');

      writeFileSync(
        join(rig.corpusDir, '2026-06-23-glm-blank-output.txt'),
        'User: keep testing GLM through the dream path.\n' +
        'Agent: ' + 'meaningful conversation '.repeat(220),
      );

      __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
        if ((opts.system ?? '').includes('You judge whether a conversation transcript is worth synthesizing')) {
          return {
            text: JSON.stringify({
              worth_processing: true,
              reasons: ['user wants to validate blank-output handling on dream synthesis'],
            }),
            blocks: [{
              type: 'text',
              text: JSON.stringify({
                worth_processing: true,
                reasons: ['user wants to validate blank-output handling on dream synthesis'],
              }),
            }],
            stopReason: 'end',
            usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'anthropic:claude-haiku-4-5-20251001',
            providerId: 'anthropic',
          };
        }

        if (opts.model === 'zai:glm-5.2') {
          return {
            text: '',
            blocks: [{
              type: 'text',
              text: '',
            }],
            stopReason: 'end',
            usage: { input_tokens: 18, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'zai:glm-5.2',
            providerId: 'zai',
          };
        }

        throw new Error(`unexpected chat transport model/system: ${opts.model ?? '<default>'}`);
      });

      const savedKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-glm-judge';
      try {
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });

        expect(result.status).toBe('warn');
        const details = result.details as {
          child_outcomes: Array<{ jobId: number; status: string }>;
          completed_children: number;
          completed_without_writes: number;
          completed_with_empty_output: number;
          child_ids_with_empty_output: number[];
          child_ids_without_writes: number[];
        };
        expect(details.child_outcomes).toHaveLength(1);
        expect(details.child_outcomes[0].status).toBe('dead');
        expect(details.completed_children).toBe(0);
        expect(details.completed_without_writes).toBe(0);
        expect(details.completed_with_empty_output).toBe(0);
        expect(details.child_ids_with_empty_output).toEqual([]);
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
        __setChatTransportForTests(null);
        resetGateway();
      }
    } finally {
      worker.stop();
      await runPromise;
      await rig.cleanup();
    }
  }, 30_000);

  test('completed no-write synth children are retried on the next run when they omit the no-write marker', async () => {
    const { __setChatTransportForTests, resetGateway } = await import('../../src/core/ai/gateway.ts');

    const rig = await setupRig();
    const worker = new MinionWorker(rig.engine, { pollInterval: 25, lockDuration: 30_000 });
    await registerBuiltinHandlers(worker, rig.engine);
    const runPromise = worker.start();

    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      await rig.engine.setConfig('models.dream.synthesize', 'zai:glm-5.2');
      await rig.engine.setConfig('models.dream.synthesize_verdict', 'anthropic:claude-haiku-4-5-20251001');
      await rig.engine.setConfig('agent.use_gateway_loop', 'true');
      await rig.engine.setConfig('dream.synthesize.last_completion_ts', '2000-01-01T00:00:00.000Z');

      writeFileSync(
        join(rig.corpusDir, '2026-06-23-glm-retry-no-write.txt'),
        'User: keep testing GLM through the dream path.\n' +
        'Agent: ' + 'meaningful conversation '.repeat(220),
      );

      let synthAttempt = 0;
      __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
        if ((opts.system ?? '').includes('You judge whether a conversation transcript is worth synthesizing')) {
          return {
            text: JSON.stringify({
              worth_processing: true,
              reasons: ['user wants to validate GLM retry behavior on dream synthesis'],
            }),
            blocks: [{
              type: 'text',
              text: JSON.stringify({
                worth_processing: true,
                reasons: ['user wants to validate GLM retry behavior on dream synthesis'],
              }),
            }],
            stopReason: 'end',
            usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'anthropic:claude-haiku-4-5-20251001',
            providerId: 'anthropic',
          };
        }

        if (opts.model === 'zai:glm-5.2') {
          synthAttempt++;
          if (synthAttempt === 1) {
            return {
              text: 'I am not confident enough to write a page yet.',
              blocks: [{
                type: 'text',
                text: 'I am not confident enough to write a page yet.',
              }],
              stopReason: 'end',
              usage: { input_tokens: 18, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
              model: 'zai:glm-5.2',
              providerId: 'zai',
            };
          }

          if (synthAttempt === 2) {
            return {
              text: '',
              blocks: [{
                type: 'tool-call',
                toolCallId: 'glm-put-page-retry-1',
                toolName: 'brain_put_page',
                input: {
                  slug: 'wiki/personal/reflections/2026-06-23-glm-retried-after-no-write',
                  content: [
                    '---',
                    'title: GLM retried after no write',
                    'type: note',
                    '---',
                    '',
                    '# GLM retried after no write',
                    '',
                    'A later dream synth retry produced the reflection after an earlier no-write completion.',
                  ].join('\n'),
                },
              }],
              stopReason: 'tool_calls',
              usage: { input_tokens: 40, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
              model: 'zai:glm-5.2',
              providerId: 'zai',
            };
          }

          return {
            text: 'reflection written',
            blocks: [{ type: 'text', text: 'reflection written' }],
            stopReason: 'end',
            usage: { input_tokens: 30, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'zai:glm-5.2',
            providerId: 'zai',
          };
        }

        throw new Error(`unexpected chat transport model/system: ${opts.model ?? '<default>'}`);
      });

      const savedKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-glm-judge';
      try {
        const first = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });
        expect(first.status).toBe('warn');
        const firstDetails = first.details as {
          child_outcomes: Array<{ jobId: number; status: string }>;
          completed_without_writes: number;
        };
        expect(firstDetails.completed_without_writes).toBe(1);
        expect(firstDetails.child_outcomes).toHaveLength(1);
        expect(firstDetails.child_outcomes[0].status).toBe('missing_write_contract');

        const second = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });
        expect(second.status).toBe('ok');
        const secondDetails = second.details as {
          pages_written: number;
          written_slugs: string[];
          child_outcomes: Array<{ jobId: number; status: string }>;
        };
        expect(secondDetails.pages_written).toBeGreaterThanOrEqual(1);
        expect(secondDetails.written_slugs).toContain(
          'wiki/personal/reflections/2026-06-23-glm-retried-after-no-write',
        );
        expect(secondDetails.child_outcomes).toHaveLength(1);
        expect(secondDetails.child_outcomes[0].status).toBe('completed');
        expect(secondDetails.child_outcomes[0].jobId).not.toBe(firstDetails.child_outcomes[0].jobId);

        const page = await rig.engine.getPage('wiki/personal/reflections/2026-06-23-glm-retried-after-no-write');
        expect(page).not.toBeNull();
        expect(page!.compiled_truth).toContain('later dream synth retry produced the reflection');
        expect(await rig.engine.getConfig('dream.synthesize.last_completion_ts')).not.toBe('2000-01-01T00:00:00.000Z');
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
        __setChatTransportForTests(null);
        resetGateway();
      }
    } finally {
      worker.stop();
      await runPromise;
      await rig.cleanup();
    }
  }, 30_000);

  test('completed synth children that explicitly report no write are treated as successful no-ops', async () => {
    const { __setChatTransportForTests, resetGateway } = await import('../../src/core/ai/gateway.ts');

    const rig = await setupRig();
    const worker = new MinionWorker(rig.engine, { pollInterval: 25, lockDuration: 30_000 });
    await registerBuiltinHandlers(worker, rig.engine);
    const runPromise = worker.start();

    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      await rig.engine.setConfig('models.dream.synthesize', 'zai:glm-5.2');
      await rig.engine.setConfig('models.dream.synthesize_verdict', 'anthropic:claude-haiku-4-5-20251001');
      await rig.engine.setConfig('agent.use_gateway_loop', 'true');
      await rig.engine.setConfig('dream.synthesize.last_completion_ts', '2000-01-01T00:00:00.000Z');

      writeFileSync(
        join(rig.corpusDir, '2026-06-23-glm-explicit-no-write.txt'),
        'User: keep testing GLM through the dream path.\n' +
        'Agent: ' + 'meaningful conversation '.repeat(220),
      );

      let synthAttempt = 0;
      __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
        if ((opts.system ?? '').includes('You judge whether a conversation transcript is worth synthesizing')) {
          return {
            text: JSON.stringify({
              worth_processing: true,
              reasons: ['user wants to validate explicit no-write behavior on dream synthesis'],
            }),
            blocks: [{
              type: 'text',
              text: JSON.stringify({
                worth_processing: true,
                reasons: ['user wants to validate explicit no-write behavior on dream synthesis'],
              }),
            }],
            stopReason: 'end',
            usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'anthropic:claude-haiku-4-5-20251001',
            providerId: 'anthropic',
          };
        }

        if (opts.model === 'zai:glm-5.2') {
          synthAttempt++;
          return {
            text: 'NO_WRITE: no page met the synthesis bar.',
            blocks: [{
              type: 'text',
              text: 'NO_WRITE: no page met the synthesis bar.',
            }],
            stopReason: 'end',
            usage: { input_tokens: 18, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'zai:glm-5.2',
            providerId: 'zai',
          };
        }

        throw new Error(`unexpected chat transport model/system: ${opts.model ?? '<default>'}`);
      });

      const savedKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-glm-judge';
      try {
        const first = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });
        expect(first.status).toBe('ok');
        const firstDetails = first.details as {
          pages_written: number;
          child_outcomes: Array<{ jobId: number; status: string }>;
          completed_no_write_acknowledged: number;
          child_ids_no_write_acknowledged: number[];
        };
        expect(firstDetails.pages_written).toBe(0);
        expect(firstDetails.child_outcomes).toHaveLength(1);
        expect(firstDetails.child_outcomes[0].status).toBe('no_write_acknowledged');
        expect(firstDetails.completed_no_write_acknowledged).toBe(1);
        expect(firstDetails.child_ids_no_write_acknowledged).toHaveLength(1);
        expect(await rig.engine.getConfig('dream.synthesize.last_completion_ts')).not.toBe('2000-01-01T00:00:00.000Z');

        await rig.engine.setConfig('dream.synthesize.last_completion_ts', '2000-01-01T00:00:00.000Z');

        const second = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });
        expect(second.status).toBe('ok');
        expect(synthAttempt).toBe(1);
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
        __setChatTransportForTests(null);
        resetGateway();
      }
    } finally {
      worker.stop();
      await runPromise;
      await rig.cleanup();
    }
  }, 30_000);

  test('boxed synth queue keeps unrelated default-queue jobs untouched', async () => {
    const { __setChatTransportForTests, resetGateway } = await import('../../src/core/ai/gateway.ts');

    const rig = await setupRig();
    const worker = new MinionWorker(rig.engine, {
      queue: 'dream-synth-test',
      pollInterval: 25,
      lockDuration: 30_000,
    });
    await registerBuiltinHandlers(worker, rig.engine);
    const runPromise = worker.start();

    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      await rig.engine.setConfig('dream.synthesize.queue', 'dream-synth-test');
      await rig.engine.setConfig('models.dream.synthesize', 'zai:glm-5.2');
      await rig.engine.setConfig('models.dream.synthesize_verdict', 'anthropic:claude-haiku-4-5-20251001');
      await rig.engine.setConfig('agent.use_gateway_loop', 'true');
      await rig.engine.setConfig('dream.synthesize.last_completion_ts', '2000-01-01T00:00:00.000Z');

      writeFileSync(
        join(rig.corpusDir, '2026-06-23-glm-boxed-queue.txt'),
        'User: keep testing GLM through the dream path.\n' +
        'Agent: ' + 'meaningful conversation '.repeat(220),
      );

      const queue = new MinionQueue(rig.engine);
      const unrelated = await queue.add(
        'subagent',
        { prompt: 'unrelated default-queue job', model: 'zai:glm-5.2' },
        { queue: 'default' },
        { allowProtectedSubmit: true },
      );

      let synthTurn = 0;
      __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
        if ((opts.system ?? '').includes('You judge whether a conversation transcript is worth synthesizing')) {
          return {
            text: JSON.stringify({
              worth_processing: true,
              reasons: ['user wants to validate queue isolation on dream synthesis'],
            }),
            blocks: [{
              type: 'text',
              text: JSON.stringify({
                worth_processing: true,
                reasons: ['user wants to validate queue isolation on dream synthesis'],
              }),
            }],
            stopReason: 'end',
            usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'anthropic:claude-haiku-4-5-20251001',
            providerId: 'anthropic',
          };
        }

        if (opts.model === 'zai:glm-5.2') {
          synthTurn++;
          if (synthTurn === 1) {
            return {
              text: '',
              blocks: [{
                type: 'tool-call',
                toolCallId: 'glm-boxed-queue-put-page',
                toolName: 'brain_put_page',
                input: {
                  slug: 'wiki/personal/reflections/2026-06-23-glm-boxed-queue',
                  content: [
                    '---',
                    'title: GLM boxed queue',
                    'type: note',
                    '---',
                    '',
                    '# GLM boxed queue',
                    '',
                    'The synth child ran on its own queue and left default-queue work untouched.',
                  ].join('\n'),
                },
              }],
              stopReason: 'tool_calls',
              usage: { input_tokens: 40, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
              model: 'zai:glm-5.2',
              providerId: 'zai',
            };
          }

          return {
            text: 'reflection written',
            blocks: [{ type: 'text', text: 'reflection written' }],
            stopReason: 'end',
            usage: { input_tokens: 30, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'zai:glm-5.2',
            providerId: 'zai',
          };
        }

        throw new Error(`unexpected chat transport model/system: ${opts.model ?? '<default>'}`);
      });

      const savedKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-glm-judge';
      try {
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });

        expect(result.status).toBe('ok');
        const details = result.details as {
          child_queue: string;
          child_outcomes: Array<{ jobId: number; status: string }>;
        };
        expect(details.child_queue).toBe('dream-synth-test');
        expect(details.child_outcomes).toHaveLength(1);

        const childRow = await rig.engine.executeRaw<{ queue: string }>(
          'SELECT queue FROM minion_jobs WHERE id = $1',
          [details.child_outcomes[0].jobId],
        );
        expect(childRow[0]?.queue).toBe('dream-synth-test');

        const unrelatedAfter = await queue.getJob(unrelated.id);
        expect(unrelatedAfter?.status).toBe('waiting');
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
        __setChatTransportForTests(null);
        resetGateway();
      }
    } finally {
      worker.stop();
      await runPromise;
      await rig.cleanup();
    }
  }, 30_000);

  test('boxed synth children carry tighter turn, timeout, stall, and cost limits', async () => {
    const { __setChatTransportForTests, resetGateway } = await import('../../src/core/ai/gateway.ts');

    const rig = await setupRig();
    const worker = new MinionWorker(rig.engine, {
      queue: 'dream-synth-test',
      pollInterval: 25,
      lockDuration: 30_000,
    });
    await registerBuiltinHandlers(worker, rig.engine);
    const runPromise = worker.start();

    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      await rig.engine.setConfig('dream.synthesize.queue', 'dream-synth-test');
      await rig.engine.setConfig('dream.synthesize.max_child_cost_usd', '0.42');
      await rig.engine.setConfig('models.dream.synthesize', 'zai:glm-5.2');
      await rig.engine.setConfig('models.dream.synthesize_verdict', 'anthropic:claude-haiku-4-5-20251001');
      await rig.engine.setConfig('agent.use_gateway_loop', 'true');
      await rig.engine.setConfig('dream.synthesize.last_completion_ts', '2000-01-01T00:00:00.000Z');

      writeFileSync(
        join(rig.corpusDir, '2026-06-23-glm-boxed-guards.txt'),
        'User: keep the Dream child boxed tightly.\n' +
        'Agent: ' + 'meaningful conversation '.repeat(220),
      );

      let synthTurn = 0;
      __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
        if ((opts.system ?? '').includes('You judge whether a conversation transcript is worth synthesizing')) {
          return {
            text: JSON.stringify({
              worth_processing: true,
              reasons: ['user wants to validate Dream child guardrails'],
            }),
            blocks: [{
              type: 'text',
              text: JSON.stringify({
                worth_processing: true,
                reasons: ['user wants to validate Dream child guardrails'],
              }),
            }],
            stopReason: 'end',
            usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'anthropic:claude-haiku-4-5-20251001',
            providerId: 'anthropic',
          };
        }

        if (opts.model === 'zai:glm-5.2') {
          synthTurn++;
          if (synthTurn === 1) {
            return {
              text: '',
              blocks: [{
                type: 'tool-call',
                toolCallId: 'glm-boxed-guards-put-page',
                toolName: 'brain_put_page',
                input: {
                  slug: 'wiki/personal/reflections/2026-06-23-glm-boxed-guards',
                  content: [
                    '---',
                    'title: GLM boxed guards',
                    'type: note',
                    '---',
                    '',
                    '# GLM boxed guards',
                    '',
                    'The Dream synth child carried the tighter runtime guardrails.',
                  ].join('\n'),
                },
              }],
              stopReason: 'tool_calls',
              usage: { input_tokens: 40, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
              model: 'zai:glm-5.2',
              providerId: 'zai',
            };
          }

          return {
            text: 'reflection written',
            blocks: [{ type: 'text', text: 'reflection written' }],
            stopReason: 'end',
            usage: { input_tokens: 30, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'zai:glm-5.2',
            providerId: 'zai',
          };
        }

        throw new Error(`unexpected chat transport model/system: ${opts.model ?? '<default>'}`);
      });

      const savedKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-glm-judge';
      try {
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });

        expect(result.status).toBe('ok');
        const details = result.details as {
          child_outcomes: Array<{ jobId: number; status: string }>;
        };
        expect(details.child_outcomes).toHaveLength(1);

        const queue = new MinionQueue(rig.engine);
        const child = await queue.getJob(details.child_outcomes[0].jobId);
        expect(child).not.toBeNull();
        expect(child?.queue).toBe('dream-synth-test');
        expect(child?.max_stalled).toBe(2);
        expect(child?.timeout_ms).toBe(15 * 60 * 1000);
        expect(child?.data.max_turns).toBe(12);
        expect(child?.data.max_cost_usd).toBe(0.42);
        expect(child?.data.model).toBe('zai:glm-5.2');
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
        __setChatTransportForTests(null);
        resetGateway();
      }
    } finally {
      worker.stop();
      await runPromise;
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E synthesize — round-trip self-consumption guard (v0.23.2)', () => {
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
        // A legitimate transcript that merely mentions a reflection slug
        // must not be mistaken for dream-generated output.
        expect(stderr).not.toMatch(
          /\[dream\] skipped 2026-04-30-real-convo: dream_generated marker/,
        );
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
