/**
 * v0.36.1.0 (T6 / D24) — voice gate unit tests.
 *
 * Hermetic. No real LLM, no PGLite. Inject the judge + generator + template
 * fallback per test.
 *
 * Tests cover:
 *  - D11 retry policy: 2 attempts then template fallback
 *  - happy path: first attempt passes, second attempt skipped
 *  - happy path: first rejected, second passes
 *  - both rejected → template fallback, audit fields populated
 *  - generator throws → counted as failed attempt + template fallback
 *  - parseJudgeOutput: fence-stripping, malformed input, parse failure
 *    falls to 'academic' (NOT pass-through)
 *  - mode parity: every VoiceGateMode has a default rubric
 *  - templates produce stable output for fixed slots
 */

import { describe, test, expect } from 'bun:test';
import {
  gateVoice,
  parseJudgeOutput,
  DEFAULT_RUBRICS,
  type VoiceGateJudge,
  type VoiceGateGenerator,
} from '../src/core/calibration/voice-gate.ts';
import {
  VOICE_GATE_MODES,
  patternStatementTemplate,
  nudgeTemplate,
  forecastBlurbTemplate,
  dashboardCaptionTemplate,
  morningPulseTemplate,
  type PatternStatementSlots,
} from '../src/core/calibration/templates.ts';

const passJudge: VoiceGateJudge = async () => ({ verdict: 'conversational', reason: 'reads natural' });
const rejectJudge: VoiceGateJudge = async () => ({ verdict: 'academic', reason: 'too clinical' });

const defaultSlots: PatternStatementSlots = { domain: 'macro tech', nRight: 2, nWrong: 5, direction: 'over-confident' };

// ─── parseJudgeOutput ───────────────────────────────────────────────

describe('parseJudgeOutput', () => {
  test('parses a clean verdict object', () => {
    const out = parseJudgeOutput('{"verdict":"conversational","reason":"sounds like a friend"}');
    expect(out.verdict).toBe('conversational');
    expect(out.reason).toBe('sounds like a friend');
  });

  test('parses fence-wrapped JSON', () => {
    const out = parseJudgeOutput('```json\n{"verdict":"academic","reason":"jargon"}\n```');
    expect(out.verdict).toBe('academic');
  });

  test('parses leading-prose payload', () => {
    const out = parseJudgeOutput('Here is my verdict: {"verdict":"academic","reason":"clinical"}');
    expect(out.verdict).toBe('academic');
  });

  test('falls to academic on empty input (NEVER passes pass-through)', () => {
    expect(parseJudgeOutput('').verdict).toBe('academic');
    expect(parseJudgeOutput('   ').verdict).toBe('academic');
  });

  test('falls to academic on malformed JSON', () => {
    expect(parseJudgeOutput('not json').verdict).toBe('academic');
    expect(parseJudgeOutput('{not valid').verdict).toBe('academic');
  });

  test('coerces unknown verdict label to academic', () => {
    expect(parseJudgeOutput('{"verdict":"meh","reason":"x"}').verdict).toBe('academic');
  });

  test('truncates reason at 80 chars', () => {
    const long = 'x'.repeat(200);
    const out = parseJudgeOutput(`{"verdict":"academic","reason":"${long}"}`);
    expect(out.reason.length).toBe(80);
  });
});

// ─── gateVoice ──────────────────────────────────────────────────────

