/** Free contracts only: DI stages and a fake reader; no provider requests or quality claims. */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkNightlyJudgeCapabilities, type NightlyProbeModelRoutes } from '../src/core/cycle/nightly-probe-routes.ts';
import { runNightlyQualityProbe, type NightlyProbeDeps } from '../src/core/cycle/nightly-quality-probe.ts';
import { readRecentQualityProbeEvents, type QualityProbeFailure } from '../src/core/audit-quality-probe.ts';
import { buildReaderRequest, diagnoseReaderFailure, generateAnswer, READER_PROMPT_SHA, resolveReaderConfig } from '../src/eval/longmemeval/reader.ts';
import { computeNightlyQualityProbeHealthCheck } from '../src/commands/doctor/checks/search-eval.ts';
import { aggregate } from '../src/core/cross-modal-eval/aggregate.ts';
import { withEnv } from './helpers/with-env.ts';

const TWO = { A: 'deepseek:deepseek-flash', B: 'deepseek:deepseek-v4-pro' };
const THREE = { ...TWO, C: 'zhipu:glm-5.3-flash' };
const routes = (slots: NightlyProbeModelRoutes['slots']): NightlyProbeModelRoutes => ({
  reader: { model: TWO.A, source: 'config_key' }, extractor: { model: TWO.A, source: 'tier_config' }, slots,
});
const DIRECT = { question_id: 'nightly-5', reader_mode: 'direct', reader_prompt_sha: READER_PROMPT_SHA,
  reader_finish_reason: 'end_turn', recall_all_hit: true, hypothesis: 'placeholder-city' };
const failure: QualityProbeFailure = { question_id: 'nightly-5', verdict: 'fail',
  dimensions: [{ dimension: 'correctness', mean: 3.5, scores: [null, 3, 4], fail_reason: 'mean_below_7' }] };

