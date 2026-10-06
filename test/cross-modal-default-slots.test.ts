/**
 * Consistency guard: every cross-modal DEFAULT_SLOTS model must be listed
 * in its recipe's chat touchpoint. `openai:gpt-4o` drifted out of the
 * OpenAI recipe while remaining the slot-A default — the gateway then
 * rejected slot A ("not listed for OpenAI chat") on every install, and the
 * 3-slot judge panel could never reach its 2-model quorum without a Google
 * key, pinning every batch verdict at inconclusive (which the nightly
 * quality probe surfaces as a doctor WARN).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_SLOTS,
  DEFAULT_DIMENSIONS,
  buildPrompt,
  dimensionScoreKey,
  type RunEvalResult,
  type SlotConfig,
} from '../src/core/cross-modal-eval/runner.ts';
import { runEvalCrossModal, substituteUnavailableDefaultSlots } from '../src/commands/eval-cross-modal.ts';
import {
  __setChatTransportForTests,
  __unconfigureGatewayForTests,
  configureGateway,
  getChatModel,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { splitProviderModelId } from '../src/core/model-id.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';

describe('cross-modal DEFAULT_SLOTS ↔ recipe consistency', () => {
  test('every default slot model is listed in its recipe chat touchpoint', () => {
    for (const slot of DEFAULT_SLOTS) {
      const { provider, model } = splitProviderModelId(slot.model);
      expect(provider).not.toBeNull();
      const recipe = getRecipe(provider!);
      expect(recipe, `slot ${slot.id}: unknown recipe "${provider}"`).toBeDefined();
      const chatModels = recipe!.touchpoints.chat?.models ?? [];
      expect(
        chatModels,
        `slot ${slot.id}: "${model}" not listed for ${provider} chat — the judge slot can never run`,
      ).toContain(model);
    }
  });

  test('every default slot model has a canonical pricing entry', () => {
    // Without one, estimateCost silently drops the slot from the
    // --max-usd pre-flight and est_cost_usd audit rows (~1/3 under-count).
    for (const slot of DEFAULT_SLOTS) {
      expect(
        canonicalLookup(slot.model),
        `slot ${slot.id}: "${slot.model}" missing from CANONICAL_PRICING`,
      ).toBeDefined();
    }
  });

  test('slots span three distinct providers (uncorrelated blind spots)', () => {
    const providers = new Set(DEFAULT_SLOTS.map(s => splitProviderModelId(s.model).provider));
    expect(providers.size).toBe(3);
  });
});

// #4636 — a single-provider install can never serve three distinct frontier
// defaults; unusable defaults substitute the configured chat model so the
// nightly probe reports provider reachability truthfully.
describe('cross-modal slot substitution for unavailable default providers (#4636)', () => {
  const NO_EXPLICIT = { A: undefined, B: undefined, C: undefined };

  afterEach(() => {
    resetGateway();
  });

  test('single-provider install: unusable frontier defaults fall back to the configured chat model', () => {
    configureGateway({
      chat_model: 'openai:gpt-5.2',
      env: { OPENAI_API_KEY: 'sk-test-openai-only' },
    });
    const out = substituteUnavailableDefaultSlots([...DEFAULT_SLOTS], NO_EXPLICIT);
    expect(out.map(s => s.model)).toEqual(['openai:gpt-5.2', 'openai:gpt-5.2', 'openai:gpt-5.2']);
    expect(out.map(s => s.id)).toEqual(['A', 'B', 'C']);
  });

  test('explicit --slot-*-model overrides always win, even when their provider has no key', () => {
    configureGateway({
      chat_model: 'openai:gpt-5.2',
      env: { OPENAI_API_KEY: 'sk-test-openai-only' },
    });
    const slots = [
      { id: 'A', model: 'openai:gpt-5.2' },
      { id: 'B', model: 'anthropic:claude-opus-4-7' },
      { id: 'C', model: 'deepseek:deepseek-v4-pro' },
    ];
    const out = substituteUnavailableDefaultSlots(slots, {
      A: undefined, B: 'anthropic:claude-opus-4-7', C: undefined,
    });
    expect(out.map(s => s.model)).toEqual([
      'openai:gpt-5.2',
      'anthropic:claude-opus-4-7', // explicit — untouched
      'openai:gpt-5.2',
    ]);
  });

  test('all three default providers keyed: slots are untouched', () => {
    configureGateway({
      chat_model: 'openai:gpt-5.2',
      env: {
        OPENAI_API_KEY: 'sk-test',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        DEEPSEEK_API_KEY: 'sk-ds-test',
      },
    });
    const out = substituteUnavailableDefaultSlots([...DEFAULT_SLOTS], NO_EXPLICIT);
    expect(out.map(s => s.model)).toEqual(DEFAULT_SLOTS.map(s => s.model));
  });

  test('no usable configured chat model: defaults stay (existing error path owns messaging)', () => {
    configureGateway({
      chat_model: 'anthropic:claude-opus-4-7',
      env: {},
    });
    const out = substituteUnavailableDefaultSlots([...DEFAULT_SLOTS], NO_EXPLICIT);
    expect(out.map(s => s.model)).toEqual(DEFAULT_SLOTS.map(s => s.model));
  });

  test('gateway unconfigured: defaults stay', () => {
    resetGateway();
    const out = substituteUnavailableDefaultSlots([...DEFAULT_SLOTS], NO_EXPLICIT);
    expect(out.map(s => s.model)).toEqual(DEFAULT_SLOTS.map(s => s.model));
  });

  test('a log sink receives one line per substituted slot', () => {
    configureGateway({
      chat_model: 'openai:gpt-5.2',
      env: { OPENAI_API_KEY: 'sk-test-openai-only' },
    });
    const lines: string[] = [];
    substituteUnavailableDefaultSlots([...DEFAULT_SLOTS], NO_EXPLICIT, line => lines.push(line));
    expect(lines).toEqual([
      '[eval cross-modal] slot B default anthropic:claude-opus-4-7 has no usable provider here; ' +
        'using the configured chat model openai:gpt-5.2 instead (#4636).\n',
      '[eval cross-modal] slot C default deepseek:deepseek-v4-pro has no usable provider here; ' +
        'using the configured chat model openai:gpt-5.2 instead (#4636).\n',
    ]);
  });
});

// #5872: the nightly probe runs the batch inside the autopilot daemon, whose
// gateway holds the chat model resolved from the brain. useConfiguredGateway
// keeps that gateway instead of rebuilding it from the file plane.
describe('cross-modal batch on a caller-configured gateway (#5872)', () => {
  const BRAIN_CHAT_MODEL = 'claude-cli:claude-opus-5-5';
  let dir: string;
  let batchPath: string;
  let summaryPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-configured-gateway-'));
    batchPath = join(dir, 'batch.jsonl');
    summaryPath = join(dir, 'summary.json');
    writeFileSync(batchPath, JSON.stringify({ question_id: 'q1', question: 'Where?', hypothesis: 'widget-co', answer: 'widget-co' }) + '\n');
    configureGateway({ chat_model: BRAIN_CHAT_MODEL, env: { ANTHROPIC_API_KEY: 'sk-ant-fake' } });
  });

  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
    rmSync(dir, { recursive: true, force: true });
  });

  test('useConfiguredGateway: unusable defaults take the brain chat model, and the gateway keeps it', async () => {
    const judged: SlotConfig[][] = [];
    const exit = await runEvalCrossModal(['--batch', batchPath, '--output', summaryPath, '--yes'], {
      useConfiguredGateway: true,
      runEval: async (opts): Promise<RunEvalResult> => {
        judged.push(opts.slots ?? []);
        return {
          finalAggregate: { verdict: 'pass', verdictMessage: 'stub: pass' } as RunEvalResult['finalAggregate'],
          cycles: [],
          finalReceiptPath: join(dir, 'receipt.json'),
        };
      },
    });
    const panel = [BRAIN_CHAT_MODEL, 'anthropic:claude-opus-4-7', BRAIN_CHAT_MODEL];
    expect(exit).toBe(0);
    expect(judged.map(slots => slots.map(s => s.model))).toEqual([panel]);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    expect(summary.slots.map((s: SlotConfig) => s.model)).toEqual(panel);
    expect(getChatModel()).toBe(BRAIN_CHAT_MODEL);
  });

  test('useConfiguredGateway on an unconfigured gateway exits 1 before any judge runs', async () => {
    __unconfigureGatewayForTests();
    let judgeRuns = 0;
    const exit = await runEvalCrossModal(['--batch', batchPath, '--output', summaryPath, '--yes'], {
      useConfiguredGateway: true,
      runEval: async (): Promise<RunEvalResult> => { judgeRuns++; throw new Error('judge must not run'); },
    });
    expect(exit).toBe(1);
    expect(judgeRuns).toBe(0);
  });

  test('without the option the batch rebuilds the gateway from the file plane, as before', async () => {
    __setChatTransportForTests(async () => { throw new Error('stub judge unavailable'); });
    await runEvalCrossModal(['--batch', batchPath, '--output', summaryPath, '--yes']);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    expect(summary.slots.map((s: SlotConfig) => s.model)).toEqual(DEFAULT_SLOTS.map(s => s.model));
    expect(getChatModel()).not.toBe(BRAIN_CHAT_MODEL);
  });

  test.each([
    { useConfiguredGateway: true, keepsBrainModel: true },
    { useConfiguredGateway: false, keepsBrainModel: false },
  ])('single-task mode, useConfiguredGateway=$useConfiguredGateway', async ({ useConfiguredGateway, keepsBrainModel }) => {
    const outputPath = join(dir, 'answer.md');
    writeFileSync(outputPath, 'widget-co\n');
    await runEvalCrossModal(['--task', 'Where?', '--output', outputPath, '--cycles', '1', '--receipt-dir', dir], {
      useConfiguredGateway,
      runEval: async (): Promise<RunEvalResult> => ({
        finalAggregate: { verdict: 'pass', verdictMessage: 'stub: pass' } as RunEvalResult['finalAggregate'],
        cycles: [],
        finalReceiptPath: join(dir, 'receipt.json'),
      }),
    });
    expect(getChatModel() === BRAIN_CHAT_MODEL).toBe(keepsBrainModel);
  });
});

// #3491 (the #4338 approach): the judge prompt pins the exact "scores" keys.
// The pre-fix "dim_1_name" placeholder let each judge invent its own
// spelling/casing, splitting one dimension into per-model singletons at
// aggregation; aggregate.ts's trim+lowercase normalization is the backstop.
describe('cross-modal judge-key pinning', () => {
  test('dimensionScoreKey takes the label before the em-dash', () => {
    expect(dimensionScoreKey('GOAL_ACHIEVEMENT — Does it work?')).toBe('GOAL_ACHIEVEMENT');
    expect(dimensionScoreKey('  custom dimension without separator ')).toBe(
      'custom dimension without separator',
    );
  });

  test('buildPrompt enumerates every dimension key verbatim (no placeholder)', () => {
    const prompt = buildPrompt('task', DEFAULT_DIMENSIONS, 'output');
    for (const dim of DEFAULT_DIMENSIONS) {
      expect(prompt).toContain(`"${dimensionScoreKey(dim)}": { "score": N, "feedback": "..." },`);
    }
    expect(prompt).not.toContain('dim_1_name');
    expect(prompt).toContain('using EXACTLY these keys under "scores"');
  });
});