describe('gateVoice — happy path', () => {
  test('first attempt passes → returns LLM text, attempts=1, passed=true', async () => {
    const generate: VoiceGateGenerator = async () => 'You got 2 of 7 macro calls right last year — clear pattern.';
    const result = await gateVoice({
      mode: 'pattern_statement',
      generate,
      judge: passJudge,
      templateFallback: { fn: patternStatementTemplate, slots: defaultSlots },
    });
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.text).toContain('macro calls right');
  });

  test('first rejected, second passes → attempts=2, passed=true', async () => {
    let calls = 0;
    const generate: VoiceGateGenerator = async () => {
      calls++;
      return calls === 1 ? 'Per analysis, results show...' : 'You got 2 of 7 right.';
    };
    let judgeCalls = 0;
    const judge: VoiceGateJudge = async () => {
      judgeCalls++;
      return judgeCalls === 1
        ? { verdict: 'academic', reason: 'starts with "per analysis"' }
        : { verdict: 'conversational', reason: 'second-person and concrete' };
    };
    const result = await gateVoice({
      mode: 'pattern_statement',
      generate,
      judge,
      templateFallback: { fn: patternStatementTemplate, slots: defaultSlots },
    });
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.text).toBe('You got 2 of 7 right.');
  });

  test('feedback from failed attempt 1 reaches generator on attempt 2', async () => {
    let receivedFeedback: string | undefined;
    let calls = 0;
    const generate: VoiceGateGenerator = async ({ attempt, feedback }) => {
      calls++;
      if (attempt === 2) receivedFeedback = feedback;
      return `attempt ${calls}`;
    };
    let judgeCalls = 0;
    const judge: VoiceGateJudge = async () => {
      judgeCalls++;
      return judgeCalls === 1
        ? { verdict: 'academic', reason: 'too short' }
        : { verdict: 'conversational', reason: '' };
    };
    await gateVoice({
      mode: 'nudge',
      generate,
      judge,
      templateFallback: {
        fn: nudgeTemplate,
        slots: {
          domain: 'macro',
          conviction: 0.8,
          nRecentMisses: 2,
          nRecentTotal: 3,
          hushPattern: 'over-confident-macro',
        },
      },
    });
    expect(receivedFeedback).toBe('too short');
  });
});

describe('gateVoice — fallback path', () => {
  test('both attempts rejected → template fallback, passed=false, attempts=2', async () => {
    const generate: VoiceGateGenerator = async () => 'Per our analysis, the data indicates...';
    const result = await gateVoice({
      mode: 'pattern_statement',
      generate,
      judge: rejectJudge,
      templateFallback: { fn: patternStatementTemplate, slots: defaultSlots },
    });
    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.text).toContain('macro tech');
    expect(result.text).toContain('over-confident');
    expect(result.lastReason).toBe('too clinical');
    expect(result.templateSlots).toEqual(defaultSlots);
  });

  test('generator throws on both attempts → template fallback, NO judge calls', async () => {
    let judgeCalls = 0;
    const generate: VoiceGateGenerator = async () => {
      throw new Error('LLM timeout');
    };
    const judge: VoiceGateJudge = async () => {
      judgeCalls++;
      return { verdict: 'conversational', reason: '' };
    };
    const result = await gateVoice({
      mode: 'pattern_statement',
      generate,
      judge,
      templateFallback: { fn: patternStatementTemplate, slots: defaultSlots },
    });
    expect(result.passed).toBe(false);
    expect(judgeCalls).toBe(0);
    expect(result.lastReason).toBe('LLM timeout');
  });

  test('empty generation counts as a failed attempt + falls through', async () => {
    const generate: VoiceGateGenerator = async () => '';
    const result = await gateVoice({
      mode: 'pattern_statement',
      generate,
      judge: passJudge, // judge would pass but generation is empty
      templateFallback: { fn: patternStatementTemplate, slots: defaultSlots },
    });
    expect(result.passed).toBe(false);
    expect(result.lastReason).toBe('empty_generation');
  });

  test('parse_failed judge output is treated as academic → fallback fires', async () => {
    const generate: VoiceGateGenerator = async () => 'Some candidate.';
    // Inject a judge that simulates the parse-failure path: returns the
    // 'academic' / 'parse_failed' verdict the production parser would emit
    // when the Haiku call returns garbage.
    const judge: VoiceGateJudge = async () => ({ verdict: 'academic', reason: 'parse_failed' });
    const result = await gateVoice({
      mode: 'pattern_statement',
      generate,
      judge,
      templateFallback: { fn: patternStatementTemplate, slots: defaultSlots },
    });
    expect(result.passed).toBe(false);
    expect(result.lastReason).toBe('parse_failed');
  });

  test('maxAttempts override changes the retry count', async () => {
    let calls = 0;
    const generate: VoiceGateGenerator = async () => {
      calls++;
      return `attempt ${calls}`;
    };
    await gateVoice({
      mode: 'pattern_statement',
      generate,
      judge: rejectJudge,
      maxAttempts: 4,
      templateFallback: { fn: patternStatementTemplate, slots: defaultSlots },
    });
    expect(calls).toBe(4);
  });
});

