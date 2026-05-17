/**
 * Judge wrapper tests — hermetic via direct `chatFn` stub.
 *
 * Covers:
 *   - prompt building (query-conditioned, holder included, truncation)
 *   - parseModelJSON 4-strategy fence-stripping
 *   - shape validation (missing/invalid fields throw)
 *   - C1 confidence-floor double-enforcement
 *   - severity classification
 *   - refusal detection
 *   - UTF-8-safe truncation
 */

import { describe, test, expect } from 'bun:test';
import {
  buildJudgePrompt,
  judgeContradiction,
  normalizeVerdict,
  truncateUtf8,
  DEFAULT_MAX_PAIR_CHARS,
} from '../src/core/eval-contradictions/judge.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

function mkResult(text: string, overrides: Partial<ChatResult> = {}): ChatResult {
  return {
    text,
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
    ...overrides,
  };
}

function stubChat(response: ChatResult | ((opts: ChatOpts) => ChatResult | Promise<ChatResult>)) {
  return async (opts: ChatOpts): Promise<ChatResult> => {
    if (typeof response === 'function') return await response(opts);
    return response;
  };
}

describe('truncateUtf8', () => {
  test('returns unchanged when under limit', () => {
    expect(truncateUtf8('short', 100)).toBe('short');
  });

  test('truncates at code-point boundary', () => {
    const out = truncateUtf8('hello world', 5);
    expect(out).toBe('hello');
  });

  test('handles empty string', () => {
    expect(truncateUtf8('', 100)).toBe('');
  });

  test('does not split surrogate pairs (4-byte emoji)', () => {
    // 🚀 = U+1F680 (surrogate pair in UTF-16, length 2 in JS string).
    const text = 'a🚀b';  // length 4 in JS
    const out = truncateUtf8(text, 3);  // would split the emoji
    // Should drop the high surrogate, leaving just 'a'.
    expect(out).toBe('a');
  });
});

describe('buildJudgePrompt', () => {
  test('includes user query verbatim (query-conditioned, Codex fix)', () => {
    const p = buildJudgePrompt({
      query: 'what is acme MRR',
      a: { slug: 'companies/acme', text: 'A text' },
      b: { slug: 'openclaw/chat/1', text: 'B text' },
      maxPairChars: 1500,
    });
    expect(p).toContain("User's query: what is acme MRR");
  });

  test('truncates per maxPairChars', () => {
    const longText = 'x'.repeat(5000);
    const p = buildJudgePrompt({
      query: 'q',
      a: { slug: 'a', text: longText },
      b: { slug: 'b', text: longText },
      maxPairChars: 500,
    });
    // longText was 5000; both sides should appear truncated.
    expect(p.split('x'.repeat(501)).length).toBe(1);  // no 501-x run survives
  });

  test('includes source-tier label when present', () => {
    const p = buildJudgePrompt({
      query: 'q',
      a: { slug: 'a', text: 'A', source_tier: 'curated' },
      b: { slug: 'b', text: 'B', source_tier: 'bulk' },
      maxPairChars: 1500,
    });
    expect(p).toContain('source-tier curated');
    expect(p).toContain('source-tier bulk');
  });

  test('includes holder for take pairs', () => {
    const p = buildJudgePrompt({
      query: 'q',
      a: { slug: 'a', text: 'A' },
      b: { slug: 'b', text: 'B', holder: 'garry' },
      maxPairChars: 1500,
    });
    expect(p).toContain('holder garry');
  });
});

