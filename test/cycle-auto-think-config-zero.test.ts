import { describe, test, expect } from 'bun:test';
import { __testing } from '../src/core/cycle/auto-think.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// A configured 0 must survive config resolution. The pre-fix
// `parse*(str) || <default>` coerced an explicit "0" back to the default
// (budget 0 = "spend nothing", cooldown 0 = "no cooldown"); loadConfig now
// routes budget + cooldown_days through getNumberConfig, which honors 0.
function stubEngine(config: Record<string, string>): BrainEngine {
  return { getConfig: async (key: string) => config[key] ?? null } as unknown as BrainEngine;
}

describe('auto_think loadConfig honors a configured 0', () => {
  test('budget = "0" resolves 0, not $2', async () => {
    const cfg = await __testing.loadConfig(stubEngine({ 'dream.auto_think.budget': '0' }));
    expect(cfg.budgetUsd).toBe(0);
  });

  test('cooldown_days = "0" resolves 0, not the 30d default', async () => {
    const cfg = await __testing.loadConfig(stubEngine({ 'dream.auto_think.cooldown_days': '0' }));
    expect(cfg.cooldownDays).toBe(0);
  });

  test('absent keys keep the defaults', async () => {
    const cfg = await __testing.loadConfig(stubEngine({}));
    expect(cfg.budgetUsd).toBe(2.0);
    expect(cfg.cooldownDays).toBe(30);
  });

  test('unparseable values fall back to the defaults', async () => {
    const cfg = await __testing.loadConfig(stubEngine({
      'dream.auto_think.budget': 'abc',
      'dream.auto_think.cooldown_days': 'xyz',
    }));
    expect(cfg.budgetUsd).toBe(2.0);
    expect(cfg.cooldownDays).toBe(30);
  });

  test('positive values round-trip (budget accepts fractions)', async () => {
    const cfg = await __testing.loadConfig(stubEngine({
      'dream.auto_think.budget': '0.5',
      'dream.auto_think.cooldown_days': '7',
    }));
    expect(cfg.budgetUsd).toBe(0.5);
    expect(cfg.cooldownDays).toBe(7);
  });

  test('a negative value clamps to 0', async () => {
    const cfg = await __testing.loadConfig(stubEngine({ 'dream.auto_think.budget': '-1' }));
    expect(cfg.budgetUsd).toBe(0);
  });
});
