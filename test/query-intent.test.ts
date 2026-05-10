/**
 * v0.29.1 — merged query-intent classifier tests.
 *
 * Covers the new classifyQuery(query) returning {intent, suggestedDetail,
 * suggestedSalience, suggestedRecency}. Legacy intent.ts behavior is
 * preserved in test/query-intent-legacy.test.ts (which imports the
 * classifyQueryIntent + autoDetectDetail compat shims).
 *
 * Pure regex; no DB.
 */

import { describe, test, expect } from 'bun:test';
import { classifyQuery } from '../src/core/search/query-intent.ts';

describe('classifyQuery — entity / canonical queries → both axes off', () => {
  test('"who is widget-ceo" → recency=off, salience=off', () => {
    const r = classifyQuery('who is widget-ceo');
    expect(r.intent).toBe('entity');
    expect(r.suggestedRecency).toBe('off');
    expect(r.suggestedSalience).toBe('off');
    expect(r.suggestedDetail).toBe('low');
  });

  test('"what is recursion" → both off', () => {
    const r = classifyQuery('what is recursion');
    expect(r.suggestedRecency).toBe('off');
    expect(r.suggestedSalience).toBe('off');
  });

  test('"tell me about widget-co" → both off', () => {
    const r = classifyQuery('tell me about widget-co');
    expect(r.suggestedRecency).toBe('off');
    expect(r.suggestedSalience).toBe('off');
  });

  test('"history of X" → both off (canonical)', () => {
    const r = classifyQuery('history of acme corp');
    expect(r.suggestedRecency).toBe('off');
    expect(r.suggestedSalience).toBe('off');
  });

  test('code lookup syntax → both off', () => {
    const r = classifyQuery('Foo::bar() returns null');
    expect(r.suggestedRecency).toBe('off');
    expect(r.suggestedSalience).toBe('off');
  });

  test('graph traversal language → both off', () => {
    const r = classifyQuery('show me backlinks to widget-co');
    expect(r.suggestedRecency).toBe('off');
    expect(r.suggestedSalience).toBe('off');
  });
});

describe('classifyQuery — current-state queries → both axes on', () => {
  test('"what\'s going on with widget-co" → both on', () => {
    const r = classifyQuery("what's going on with widget-co");
    expect(r.suggestedRecency).toBe('on');
    expect(r.suggestedSalience).toBe('on');
  });

  test('"catch me up on acme" → both on', () => {
    const r = classifyQuery('catch me up on acme');
    expect(r.suggestedRecency).toBe('on');
    expect(r.suggestedSalience).toBe('on');
  });

  test('"prep me for the widget-ceo meeting" → both on', () => {
    const r = classifyQuery('prep me for the widget-ceo meeting');
    expect(r.suggestedRecency).toBe('on');
    expect(r.suggestedSalience).toBe('on');
  });

  test('"before my meeting with X" → both on', () => {
    const r = classifyQuery('before my meeting with widget-ceo');
    expect(r.suggestedRecency).toBe('on');
    expect(r.suggestedSalience).toBe('on');
  });

  test('"remind me about acme" → both on', () => {
    const r = classifyQuery('remind me about acme');
    expect(r.suggestedRecency).toBe('on');
    expect(r.suggestedSalience).toBe('on');
  });
});

describe('classifyQuery — recency-only patterns (no salience signal)', () => {
  test('"latest news on AI" → recency=on, salience=off', () => {
    const r = classifyQuery('latest news on AI');
    expect(r.suggestedRecency).toBe('on');
    expect(r.suggestedSalience).toBe('off');
  });

  test('"this week\'s updates" → recency=on, salience=off', () => {
    const r = classifyQuery("this week's updates");
    expect(r.suggestedRecency).toBe('on');
    // "updates" + "on/with/from" pattern needed for salience
    expect(r.suggestedSalience).toBe('off');
  });
});

describe('classifyQuery — strong recency ("today" / "right now")', () => {
  test('"what happened today" → recency=strong', () => {
    const r = classifyQuery('what happened today');
    expect(r.suggestedRecency).toBe('strong');
  });

  test('"right now what is the status" → strong', () => {
    const r = classifyQuery('right now what is the status of the deal');
    // "what is" canonical fires; but "right now" is a temporal bound
    expect(r.suggestedRecency).toBe('strong');
  });
});

describe('classifyQuery — D6 narrow temporal-bound exception', () => {
  test('"who is widget-ceo right now" → recency=strong (temporal bound wins)', () => {
    const r = classifyQuery('who is widget-ceo right now');
    expect(r.suggestedRecency).toBe('strong');
  });

  test('"who is widget-ceo today" → recency=strong', () => {
    const r = classifyQuery('who is widget-ceo today');
    expect(r.suggestedRecency).toBe('strong');
  });

  test('"who is widget-ceo" (no bound) → recency=off (canonical wins)', () => {
    const r = classifyQuery('who is widget-ceo');
    expect(r.suggestedRecency).toBe('off');
  });

  test('"what is widget-co\'s status this week" → recency=on (temporal bound wins)', () => {
    const r = classifyQuery("what is widget-co's status this week");
    expect(r.suggestedRecency).toBe('on');
  });
});

describe('classifyQuery — orthogonality of axes', () => {
  test('default plain query → both off', () => {
    const r = classifyQuery('the quick brown fox');
    expect(r.suggestedRecency).toBe('off');
    expect(r.suggestedSalience).toBe('off');
    expect(r.intent).toBe('general');
    expect(r.suggestedDetail).toBeUndefined();
  });

  test('intent vs recency are independent axes', () => {
    // "when did widget-co IPO": both 'when' (temporal) and 'IPO' (event)
    // match v0.29.0 patterns. classifyQueryIntent's priority is
    // temporal > event so .intent = 'temporal'. But recency depends on
    // CANONICAL/RECENCY_ON patterns, not on .intent — neither set
    // matches here, so suggestedRecency = 'off'.
    const r = classifyQuery('when did widget-co IPO');
    expect(r.intent).toBe('temporal');
    expect(r.suggestedRecency).toBe('off');
    expect(r.suggestedSalience).toBe('off');
  });
});
