/**
 * v0.40.2.0 — LongMemEval intent classifier tests.
 *
 * Sibling shape to test/think-intent.test.ts. The dataset's question_type
 * field takes priority; regex fallback applies when question_type is
 * absent or unknown.
 */

import { describe, test, expect } from 'bun:test';
import { classifyIntent } from '../src/eval/longmemeval/intent.ts';
import type { LongMemEvalQuestion } from '../src/eval/longmemeval/adapter.ts';

function mk(opts: { type: string; question?: string }): LongMemEvalQuestion {
  return {
    question_id: 'test',
    question_type: opts.type,
    question: opts.question ?? 'placeholder',
    answer: 'placeholder',
    haystack_sessions: [],
    answer_session_ids: [],
  };
}

describe('classifyIntent — dataset question_type wins', () => {
  test('temporal-reasoning maps to temporal', () => {
    expect(classifyIntent(mk({ type: 'temporal-reasoning' }))).toBe('temporal');
  });

  test('knowledge-update maps to knowledge_update', () => {
    expect(classifyIntent(mk({ type: 'knowledge-update' }))).toBe('knowledge_update');
  });

  test('single-session-user maps to other', () => {
    expect(classifyIntent(mk({ type: 'single-session-user' }))).toBe('other');
  });

  test('single-session-assistant maps to other', () => {
    expect(classifyIntent(mk({ type: 'single-session-assistant' }))).toBe('other');
  });

  test('multi-session maps to other', () => {
    expect(classifyIntent(mk({ type: 'multi-session' }))).toBe('other');
  });

  test('single-session-preference maps to other', () => {
    expect(classifyIntent(mk({ type: 'single-session-preference' }))).toBe('other');
  });

  test('dataset label trumps question-text signal', () => {
    // Question text screams "temporal" but the dataset said "multi-session".
    expect(
      classifyIntent(mk({
        type: 'multi-session',
        question: 'When did Marco last switch jobs?',
      })),
    ).toBe('other');
  });
});

describe('classifyIntent — regex fallback for unknown question_type', () => {
  test('unknown question_type falls through to regex classifier', () => {
    expect(
      classifyIntent(mk({ type: 'unknown-future-label', question: 'When did this happen?' })),
    ).toBe('temporal');
  });

  test('missing question_type also falls through', () => {
    const q = mk({ type: '' });
    q.question = 'When did Marco switch jobs?';
    // Empty question_type → mapDatasetQuestionType returns null → regex applies.
    expect(classifyIntent(q)).toBe('knowledge_update');
  });
});
