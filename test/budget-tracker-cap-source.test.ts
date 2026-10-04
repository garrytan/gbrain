/**
 * A4 cap sources on BudgetTracker: an unpriced model hard-fails only under a
 * user cap (with a `fix` that registers the rate); derived and default caps
 * warn once and run it. A tracker built without `capSource` keeps the pre-A4
 * behaviour (an explicit cap is a user cap). Exhausting a derived cap logs
 * `derived_cap_exhausted` to the agent-contract log.
 *
 * Hermetic: tmp audit path, GBRAIN_HOME redirected per test via withEnv.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExhausted, BudgetTracker, _resetBudgetTrackerWarningsForTest, type BudgetTrackerOpts } from '../src/core/budget/budget-tracker.ts';
import { pricingSetArgv, pricingSetCommand } from '../src/core/budget/no-pricing.ts';
import { readAgentContractEvents } from '../src/core/agent-contract-log.ts';
import { renderAction, cliRenderContext, shellQuote } from '../src/core/agent-output.ts';
import { withEnv } from './helpers/with-env.ts';

const UNPRICED = 'mystery:some-unreleased-model';
const PRICED = 'claude-haiku-4-5-20251001';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-cap-source-'));
  _resetBudgetTrackerWarningsForTest();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const tracker = (opts: Partial<BudgetTrackerOpts>) => new BudgetTracker({ label: 'test.run', auditPath: join(tmp, 'audit.jsonl'), ...opts });
const reserveUnpriced = (t: BudgetTracker) => t.reserve({ modelId: UNPRICED, kind: 'chat', estimatedInputTokens: 1000, maxOutputTokens: 500 });

function stderrOf(fn: () => void): string {
  let out = '';
  const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

describe('unpriced model × cap source', () => {
  test('no capSource + explicit cap = user cap: refuses with a register-the-rate fix (pre-A4 behaviour)', () => {
    const t = tracker({ maxCostUsd: 1 });
    expect(t.capSource).toBe('user');
    let err: unknown;
    try { reserveUnpriced(t); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BudgetExhausted);
    const be = err as BudgetExhausted;
    expect(be.reason).toBe('no_pricing');
    expect(be.capSource).toBe('user');
    expect(be.message).toContain('gbrain pricing set');
    expect(be.fix?.argv).toEqual(pricingSetArgv(UNPRICED, 'chat'));
    expect(be.fix?.actor).toBe('agent');
    expect(be.fix?.inputs?.map(i => i.name)).toEqual(['usd-per-1M-input-tokens', 'usd-per-1M-output-tokens', 'pricing-page-url']);
    for (const input of be.fix!.inputs!) expect(be.fix!.argv).toContain(`<${input.name}>`);
    expect(renderAction(be.fix!, cliRenderContext()).next).toBe('run');
  });

  test('explicit user cap on a remote transport: the fix is for the host admin', () => {
    let err: BudgetExhausted | undefined;
    try { reserveUnpriced(tracker({ maxCostUsd: 1, capSource: 'user', transport: 'http' })); } catch (e) { err = e as BudgetExhausted; }
    expect(err?.reason).toBe('no_pricing');
    expect(err?.fix?.actor).toBe('host_admin');
  });

  test.each(['derived', 'default'] as const)('%s cap: warns once and runs the model', (capSource) => {
    const t = tracker({ maxCostUsd: 1, capSource });
    const out = stderrOf(() => {
      reserveUnpriced(t);
      reserveUnpriced(t);
      t.record({ modelId: UNPRICED, kind: 'chat', inputTokens: 1000, outputTokens: 500 });
    });
    expect(out.match(/BUDGET_TRACKER_NO_PRICING/g)?.length).toBe(1);
    expect(out).toContain(`The ${capSource} $1.00 cap can't meter it`);
    expect(out).toContain(pricingSetCommand(UNPRICED, 'chat'));
    expect(t.totalSpent).toBe(0);
  });

  test('no cap at all: legacy warn-once, capSource undefined', () => {
    const t = tracker({});
    expect(t.capSource).toBeUndefined();
    const out = stderrOf(() => reserveUnpriced(t));
    expect(out).toContain('Running it without a cost gate');
  });
});

describe('priced model × cap source', () => {
  test.each(['derived', 'default', 'user'] as const)('%s cap is still enforced on priced calls', (capSource) => {
    const t = tracker({ maxCostUsd: 0.000001, capSource });
    let err: BudgetExhausted | undefined;
    try { t.reserve({ modelId: PRICED, kind: 'chat', estimatedInputTokens: 100_000, maxOutputTokens: 10_000 }); } catch (e) { err = e as BudgetExhausted; }
    expect(err?.reason).toBe('cost');
    expect(err?.capSource).toBe(capSource);
  });

  test('derived-cap exhaustion logs derived_cap_exhausted to E11; a user cap does not', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cap-home-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const derived = tracker({ maxCostUsd: 0.000001, capSource: 'derived' });
        expect(() => derived.record({ modelId: PRICED, kind: 'chat', inputTokens: 100_000, outputTokens: 10_000 })).toThrow(BudgetExhausted);
        const user = tracker({ maxCostUsd: 0.000001, capSource: 'user', label: 'other.run' });
        expect(() => user.record({ modelId: PRICED, kind: 'chat', inputTokens: 100_000, outputTokens: 10_000 })).toThrow(BudgetExhausted);
        const events = readAgentContractEvents();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ command: 'test.run', transport: 'cli', code: 'derived_cap_exhausted', effects: ['paid'], outcome: 'stopped' });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('pricing registration argv', () => {
  test('pricingSetCommand is rendered from pricingSetArgv (one source)', () => {
    for (const kind of ['chat', 'embed', 'rerank'] as const) {
      const argv = pricingSetArgv('openai:text-embedding-3-large', kind);
      expect(pricingSetCommand('openai:text-embedding-3-large', kind)).toBe(argv.join(' '));
    }
    expect(pricingSetCommand("odd'model", 'chat')).toContain(shellQuote(["odd'model"]));
  });
});

