import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import type { ThinkLLMClient } from '../src/core/think/index.ts';
import { buildQaAccuracy } from '../src/eval/longmemeval/qa-accuracy.ts';

let dir: string;
let dataset: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lme-reader-mode-'));
  dataset = join(dir, 'dataset.jsonl');
  writeFileSync(dataset, JSON.stringify({
    question_id: 'reader-1', question_type: 'single-session-user', question: 'Which tea?', answer: 'mint',
    question_date: '2024-01-02', answer_session_ids: ['s1'], haystack_dates: ['2024-01-01'],
    haystack_sessions: [{ session_id: 's1', turns: [{ role: 'user', content: 'I like mint tea.' }] }],
  }) + '\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base = () => [dataset, '--keyword-only', '--no-trajectory', '--no-embed-cache', '--by-type', '--model', 'anthropic:claude-sonnet-4-6'];
const rows = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
function stub(reason: 'end_turn' | 'max_tokens', seen: Anthropic.MessageCreateParamsNonStreaming[]): ThinkLLMClient {
  return { create: async (params) => {
    seen.push(params);
    return { model: params.model, content: [{ type: 'text', text: 'mint' }], stop_reason: reason } as Anthropic.Message;
  } };
}

describe('reader mode CLI receipts', () => {
  test('notes is default; direct preserves the earlier system instruction and output budget', async () => {
    const directPath = join(dir, 'direct.jsonl');
    const notesPath = join(dir, 'notes.jsonl');
    const directCalls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const notesCalls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    await runEvalLongMemEval([...base(), '--reader-mode', 'direct', '--output', directPath], { client: stub('end_turn', directCalls), exitOnError: false });
    await runEvalLongMemEval([...base(), '--output', notesPath], { client: stub('end_turn', notesCalls), exitOnError: false });
    expect(directCalls).toHaveLength(1);
    expect(notesCalls).toHaveLength(1);
    expect(directCalls[0].messages).toEqual(notesCalls[0].messages);
    expect(notesCalls[0].system).not.toBe(directCalls[0].system);
    expect(directCalls[0].max_tokens).toBe(512);
    expect(notesCalls[0].max_tokens).toBe(1024);
    const [direct, directSummary] = rows(directPath);
    const [notes, notesSummary] = rows(notesPath);
    expect(direct.reader_mode).toBe('direct');
    expect(notes.reader_mode).toBe('notes');
    expect(direct.reader_finish_reason).toBe('end_turn');
    expect(notes.reader_finish_reason).toBe('end_turn');
    expect(direct.reader_config_hash).not.toBe(notes.reader_config_hash);
    expect(directSummary.run_config.reader).toMatchObject({ mode: 'direct', max_tokens: 512, config_hash: direct.reader_config_hash });
    expect(notesSummary.run_config.reader).toMatchObject({ mode: 'notes', max_tokens: 1024, config_hash: notes.reader_config_hash });
    expect(direct.retrieval_config_hash).toBe(notes.retrieval_config_hash);

    await expect(runEvalLongMemEval([...base(), '--reader-mode', 'notes', '--output', directPath, '--resume-from', directPath, '--allow-mixed-run-config'], { client: stub('end_turn', []), exitOnError: false })).rejects.toThrow('exit 1');
    expect(rows(directPath)[0].reader_mode).toBe('direct');
    await runEvalLongMemEval([...base(), '--reader-mode', 'direct', '--output', directPath, '--resume-from', directPath], { client: stub('end_turn', []), exitOnError: false });
  });

  test('max_tokens records cutoff as error, keeps its denominator, and fails instead of judging partial text', async () => {
    const path = join(dir, 'cutoff.jsonl');
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    await expect(runEvalLongMemEval([...base(), '--reader-mode', 'notes', '--reader-max-tokens', '512', '--output', path], { client: stub('max_tokens', calls), exitOnError: false })).rejects.toThrow('exit 1');
    expect(calls[0].max_tokens).toBe(512);
    const [row, summary] = rows(path);
    expect(row).toMatchObject({ reader_mode: 'notes', reader_max_tokens: 512, reader_finish_reason: 'max_tokens', hypothesis: '', error: 'reader_max_tokens', reader_partial_output: 'mint' });
    expect(summary.run_config.errors).toBe(1);
    const qa = buildQaAccuracy([row], { judgeModel: 'm', judgePromptVersion: 'v', judgeConfigHash: 'h', estCostUsd: null, runCostUsd: null, methodologyNote: 'test' });
    expect(qa).toMatchObject({ total_questions: 1, reader_errors: 1, accuracy_headline: 0, complete: false });
  });

  test('invalid reader flags fail before any provider call', async () => {
    for (const flags of [['--reader-mode', 'summarize'], ['--reader-max-tokens', '0'], ['--reader-max-tokens', '1.5'], ['--reader-max-tokens', 'NaN']]) {
      const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
      await expect(runEvalLongMemEval([...base(), ...flags], { client: stub('end_turn', calls), exitOnError: false })).rejects.toThrow('exit 1');
      expect(calls).toHaveLength(0);
    }
  });

  test('empty and unknown completions are not treated as answered or judged', async () => {
    for (const [name, reason, text, error] of [
      ['empty', 'end_turn', '', 'reader_empty_response'],
      ['unknown', null, 'unfinished notes', 'reader_unknown_finish_reason'],
    ] as const) {
      const path = join(dir, `${name}.jsonl`);
      const client: ThinkLLMClient = { create: async (params) => ({ model: params.model, content: [{ type: 'text', text }], stop_reason: reason }) as Anthropic.Message };
      await expect(runEvalLongMemEval([...base(), '--output', path], { client, exitOnError: false })).rejects.toThrow('exit 1');
      const [row] = rows(path);
      expect(row).toMatchObject({ hypothesis: '', reader_finish_reason: reason, error });
      if (text) expect(row.reader_partial_output).toBe(text);
      expect(row.judge_correct).toBeUndefined();
    }
  });
});