// ─── Mode parity ────────────────────────────────────────────────────

describe('VoiceGateMode parity', () => {
  test('every mode has a default rubric', () => {
    for (const mode of VOICE_GATE_MODES) {
      expect(DEFAULT_RUBRICS[mode]).toBeDefined();
      expect(DEFAULT_RUBRICS[mode].length).toBeGreaterThan(50);
    }
  });

  test('every mode rubric explicitly forbids preachy/clinical voice', () => {
    // Anchors the cross-cutting voice rule: each mode's rubric must
    // mention something about NOT sounding academic / preachy / clinical.
    for (const mode of VOICE_GATE_MODES) {
      const rubric = DEFAULT_RUBRICS[mode].toLowerCase();
      const hasGuard =
        rubric.includes('preachy') ||
        rubric.includes('clinical') ||
        rubric.includes('jargon') ||
        rubric.includes('marketing') ||
        rubric.includes('corporate') ||
        rubric.includes('condescending') ||
        rubric.includes('doctor') ||
        rubric.includes('hr');
      expect(hasGuard).toBe(true);
    }
  });
});

// ─── Templates (deterministic) ──────────────────────────────────────

describe('voice-gate templates', () => {
  test('patternStatementTemplate is deterministic for fixed slots', () => {
    const out = patternStatementTemplate({
      domain: 'macro tech',
      nRight: 2,
      nWrong: 5,
      direction: 'over-confident',
    });
    expect(out).toBe('Your macro tech calls have a over-confident record — 2 of 7 held up.');
  });

  test('patternStatementTemplate handles empty resolved set', () => {
    const out = patternStatementTemplate({ domain: 'X', nRight: 0, nWrong: 0 });
    expect(out).toContain('Not enough resolved X calls yet');
  });

  test('nudgeTemplate includes the hush command', () => {
    const out = nudgeTemplate({
      domain: 'macro',
      conviction: 0.85,
      nRecentMisses: 2,
      nRecentTotal: 3,
      hushPattern: 'over-confident-macro',
    });
    expect(out).toContain('gbrain takes nudge --hush over-confident-macro');
    expect(out).toContain('0.85');
    expect(out).toContain('2 of 3 missed');
  });

  test('forecastBlurbTemplate flags insufficient data when n<5', () => {
    const out = forecastBlurbTemplate({
      domain: 'macro',
      conviction: 0.7,
      bucketBrier: 0.31,
      overallBrier: 0.18,
      bucketN: 3,
    });
    expect(out).toContain('Forecast unavailable');
    expect(out).toContain('3 resolved');
  });

  test('forecastBlurbTemplate names comparison vs overall when n>=5', () => {
    const out = forecastBlurbTemplate({
      domain: 'macro',
      conviction: 0.7,
      bucketBrier: 0.31,
      overallBrier: 0.18,
      bucketN: 7,
    });
    expect(out).toContain('worse than your average');
  });

  test('dashboardCaptionTemplate is concise', () => {
    const out = dashboardCaptionTemplate({ surface: 'Brier trend', fact: '0.18, improving from 0.22 90d ago' });
    expect(out).toBe('Brier trend: 0.18, improving from 0.22 90d ago');
  });

  test('morningPulseTemplate skips pattern line when topPattern empty', () => {
    const out = morningPulseTemplate({ brier: 0.18, trend: 'improving', topPattern: '' });
    expect(out).toContain('Brier 0.18');
    expect(out).toContain('improving');
    expect(out).not.toContain('Top pattern');
  });
});
