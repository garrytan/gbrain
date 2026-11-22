// GST-3490 (#9678): a dream phase's USD cap stored with `gbrain config set` binds, and a stored 0 spends nothing.
//
// Protects: `cycle.propose_takes.budget_usd`, `cycle.grade_takes.budget_usd` and
// `cycle.calibration_profile.budget_usd` written to the database config (what
// `gbrain config set` does) are the caps their phases enforce, with an explicit
// caller value and the file config still taking precedence; and a stored `0` for
// `cycle.extract_atoms.budget_usd`, `cycle.enrich_thin.max_cost_usd` /
// `max_total_cost_usd` and `cycle.conversation_facts_backfill.max_cost_usd` /
// `max_total_cost_usd` is a $0 cap, not the phase default.
// Fails when: the calibration phases read only the file config the cycle hands
// them (`loadConfig()`, which never carries database rows), or a phase treats a
// stored 0 as "unset" and runs under its default ($0.30, $1 or $5).
// Why new: every existing calibration test injects `opts.budgetUsd` or
// `opts.meter`, which skips the config read, and the other phases' tests only
// store positive caps.
// Seams: real PGLite; the propose_takes extractor and the extract_atoms chat are
// stubbed, so no provider is called.
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { BaseCyclePhase, type BasePhaseOpts, type ScopedReadOpts } from '../src/core/cycle/base-phase.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor } from '../src/core/cycle/propose-takes.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { runPhaseEnrichThin } from '../src/core/cycle/enrich-thin.ts';
import { loadCfg as loadConversationFactsCfg } from '../src/core/cycle/conversation-facts-backfill.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { CyclePhase } from '../src/core/cycle.ts';

const PROBE_KEY = 'cycle.budget_probe.budget_usd';
const PRICED_CHAT = 'anthropic:claude-sonnet-4-6';

class BudgetProbePhase extends BaseCyclePhase {
  readonly name = 'lint' as CyclePhase;
  protected readonly budgetUsdKey = PROBE_KEY;
  protected readonly budgetUsdDefault = 5;
  resolved: number | undefined;
  protected async process(_engine: BrainEngine, _scope: ScopedReadOpts, _ctx: OperationContext, _opts: BasePhaseOpts) {
    this.resolved = this.checkBudget({ modelId: PRICED_CHAT, estimatedInputTokens: 0, maxOutputTokens: 0 }).budgetUsd;
    return { summary: 'ok', details: {} };
  }
}

function ctxFor(engine: BrainEngine, config: Record<string, unknown> = {}): OperationContext {
  return { engine, config: config as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: 'default' };
}

let engine: PGLiteEngine;
const touched = new Set<string>();
async function store(key: string, value: string) { touched.add(key); await engine.setConfig(key, value); }

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await engine.disconnect(); });
afterEach(async () => { for (const key of touched) await engine.unsetConfig(key); touched.clear(); });

async function probeCap(config: Record<string, unknown> = {}, opts: BasePhaseOpts = {}): Promise<number | undefined> {
  const phase = new BudgetProbePhase();
  expect((await phase.run(ctxFor(engine, config), opts)).status).toBe('ok');
  return phase.resolved;
}

describe('calibration phases read the cap gbrain config set stores', () => {
  test('a stored 0, a stored amount and a stored unlimited are the cap', async () => {
    await store(PROBE_KEY, '0');
    expect(await probeCap()).toBe(0);
    await store(PROBE_KEY, '0.75');
    expect(await probeCap()).toBe(0.75);
    await store(PROBE_KEY, 'unlimited');
    expect(await probeCap()).toBe(Infinity);
  });

  test('an explicit caller value, then the file config, win over the stored value; nothing stored keeps the default', async () => {
    expect(await probeCap()).toBe(5);
    await store(PROBE_KEY, '0');
    expect(await probeCap({}, { budgetUsd: 4 })).toBe(4);
    expect(await probeCap({ [PROBE_KEY]: 3 })).toBe(3);
    await store(PROBE_KEY, '2');
    expect(await probeCap({ cycle: { 'budget_probe.budget_usd': '0' } })).toBe(0);
  });

  test('propose_takes with a stored 0 cap never calls the model; with nothing stored it does', async () => {
    configureGateway({ chat_model: PRICED_CHAT, env: { ANTHROPIC_API_KEY: 'test-key' } });
    try {
      await engine.putPage('wiki/budget-zero-example', { type: 'note', title: 'budget zero example', compiled_truth: 'a stored zero cap must stop the proposal phase before any model call', timeline: '' });
      const run = async () => {
        let calls = 0;
        const extractor: ProposeTakesExtractor = async () => { calls++; return []; };
        const result = await runPhaseProposeTakes(ctxFor(engine), { extractor, once: true });
        return { calls, result };
      };
      await store('cycle.propose_takes.budget_usd', '0');
      const capped = await run();
      expect(capped.calls).toBe(0);
      expect(capped.result.details.budget_exhausted).toBe(true);
      await engine.unsetConfig('cycle.propose_takes.budget_usd');
      const open = await run();
      expect(open.calls).toBe(1);
    } finally {
      resetGateway();
    }
  });
});

describe('a stored 0 cap stops the other paid dream phases', () => {
  test('extract_atoms: a stored 0 is a $0 cap and the model is never called', async () => {
    resetGateway();
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
    __setEmbedTransportForTests((async (args: { values: string[] }) => ({ embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.01)), usage: { tokens: 10 * args.values.length } })) as never);
    await store('models.dream.extract_atoms', PRICED_CHAT);
    await store('cycle.extract_atoms.budget_usd', '0');
    let calls = 0;
    const chat = async (_o: ChatOpts): Promise<ChatResult> => {
      calls++;
      return { text: '[]', blocks: [{ type: 'text', text: '' }], stopReason: 'end', usage: { input_tokens: 500, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: PRICED_CHAT, providerId: 'anthropic' };
    };
    const saved = console.error;
    console.error = () => {};
    try {
      const result = await runPhaseExtractAtoms(engine, {
        _transcripts: [{ filePath: '/fake/zero-cap.txt', content: 'a transcript the zero cap must not send', contentHash: '0000000000000001' }],
        _pages: [],
        _chat: chat as never,
      });
      expect(calls).toBe(0);
      expect((result.details as Record<string, unknown>).budget_usd).toBe(0);
    } finally {
      console.error = saved;
    }
  }, 60_000);

  test('enrich_thin: stored 0 caps are reported as 0 and no source runs', async () => {
    await store('cycle.enrich_thin.enabled', 'true');
    await store('cycle.enrich_thin.max_cost_usd', '0');
    await store('cycle.enrich_thin.max_total_cost_usd', '0');
    const r = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(r.details.max_cost_usd).toBe(0);
    expect(r.details.max_total_cost_usd).toBe(0);
    expect(Object.keys(r.details.per_source as Record<string, unknown>)).toEqual([]);
  });

  test('conversation_facts_backfill: stored 0 caps resolve to 0', async () => {
    await store('cycle.conversation_facts_backfill.max_cost_usd', '0');
    await store('cycle.conversation_facts_backfill.max_total_cost_usd', '0');
    const cfg = await loadConversationFactsCfg(engine);
    expect(cfg.maxCostUsd).toBe(0);
    expect(cfg.maxTotalCostUsd).toBe(0);
    expect(cfg.explicitCostCap).toBe(true);
  });
});
