import { describe, test, expect } from 'bun:test';
import { __testing } from '../src/core/cycle/synthesize.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// A configured 0 must survive config resolution. The pre-fix `parseInt(str, 10)
// || <default>` coerced an explicit "0" back to the default (cooldown 0 = "no
// cooldown"); loadSynthConfig now routes cooldown_hours + min_chars through
// getNumberConfig, which honors 0. Only engine.getConfig is exercised, so a
// stub engine is sufficient (no PGLite).
function stubEngine(config: Record<string, string>): BrainEngine {
  return { getConfig: async (key: string) => config[key] ?? null } as unknown as BrainEngine;
}

describe('loadSynthConfig honors a configured 0', () => {
  test('cooldown_hours = "0" resolves 0, not the 12h default', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine({ 'dream.synthesize.cooldown_hours': '0' }));
    expect(cfg.cooldownHours).toBe(0);
  });

  test('min_chars = "0" resolves 0, not 2000', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine({ 'dream.synthesize.min_chars': '0' }));
    expect(cfg.minChars).toBe(0);
  });

  test('absent keys keep the defaults', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine({}));
    expect(cfg.cooldownHours).toBe(12);
    expect(cfg.minChars).toBe(2000);
  });

  test('unparseable values fall back to the defaults', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine({
      'dream.synthesize.cooldown_hours': 'abc',
      'dream.synthesize.min_chars': 'xyz',
    }));
    expect(cfg.cooldownHours).toBe(12);
    expect(cfg.minChars).toBe(2000);
  });

  test('positive values round-trip', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine({
      'dream.synthesize.cooldown_hours': '6',
      'dream.synthesize.min_chars': '500',
    }));
    expect(cfg.cooldownHours).toBe(6);
    expect(cfg.minChars).toBe(500);
  });

  test('a negative value clamps to 0', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine({ 'dream.synthesize.cooldown_hours': '-5' }));
    expect(cfg.cooldownHours).toBe(0);
  });
});

// ── #4152 triage knobs: resolution chain, clamps, floors ──────────────────

describe('loadSynthConfig — triage model resolution chain (#4152 2A)', () => {
  test('models.dream.triage wins over models.dream.synthesize_verdict and the deprecated key', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine({
      'models.dream.triage': 'anthropic:claude-sonnet-4-6',
      'models.dream.synthesize_verdict': 'anthropic:claude-haiku-4-5-20251001',
      'dream.synthesize.verdict_model': 'anthropic:claude-3-5-haiku-20241022',
    }));
    expect(cfg.triage.model).toBe('anthropic:claude-sonnet-4-6');
  });

  test('models.dream.synthesize_verdict wins when models.dream.triage is unset', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine({
      'models.dream.synthesize_verdict': 'anthropic:claude-haiku-4-5-20251001',
      'dream.synthesize.verdict_model': 'anthropic:claude-3-5-haiku-20241022',
    }));
    expect(cfg.triage.model).toBe('anthropic:claude-haiku-4-5-20251001');
  });

  test('deprecated dream.synthesize.verdict_model still resolves when both new keys are unset', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine({
      'dream.synthesize.verdict_model': 'anthropic:claude-3-5-haiku-20241022',
    }));
    expect(cfg.triage.model).toBe('anthropic:claude-3-5-haiku-20241022');
  });

  test('all keys unset → tier utility default', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine({}));
    expect(cfg.triage.model).toBe('anthropic:claude-haiku-4-5-20251001');
  });
});

describe('loadSynthConfig — triage knob clamps and floors (#4152)', () => {
  test('threshold outside [0,1] clamps with a stderr warning; 0 is honored as-is', async () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
      chunks.push(String(c));
      return true;
    };
    try {
      const over = await __testing.loadSynthConfig(stubEngine({ 'dream.triage.threshold': '1.5' }));
      expect(over.triage.threshold).toBe(1);
      const under = await __testing.loadSynthConfig(stubEngine({ 'dream.triage.threshold': '-0.5' }));
      expect(under.triage.threshold).toBe(0);
      const zero = await __testing.loadSynthConfig(stubEngine({ 'dream.triage.threshold': '0' }));
      expect(zero.triage.threshold).toBe(0);
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    expect(chunks.join('')).toMatch(/dream\.triage\.threshold .* outside \[0,1\]/);
  });

  test('max_turns floors at 1 (a configured 0 clamps up); default is 16', async () => {
    const zero = await __testing.loadSynthConfig(stubEngine({ 'dream.synthesize.max_turns': '0' }));
    expect(zero.maxTurns).toBe(1);
    const dflt = await __testing.loadSynthConfig(stubEngine({}));
    expect(dflt.maxTurns).toBe(16);
    const restored = await __testing.loadSynthConfig(stubEngine({ 'dream.synthesize.max_turns': '30' }));
    expect(restored.maxTurns).toBe(30);
  });

  test('triage floors: max_chars >= 1000, max_tokens >= 256, concurrency clamped [1,16], max_ms 0 = unlimited', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine({
      'dream.triage.max_chars': '10',
      'dream.triage.max_tokens': '5',
      'dream.triage.concurrency': '99',
      'dream.triage.max_ms': '0',
    }));
    expect(cfg.triage.maxChars).toBe(1000);
    expect(cfg.triage.maxTokens).toBe(256);
    expect(cfg.triage.concurrency).toBe(16);
    expect(cfg.triage.maxMs).toBe(0);
    const low = await __testing.loadSynthConfig(stubEngine({ 'dream.triage.concurrency': '0' }));
    expect(low.triage.concurrency).toBe(1);
  });

  test('daily cap defaults to 0 (disabled, D2D); explicit positive value engages', async () => {
    const dflt = await __testing.loadSynthConfig(stubEngine({}));
    expect(dflt.maxSubmissionsPerSourcePerDay).toBe(0);
    const set = await __testing.loadSynthConfig(stubEngine({ 'dream.synthesize.max_submissions_per_source_per_day': '200' }));
    expect(set.maxSubmissionsPerSourcePerDay).toBe(200);
  });
});