describe('normalizeVerdict', () => {
  test('valid contradiction verdict passes through', () => {
    const v = normalizeVerdict({
      verdict: 'contradiction',
      severity: 'medium',
      axis: 'MRR figure',
      confidence: 0.85,
      resolution_kind: 'dream_synthesize',
    });
    expect(v.verdict).toBe('contradiction');
    expect(v.severity).toBe('medium');
    expect(v.confidence).toBe(0.85);
    expect(v.resolution_kind).toBe('dream_synthesize');
  });

  test('valid temporal_supersession verdict passes through (Lane A2)', () => {
    const v = normalizeVerdict({
      verdict: 'temporal_supersession',
      severity: 'info',
      axis: 'role over time',
      confidence: 0.9,
      resolution_kind: 'temporal_supersede',
    });
    expect(v.verdict).toBe('temporal_supersession');
    expect(v.severity).toBe('info');
    expect(v.resolution_kind).toBe('temporal_supersede');
  });

  test('all 6 verdict members accepted by parser', () => {
    for (const verdict of [
      'no_contradiction',
      'contradiction',
      'temporal_supersession',
      'temporal_regression',
      'temporal_evolution',
      'negation_artifact',
    ] as const) {
      const v = normalizeVerdict({ verdict, severity: 'medium', confidence: 0.8 });
      expect(v.verdict).toBe(verdict);
    }
  });

  test('throws on missing verdict field', () => {
    expect(() => normalizeVerdict({ confidence: 0.9 })).toThrow();
  });

  test('throws on invalid verdict string', () => {
    expect(() => normalizeVerdict({ verdict: 'maybe', confidence: 0.9 })).toThrow();
  });

  test('throws on invalid confidence', () => {
    expect(() => normalizeVerdict({ verdict: 'contradiction', confidence: 'high' })).toThrow();
    expect(() => normalizeVerdict({ verdict: 'contradiction', confidence: NaN })).toThrow();
  });

  test('throws on missing or non-object input', () => {
    expect(() => normalizeVerdict(null)).toThrow();
    expect(() => normalizeVerdict(undefined)).toThrow();
    expect(() => normalizeVerdict('json string')).toThrow();
  });

  test('C1 double-enforce: verdict:contradiction + confidence<0.7 downgrades to no_contradiction', () => {
    const v = normalizeVerdict({
      verdict: 'contradiction',
      severity: 'high',
      axis: 'something',
      confidence: 0.6,
      resolution_kind: 'takes_supersede',
    });
    expect(v.verdict).toBe('no_contradiction');
    expect(v.axis).toBe('');
    expect(v.resolution_kind).toBeNull();
  });

  test('C1 boundary: confidence exactly 0.7 stays as verdict:contradiction', () => {
    const v = normalizeVerdict({
      verdict: 'contradiction',
      severity: 'medium',
      axis: 'something',
      confidence: 0.7,
    });
    expect(v.verdict).toBe('contradiction');
    expect(v.confidence).toBe(0.7);
  });

  test('C1 floor does NOT downgrade other verdicts on low confidence (Lane A2)', () => {
    const v = normalizeVerdict({
      verdict: 'temporal_supersession',
      severity: 'info',
      confidence: 0.4,
    });
    // Non-contradiction verdicts have no confidence floor; they survive at 0.4.
    expect(v.verdict).toBe('temporal_supersession');
  });

  test('clamps confidence into [0, 1]', () => {
    const v1 = normalizeVerdict({ verdict: 'no_contradiction', severity: 'low', confidence: -0.5 });
    expect(v1.confidence).toBe(0);
    const v2 = normalizeVerdict({ verdict: 'no_contradiction', severity: 'low', confidence: 1.5 });
    expect(v2.confidence).toBe(1);
  });

  test('garbage severity falls back to defaultSeverityForVerdict (no_contradiction → info)', () => {
    const v = normalizeVerdict({
      verdict: 'no_contradiction',
      severity: 'critical',
      confidence: 0.5,
    });
    expect(v.severity).toBe('info');
  });

  test('garbage severity falls back to defaultSeverityForVerdict (contradiction → medium)', () => {
    const v = normalizeVerdict({
      verdict: 'contradiction',
      severity: 'critical',
      confidence: 0.85,
    });
    expect(v.severity).toBe('medium');
  });

  test('unknown resolution_kind on contradiction falls back to manual_review (legacy)', () => {
    const v = normalizeVerdict({
      verdict: 'contradiction',
      severity: 'medium',
      axis: 'X',
      confidence: 0.85,
      resolution_kind: 'invalid_kind',
    });
    expect(v.resolution_kind).toBe('manual_review');
  });

  test('axis cleared when verdict:no_contradiction', () => {
    const v = normalizeVerdict({
      verdict: 'no_contradiction',
      severity: 'low',
      axis: 'some axis',
      confidence: 0.4,
    });
    expect(v.axis).toBe('');
  });
});