async function probe(slots: NightlyProbeModelRoutes['slots'], opts: { row?: object; duplicate?: boolean; stageError?: boolean; judgeError?: 'inconclusive' | 'error' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-contract-'));
  const stages: string[] = [];
  const now = new Date();
  const failed = !!opts.row;
  try {
    return await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const deps: NightlyProbeDeps = {
        isEnabled: () => true, hasEmbeddingProvider: () => true, resolveMaxUsd: () => 5,
        resolveRepoRoot: () => process.cwd(), resolveModelRoutes: async () => routes(slots), now: () => now,
        runLongMemEval: async ({ outputPath }) => {
          stages.push('reader');
          if (opts.stageError) throw new Error('synthetic reader failure');
          writeFileSync(outputPath, JSON.stringify(opts.row ?? { question_id: 'nightly-5', hypothesis: 'placeholder-city' }) + '\n');
        },
        runCrossModalBatch: async () => {
          stages.push('judges');
          if (opts.judgeError) return { exitCode: 2, summary: {
            verdict: opts.judgeError, pass_count: 0, fail_count: 0,
            inconclusive_count: opts.judgeError === 'inconclusive' ? 1 : 0,
            error_count: opts.judgeError === 'error' ? 1 : 0, est_cost_usd: 0,
            judge_models: [TWO.A, TWO.B],
            panel: { distinct_models: 0, distinct_providers: 0, slot_scored_questions: [0, 0] },
            failures: [{ question_id: 'nightly-5', verdict: opts.judgeError,
              slot_errors: [TWO.A, TWO.B].map(model => ({ model, error: 'synthetic judge infrastructure failure' })) }],
          } };
          return { exitCode: failed ? 2 : 0, summary: {
            verdict: failed ? 'fail' : 'pass', pass_count: failed ? 0 : 1, fail_count: failed ? 1 : 0,
            inconclusive_count: 0, error_count: 0, est_cost_usd: 0,
            judge_models: opts.duplicate ? [TWO.A, TWO.A, TWO.B] : [TWO.A, TWO.B],
            panel: { distinct_models: 2, distinct_providers: 1, slot_scored_questions: opts.duplicate ? [1, 1, 1] : [1, 1] },
            ...(failed ? { failures: [failure] } : {}),
          } };
        },
      };
      const result = await runNightlyQualityProbe(deps);
      const [event] = readRecentQualityProbeEvents(2, now);
      return { result, event, stages };
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('nightly configured judge capability gate', () => {
  test.each([
    ['dashscope:qwen3.8-flash', 'does not support touchpoint "chat"'],
    ['unknown-provider-example:judge', 'Unknown provider: "unknown-provider-example"'],
  ])('%s fails before any reader/extractor or judge work, even with two other ready models', async (model, reason) => {
    const { result, event, stages } = await probe({ A: model, B: TWO.A, C: TWO.B });
    expect(result).toMatchObject({ outcome: 'error', exit_code: 1 });
    expect(result.detail).toContain(reason);
    expect(stages).toEqual([]);
    expect(event).toMatchObject({ reason: 'capability_error', chat_calls: 0, chat_cost_usd: 0, capability_distinct_models: 2 });
    expect(event.judge_capabilities).toEqual([
      { slot: 'A', model, capability_ready: false, error: expect.stringContaining(reason) },
      { slot: 'B', model: TWO.A, capability_ready: true }, { slot: 'C', model: TWO.B, capability_ready: true },
    ]);
  });

  test.each([TWO, THREE])('two or three chat-capable pins retain the existing two-scored-model rule', async slots => {
    const { result, event, stages } = await probe(slots);
    expect(result.outcome).toBe('pass');
    expect(stages).toEqual(['reader', 'judges']);
    expect(event.capability_distinct_models).toBe(Object.keys(slots).length);
    expect(event.distinct_judge_models).toBe(2);
    expect(event.distinct_judge_providers).toBe(1);
  });

  test('duplicate configured votes remain inconclusive; capability readiness is not a scoring quorum', async () => {
    const slots = { ...TWO, C: TWO.A };
    expect(checkNightlyJudgeCapabilities(slots).capability_distinct_models).toBe(2);
    const { result, event } = await probe(slots, { duplicate: true });
    expect(result.outcome).toBe('inconclusive');
    expect(event.reason).toBe('panel_collapsed');
  });

  test('model aliases and provider slash syntax count once; no model catalog allowlist is added', () => {
    const report = checkNightlyJudgeCapabilities({ A: 'openai:gpt-5.2', B: 'OPENAI/gpt-5.2', C: 'openai:future-model-example' });
    expect(report.capability_distinct_models).toBe(2);
    expect(report.judge_capabilities.every(s => s.capability_ready)).toBe(true);
    expect(checkNightlyJudgeCapabilities({}).judge_capabilities).toEqual([]);
  });

  test('capability receipt survives a later reader failure', async () => {
    const { result, event } = await probe(TWO, { stageError: true });
    expect(result.outcome).toBe('error');
    expect(event.capability_distinct_models).toBe(2);
    expect(event.judge_capabilities).toHaveLength(2);
  });
});

describe('literal reader request and receipt diagnosis', () => {
  test.each(['inconclusive', 'error'] as const)('judge-only %s preserves its verdict and never diagnoses a healthy reader', async judgeError => {
    const { result, event, stages } = await probe(TWO, { row: DIRECT, judgeError });
    expect(stages).toEqual(['reader', 'judges']);
    expect(result.outcome).toBe(judgeError);
    expect(event.outcome).toBe(judgeError);
    expect(event.chat_calls).toBe(0);
    expect(event.failures?.[0].slot_errors).toHaveLength(2);
    expect(event.failures?.[0].reader_cause).toBeUndefined();
  });

  test('a scored answer failure still diagnoses answer_quality', async () => {
    const { result, event } = await probe(TWO, { row: DIRECT });
    expect(result.outcome).toBe('fail');
    expect(event.failures?.[0].reader_cause).toBe('answer_quality');
  });

  test('nightly-5 reaches the reader unchanged with literal and missing-information instructions', () => {
    const q = readFileSync(new URL('./fixtures/longmemeval-nightly.jsonl', import.meta.url), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line)).find(q => q.question_id === 'nightly-5');
    expect(q.answer).toBe('placeholder-city');
    const request = buildReaderRequest({ question: q.question, rendered: JSON.stringify(q.haystack_sessions) }, TWO.A, resolveReaderConfig({ mode: 'direct' }));
    expect(request.max_tokens).toBe(512);
    expect(request.messages[0].content).toContain('Answer synthetic or literal values exactly as recorded');
    expect(request.messages[0].content).toContain('Do not replace a recorded value with a real-world name');
    expect(request.messages[0].content).toContain('Refuse only when the information needed to answer is missing');
    expect(request.messages[0].content).toContain(q.haystack_sessions[0][1].content);
  });

  test.each(['placeholder-city', "The information is not available; I don't know.", 'An incorrect real city with an explanation.'])('reader response is not rewritten or truncated: %s', async text => {
    const client = { create: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) };
    const answer = await generateAnswer(client as never, { question: 'Which city?' }, [], [], new Map(), TWO.A, '', resolveReaderConfig({ mode: 'direct' }));
    expect(answer.text).toBe(text);
    expect(answer.finish_reason).toBe('end_turn');
  });

  test.each([
    [{ hypothesis: "The information is not available; I don't know. The session only contains a placeholder rather than an actual city." }, 'literal_value_refusal'],
    [{ hypothesis: 'An incorrect city. Here is an explanation.' }, 'answer_quality'],
    [{ reader_mode: 'notes', hypothesis: 'placeholder-city' }, 'reader_protocol_mismatch'],
    [{ reader_prompt_sha: 'old-system-prompt' }, 'reader_prompt_mismatch'],
    [{ reader_finish_reason: 'max_tokens' }, 'reader_incomplete_output'],
    [{ reader_finish_reason: null }, 'reader_receipt_incomplete'],
    [{ recall_all_hit: false }, 'retrieval_miss'],
    [{ recall_all_hit: undefined }, 'reader_receipt_incomplete'],
    [{ reader_mode: undefined }, 'reader_receipt_incomplete'],
    [{ hypothesis: '' }, 'reader_incomplete_output'],
  ] as const)('receipt pins take precedence over answer wording: %j', (overrides, cause) => {
    expect(diagnoseReaderFailure({ ...DIRECT, ...overrides })).toBe(cause);
  });

  test('a failing literal-refusal receipt reaches Doctor as a machine cause without restart advice', async () => {
    const { result, event } = await probe(TWO, { row: { ...DIRECT, hypothesis: "I don't know: placeholder-city is a placeholder." } });
    expect(result.outcome).toBe('fail');
    expect(event.failures?.[0].reader_cause).toBe('literal_value_refusal');
    const check = computeNightlyQualityProbeHealthCheck(true, [event]);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ reader_causes: ['literal_value_refusal'], correctness_failed: true });
    expect(check.message).not.toContain('restart it');
  });

  test('old receipts stay unknown and keep WARN instead of diagnosing a daemon from prose', () => {
    const check = computeNightlyQualityProbeHealthCheck(true, [{ outcome: 'fail', ts: new Date().toISOString(), failures: [failure] }]);
    expect(check.details).toMatchObject({ reader_causes: ['reader_receipt_unavailable'] });
    expect(check.status).toBe('warn');
    expect(check.message).not.toContain('restart it');
  });

  test('real low scores still FAIL at the unchanged mean and floor with two judges', () => {
    const scored = (modelId: string, score: number) => ({ ok: true as const, modelId, parsed: {
      scores: { correctness: { score, rationale: 'synthetic score' } }, improvements: [],
    } });
    expect(aggregate({ slots: [scored(TWO.A, 3), scored(TWO.B, 4)] }).verdict).toBe('fail');
    expect(aggregate({ slots: [scored(TWO.A, 4), scored(TWO.B, 10)] }).dimensions.correctness.failReason).toBe('min_below_5');
    expect(aggregate({ slots: [scored(TWO.A, 7), scored(TWO.B, 7)] }).verdict).toBe('pass');
  });
});
