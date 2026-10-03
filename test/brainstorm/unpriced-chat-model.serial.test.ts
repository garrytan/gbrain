/**
 * #5873: brainstorm / lsd on a chat model that has no price.
 *
 * Authoring gate:
 *   1. Protects: a run on an unpriced cross or judge chat model completes when
 *      the user did not pass --max-cost, while the $5 default still stops an
 *      oversized run at Sonnet rates (pre-run estimate, mid-run guard,
 *      pre-judge check); `pricing.overrides` prices the run, by alias too; the
 *      estimate prices the chat model the gateway runs and the judge share at
 *      the judge model; an explicit --max-cost on an unpriced model is refused
 *      before any work; an unpriced embedding model counts at $0 through
 *      gateway.embed; brainstorm_health names an unpriced cross or judge model.
 *   2. Regression: the run tracker built as `maxCostUsd ?? 5` without
 *      `pricingOverrides`, so every gateway.chat reserve() throws no_pricing
 *      and the remedy the error names never reaches the run.
 *   3. Every other brainstorm test injects `chatFn`, which bypasses the
 *      gateway's reserve(); these runs go through gateway.chat.
 *   4. No new seam: configureGateway + the gateway's chat and embed transport seams.
 *
 * Serial: configureGateway and the transport seams mutate module state.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import {
  runBrainstorm,
  BRAINSTORM_PROFILE,
  BudgetExhausted,
  type BrainstormProfile,
} from '../../src/core/brainstorm/orchestrator.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  type ChatOpts,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import { checkBrainstormHealth } from '../../src/commands/doctor/checks/graph-embedding.ts';
import { resolveBrainstormCostGate } from '../../src/core/brainstorm/cost-gate.ts';
import { isModelPriceable } from '../../src/core/budget/reservation-cost.ts';

/** Fictional model ids: in no pricing table, so a call to them can never reach a provider. */
const UNPRICED = 'claude-cli:claude-opus-9-9';
const UNPRICED_JUDGE = 'claude-cli:claude-judge-9-9';
const UNPRICED_EMBED = 'litellm:my-embed';
const PRICED = 'anthropic:claude-sonnet-4-6';

/** k_close x m_far sets the estimate (far above $5 at Sonnet rates); the 4-page far set caps the real crosses. */
const BIG_ESTIMATE: BrainstormProfile = { ...BRAINSTORM_PROFILE, k_close: 2, m_far: 2000, ideas_per_cross: 1 };
/** Estimate well under $1 at Sonnet rates; the seeded brain yields 2 x 4 = 8 crosses, one idea each. */
const TINY: BrainstormProfile = { ...BRAINSTORM_PROFILE, k_close: 2, m_far: 4, ideas_per_cross: 1 };
const DIMS = 1536;

let engine: PGLiteEngine;
let home: string;
let homeBackup: string | undefined;
const calls = { cross: 0, judge: 0, embed: 0 };

function basisEmbedding(idx: number, dim = DIMS): Float32Array {
  const v = new Float32Array(dim);
  v[idx % dim] = 1.0;
  return v;
}

async function seedPage(slug: string, body: string, basis: number): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '' });
  await installFixtureChunks(engine, slug, [
    { chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth', embedding: basisEmbedding(basis), token_count: 6 },
  ] satisfies ChunkInput[]);
}

type Usage = { input: number; output: number };

/**
 * Answers cross and judge prompts the way the e2e resume stub does. `model`
 * is reported as the served model; `crossUsage` is the token count each cross
 * call bills, so a case can drive the mid-run guard and the pre-judge check.
 */
