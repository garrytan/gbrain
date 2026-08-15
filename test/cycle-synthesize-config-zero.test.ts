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
