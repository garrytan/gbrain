/**
 * Explicit cost cap + a model gbrain has no price for: the run is refused,
 * and the refusal tells the agent to look the price up and register it with
 * `gbrain pricing set`, then retry. Default caps still warn and run.
 *
 * Covers the shared builder (src/core/budget/no-pricing.ts) on every surface
 * that reports `no_pricing`, the merge-safe `gbrain pricing` command, and the
 * trust boundary (registration is trusted-local CLI only).
 *
 * Hermetic: one in-memory PGLite engine and gateway test transports. No
 * network, API keys or production database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import {
  BudgetExhausted,
  BudgetTracker,
  _resetBudgetTrackerWarningsForTest,
  loadPricingOverrides,
  parsePricingOverrides,
} from '../../src/core/budget/budget-tracker.ts';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import { runPhaseConversationFactsBackfill } from '../../src/core/cycle/conversation-facts-backfill.ts';
import { conversationFactsCostCap } from '../../src/core/facts/conversation-budget.ts';
import { runPricing } from '../../src/commands/pricing.ts';
import { budgetExhaustedMessage } from '../../src/commands/enrich.ts';
import { classifyAbortError } from '../../src/core/skillopt/orchestrator.ts';
import { formatRunSummary } from '../../src/commands/skillopt.ts';
import { operations } from '../../src/core/operations.ts';
import { CLI_COMMANDS, THIN_CLIENT_REFUSED_COMMANDS } from '../../src/cli/command-table.ts';
import { ERROR_CATALOGUE } from '../../src/core/error-catalogue.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';

const MODEL = 'litellm:custom-chat';
const OTHER = 'litellm:text-embedding-3-large';
const SLUG = 'conversations/no-pricing-example';
const PRICE_URL = 'https://example.com/pricing';
const BODY = [
  '**Alice Example** (2026-08-27 9:00 AM): The example rollout is complete.',
  '**Bob Demo** (2026-08-27 9:01 AM): Record the result.',
].join('\n');

let engine: PGLiteEngine;
let chatCalls = 0;
let auditDir: string;

/** Run `gbrain pricing …` in-process, capturing output and the exit code. */
async function pricing(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  _resetCliExitVerdictForTests();
  try {
    await runPricing(engine, args);
  } finally {
    console.log = log;
    console.error = error;
  }
  const code = currentExitCode();
  _resetCliExitVerdictForTests();
  return { out: out.join('\n'), err: err.join('\n'), code };
}

function captureReserve(t: BudgetTracker, modelId: string, kind: 'chat' | 'embed'): BudgetExhausted {
  try {
    t.reserve({ modelId, estimatedInputTokens: 100, maxOutputTokens: kind === 'chat' ? 100 : 0, kind });
  } catch (e) {
    if (e instanceof BudgetExhausted) return e;
    throw e;
  }
  throw new Error('reserve() did not refuse');
}

beforeAll(async () => {
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-no-pricing-'));
  // Configure the gateway before the engine: connect() and initSchema() size
  // the vector columns from it, and the embed transport below returns 1536-d.
  resetGateway();
  configureGateway({
    chat_model: MODEL,
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    base_urls: { litellm: 'http://localhost:4000' },
    env: { LITELLM_BASE_URL: 'http://localhost:4000', OPENAI_API_KEY: 'test' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    chatCalls++;
    return {
      text: JSON.stringify({
        facts: [{ fact: 'the example rollout is complete', kind: 'event', entity: null, confidence: 1, notability: 'high' }],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: MODEL,
      providerId: 'litellm',
    };
  });
  __setEmbedTransportForTests(
    (async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.1)),
    })) as never,
  );
});

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(auditDir, { recursive: true, force: true });
});

beforeEach(async () => {
  chatCalls = 0;
  _resetBudgetTrackerWarningsForTest();
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM pages WHERE slug = $1`, [SLUG]);
  await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op = 'extract-conversation-facts'`);
  await engine.executeRaw(`DELETE FROM extract_rollup_7d`);
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('facts.extraction_model', MODEL);
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
  await engine.unsetConfig('cycle.conversation_facts_backfill.max_total_cost_usd');
  await engine.setConfig('cycle.conversation_facts_backfill.max_cost_usd', '0.1');
  // An unrelated operator override that every registration must preserve.
  await engine.setConfig('pricing.overrides', JSON.stringify({ [OTHER]: 0.13 }));
  await engine.putPage(SLUG, {
    type: 'conversation', title: 'No pricing example', compiled_truth: BODY, timeline: '', frontmatter: {},
  }, { sourceId: 'default' });
});