function transportFor(model: string, crossUsage: Usage) {
  return async (opts: ChatOpts): Promise<ChatResult> => {
    const user = opts.messages.find((m) => m.role === 'user');
    const content = typeof user?.content === 'string' ? user.content : '';
    let text: string;
    let usage: Usage = { input: 100, output: 50 };
    if (/\(close=.* × far=.*\)/.test(content)) {
      calls.judge++;
      const ids = Array.from(content.matchAll(/## Idea (\S+)/g)).map((m) => m[1] as string);
      const ideas = ids.map((id) => ({
        id,
        scores: { originality: 4, resistance: 4, thesis_density: 4, concrete_grounding: 4, cognitive_load: 4 },
        note: 'stub judge',
      }));
      text = '```json\n' + JSON.stringify({ ideas }) + '\n```';
    } else {
      calls.cross++;
      usage = crossUsage;
      // parseIdeaResponse needs at least two numbered items.
      text = `1. stub idea ${calls.cross}\n2. backup idea ${calls.cross}`;
    }
    return {
      text,
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      model,
      providerId: 'stub',
      usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_tokens: 0, cache_creation_tokens: 0 },
    };
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedPage('wiki/close-a', 'battery recycling question close anchor a', 10);
  await seedPage('wiki/close-b', 'battery recycling question close anchor b', 11);
  await seedPage('concepts/tide-a', 'Far content: tidal energy body a.', 200);
  await seedPage('concepts/tide-b', 'Far content: tidal energy body b.', 201);
  await seedPage('people/founder-a', 'Far content: founder notes a.', 202);
  await seedPage('people/founder-b', 'Far content: founder notes b.', 203);
}, 60_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-5873-'));
  homeBackup = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = home;
  calls.cross = 0;
  calls.judge = 0;
  calls.embed = 0;
});

afterEach(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.unsetConfig('pricing.overrides');
  await engine.unsetConfig('models.brainstorm.judge');
  if (homeBackup === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = homeBackup;
  rmSync(home, { recursive: true, force: true });
});

interface RunCase {
  name: string;
  /** Chat model the gateway runs (`models.tier.reasoning` lands here in the CLI). */
  gatewayModel: string;
  /** The file-config `chat_model` the CLI passes as `config`. */
  fileModel?: string;
  /** `models.brainstorm.judge`. */
  judgeModel?: string;
  /** Gateway embedding model; when set, the question embeds through gateway.embed instead of an injected fn. */
  embeddingModel?: string;
  overrides?: Record<string, number | Usage>;
  maxCostUsd?: number;
  profile: BrainstormProfile;
  /** Tokens each cross call bills (default 100 in / 50 out). */
  crossUsage?: Usage;
  expect:
    | { completes: true; judgeFailed?: boolean; crosses?: number; stderr?: RegExp; notStderr?: RegExp }
    /** `refused`: before the preview, at the estimate, or mid-run after at least one cross. */
    | { reason: 'cost' | 'no_pricing'; message: RegExp; refused: 'before-preview' | 'at-estimate' | 'mid-run' };
}

