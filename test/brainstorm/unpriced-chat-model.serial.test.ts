/**
 * #5873: brainstorm / lsd on a chat model that has no price.
 *
 * Policy (no-pricing.ts): under the default $5 cap an unpriced model warns and
 * runs, while the run tracker keeps metering priced calls and the
 * orchestrator's estimate / mid-run / pre-judge checks count the unpriced
 * model at Sonnet rates; an explicit --max-usd refuses a run that would call
 * a model nothing prices, before any work, with the shared no_pricing
 * guidance; --max-usd off removes the USD ceiling. `pricing.overrides`
 * prices every check in the run.
 *
 * Regression: the run tracker was built as `maxCostUsd ?? 5` (a user cap)
 * without `pricingOverrides`, so every gateway.chat reserve() on an unpriced
 * model threw no_pricing even with no flag, and the registered rate never
 * reached the run.
 *
 * Every other brainstorm test injects `chatFn`, which bypasses the gateway's
 * reserve(); these runs go through gateway.chat. Serial: configureGateway and
 * the transport seams mutate module state.
 *
 * Adapted from @andreineacsu's #5959 suite.
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
import { readdirSync, readFileSync } from 'node:fs';

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
  maxCostUsd?: number | null;
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
    name: 'unpriced chat model, no cap flag: runs under the default cap and names the model with the registration command',
    gatewayModel: UNPRICED,
    profile: TINY,
    expect: { completes: true, judgeFailed: false, stderr: /chat model "claude-cli:claude-opus-9-9" has no price: the default \$5\.00 cap cannot meter its calls.*gbrain pricing set claude-cli:claude-opus-9-9 --input/ },
  },
  {
    name: 'unpriced chat model, no cap flag: the $5 default still stops an oversized run at Sonnet rates',
    gatewayModel: UNPRICED,
    profile: BIG_ESTIMATE,
    expect: { reason: 'cost', message: /estimated cost \$67\.20 exceeds --max-cost \$5\.00\. Lower --limit, register the real rate of "claude-cli:claude-opus-9-9" \(the estimate assumes Sonnet rates\): gbrain pricing set/, refused: 'at-estimate' },
  },
  {
    name: 'unpriced chat model, no cap flag: the mid-run guard stops crosses past $5 at Sonnet rates',
    gatewayModel: UNPRICED,
    profile: TINY,
    crossUsage: { input: 0, output: 400_000 }, // $6.00 per cross at the $15/M Sonnet output rate
    expect: { reason: 'cost', message: /running cost \$6\.00 exceeded --max-cost \$5\.00 mid-run/, refused: 'mid-run' },
  },
  {
    name: 'unpriced judge model, no cap flag: the run completes and names the judge',
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
    name: 'pricing.overrides reaches the run tracker: an explicit cap runs on the registered rate',
    gatewayModel: UNPRICED,
    overrides: { [UNPRICED]: 3 },
    maxCostUsd: 1,
    profile: TINY,
    expect: { completes: true, judgeFailed: false, stderr: /cap: \$1\.00 \(--max-usd; remove it with --max-usd off\)/ },
  },
  {
    name: 'pricing.overrides reaches the pre-run estimate: the explicit cap holds against the registered rate',
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
    name: 'an unpriced embedding model under the default cap: the question embedding runs (unmetered) instead of failing',
    gatewayModel: PRICED,
    embeddingModel: UNPRICED_EMBED,
    profile: TINY,
    expect: { completes: true, notStderr: /question embedding failed/ },
  },
  {
    name: 'an unpriced embedding model under an explicit cap: refused before any work with the registration command',
    gatewayModel: PRICED,
    embeddingModel: UNPRICED_EMBED,
    maxCostUsd: 1,
    profile: TINY,
    expect: { reason: 'no_pricing', message: /gbrain has no pricing for embedding model "litellm:my-embed".*gbrain pricing set litellm:my-embed --rate/, refused: 'before-preview' },
  },
  {
    name: 'unpriced chat model under an explicit cap: refused before any work with the shared no_pricing guidance',
    gatewayModel: UNPRICED,
    maxCostUsd: 1,
    profile: TINY,
    expect: { reason: 'no_pricing', message: /brainstorm \(chat model\): gbrain has no pricing for chat model "claude-cli:claude-opus-9-9" \(provider claude-cli\), so the \$1\.00 cost cap can't be enforced\. Look up .*gbrain pricing set claude-cli:claude-opus-9-9 --input/, refused: 'before-preview' },
  },
  {
    name: 'unpriced judge model under an explicit cap: refused before the crosses are paid for',
    gatewayModel: PRICED,
    judgeModel: UNPRICED_JUDGE,
    maxCostUsd: 1,
    profile: TINY,
    expect: { reason: 'no_pricing', message: /brainstorm \(judge model\): gbrain has no pricing for chat model "claude-cli:claude-judge-9-9"/, refused: 'before-preview' },
  },
  {
    name: 'priced chat model, no cap flag: the default $5 ceiling still refuses an oversized run',
    gatewayModel: PRICED,
    profile: BIG_ESTIMATE,
    expect: { reason: 'cost', message: /exceeds --max-cost \$5\.00\. Lower --limit, raise --max-usd/, refused: 'at-estimate' },
  },
  {
    name: '--max-usd off: an estimate far past $5 runs, and the notice says the cap is off',
    gatewayModel: PRICED,
    maxCostUsd: null,
    profile: BIG_ESTIMATE,
    expect: { completes: true, stderr: /cap: off \(--max-usd off; spend is still ledgered/ },
  },
  {
    name: '--max-usd off on an unpriced model: runs without a no_pricing refusal',
    gatewayModel: UNPRICED,
    maxCostUsd: null,
    profile: BIG_ESTIMATE,
    expect: { completes: true, notStderr: /has no price: the default/ },
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
        ...(typeof c.maxCostUsd === 'number' || c.maxCostUsd === null ? { maxCostFlag: '--max-usd' } : {}),
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
        expect(result.cost.cap_usd).toBe(c.maxCostUsd === undefined ? 5 : c.maxCostUsd);
        expect(result.cost.cap_source).toBe(c.maxCostUsd === undefined ? 'default' : 'user');
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
      if (c.expect.reason === 'no_pricing') {
        expect((err as BudgetExhausted).pricing?.code).toBe('no_pricing');
        expect((err as BudgetExhausted).fix?.argv?.slice(0, 3)).toEqual(['gbrain', 'pricing', 'set']);
        expect((err as BudgetExhausted).capSource).toBe('user');
      }
      expect(calls.judge).toBe(0);
      expect(calls.embed).toBe(0);
      if (c.expect.refused === 'mid-run') {
        expect(calls.cross).toBeGreaterThan(0);
      } else {
        expect(calls.cross).toBe(0);
        // Refused before the preview means no estimate line and no retrieval.
        expect(stderr.join('').includes('estimated cost')).toBe(c.expect.refused === 'at-estimate');
      }
    });
  }

  test('a default cap with an unpriced judge keeps metering the priced cross calls', async () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'gbrain-5873-audit-'));
    const prev = process.env.GBRAIN_AUDIT_DIR;
    process.env.GBRAIN_AUDIT_DIR = auditDir;
    try {
      configureGateway({ chat_model: PRICED, env: {} });
      __setChatTransportForTests(transportFor(PRICED, { input: 100, output: 50 }));
      await engine.setConfig('models.brainstorm.judge', UNPRICED_JUDGE);
      await runBrainstorm(engine, {}, {
        question: 'battery recycling question',
        profile: TINY,
        skipCostPreview: true,
        embedQueryFn: async () => basisEmbedding(10),
        stderrWrite: () => {},
      });
      const lines = readdirSync(auditDir)
        .filter((f) => f.startsWith('budget-'))
        .flatMap((f) => readFileSync(join(auditDir, f), 'utf8').trim().split('\n'))
        .map((l) => JSON.parse(l) as { event: string; model?: string; actual_cost_usd?: number; max_cost_usd?: number | null });
      const priced = lines.filter((l) => l.event === 'record' && l.actual_cost_usd !== undefined);
      expect(priced.length).toBeGreaterThan(0);
      expect(priced.every((l) => l.max_cost_usd === 5)).toBe(true);
      expect(lines.some((l) => l.event === 'reserve_unpriced' && l.model === UNPRICED_JUDGE)).toBe(true);
      expect(lines.some((l) => l.event === 'reserve_no_pricing')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_AUDIT_DIR;
      else process.env.GBRAIN_AUDIT_DIR = prev;
      rmSync(auditDir, { recursive: true, force: true });
    }
  });
});

describe('#5873 resolveBrainstormCostGate', () => {
  test('no flag is the $5 default; a number is a user cap; null is off', () => {
    const base = { crossModel: PRICED, judgeModel: PRICED };
    expect(resolveBrainstormCostGate(base)).toMatchObject({ ceilingUsd: 5, capSource: 'default', unpricedChatModels: [] });
    expect(resolveBrainstormCostGate({ ...base, maxCostUsd: 2 })).toMatchObject({ ceilingUsd: 2, capSource: 'user' });
    expect(resolveBrainstormCostGate({ ...base, maxCostUsd: null })).toMatchObject({ ceilingUsd: null, capSource: 'user' });
  });

  test('unpriced cross and judge models are listed once each, cross first; an override prices them', () => {
    expect(resolveBrainstormCostGate({ crossModel: UNPRICED, judgeModel: UNPRICED }).unpricedChatModels).toEqual([{ model: UNPRICED, role: 'chat' }]);
    expect(resolveBrainstormCostGate({ crossModel: UNPRICED, judgeModel: UNPRICED_JUDGE }).unpricedChatModels)
      .toEqual([{ model: UNPRICED, role: 'chat' }, { model: UNPRICED_JUDGE, role: 'judge' }]);
    expect(resolveBrainstormCostGate({ crossModel: UNPRICED, judgeModel: UNPRICED, pricingOverrides: { [UNPRICED]: { input: 1, output: 1 } } }).unpricedChatModels).toEqual([]);
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
        expect(check.message).toContain('under the default $5 cap');
        expect(check.message).toContain('--max-usd');
        expect(check.message).toContain(`gbrain pricing set ${c.unpriced.model} --input`);
      } else {
        expect(check.message).not.toContain('has no price');
      }
    });
  }

  test('no configured gateway -> the pricing signal is skipped, not guessed', async () => {
    resetGateway();
    const check = await checkBrainstormHealth(engine);
    expect(check.message).not.toContain('has no price');
  });
});