describe('judgeContradiction', () => {
  const baseInput = {
    query: 'what is acme MRR',
    a: { slug: 'companies/acme', text: 'Acme MRR is $2M (compiled).' },
    b: { slug: 'openclaw/chat/1', text: 'Acme MRR was $50K back in 2024.' },
    model: 'anthropic:claude-haiku-4-5',
  };

  test('happy path: direct-parse JSON response', async () => {
    const out = await judgeContradiction({
      ...baseInput,
      chatFn: stubChat(mkResult(JSON.stringify({
        verdict: 'contradiction',
        severity: 'medium',
        axis: 'MRR figure',
        confidence: 0.85,
        resolution_kind: 'dream_synthesize',
      }))),
    });
    expect(out.verdict.verdict).toBe('contradiction');
    expect(out.verdict.severity).toBe('medium');
    expect(out.usage.inputTokens).toBe(100);
    expect(out.usage.outputTokens).toBe(50);
  });

  test('fence-wrapped JSON: parseModelJSON 4-strategy fallback', async () => {
    const fenced = '```json\n' + JSON.stringify({
      verdict: 'no_contradiction',
      severity: 'info',
      confidence: 0.3,
    }) + '\n```';
    const out = await judgeContradiction({
      ...baseInput,
      chatFn: stubChat(mkResult(fenced)),
    });
    expect(out.verdict.verdict).toBe('no_contradiction');
  });

  test('throws on parse failure (counted in judge_errors)', async () => {
    await expect(
      judgeContradiction({
        ...baseInput,
        chatFn: stubChat(mkResult('not valid json at all')),
      })
    ).rejects.toThrow();
  });

  test('detects refusal via stopReason', async () => {
    await expect(
      judgeContradiction({
        ...baseInput,
        chatFn: stubChat(mkResult('Anything', { stopReason: 'refusal' })),
      })
    ).rejects.toThrow(/refused/i);
  });

  test('detects refusal via response text', async () => {
    await expect(
      judgeContradiction({
        ...baseInput,
        chatFn: stubChat(mkResult("I can't help with that")),
      })
    ).rejects.toThrow(/refused/i);
  });

  test('passes maxPairChars through to truncation', async () => {
    let capturedPrompt = '';
    await judgeContradiction({
      ...baseInput,
      a: { slug: 'a', text: 'x'.repeat(5000) },
      b: { slug: 'b', text: 'y'.repeat(5000) },
      maxPairChars: 100,
      chatFn: stubChat(async (opts) => {
        const userMsg = opts.messages.find((m) => m.role === 'user');
        capturedPrompt = typeof userMsg?.content === 'string' ? userMsg.content : '';
        return mkResult(JSON.stringify({
          verdict: 'no_contradiction', severity: 'info', confidence: 0.5,
        }));
      }),
    });
    expect(capturedPrompt.split('x'.repeat(101)).length).toBe(1);
  });

  test('default maxPairChars constant is 1500', () => {
    expect(DEFAULT_MAX_PAIR_CHARS).toBe(1500);
  });

  test('C1 enforcement reaches the verdict (low-confidence contradiction → no_contradiction)', async () => {
    const out = await judgeContradiction({
      ...baseInput,
      chatFn: stubChat(mkResult(JSON.stringify({
        verdict: 'contradiction',
        severity: 'high',
        axis: 'something',
        confidence: 0.5,
      }))),
    });
    expect(out.verdict.verdict).toBe('no_contradiction');
  });

  test('query appears in the rendered prompt (Codex fix)', async () => {
    let capturedQuery = '';
    await judgeContradiction({
      ...baseInput,
      query: 'distinctive-query-marker-12345',
      chatFn: stubChat(async (opts) => {
        const m = opts.messages[0]?.content;
        capturedQuery = typeof m === 'string' ? m : '';
        return mkResult(JSON.stringify({ verdict: 'no_contradiction', severity: 'info', confidence: 0.4 }));
      }),
    });
    expect(capturedQuery).toContain('distinctive-query-marker-12345');
  });
});