const RUN_CASES: RunCase[] = [
  {
    name: 'unpriced chat model, no --max-cost: the run tracker installs no default cap and says so',
    gatewayModel: UNPRICED,
    profile: TINY,
    expect: { completes: true, judgeFailed: false, stderr: /chat model "claude-cli:claude-opus-9-9" has no price.*pricing\.overrides/ },
  },
  {
    name: 'unpriced chat model, no --max-cost: the $5 default still stops an oversized run at Sonnet rates',
    gatewayModel: UNPRICED,
    profile: BIG_ESTIMATE,
    expect: { reason: 'cost', message: /estimated cost \$67\.20 exceeds --max-cost \$5\.00\. Lower --limit, declare the rate of "claude-cli:claude-opus-9-9" in pricing\.overrides/, refused: 'at-estimate' },
  },
  {
    name: 'unpriced chat model, no --max-cost: the mid-run guard stops crosses past $5 at Sonnet rates',
    gatewayModel: UNPRICED,
    profile: TINY,
    crossUsage: { input: 0, output: 400_000 }, // $6.00 per cross at the $15/M Sonnet output rate
    expect: { reason: 'cost', message: /running cost \$6\.00 exceeded --max-cost \$5\.00 mid-run/, refused: 'mid-run' },
  },
  {
    name: 'unpriced judge model, no --max-cost: the run completes and names the judge',
    gatewayModel: PRICED,
    judgeModel: UNPRICED_JUDGE,
    profile: TINY,
    expect: { completes: true, judgeFailed: false, stderr: /judge model "claude-cli:claude-judge-9-9" has no price/ },
  },
  {
    name: 'the pre-judge check skips a judge whose projected cost passes the ceiling, keeping the ideas',
    gatewayModel: UNPRICED,
    judgeModel: UNPRICED_JUDGE,
    // Estimate: $0.10 crosses + $0.32 judge. Real run: 8 crosses x $0.60 = $4.80, + $0.32 judge > $5.
    overrides: { [UNPRICED_JUDGE]: { input: 0, output: 200 } },
    crossUsage: { input: 0, output: 40_000 },
    profile: TINY,
    expect: { completes: true, judgeFailed: true, crosses: 8, stderr: /crosses cost \$4\.80 and the projected judge cost is \$0\.32, over the \$5\.00 ceiling; skipping the judge/ },
  },
  {
    name: 'pricing.overrides reaches the run tracker: an explicit --max-cost runs on the declared rate',
    gatewayModel: UNPRICED,
    overrides: { [UNPRICED]: 3 },
    maxCostUsd: 1,
    profile: TINY,
    expect: { completes: true, judgeFailed: false },
  },
  {
    name: 'pricing.overrides reaches the pre-run estimate: the explicit --max-cost holds against the declared rate',
    gatewayModel: UNPRICED,
    overrides: { [UNPRICED]: 0 },
    maxCostUsd: 1,
    profile: BIG_ESTIMATE,
    expect: { completes: true },
  },
  {
    name: 'the estimate prices the chat model the gateway runs, not the file-config chat_model',
    gatewayModel: UNPRICED,
    fileModel: PRICED,
    overrides: { [UNPRICED]: 0 },
    profile: BIG_ESTIMATE,
    expect: { completes: true },
  },
  {
    name: 'an unpriced embedding model counts at $0 through gateway.embed instead of failing the question embedding',
    gatewayModel: PRICED,
    embeddingModel: UNPRICED_EMBED,
    profile: TINY,
    expect: {
      completes: true,
      stderr: /embedding model "litellm:my-embed" has no price; the question embedding counts as \$0/,
      notStderr: /question embedding failed/,
    },
  },
  {
    name: 'unpriced chat model under an explicit --max-cost: refused before any work',
    gatewayModel: UNPRICED,
    maxCostUsd: 1,
    profile: TINY,
    expect: { reason: 'no_pricing', message: /no pricing entry for chat model "claude-cli:claude-opus-9-9", and --max-cost cannot hold a cap/, refused: 'before-preview' },
  },
  {
    name: 'unpriced judge model under an explicit --max-cost: refused before the crosses are paid for',
    gatewayModel: PRICED,
    judgeModel: UNPRICED_JUDGE,
    maxCostUsd: 1,
    profile: TINY,
    expect: { reason: 'no_pricing', message: /no pricing entry for judge model "claude-cli:claude-judge-9-9"/, refused: 'before-preview' },
  },
  {
    name: 'priced chat model, no --max-cost: the default $5 ceiling still refuses an oversized run',
    gatewayModel: PRICED,
    profile: BIG_ESTIMATE,
    expect: { reason: 'cost', message: /exceeds --max-cost \$5\.00\. Lower --limit, raise --max-cost/, refused: 'at-estimate' },
  },
];

