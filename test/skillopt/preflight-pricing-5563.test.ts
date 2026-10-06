/**
 * #5563 + A-N4: skillopt must not block a valid model only for missing
 * pricing under the default cap, and its preflight must not invent prices.
 *
 * Pre-fix, the preflight priced every unknown model at Sonnet rates and
 * ignored `pricing.overrides` (`est_cost_usd 0.326` next to a 0.032
 * per-model figure), and the $5 default was a user cap, so the tracker threw
 * no_pricing at the first reserve with no flag passed.
 *
 * Covers the real parser (D19 spellings), the preflight's resolver, its
 * unpriced reporting and the user-cap refusal.
 */
import { describe, expect, test } from 'bun:test';
import { parseFlags } from '../../src/commands/skillopt.ts';
import { estimateCost, formatPreflightReport, preflight, type PreflightOpts } from '../../src/core/skillopt/preflight.ts';

const SKILL = 'widget-example';
const UNPRICED = 'openai:gpt-unreleased-x';

const base: PreflightOpts = {
  epochs: 2,
  batchSize: 4,
  trainSize: 8,
  selSize: 2,
  testSize: 2,
  optimizerModel: UNPRICED,
  targetModel: UNPRICED,
  judgeModel: UNPRICED,
  maxCostUsd: 5,
  heldOutSize: 0,
  interactive: false,
};

describe('A-N4 preflight prices through the shared resolver', () => {
  test('pricing.overrides price the estimate instead of invented Sonnet rates', () => {
    const cheap = { [UNPRICED]: { input: 0.01, output: 0.01 } };
    const est = estimateCost({ ...base, pricingOverrides: cheap });
    expect(est.unpriced_models).toEqual([]);
    const tokensCost = (est.est_input_tokens + est.est_output_tokens) * 0.01 / 1_000_000;
    expect(est.est_cost_usd).not.toBeNull();
    expect(est.est_cost_usd!).toBeGreaterThan(0);
    expect(est.est_cost_usd!).toBeLessThanOrEqual(tokensCost);
  });

  test('an unpriced model is reported as unpriced, never priced at a guessed rate', () => {
    const est = estimateCost({ ...base, maxCostSource: 'default' });
    expect(est.est_cost_usd).toBeNull();
    expect(est.unpriced_models).toEqual([UNPRICED]);
    expect(est.per_model_cost_usd[UNPRICED]).toBeNull();
    expect(est.exceeds_cap).toBe(false);
    const report = formatPreflightReport(est, { ...base, maxCostSource: 'default' });
    expect(report).toContain(`Est. cost:  unpriced (no price for ${UNPRICED}; register a rate with gbrain pricing set)`);
    expect(report).toContain('cap: $5.00 default');
  });

  test('a priced target with an unpriced judge names only the judge', () => {
    const est = estimateCost({ ...base, optimizerModel: 'anthropic:claude-sonnet-4-6', targetModel: 'anthropic:claude-sonnet-4-6' });
    expect(est.unpriced_models).toEqual([UNPRICED]);
    expect(est.per_model_cost_usd['anthropic:claude-sonnet-4-6']).toBeGreaterThan(0);
  });
});

describe('#5563 preflight policy for unpriced models', () => {
  test('default cap: proceeds (the tracker warns and runs the model)', () => {
    const r = preflight({ ...base, maxCostSource: 'default' });
    expect(r.proceed).toBe(true);
  });

  test('user cap: refuses before any spend with the shared no_pricing guidance', () => {
    const r = preflight({ ...base, maxCostSource: 'user', maxCostUsd: 3 });
    expect(r.proceed).toBe(false);
    expect(r.abort_code).toBe('no_pricing');
    expect(r.no_pricing?.model).toBe(UNPRICED);
    expect(r.abort_reason).toContain(`skillopt: gbrain has no pricing for chat model "${UNPRICED}"`);
    expect(r.abort_reason).toContain(`gbrain pricing set ${UNPRICED} --input`);
  });

  test('user cap with a registered rate: proceeds', () => {
    const r = preflight({ ...base, maxCostSource: 'user', pricingOverrides: { [UNPRICED]: { input: 0.01, output: 0.01 } } });
    expect(r.proceed).toBe(true);
  });

  test('uncapped (0): proceeds even when unpriced', () => {
    expect(preflight({ ...base, maxCostUsd: 0, maxCostSource: 'user' }).proceed).toBe(true);
  });
});

describe('D19 skillopt cap flags (real parser)', () => {
  test('no flag: $5 default cap', () => {
    const p = parseFlags([SKILL]);
    expect([p.maxCostUsd, p.maxCostSource]).toEqual([5, 'default']);
  });
  test('--max-usd N: user cap', () => {
    const p = parseFlags([SKILL, '--max-usd', '2.5']);
    expect([p.maxCostUsd, p.maxCostSource, p.maxCostFlag]).toEqual([2.5, 'user', '--max-usd']);
  });
  for (const word of ['off', 'unlimited', 'none', 'OFF']) {
    test(`--max-usd ${word}: uncapped`, () => {
      const p = parseFlags([SKILL, '--max-usd', word]);
      expect([p.maxCostUsd, p.maxCostSource]).toEqual([0, 'user']);
    });
  }
  test('--no-max-cost and legacy --max-cost-usd 0 stay uncapped', () => {
    expect(parseFlags([SKILL, '--no-max-cost']).maxCostUsd).toBe(0);
    expect(parseFlags([SKILL, '--max-cost-usd', '0']).maxCostUsd).toBe(0);
    expect(parseFlags([SKILL, '--max-cost-usd', '4']).maxCostUsd).toBe(4);
  });
  test('--max-usd 0 is refused as ambiguous', () => {
    expect(() => parseFlags([SKILL, '--max-usd', '0'])).toThrow(/--max-usd 0 is ambiguous: pass --max-usd off/);
  });
  test('missing and invalid values are refused', () => {
    expect(() => parseFlags([SKILL, '--max-usd'])).toThrow(/--max-usd needs a positive USD amount or "off"/);
    expect(() => parseFlags([SKILL, '--max-usd', '--json'])).toThrow(/--max-usd needs/);
    expect(() => parseFlags([SKILL, '--max-usd', 'lots'])).toThrow(/--max-usd must be a positive USD amount or "off" \(got "lots"\)/);
    expect(() => parseFlags([SKILL, '--max-usd', '-2'])).toThrow(/must be a positive USD amount/);
  });
  test('disagreeing cap flags are refused; repeating the same cap is fine', () => {
    expect(() => parseFlags([SKILL, '--max-usd', '3', '--no-max-cost'])).toThrow(/--max-usd 3 conflicts with --no-max-cost off; pass one cost cap/);
    expect(() => parseFlags([SKILL, '--max-cost-usd', '2', '--max-usd', '3'])).toThrow(/conflicts/);
    expect(parseFlags([SKILL, '--max-cost-usd', '3', '--max-usd', '3']).maxCostUsd).toBe(3);
  });
});

describe('D3 the preflight labels DeepSeek peak-rate estimates', () => {
  test('a deepseek target prints the peak-rate label next to the estimate', () => {
    const opts = { ...base, targetModel: 'deepseek:deepseek-flash', optimizerModel: 'deepseek:deepseek-flash', judgeModel: 'deepseek:deepseek-flash' };
    const report = formatPreflightReport(estimateCost(opts), opts);
    expect(report).toMatch(/Est\. cost:  \$\d+\.\d\d \(DeepSeek at peak rates, an upper bound; off-peak bills half\)/);
  });
});