afterEach(() => {
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});

describe('explicit cap + unpriced model: refused with lookup-and-register guidance', () => {
  test('a chat model: text and structured fields name the model, provider, units, command and docs', () => {
    const t = new BudgetTracker({ maxCostUsd: 5, label: 'test', auditPath: join(auditDir, 'a.jsonl') });
    const err = captureReserve(t, 'mystery:unreleased-chat', 'chat');
    expect(err.reason).toBe('no_pricing');
    expect(err.pricing).toEqual({
      code: 'no_pricing',
      model: 'mystery:unreleased-chat',
      provider: 'mystery',
      kind: 'chat',
      units: ['usd_per_1m_input_tokens', 'usd_per_1m_output_tokens'],
      lookup: "Look up mystery's current price for mystery:unreleased-chat (for example, web-search its pricing page): USD per 1M input tokens and USD per 1M output tokens.",
      register_command: 'gbrain pricing set mystery:unreleased-chat --input <usd-per-1M-input-tokens> --output <usd-per-1M-output-tokens> --source <pricing-page-url>',
      register_scope: 'local_cli',
      docs: 'docs/guides/write-refusals.md#no_pricing',
    });
    expect(err.message).toContain(`gbrain has no pricing for chat model "mystery:unreleased-chat" (provider mystery), so the $5.00 cost cap can't be enforced.`);
    expect(err.message).toContain(err.pricing!.lookup);
    expect(err.message).toContain(`with: ${err.pricing!.register_command} — then retry.`);
    expect(err.message).toContain("Over MCP or another remote connection you cannot register prices; ask the brain's operator to run that command.");
    expect(err.message).toContain('docs/guides/write-refusals.md#no_pricing');
  });

  test('an embedding model takes a single --rate in USD per 1M tokens', () => {
    const t = new BudgetTracker({ maxCostUsd: 1, label: 'test', auditPath: join(auditDir, 'b.jsonl') });
    const err = captureReserve(t, 'mystery:some-embed-model', 'embed');
    expect(err.pricing).toMatchObject({
      kind: 'embed',
      units: ['usd_per_1m_tokens'],
      register_command: 'gbrain pricing set mystery:some-embed-model --rate <usd-per-1M-tokens> --source <pricing-page-url>',
    });
    expect(err.message).toContain('embedding model "mystery:some-embed-model"');
    expect(err.message).toContain('USD per 1M tokens');
  });

  test('the docs anchor is catalogued under the stable no_pricing code', () => {
    expect(ERROR_CATALOGUE.no_pricing).toEqual({ code: 'no_pricing', docs: 'docs/guides/write-refusals.md#no_pricing' });
  });
});

describe('default cap + unpriced model: warns and runs', () => {
  test('an uncapped tracker admits the call and its warning names the registration command', () => {
    const writes: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as never;
    try {
      const t = new BudgetTracker({ label: 'test', auditPath: join(auditDir, 'c.jsonl') });
      expect(() => t.reserve({ modelId: 'mystery:unreleased-chat', estimatedInputTokens: 100, maxOutputTokens: 100, kind: 'chat' })).not.toThrow();
    } finally {
      process.stderr.write = write;
    }
    const warning = writes.join('');
    expect(warning).toContain('BUDGET_TRACKER_NO_PRICING');
    expect(warning).toContain('gbrain pricing set mystery:unreleased-chat --input');
  });

  test('a default conversation-facts cap is lifted with a warning that names the registration command', async () => {
    const errors: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      expect(await conversationFactsCostCap(engine, 5, false, undefined)).toBeUndefined();
    } finally {
      console.error = error;
    }
    expect(errors.join('\n')).toContain(`gbrain pricing set ${MODEL} --input`);
  });

  test('the core run under a default budget calls the unpriced model', async () => {
    const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: SLUG, sleepMs: 0 });
    expect(result.budget_exhausted).not.toBe(true);
    expect(chatCalls).toBeGreaterThan(0);
  });
});