describe('#5873 brainstorm on an unpriced chat model', () => {
  for (const c of RUN_CASES) {
    test(c.name, async () => {
      configureGateway({
        chat_model: c.gatewayModel,
        ...(c.embeddingModel ? { embedding_model: c.embeddingModel, embedding_dimensions: DIMS } : {}),
        env: {},
      });
      __setChatTransportForTests(transportFor(c.gatewayModel, c.crossUsage ?? { input: 100, output: 50 }));
      if (c.embeddingModel) {
        __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
          calls.embed++;
          return { embeddings: values.map(() => Array.from(basisEmbedding(10))), usage: { tokens: 0 } };
        }) as never);
      }
      if (c.overrides) await engine.setConfig('pricing.overrides', JSON.stringify(c.overrides));
      if (c.judgeModel) await engine.setConfig('models.brainstorm.judge', c.judgeModel);
      const stderr: string[] = [];
      const run = runBrainstorm(engine, c.fileModel ? { chat_model: c.fileModel } : {}, {
        question: 'battery recycling question',
        profile: c.profile,
        skipCostPreview: true,
        maxCostUsd: c.maxCostUsd,
        embedQueryFn: c.embeddingModel ? undefined : async () => basisEmbedding(10),
        stderrWrite: (s) => { stderr.push(s); },
      });

      if ('completes' in c.expect) {
        // Carry the run's stderr into the failure: per-cross errors are only warned there.
        const result = await run.catch((e: unknown) => {
          throw new Error(`${e instanceof Error ? e.message : String(e)}\n${stderr.join('')}`);
        });
        expect(result.ideas.length).toBeGreaterThan(0);
        expect(calls.cross).toBeGreaterThan(0);
        if (c.expect.crosses !== undefined) expect(calls.cross).toBe(c.expect.crosses);
        if (c.expect.judgeFailed !== undefined) {
          expect(result.judge_failed).toBe(c.expect.judgeFailed);
          expect(calls.judge > 0).toBe(!c.expect.judgeFailed);
        }
        if (c.expect.stderr) expect(stderr.join('')).toMatch(c.expect.stderr);
        if (c.expect.notStderr) expect(stderr.join('')).not.toMatch(c.expect.notStderr);
        if (c.embeddingModel) expect(calls.embed).toBeGreaterThan(0);
        return;
      }
      let err: unknown = null;
      try { await run; } catch (e) { err = e; }
      expect(err).toBeInstanceOf(BudgetExhausted);
      expect((err as BudgetExhausted).reason).toBe(c.expect.reason);
      expect((err as Error).message).toMatch(c.expect.message);
      expect(calls.judge).toBe(0);
      if (c.expect.refused === 'mid-run') {
        expect(calls.cross).toBeGreaterThan(0);
      } else {
        expect(calls.cross).toBe(0);
        // Refused before the preview means no estimate line and no retrieval.
        expect(stderr.join('').includes('estimated cost')).toBe(c.expect.refused === 'at-estimate');
      }
    });
  }
});

describe('#5873 resolveBrainstormCostGate', () => {
  const PRICED_EMBED = 'openai:text-embedding-3-large';
  const GATE_CASES: Array<{
    name: string;
    maxCostUsd?: number;
    crossModel: string;
    judgeModel: string;
    embedModel: string | null;
    overrides?: Record<string, Usage>;
    want: {
      maxCostUsd: number;
      trackerCapUsd: number | undefined;
      unpricedCrossModel?: string;
      unpricedJudgeModel?: string;
      zeroPricedEmbedModel?: string;
    };
  }> = [
    { name: 'priced models keep the $5 default on the tracker', crossModel: PRICED, judgeModel: PRICED, embedModel: PRICED_EMBED, want: { maxCostUsd: 5, trackerCapUsd: 5 } },
    { name: 'an unpriced judge model keeps the default off the tracker only', crossModel: PRICED, judgeModel: UNPRICED, embedModel: null, want: { maxCostUsd: 5, trackerCapUsd: undefined, unpricedJudgeModel: UNPRICED } },
    { name: 'an override makes the chat model priceable', crossModel: UNPRICED, judgeModel: UNPRICED, embedModel: null, overrides: { [UNPRICED]: { input: 1, output: 1 } }, want: { maxCostUsd: 5, trackerCapUsd: 5 } },
    { name: 'an explicit --max-cost stays on the tracker and still reports the unpriced model', maxCostUsd: 2, crossModel: UNPRICED, judgeModel: UNPRICED, embedModel: null, want: { maxCostUsd: 2, trackerCapUsd: 2, unpricedCrossModel: UNPRICED, unpricedJudgeModel: UNPRICED } },
    { name: 'an unpriced embedding model counts at $0 and keeps the default', crossModel: PRICED, judgeModel: PRICED, embedModel: UNPRICED_EMBED, want: { maxCostUsd: 5, trackerCapUsd: 5, zeroPricedEmbedModel: UNPRICED_EMBED } },
    { name: 'an unpriced embedding model counts at $0 under an explicit cap', maxCostUsd: 2, crossModel: PRICED, judgeModel: PRICED, embedModel: UNPRICED_EMBED, want: { maxCostUsd: 2, trackerCapUsd: 2, zeroPricedEmbedModel: UNPRICED_EMBED } },
  ];

  for (const c of GATE_CASES) {
    test(c.name, () => {
      const gate = resolveBrainstormCostGate({
        maxCostUsd: c.maxCostUsd,
        crossModel: c.crossModel,
        judgeModel: c.judgeModel,
        embedModel: c.embedModel,
        pricingOverrides: c.overrides,
      });
      expect(gate.maxCostUsd).toBe(c.want.maxCostUsd);
      expect(gate.trackerCapUsd).toBe(c.want.trackerCapUsd);
      expect(gate.unpricedCrossModel).toBe(c.want.unpricedCrossModel);
      expect(gate.unpricedJudgeModel).toBe(c.want.unpricedJudgeModel);
      expect(gate.zeroPricedEmbedModel).toBe(c.want.zeroPricedEmbedModel);
      if (c.embedModel) expect(isModelPriceable(c.embedModel, 'embed', gate.pricingOverrides)).toBe(true);
      // The operator's own rows survive alongside the $0 embedding row.
      for (const model of Object.keys(c.overrides ?? {})) {
        expect(isModelPriceable(model, 'chat', gate.pricingOverrides)).toBe(true);
      }
    });
  }

  test('an override keyed by a model alias also prices the id the provider serves for it', () => {
    const served = 'nvidia:nvidia/nemotron-3-super-120b-a12b';
    const overrides = { 'nvidia:nemotron-3-super': { input: 1, output: 2 } };
    expect(isModelPriceable(served, 'chat', overrides)).toBe(false);
    const gate = resolveBrainstormCostGate({ crossModel: 'nvidia:nemotron-3-super', judgeModel: PRICED, embedModel: null, pricingOverrides: overrides });
    expect(isModelPriceable(served, 'chat', gate.pricingOverrides)).toBe(true);
  });
});

