/** #7536: incomplete probes get one repair, never a fresh budget or a partial pass.
 * DI stages write synthetic receipts; gateway calls exercise real budget/meter settlement.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNightlyQualityProbe, type NightlyProbeDeps } from '../src/core/cycle/nightly-quality-probe.ts';
import { readRecentQualityProbeEvents } from '../src/core/audit-quality-probe.ts';
import { __setChatTransportForTests, chat, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { probeCompleteness } from '../src/core/cycle/nightly-probe-completeness.ts';

let home: string;
const model = 'anthropic:claude-haiku-4-5';
const pass = { pass_count: 2, fail_count: 0, inconclusive_count: 0, error_count: 0, total: 2, est_cost_usd: 0.01, verdict: 'pass' };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'probe-incomplete-'));
  configureGateway({ env: {} });
  __setChatTransportForTests(async () => ({ text: 'example', blocks: [], stopReason: 'end', model, providerId: 'anthropic',
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 } }));
});
afterEach(() => { __setChatTransportForTests(null); resetGateway(); rmSync(home, { recursive: true, force: true }); });
const paidCall = () => chat({ model, messages: [{ role: 'user', content: 'synthetic question' }], maxTokens: 1000 });
function deps(overrides: Partial<NightlyProbeDeps>): NightlyProbeDeps {
  return { isEnabled: () => true, hasEmbeddingProvider: () => true, resolveMaxUsd: () => 5,
    resolveRepoRoot: () => process.cwd(), now: () => new Date(),
    runLongMemEval: async ({ outputPath }) => { await paidCall(); writeFileSync(outputPath, 'synthetic first-stage receipt\n'); },
    runCrossModalBatch: async () => ({ exitCode: 0, summary: pass }), ...overrides };
}

test('an explicitly incomplete batch is repaired once and retains both receipts plus cumulative spend', async () => {
  await withEnv({ GBRAIN_AUDIT_DIR: home }, async () => {
    let attempts = 0;
    const result = await runNightlyQualityProbe(deps({ runCrossModalBatch: async ({ summaryPath }) => {
      attempts++; await paidCall();
      const summary = attempts === 1 ? { ...pass, pass_count: 1, total: 1, completeness: { complete: false, retryable: true } } : pass;
      writeFileSync(summaryPath, JSON.stringify(summary));
      return { exitCode: 0, summary };
    } }));
    expect(attempts).toBe(2);
    expect(result.outcome).toBe('pass');
    const events = readRecentQualityProbeEvents(1);
    expect(events.map(e => e.outcome)).toEqual(['error', 'pass']);
    expect(events.map(e => e.chat_calls)).toEqual([2, 2]);
    expect(events.map(e => e.attempt)).toEqual([1, 2]);
    expect(events[0].run_id).toBe(events[1].run_id);
    expect(events[0].receipt_dir).toBeDefined();
    expect(events[1].receipt_dir).toBeDefined();
    expect(events[0].receipt_dir).not.toBe(events[1].receipt_dir);
    expect(JSON.parse(readFileSync(join(events[0].receipt_dir!, 'summary.json'), 'utf8')).total).toBe(1);
    expect(JSON.parse(readFileSync(join(events[1].receipt_dir!, 'summary.json'), 'utf8')).total).toBe(2);
    expect(readdirSync(join(home, 'nightly-probe'))).toHaveLength(2);
    expect((await runNightlyQualityProbe(deps({}))).outcome).toBe('rate_limited');
  });
});

test('a second incomplete batch stays non-passing and stops after two attempts', async () => {
  await withEnv({ GBRAIN_AUDIT_DIR: home }, async () => {
    let attempts = 0;
    const result = await runNightlyQualityProbe(deps({ runCrossModalBatch: async () => {
      attempts++; return { exitCode: 0, summary: { ...pass, completeness: { complete: false, retryable: true } } };
    } }));
    expect(result.outcome).toBe('error');
    expect(result.exit_code).not.toBe(0);
    expect(attempts).toBe(2);
    expect(readRecentQualityProbeEvents(1).map(e => e.outcome)).toEqual(['error', 'error']);
  });
});

test('an authorization refusal is never repaired or accepted as a pass', async () => {
  await withEnv({ GBRAIN_AUDIT_DIR: home }, async () => {
    let attempts = 0;
    const result = await runNightlyQualityProbe(deps({ runCrossModalBatch: async () => {
      attempts++; return { exitCode: 0, summary: { ...pass, completeness: { complete: false, retryable: false } } };
    } }));
    expect(result.outcome).toBe('error'); expect(attempts).toBe(1);
  });
});

test('a complete quality failure is not retried to fish for a passing score', async () => {
  await withEnv({ GBRAIN_AUDIT_DIR: home }, async () => {
    let attempts = 0;
    const result = await runNightlyQualityProbe(deps({ runCrossModalBatch: async () => {
      attempts++; return { exitCode: 2, summary: { ...pass, pass_count: 1, fail_count: 1, verdict: 'fail' } };
    } }));
    expect(result.outcome).toBe('fail'); expect(attempts).toBe(1);
  });
});

test('coverage rejects missing, duplicate, foreign and inconclusive verdicts', () => {
  const a = { question_id: 'a', verdict: 'pass' };
  const b = { question_id: 'b', verdict: 'fail' };
  expect(probeCompleteness(['a', 'b'], [a, b], 'judge').complete).toBe(true);
  for (const rows of [[a], [a, a], [a, { ...b, question_id: 'c' }], [a, { ...b, verdict: 'inconclusive' }]]) {
    expect(probeCompleteness(['a', 'b'], rows, 'judge')).toEqual({ complete: false, retryable: true });
  }
  for (const error of ['HTTP 401 unauthorized', 'HTTP 402 credits exhausted', 'budget exceeded', 'unknown failure']) {
    expect(probeCompleteness(['a'], [{ ...a, error }], 'judge')).toEqual({ complete: false, retryable: false });
  }
  expect(probeCompleteness(['a'], [{ ...a, final_aggregate: { errors: [{ error: 'unparseable JSON' }] } }], 'judge'))
    .toEqual({ complete: false, retryable: true });
});

test('reader incompleteness skips judging and shares the original budget with repair', async () => {
  await withEnv({ GBRAIN_AUDIT_DIR: home }, async () => {
    let readers = 0;
    let judges = 0;
    const result = await runNightlyQualityProbe(deps({ resolveMaxUsd: () => 0.006,
      runLongMemEval: async () => {
        readers++;
        await paidCall();
        return { questionIds: ['a'], completeness: { complete: false, retryable: true } };
      },
      runCrossModalBatch: async () => { judges++; return { exitCode: 0, summary: pass }; },
    }));
    expect(readers).toBe(2);
    expect(judges).toBe(0);
    expect(result.outcome).toBe('budget_exceeded');
    expect(readRecentQualityProbeEvents(1).map(e => e.outcome)).toEqual(['error', 'budget_exceeded']);
  });
});