describe('conversation facts surfaces carry the guidance', () => {
  test('the core result carries budget_pricing and no model call is made', async () => {
    const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: SLUG, maxCostUsd: 0.1, sleepMs: 0 });
    expect(result).toMatchObject({ budget_exhausted: true, budget_reason: 'no_pricing', budget_model: MODEL });
    expect(result.budget_pricing).toMatchObject({ code: 'no_pricing', model: MODEL, provider: 'litellm', kind: 'chat', register_scope: 'local_cli' });
    expect(chatCalls).toBe(0);
  });

  test('the cycle phase reports no_pricing guidance in details and summary', async () => {
    const result = await runPhaseConversationFactsBackfill(engine, {});
    const details = result.details as { no_pricing: Array<{ model: string; register_command: string }> };
    expect(result.status).toBe('warn');
    expect(details.no_pricing).toHaveLength(1);
    const [guidance] = details.no_pricing;
    expect(guidance!.model).toBe(MODEL);
    expect(guidance!.register_command.startsWith(`gbrain pricing set ${MODEL} --input`)).toBe(true);
    expect(result.summary).toContain(guidance!.register_command);
    expect(chatCalls).toBe(0);
  });
});

describe('other surfaces use the same builder', () => {
  const tracker = () => new BudgetTracker({ maxCostUsd: 2, label: 'enrich:default', auditPath: join(auditDir, 'd.jsonl') });

  test('enrich prints the lookup, the command and the remote-caller route', () => {
    const err = captureReserve(tracker(), MODEL, 'chat');
    const msg = budgetExhaustedMessage('no_pricing', MODEL, err.pricing);
    expect(msg).toContain(err.pricing!.lookup);
    expect(msg).toContain(err.pricing!.register_command);
    expect(msg).toContain("ask the brain's operator to run that command");
    expect(msg).toContain('--max-usd off');
  });

  test('a skillopt receipt carries the guidance and the summary prints the command', () => {
    const err = captureReserve(tracker(), MODEL, 'chat');
    const caught = classifyAbortError(err, { maxRuntimeMin: 60 });
    expect(caught.pricing).toEqual(err.pricing);
    const summary = formatRunSummary('aborted', {
      abort_reason: 'budget_exhausted', abort_detail: caught.abortDetail, no_pricing: caught.pricing,
    } as never, '/tmp/skills');
    expect(summary).toContain(`Register it with: ${err.pricing!.register_command}`);
  });
});

