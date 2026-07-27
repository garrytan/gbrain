/**
 * SkillOpt scoring unit tests. All three judge modes (rule, llm, qrels).
 *
 * LLM judge is tested via DI'd chat seam (no real API calls).
 */

import { describe, expect, test } from 'bun:test';
import {
  countCitations,
  extractRetrievedSlugs,
  scoreQrels,
  scoreRule,
  scoreTrajectory,
} from '../../src/core/skillopt/score.ts';
import type { Trajectory } from '../../src/core/skillopt/types.ts';

function makeTrajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    task_id: 't1',
    task: 'do X',
    final_text: 'hello world',
    tool_calls: [],
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    turns: 1,
    stop_reason: 'end',
    duration_ms: 500,
    ...overrides,
  };
}

describe('scoreRule', () => {
  test('all checks pass → 1.0', () => {
    const t = makeTrajectory({ final_text: 'Short output\n## People\nalice-example' });
    const s = scoreRule(t, [
      { op: 'contains', arg: 'alice' },
      { op: 'section_present', arg: '## People' },
      { op: 'max_chars', arg: 100 },
    ]);
    expect(s).toBe(1);
  });

  test('all checks fail → 0', () => {
    const t = makeTrajectory({ final_text: 'short' });
    const s = scoreRule(t, [
      { op: 'contains', arg: 'missing' },
      { op: 'max_chars', arg: 1 },
    ]);
    expect(s).toBe(0);
  });

  test('partial pass → fractional score', () => {
    const t = makeTrajectory({ final_text: 'hello' });
    const s = scoreRule(t, [
      { op: 'contains', arg: 'hello' },
      { op: 'contains', arg: 'goodbye' },
    ]);
    expect(s).toBe(0.5);
  });

  test('empty checks array → 0 (no signal)', () => {
    expect(scoreRule(makeTrajectory(), [])).toBe(0);
  });

  test('regex op', () => {
    const t = makeTrajectory({ final_text: 'order #42' });
    expect(scoreRule(t, [{ op: 'regex', arg: '#\\d+' }])).toBe(1);
    expect(scoreRule(t, [{ op: 'regex', arg: 'XYZ' }])).toBe(0);
  });

  test('regex op tolerates malformed regex (returns false)', () => {
    const t = makeTrajectory({ final_text: 'abc' });
    expect(scoreRule(t, [{ op: 'regex', arg: '[invalid' }])).toBe(0);
  });

  test('section_present matches any heading depth', () => {
    const t = makeTrajectory({ final_text: '# Outline\n## People\n### Team' });
    expect(scoreRule(t, [{ op: 'section_present', arg: 'People' }])).toBe(1);
    expect(scoreRule(t, [{ op: 'section_present', arg: 'Team' }])).toBe(1);
    expect(scoreRule(t, [{ op: 'section_present', arg: 'Missing' }])).toBe(0);
  });

  test('min_citations counts links + brain-refs + footnotes', () => {
    const t = makeTrajectory({ final_text: '[link1](http://a.com) and wiki/foo [1]' });
    expect(scoreRule(t, [{ op: 'min_citations', arg: 3 }])).toBe(1);
    expect(scoreRule(t, [{ op: 'min_citations', arg: 4 }])).toBe(0);
  });

  test('tool_called requires a non-failed call with matching name', () => {
    const t = makeTrajectory({
      tool_calls: [
        { name: 'search', input: {}, output: {}, failed: false },
        { name: 'get_page', input: {}, output: {}, failed: true },
      ],
    });
    expect(scoreRule(t, [{ op: 'tool_called', arg: 'search' }])).toBe(1);
    expect(scoreRule(t, [{ op: 'tool_called', arg: 'get_page' }])).toBe(0); // failed
    expect(scoreRule(t, [{ op: 'tool_called', arg: 'never_called' }])).toBe(0);
  });

  test('tool_not_called passes when the tool never appears', () => {
    const t = makeTrajectory({
      tool_calls: [{ name: 'search', input: {}, output: {}, failed: false }],
    });
    expect(scoreRule(t, [{ op: 'tool_not_called', arg: 'put_page' }])).toBe(1);
    expect(scoreRule(t, [{ op: 'tool_not_called', arg: 'search' }])).toBe(0);
  });
});