describe('#5873 brainstorm_health names an unpriced brainstorm chat model', () => {
  const DOCTOR_CASES: Array<{
    name: string;
    gatewayModel: string;
    judgeModel?: string;
    overrides?: Record<string, number>;
    unpriced: { model: string; role: 'chat' | 'judge' } | null;
  }> = [
    { name: 'unpriced gateway chat model -> warn', gatewayModel: UNPRICED, unpriced: { model: UNPRICED, role: 'chat' } },
    { name: 'unpriced judge model (models.brainstorm.judge) -> warn naming the judge', gatewayModel: PRICED, judgeModel: UNPRICED_JUDGE, unpriced: { model: UNPRICED_JUDGE, role: 'judge' } },
    { name: 'pricing.overrides prices it -> no pricing warning', gatewayModel: UNPRICED, overrides: { [UNPRICED]: 3 }, unpriced: null },
    { name: 'priced chat model -> no pricing warning', gatewayModel: PRICED, unpriced: null },
  ];

  for (const c of DOCTOR_CASES) {
    test(c.name, async () => {
      configureGateway({ chat_model: c.gatewayModel, env: {} });
      if (c.judgeModel) await engine.setConfig('models.brainstorm.judge', c.judgeModel);
      if (c.overrides) await engine.setConfig('pricing.overrides', JSON.stringify(c.overrides));
      const check = await checkBrainstormHealth(engine);
      if (c.unpriced) {
        expect(check.status).toBe('warn');
        expect(check.message).toContain(`brainstorm ${c.unpriced.role} model "${c.unpriced.model}" has no price`);
        expect(check.message).toContain('against the default $5 ceiling');
        expect(check.message).toContain('--max-cost');
        expect(check.message).toContain(`gbrain config set pricing.overrides '{"${c.unpriced.model}": {"input":`);
      } else {
        expect(check.status).toBe('ok');
        expect(check.message).not.toContain('has no price');
      }
    });
  }

  test('no configured gateway -> the pricing signal is skipped, not guessed', async () => {
    resetGateway();
    const check = await checkBrainstormHealth(engine);
    expect(check.status).toBe('ok');
  });

  test('a config read failure in the pricing step -> warn naming the failure', async () => {
    configureGateway({ chat_model: PRICED, env: {} });
    const failing = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'getConfig') {
          return async (key: string) => {
            if (key === 'models.brainstorm.judge') throw new Error('config plane unreachable');
            return target.getConfig(key);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BrainEngine;
    const check = await checkBrainstormHealth(failing);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('Could not check brainstorm chat model pricing (config plane unreachable)');
  });
});
