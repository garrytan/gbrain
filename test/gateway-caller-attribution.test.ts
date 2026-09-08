/**
 * Caller attribution + embed token measurement on gateway spans.
 *
 * The gateway's OpenInference spans already carried model / provider / token
 * counts, but nothing about WHICH part of gbrain spent them, so a trace
 * dashboard could group by model and not by phase. These tests pin the two
 * rules that make the caller dimension trustworthy:
 *
 *   1. `withCallLabel` beats the ambient BudgetTracker label, and an absent
 *      label produces NO attribute (rather than an 'unknown' bucket that
 *      poisons group-by).
 *   2. Embedding token counts are only reported as measured when the provider
 *      actually returned usage — anything else stays on the char estimate.
 */
import { describe, test, expect } from 'bun:test';
import { withCallLabel, getCurrentCallLabel } from '../src/core/call-label.ts';
import {
  __callerAttributesForTests as callerAttributes,
  providerEmbedTokens,
  providerLlmTokens,
  withBudgetTracker,
} from '../src/core/ai/gateway.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';

function tracker(label: string): BudgetTracker {
  // auditPath into a non-existent nested dir would still be created by the
  // appender, so point it at the OS temp dir the harness already uses.
  return new BudgetTracker({ label, auditPath: `${process.env.TMPDIR ?? '/tmp'}/gbrain-caller-attr-test.jsonl` });
}

describe('call label ALS', () => {
  test('no label outside any region', () => {
    expect(getCurrentCallLabel()).toBeNull();
  });

  test('label is visible inside the region and cleared after', async () => {
    await withCallLabel('dream.synthesize', async () => {
      expect(getCurrentCallLabel()).toBe('dream.synthesize');
    });
    expect(getCurrentCallLabel()).toBeNull();
  });

  test('survives an await boundary', async () => {
    await withCallLabel('dream.patterns', async () => {
      await new Promise(r => setTimeout(r, 1));
      expect(getCurrentCallLabel()).toBe('dream.patterns');
    });
  });

  test('nested regions: innermost wins, outer restored on exit', async () => {
    await withCallLabel('outer', async () => {
      await withCallLabel('inner', async () => {
        expect(getCurrentCallLabel()).toBe('inner');
      });
      expect(getCurrentCallLabel()).toBe('outer');
    });
  });

  test('concurrent regions do not leak into each other', async () => {
    const seen: string[] = [];
    await Promise.all([
      withCallLabel('a', async () => {
        await new Promise(r => setTimeout(r, 5));
        seen.push(getCurrentCallLabel()!);
      }),
      withCallLabel('b', async () => {
        seen.push(getCurrentCallLabel()!);
      }),
    ]);
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  test('blank label runs the body unlabeled instead of stamping empty', async () => {
    await withCallLabel('   ', async () => {
      expect(getCurrentCallLabel()).toBeNull();
    });
  });

  test('label is trimmed', async () => {
    await withCallLabel('  dream.drift  ', async () => {
      expect(getCurrentCallLabel()).toBe('dream.drift');
    });
  });
});

describe('gateway caller attribution', () => {
  test('absent when neither a call label nor a tracker is active', () => {
    expect(callerAttributes()).toEqual({});
  });

  test('falls back to the BudgetTracker phase label', async () => {
    await withBudgetTracker(tracker('brainstorm'), async () => {
      expect(callerAttributes()).toEqual({ 'gbrain.caller': 'brainstorm' });
    });
  });

  test('explicit call label wins group-by, tracker label kept as detail', async () => {
    await withBudgetTracker(tracker('extract-atoms:confluence'), async () => {
      await withCallLabel('dream.extract_atoms', async () => {
        expect(callerAttributes()).toEqual({
          'gbrain.caller': 'dream.extract_atoms',
          'gbrain.budget_label': 'extract-atoms:confluence',
        });
      });
    });
  });

  test('no redundant detail attribute when the two labels agree', async () => {
    await withBudgetTracker(tracker('brainstorm'), async () => {
      await withCallLabel('brainstorm', async () => {
        expect(callerAttributes()).toEqual({ 'gbrain.caller': 'brainstorm' });
      });
    });
  });

  test('does not leak out of the region', async () => {
    await withCallLabel('dream.consolidate', async () => {
      expect(callerAttributes()).toEqual({ 'gbrain.caller': 'dream.consolidate' });
    });
    expect(callerAttributes()).toEqual({});
  });
});

describe('provider embed token detection', () => {
  test('reads a reported count', () => {
    expect(providerEmbedTokens({ usage: { tokens: 1234 } })).toBe(1234);
  });

  test.each([
    ['no usage key', { embeddings: [] }],
    ['usage present but empty', { usage: {} }],
    ['undefined tokens', { usage: { tokens: undefined } }],
    ['NaN tokens', { usage: { tokens: NaN } }],
    ['zero tokens', { usage: { tokens: 0 } }],
    ['negative tokens', { usage: { tokens: -5 } }],
    ['non-numeric tokens', { usage: { tokens: 'lots' } }],
    ['null result', null],
    ['undefined result', undefined],
  ])('returns 0 (→ caller keeps its estimate) when %s', (_label, input) => {
    expect(providerEmbedTokens(input)).toBe(0);
  });
});

describe('provider LLM token detection (expand path)', () => {
  test('reads the field names the installed AI SDK emits', () => {
    // ai@6 reports inputTokens/outputTokens — this is the shape that has to
    // work, or expansion spend stays invisible in production while the older
    // spelling keeps a test green.
    expect(providerLlmTokens({ usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 } }))
      .toEqual({ inputTokens: 120, outputTokens: 45 });
  });

  test('accepts the pre-v5 spelling for parity with the chat path', () => {
    expect(providerLlmTokens({ usage: { promptTokens: 7, completionTokens: 3 } }))
      .toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  test('a legitimate zero output (empty completion) is still a measurement', () => {
    expect(providerLlmTokens({ usage: { inputTokens: 50, outputTokens: 0 } }))
      .toEqual({ inputTokens: 50, outputTokens: 0 });
  });

  test('one side missing does not discard the side that was reported', () => {
    expect(providerLlmTokens({ usage: { inputTokens: 50 } }))
      .toEqual({ inputTokens: 50, outputTokens: 0 });
  });

  test.each([
    ['no usage key', { text: 'hi' }],
    ['usage present but empty', { usage: {} }],
    ['both fields undefined', { usage: { inputTokens: undefined, outputTokens: undefined } }],
    ['NaN counts', { usage: { inputTokens: NaN, outputTokens: NaN } }],
    ['negative counts', { usage: { inputTokens: -1, outputTokens: -2 } }],
    ['non-numeric counts', { usage: { inputTokens: 'many' } }],
    // Number(null) is 0, so a coercing reader would publish a measured zero.
    ['null counts', { usage: { inputTokens: null, outputTokens: null } }],
    ['numeric strings (SDK contract is numbers; a string means something else)', { usage: { inputTokens: '120', outputTokens: '45' } }],
    ['null result', null],
    ['undefined result', undefined],
  ])('returns null (→ span stamps nothing) when %s', (_label, input) => {
    expect(providerLlmTokens(input)).toBeNull();
  });
});
