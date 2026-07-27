/**
 * v0.40.2.0 — Pure intent classifier tests for `src/core/think/intent.ts`.
 *
 * Hermetic, no DB, no API keys.
 */

import { describe, test, expect } from 'bun:test';
import { classifyIntent } from '../src/core/think/intent.ts';

describe('classifyIntent — temporal triggers', () => {
  test('"when did I last meet marco" → temporal', () => {
    expect(classifyIntent('When did I last meet Marco?')).toBe('temporal');
  });

  test('"how long ago" → temporal', () => {
    expect(classifyIntent('How long ago did I switch jobs?')).toBe('knowledge_update');
    // "switch" also matches knowledge_update; KU wins per the precedence rule.
    // Test pure temporal:
    expect(classifyIntent('How long ago was the Boston trip?')).toBe('temporal');
  });

  test('date markers trigger temporal', () => {
    expect(classifyIntent('What happened in January 2026?')).toBe('temporal');
    expect(classifyIntent('Notes from March?')).toBe('temporal');
  });

  test('"last X" triggers temporal', () => {
    expect(classifyIntent('Last time we talked')).toBe('temporal');
    expect(classifyIntent('When was the last meeting?')).toBe('temporal');
  });
});

describe('classifyIntent — knowledge_update triggers', () => {
  test('supersession verbs win over temporal markers', () => {
    expect(classifyIntent('When did Marco switch jobs?')).toBe('knowledge_update');
    expect(classifyIntent('Did the team move offices last year?')).toBe('knowledge_update');
  });

  test('"current/latest/new" framing', () => {
    expect(classifyIntent("What's the current MRR?")).toBe('knowledge_update');
    expect(classifyIntent('What is the latest revenue number?')).toBe('knowledge_update');
  });

  test('"no longer" phrasing', () => {
    expect(classifyIntent('Is Alice no longer at the company?')).toBe('knowledge_update');
  });
});

describe('classifyIntent — other (default)', () => {
  test('open-ended questions without temporal/supersession markers', () => {
    expect(classifyIntent('Summarize the Acme deal')).toBe('other');
    expect(classifyIntent('Who knows about pricing strategy?')).toBe('other');
    expect(classifyIntent('Explain the Q2 roadmap')).toBe('other');
  });

  test('empty + whitespace + non-string fallbacks', () => {
    expect(classifyIntent('')).toBe('other');
    // @ts-expect-error testing non-string defense
    expect(classifyIntent(null)).toBe('other');
    // @ts-expect-error testing non-string defense
    expect(classifyIntent(undefined)).toBe('other');
  });
});

describe('classifyIntent — precedence', () => {
  test('knowledge_update wins when both classes match', () => {
    // "switched ... when" — supersession verb + temporal trigger
    expect(classifyIntent('When did Marco switch from acme to widget-co?')).toBe('knowledge_update');
  });
});