describe('countCitations', () => {
  test('counts markdown links, brain-refs, footnotes', () => {
    expect(countCitations('[a](http://b)')).toBe(1);
    expect(countCitations('see wiki/foo')).toBe(1);
    expect(countCitations('mentioned [1] and [2]')).toBe(2);
    expect(countCitations('[a](http://b) wiki/x [1]')).toBe(3);
  });

  test('handles empty input', () => {
    expect(countCitations('')).toBe(0);
  });
});

describe('scoreQrels', () => {
  test('returns nDCG when retrieved slugs overlap expected', () => {
    const t = makeTrajectory({
      tool_calls: [{
        name: 'search',
        input: {},
        output: { results: [{ slug: 'people/alice-example' }, { slug: 'companies/widget-co' }] },
        failed: false,
      }],
    });
    const s = scoreQrels(t, ['people/alice-example', 'companies/widget-co'], 10);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  test('returns 0 when no retrieval tool called', () => {
    expect(scoreQrels(makeTrajectory(), ['anything'], 10)).toBe(0);
  });

  test('returns 0 when all expected slugs missing from retrieval', () => {
    const t = makeTrajectory({
      tool_calls: [{ name: 'search', input: {}, output: { results: [{ slug: 'wrong/slug' }] }, failed: false }],
    });
    expect(scoreQrels(t, ['people/missing'], 10)).toBe(0);
  });
});

describe('extractRetrievedSlugs', () => {
  test('extracts slugs from various tool output shapes', () => {
    const t = makeTrajectory({
      tool_calls: [
        { name: 'search', input: {}, output: { results: [{ slug: 'a' }, { slug: 'b' }] }, failed: false },
        { name: 'get_page', input: {}, output: { slug: 'c' }, failed: false },
        { name: 'list_pages', input: {}, output: { pages: [{ slug: 'd' }] }, failed: false },
      ],
    });
    expect(extractRetrievedSlugs(t)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('deduplicates repeated slugs', () => {
    const t = makeTrajectory({
      tool_calls: [
        { name: 'search', input: {}, output: { results: [{ slug: 'a' }] }, failed: false },
        { name: 'search', input: {}, output: { results: [{ slug: 'a' }] }, failed: false },
      ],
    });
    expect(extractRetrievedSlugs(t)).toEqual(['a']);
  });

  test('skips failed tool calls', () => {
    const t = makeTrajectory({
      tool_calls: [
        { name: 'search', input: {}, output: { results: [{ slug: 'a' }] }, failed: true },
        { name: 'search', input: {}, output: { results: [{ slug: 'b' }] }, failed: false },
      ],
    });
    expect(extractRetrievedSlugs(t)).toEqual(['b']);
  });
});

describe('scoreTrajectory (llm judge via DI)', () => {
  test('returns parsed score from chat result', async () => {
    const t = makeTrajectory({ final_text: 'good output' });
    const stub = async () => ({
      text: '{"score": 0.85, "rationale": "good"}',
      blocks: [],
      stopReason: 'end' as const,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test',
      providerId: 'test',
    });
    const r = await scoreTrajectory(t, { kind: 'llm', rubric: 'is it good?' }, { chatFn: stub as never });
    expect(r.score).toBeCloseTo(0.85, 2);
    expect(r.rationale).toBe('good');
  });

  test('returns score=0 on parse failure (pessimistic fallback)', async () => {
    const t = makeTrajectory();
    const stub = async () => ({
      text: 'this is not JSON',
      blocks: [],
      stopReason: 'end' as const,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test',
      providerId: 'test',
    });
    const r = await scoreTrajectory(t, { kind: 'llm', rubric: 'r' }, { chatFn: stub as never });
    expect(r.score).toBe(0);
    expect(r.judge_error).toBeDefined();
  });

  test('clamps out-of-range scores to [0,1]', async () => {
    const t = makeTrajectory();
    const stub = async () => ({
      text: '{"score": 1.7}',
      blocks: [],
      stopReason: 'end' as const,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test',
      providerId: 'test',
    });
    const r = await scoreTrajectory(t, { kind: 'llm', rubric: 'r' }, { chatFn: stub as never });
    expect(r.score).toBe(1);
  });

  test('returns score=0 + judge_error when chat throws', async () => {
    const t = makeTrajectory();
    const stub = async () => { throw new Error('network down'); };
    const r = await scoreTrajectory(t, { kind: 'llm', rubric: 'r' }, { chatFn: stub as never });
    expect(r.score).toBe(0);
    expect(r.judge_error).toMatch(/llm_call_failed.*network down/);
  });
});