describe('gbrain pricing set / list / unset', () => {
  test('set merges one entry without clobbering others; the retried run is priced and capped', async () => {
    const refused = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: SLUG, maxCostUsd: 0.1, sleepMs: 0 });
    expect(refused.budget_reason).toBe('no_pricing');

    const r = await pricing('set', MODEL, '--input', '1', '--output', '2', '--source', PRICE_URL);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Registered ${MODEL}: $1 per 1M input tokens, $2 per 1M output tokens (source: ${PRICE_URL}).`);
    const stored = JSON.parse((await engine.getConfig('pricing.overrides'))!);
    expect(stored[OTHER]).toBe(0.13);
    expect(stored[MODEL]).toMatchObject({ input: 1, output: 2, source: PRICE_URL });
    expect(typeof stored[MODEL].set_at).toBe('string');
    expect(parsePricingOverrides(stored)).toEqual({
      [OTHER]: { input: 0.13, output: 0.13 },
      [MODEL]: { input: 1, output: 2 },
    });

    const retried = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: SLUG, maxCostUsd: 0.1, sleepMs: 0 });
    expect(retried.budget_exhausted).not.toBe(true);
    expect(chatCalls).toBeGreaterThan(0);
    // 100 input tokens at $1/1M + 50 output tokens at $2/1M per chat call;
    // the remainder is the shipped-price fact embeddings (a few tokens).
    expect(retried.spent_usd!).toBeGreaterThanOrEqual(chatCalls * 0.0002);
    expect(retried.spent_usd!).toBeLessThan(chatCalls * 0.0002 + 0.00001);

    // The registered price is enforced against the cap: a cap below one
    // call's reservation refuses on cost, not on missing pricing.
    const capped = new BudgetTracker({ maxCostUsd: 0.0001, label: 'test', auditPath: join(auditDir, 'e.jsonl'), pricingOverrides: await loadPricingOverrides(engine) });
    let costErr: unknown;
    try {
      capped.reserve({ modelId: MODEL, estimatedInputTokens: 100, maxOutputTokens: 100, kind: 'chat' });
    } catch (e) { costErr = e; }
    expect(costErr).toBeInstanceOf(BudgetExhausted);
    expect((costErr as BudgetExhausted).reason).toBe('cost');
  });

  test('set replaces a case-variant key for the same model and keeps the rest', async () => {
    await engine.setConfig('pricing.overrides', JSON.stringify({ [OTHER]: 0.13, 'LiteLLM:Custom-Chat': { input: 9, output: 9 } }));
    const r = await pricing('set', MODEL, '--input', '3', '--output', '4');
    expect(r.out).toContain(`Updated ${MODEL}`);
    const stored = JSON.parse((await engine.getConfig('pricing.overrides'))!);
    expect(Object.keys(stored).sort()).toEqual([MODEL, OTHER].sort());
    expect(stored[MODEL]).toMatchObject({ input: 3, output: 4 });
  });

  test('--rate stores the schema scalar field for embeddings', async () => {
    const r = await pricing('set', 'mystery:embed', '--rate', '0.02');
    expect(r.code).toBe(0);
    const stored = JSON.parse((await engine.getConfig('pricing.overrides'))!);
    expect(stored['mystery:embed']).toMatchObject({ pricePerMTok: 0.02 });
    expect(parsePricingOverrides(stored)!['mystery:embed']).toEqual({ input: 0.02, output: 0.02 });
  });

  test.each([
    [['--input', 'NaN', '--output', '1'], 'non-negative number'],
    [['--input', '-1', '--output', '1'], 'non-negative number'],
    [['--input', '1', '--output', 'Infinity'], 'non-negative number'],
    [['--input', '1', '--output', 'abc'], 'non-negative number'],
    [['--input', '1'], 'need both --input and --output'],
    [['--rate', '1', '--input', '1'], 'not both'],
    [['--rate'], 'needs a value'],
    [[], 'give the price'],
  ])('set refuses %p and leaves the stored value unchanged', async (flags, why) => {
    const before = await engine.getConfig('pricing.overrides');
    const r = await pricing('set', MODEL, ...flags);
    expect(r.code).toBe(1);
    expect(r.err).toContain(why);
    expect(await engine.getConfig('pricing.overrides')).toBe(before);
  });

  test('an unreadable stored value is never overwritten', async () => {
    await engine.setConfig('pricing.overrides', '{not json');
    const r = await pricing('set', MODEL, '--input', '1', '--output', '2');
    expect(r.code).toBe(1);
    expect(r.err).toContain('left unchanged');
    expect(await engine.getConfig('pricing.overrides')).toBe('{not json');
  });

  test('$0 is accepted with a warning', async () => {
    const r = await pricing('set', MODEL, '--input', '0', '--output', '0');
    expect(r.code).toBe(0);
    expect(r.err).toContain('registered at $0');
    expect(parsePricingOverrides(await engine.getConfig('pricing.overrides'))![MODEL]).toEqual({ input: 0, output: 0 });
  });

  test('list shows entries with provenance; unset removes one and keeps the rest', async () => {
    await pricing('set', MODEL, '--input', '1', '--output', '2', '--source', PRICE_URL);
    const listed = await pricing('list', '--json');
    const rows = JSON.parse(listed.out).overrides as Array<Record<string, unknown>>;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: OTHER, input: 0.13, output: 0.13, valid: true, source: null }),
      expect.objectContaining({ model: MODEL, input: 1, output: 2, valid: true, source: PRICE_URL }),
    ]));

    const removed = await pricing('unset', MODEL);
    expect(removed.code).toBe(0);
    expect(JSON.parse((await engine.getConfig('pricing.overrides'))!)).toEqual({ [OTHER]: 0.13 });
    expect((await pricing('unset', MODEL)).out).toContain('nothing changed');
  });
});

describe('trust boundary: a remote caller cannot register a price', () => {
  test('no operation (the MCP and HTTP surface) is a pricing registration', () => {
    expect(operations.filter(op => /pric/i.test(op.name)).map(op => op.name)).toEqual([]);
  });

  test('no MCP-reachable source writes pricing.overrides', () => {
    const roots = ['src/core/ops', 'src/mcp'];
    const files: string[] = ['src/core/operations.ts'];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    for (const root of roots) walk(join(import.meta.dir, '../..', root));
    const writers = files.filter(f => {
      // test-reads-source-ok[trust-boundary]: no MCP-reachable module may write pricing.overrides or call runPricing.
      const text = readFileSync(f.startsWith('src/') ? join(import.meta.dir, '../..', f) : f, 'utf8');
      return text.includes('pricing.overrides') || text.includes('runPricing');
    });
    expect(writers).toEqual([]);
  });

  test('`gbrain pricing` is a trusted-local CLI command that thin clients refuse', () => {
    const record = CLI_COMMANDS.find(c => c.name === 'pricing');
    expect(record).toMatchObject({ phase: 'post-connect', thinClient: 'refuse' });
    expect(THIN_CLIENT_REFUSED_COMMANDS.has('pricing')).toBe(true);
  });
});
