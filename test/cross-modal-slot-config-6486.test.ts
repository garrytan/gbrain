/**
 * #6486 — `gbrain eval cross-modal` resolves each judge slot as
 * `--slot-<x>-model` flag → brain config `models.eval.cross_modal.slot_<x>`
 * → `DEFAULT_SLOTS`. The config keys already existed for the nightly probe
 * (`nightly-probe-routes.ts`) but the CLI read only the flags, so an
 * operator who pinned the slots for the probe still got the literal frontier
 * defaults from the CLI and the skill text.
 *
 * The CLI stays brain-free: the slot pins arrive through an injected reader
 * (`opts.slotConfig`) that `src/cli/main.ts` builds from a fail-open
 * probe-only connect; without a brain or when every flag is given, nothing
 * is read.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SLOTS, type RunEvalResult, type SlotConfig } from '../src/core/cross-modal-eval/runner.ts';
import { runEvalCrossModal, resolveSlotModels } from '../src/commands/eval-cross-modal.ts';
import { readCrossModalSlotConfig, readCrossModalSlotConfigFrom, NIGHTLY_PROBE_SLOT_KEYS } from '../src/core/cycle/nightly-probe-routes.ts';
import { __setChatTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

const ALL_KEYED = { ANTHROPIC_API_KEY: 'sk-ant-fake', OPENAI_API_KEY: 'sk-fake', DEEPSEEK_API_KEY: 'sk-ds-fake', GOOGLE_GENERATIVE_AI_API_KEY: 'g-fake' };

describe('resolveSlotModels precedence', () => {
  test('flag beats config beats default, per slot', () => {
    const slots = resolveSlotModels(
      { slotAModel: 'openai:gpt-5.5', slotBModel: undefined, slotCModel: undefined },
      { B: 'anthropic:claude-sonnet-5-5' },
    );
    expect(slots).toEqual([
      { id: 'A', model: 'openai:gpt-5.5' },
      { id: 'B', model: 'anthropic:claude-sonnet-5-5' },
      { id: 'C', model: DEFAULT_SLOTS[2]!.model },
    ]);
  });

  test('a flag wins over a config pin for the same slot; blank config values are ignored', () => {
    const slots = resolveSlotModels(
      { slotAModel: 'openai:gpt-5.5', slotBModel: undefined, slotCModel: undefined },
      { A: 'anthropic:claude-sonnet-5-5', B: '   ' },
    );
    expect(slots.map(s => s.model)).toEqual(['openai:gpt-5.5', DEFAULT_SLOTS[1]!.model, DEFAULT_SLOTS[2]!.model]);
  });
});

describe('readCrossModalSlotConfig (shared with the nightly probe)', () => {
  test('reads the three keys, trims, resolves aliases, and leaves unset keys absent', async () => {
    const values: Record<string, string | null> = {
      [NIGHTLY_PROBE_SLOT_KEYS.A]: ' anthropic:claude-sonnet-5-5 ',
      [NIGHTLY_PROBE_SLOT_KEYS.B]: '',
    };
    const reader = { getConfig: async (key: string) => values[key] ?? null };
    expect(await readCrossModalSlotConfig(reader)).toEqual({ A: 'anthropic:claude-sonnet-5-5' });
  });

  test('readCrossModalSlotConfigFrom opens, reads and always closes the brain; a connect failure propagates to the caller', async () => {
    let closed = 0;
    const pins = await readCrossModalSlotConfigFrom(async () => ({
      getConfig: async (key: string) => (key === NIGHTLY_PROBE_SLOT_KEYS.C ? 'deepseek:deepseek-v4-pro' : null),
      disconnect: async () => { closed++; },
    }));
    expect(pins).toEqual({ C: 'deepseek:deepseek-v4-pro' });
    expect(closed).toBe(1);
    await expect(readCrossModalSlotConfigFrom(async () => { throw new Error('No database URL'); })).rejects.toThrow('No database URL');
    const failing = await readCrossModalSlotConfigFrom(async () => ({
      getConfig: async () => { throw new Error('config table missing'); },
      disconnect: async () => { closed++; },
    })).catch((e: Error) => e.message);
    expect(failing).toBe('config table missing');
    expect(closed).toBe(2);
  });
});

describe('gbrain eval cross-modal --batch honours the brain slot pins (#6486)', () => {
  let dir: string;
  let batchPath: string;
  let summaryPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-slot-config-'));
    batchPath = join(dir, 'batch.jsonl');
    summaryPath = join(dir, 'summary.json');
    writeFileSync(batchPath, JSON.stringify({ question_id: 'q1', question: 'Where?', hypothesis: 'widget-co', answer: 'widget-co' }) + '\n');
    configureGateway({ chat_model: 'anthropic:claude-sonnet-5-5', env: ALL_KEYED });
  });

  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
    rmSync(dir, { recursive: true, force: true });
  });

  const stubRunEval = (judged: SlotConfig[][]) => async (opts: { slots?: SlotConfig[] }): Promise<RunEvalResult> => {
    judged.push(opts.slots ?? []);
    return {
      finalAggregate: { verdict: 'pass', verdictMessage: 'stub: pass' } as RunEvalResult['finalAggregate'],
      cycles: [],
      finalReceiptPath: join(dir, 'receipt.json'),
    };
  };

  test('slot_a pinned in config and no flag: the panel runs the pinned model in slot A, defaults elsewhere', async () => {
    const judged: SlotConfig[][] = [];
    let reads = 0;
    const exit = await runEvalCrossModal(['--batch', batchPath, '--output', summaryPath, '--yes'], {
      useConfiguredGateway: true,
      slotConfig: async () => { reads++; return { A: 'anthropic:claude-sonnet-5-5' }; },
      runEval: stubRunEval(judged),
    });
    expect(exit).toBe(0);
    expect(reads).toBe(1);
    const panel = ['anthropic:claude-sonnet-5-5', DEFAULT_SLOTS[1]!.model, DEFAULT_SLOTS[2]!.model];
    expect(judged.map(slots => slots.map(s => s.model))).toEqual([panel]);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    expect(summary.slots.map((s: SlotConfig) => s.model)).toEqual(panel);
  });

  test('an explicit --slot-a-model flag wins over the config pin', async () => {
    const judged: SlotConfig[][] = [];
    await runEvalCrossModal(['--batch', batchPath, '--output', summaryPath, '--yes', '--slot-a-model', 'openai:gpt-5.5'], {
      useConfiguredGateway: true,
      slotConfig: async () => ({ A: 'anthropic:claude-sonnet-5-5' }),
      runEval: stubRunEval(judged),
    });
    expect(judged[0]![0]!.model).toBe('openai:gpt-5.5');
  });

  test('all three flags given: the brain is never read', async () => {
    const judged: SlotConfig[][] = [];
    let reads = 0;
    await runEvalCrossModal(['--batch', batchPath, '--output', summaryPath, '--yes',
      '--slot-a-model', 'openai:gpt-5.5', '--slot-b-model', 'anthropic:claude-sonnet-5-5', '--slot-c-model', 'deepseek:deepseek-v4-pro'], {
      useConfiguredGateway: true,
      slotConfig: async () => { reads++; return {}; },
      runEval: stubRunEval(judged),
    });
    expect(reads).toBe(0);
    expect(judged[0]!.map(s => s.model)).toEqual(['openai:gpt-5.5', 'anthropic:claude-sonnet-5-5', 'deepseek:deepseek-v4-pro']);
  });

  test('a reader that throws (brain busy, no brain) falls back to the defaults and the run still completes', async () => {
    const judged: SlotConfig[][] = [];
    const exit = await runEvalCrossModal(['--batch', batchPath, '--output', summaryPath, '--yes'], {
      useConfiguredGateway: true,
      slotConfig: async () => { throw new Error('PGLite is locked by another process'); },
      runEval: stubRunEval(judged),
    });
    expect(exit).toBe(0);
    expect(judged[0]!.map(s => s.model)).toEqual(DEFAULT_SLOTS.map(s => s.model));
  });
});
