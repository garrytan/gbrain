// The calibration trio's per-run USD cap honors `gbrain config set`.
//
// Protects: `cycle.propose_takes.budget_usd` / `cycle.grade_takes.budget_usd` /
// `cycle.calibration_profile.budget_usd`, written through the DB config plane
// (what `gbrain config set` does), are the caps BaseCyclePhase hands its
// BudgetMeter, with file config still winning over the DB value.
// Fails when: the base phase reads only the file-config object the cycle builds
// for these phases (`loadConfig()`, which never carries DB rows), so the $5 /
// $3 / $0.50 defaults apply no matter what the operator set.
// Why new: every existing trio test injects `opts.budgetUsd` or `opts.meter`,
// which bypasses the config read entirely.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { BaseCyclePhase, type BasePhaseOpts, type ScopedReadOpts } from '../src/core/cycle/base-phase.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor } from '../src/core/cycle/propose-takes.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { CyclePhase } from '../src/core/cycle.ts';

const KEY = 'cycle.budget_probe.budget_usd';

/** Records the cap the base phase resolved, read back through the meter. */
class BudgetProbePhase extends BaseCyclePhase {
  readonly name = 'lint' as CyclePhase;
  protected readonly budgetUsdKey = KEY;
  protected readonly budgetUsdDefault = 5;
  resolved: number | undefined;
  protected async process(
    _engine: BrainEngine,
    _scope: ScopedReadOpts,
    _ctx: OperationContext,
    _opts: BasePhaseOpts,
  ): Promise<{ summary: string; details: Record<string, unknown> }> {
    this.resolved = this.checkBudget({ modelId: 'anthropic:claude-sonnet-4-6', estimatedInputTokens: 0, maxOutputTokens: 0 }).budgetUsd;
    return { summary: 'ok', details: {} };
  }
}

function ctxFor(engine: BrainEngine, config: Record<string, unknown> = {}): OperationContext {
  return {
    engine,
    config: config as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function resolvedCap(config: Record<string, unknown> = {}): Promise<number | undefined> {
  const phase = new BudgetProbePhase();
  const result = await phase.run(ctxFor(engine, config));
  expect(result.status).toBe('ok');
  return phase.resolved;
}

describe('base-phase budget resolution reads the DB config plane', () => {
  test('a DB-plane value of 0 is the cap (not the $5 default)', async () => {
    await engine.setConfig(KEY, '0');
    try {
      expect(await resolvedCap()).toBe(0);
    } finally {
      await engine.unsetConfig(KEY);
    }
  });

  test('a DB-plane positive value and `unlimited` are honored', async () => {
    await engine.setConfig(KEY, '0.75');
    try {
      expect(await resolvedCap()).toBe(0.75);
      await engine.setConfig(KEY, 'unlimited');
      expect(await resolvedCap()).toBe(Infinity);
    } finally {
      await engine.unsetConfig(KEY);
    }
  });

  test('file config wins over the DB plane (cycle map and flat key)', async () => {
    await engine.setConfig(KEY, '0');
    try {
      expect(await resolvedCap({ cycle: { 'budget_probe.budget_usd': '2' } })).toBe(2);
      expect(await resolvedCap({ [KEY]: 3 })).toBe(3);
    } finally {
      await engine.unsetConfig(KEY);
    }
  });

  test('unset everywhere keeps the phase default; an explicit opts.budgetUsd still wins', async () => {
    expect(await resolvedCap()).toBe(5);
    await engine.setConfig(KEY, '0');
    try {
      const phase = new BudgetProbePhase();
      await phase.run(ctxFor(engine), { budgetUsd: 4 });
      expect(phase.resolved).toBe(4);
    } finally {
      await engine.unsetConfig(KEY);
    }
  });
});

describe('propose_takes end to end: `config set cycle.propose_takes.budget_usd 0` stops the spend', () => {
  test('a DB-plane 0 cap exhausts before the extractor runs; unset runs under the $5 default', async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'test-key' } });
    try {
      await engine.putPage('wiki/budget-db-plane', {
        type: 'note',
        title: 'budget db plane',
        compiled_truth: 'the operator cap set through config set must bind the proposal phase',
        timeline: '',
      });
      const run = async () => {
        let calls = 0;
        const extractor: ProposeTakesExtractor = async () => {
          calls++;
          return [];
        };
        const result = await runPhaseProposeTakes(ctxFor(engine), { extractor, once: true });
        return { calls, result };
      };

      await engine.setConfig('cycle.propose_takes.budget_usd', '0');
      try {
        const capped = await run();
        expect(capped.calls).toBe(0);
        expect(capped.result.details.budget_exhausted).toBe(true);
      } finally {
        await engine.unsetConfig('cycle.propose_takes.budget_usd');
      }

      // Control: same page, no DB cap → the default admits the call.
      const open = await run();
      expect(open.calls).toBe(1);
      expect(open.result.details.budget_exhausted).toBe(false);
    } finally {
      resetGateway();
    }
  });
});
