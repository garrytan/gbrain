/**
 * extract_atoms under an explicit `cycle.extract_atoms.budget_usd` with a
 * model foresights has no price for: the run is refused (status `warn`, no model
 * call), carries the shared no_pricing guidance in its details, records the
 * stop as an expected limit (not a halt) for extract_health, and doctor's
 * extract_health names the registration command until the price is
 * registered. A default cap still warns and runs (#5825).
 *
 * Hermetic: in-memory PGLite, chat stubbed through the `_chat` seam, embed
 * transport stubbed. No network or API keys.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { applyExtractAtomsNoPricing, readExtractAtomsNoPricing } from '../src/core/cycle/extract-atoms-cost-gate.ts';
import { computeExtractHealthCheck } from '../src/commands/doctor.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { runPricing } from '../src/commands/pricing.ts';

const UNPRICED_CHAT = 'litellm:custom-chat';
const FREE_CHAT = 'llama-server:local-27b';
const PRICED_EMBED = 'openai:text-embedding-3-large';
const UNPRICED_EMBED = 'litellm:nvidia/some-local-embedder';
const DIMS = 1536;

let engine: PGLiteEngine;
let chatCalls = 0;
let n = 0;

function useEmbedModel(model: string): void {
  resetGateway();
  configureGateway({ embedding_model: model, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async (args: { values: string[] }) => ({
    embeddings: args.values.map(() => Array.from({ length: DIMS }, () => 0.01)),
    usage: { tokens: 10 * args.values.length },
  })) as never);
}

async function chat(_o: ChatOpts): Promise<ChatResult> {
  chatCalls++;
  return {
    text: `[{"title":"Example atom","atom_type":"insight","body":"An example rollout finished."}]`,
    blocks: [{ type: 'text', text: '' }],
    stopReason: 'end',
    usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: UNPRICED_CHAT,
    providerId: 'litellm',
  };
}

async function runOnce() {
  n++;
  const errors: string[] = [];
  const saved = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
  try {
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: `/fake/meeting-${n}.txt`, content: `transcript content ${n}`, contentHash: `${n}`.padStart(16, '0') }],
      _pages: [],
      _chat: chat,
    });
    return { result, stderr: errors.join('\n') };
  } finally {
    console.error = saved;
  }
}

async function rollup(): Promise<{ halt: number; expected: number; completed: number }> {
  const [row] = await engine.executeRaw<{ halt_count: number; expected_limit_count: number; round_completed_count: number }>(
    `SELECT COALESCE(SUM(halt_count),0) AS halt_count, COALESCE(SUM(expected_limit_count),0) AS expected_limit_count,
            COALESCE(SUM(round_completed_count),0) AS round_completed_count
       FROM extract_rollup_7d WHERE kind = 'atoms'`,
  );
  return { halt: Number(row!.halt_count), expected: Number(row!.expected_limit_count), completed: Number(row!.round_completed_count) };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

afterEach(async () => {
  chatCalls = 0;
  await engine.unsetConfig('cycle.extract_atoms.budget_usd');
  await engine.unsetConfig('pricing.overrides');
  for (const key of await engine.listConfigKeys('cycle.extract_atoms.no_pricing.')) await engine.unsetConfig(key);
  await engine.executeRaw(`DELETE FROM extract_rollup_7d`);
});

describe('explicit extract_atoms cap + unpriced model', () => {
  test('an unpriced chat model is refused: warn, no model call, guidance in details, expected limit not halt', async () => {
    useEmbedModel(PRICED_EMBED);
    await engine.setConfig('models.dream.extract_atoms', UNPRICED_CHAT);
    await engine.setConfig('cycle.extract_atoms.budget_usd', '0.5');

    const { result, stderr } = await runOnce();
    expect(result.status).toBe('warn');
    expect(chatCalls).toBe(0);
    const details = result.details as Record<string, any>;
    expect(details.reason).toBe('no_pricing');
    expect(details.atoms_extracted).toBe(0);
    expect(details.no_pricing).toMatchObject({
      code: 'no_pricing', model: UNPRICED_CHAT, provider: 'litellm', kind: 'chat',
      units: ['usd_per_1m_input_tokens', 'usd_per_1m_output_tokens'], register_scope: 'local_cli',
      docs: 'docs/guides/write-refusals.md#no_pricing',
    });
    expect(details.no_pricing.register_command).toStartWith(`foresights pricing set ${UNPRICED_CHAT} --input`);
    expect(result.summary).toContain('the $0.50 cost cap can\'t be enforced');
    expect(result.summary).toContain(details.no_pricing.register_command);
    expect(stderr).toContain(details.no_pricing.register_command);
    expect(stderr).not.toContain('running without a cost gate');

    expect(await rollup()).toEqual({ halt: 0, expected: 1, completed: 0 });

    const records = await readExtractAtomsNoPricing(engine);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source_id: 'default', model: UNPRICED_CHAT });
    const doctor = await computeExtractHealthCheck(engine);
    applyExtractAtomsNoPricing(doctor, records);
    expect(doctor.status).toBe('warn');
    expect(doctor.message).toContain(details.no_pricing.register_command);
    expect((doctor.details as Record<string, unknown>).no_pricing).toEqual(records);
  }, 60_000);

  test('an unpriced embedding route is refused the same way instead of billing at $0', async () => {
    useEmbedModel(UNPRICED_EMBED);
    await engine.setConfig('models.dream.extract_atoms', FREE_CHAT);
    await engine.setConfig('cycle.extract_atoms.budget_usd', '0.5');

    const { result } = await runOnce();
    expect(result.status).toBe('warn');
    expect(chatCalls).toBe(0);
    const details = result.details as Record<string, any>;
    expect(details.atoms_extracted).toBe(0);
    expect(details.no_pricing).toMatchObject({ code: 'no_pricing', model: UNPRICED_EMBED, kind: 'embed', units: ['usd_per_1m_tokens'] });
    expect(details.no_pricing.register_command).toStartWith(`foresights pricing set ${UNPRICED_EMBED} --rate`);
    expect(await rollup()).toEqual({ halt: 0, expected: 1, completed: 0 });
  }, 60_000);

  test('after the price is registered the retried run extracts under the cap and the doctor warning clears', async () => {
    useEmbedModel(PRICED_EMBED);
    await engine.setConfig('models.dream.extract_atoms', UNPRICED_CHAT);
    await engine.setConfig('cycle.extract_atoms.budget_usd', '0.5');
    expect((await runOnce()).result.status).toBe('warn');
    expect(await readExtractAtomsNoPricing(engine)).toHaveLength(1);

    const saved = console.log;
    console.log = () => {};
    try {
      await runPricing(engine, ['set', UNPRICED_CHAT, '--input', '1', '--output', '2']);
    } finally {
      console.log = saved;
      _resetCliExitVerdictForTests();
    }

    const { result } = await runOnce();
    expect(result.status).toBe('ok');
    expect(chatCalls).toBe(1);
    expect(result.details?.atoms_extracted).toBe(1);
    expect(result.details?.budget_exhausted).toBe(false);
    expect(await readExtractAtomsNoPricing(engine)).toEqual([]);
  }, 60_000);
});

describe('default extract_atoms cap + unpriced model', () => {
  test('warns and runs (#5825)', async () => {
    useEmbedModel(PRICED_EMBED);
    await engine.setConfig('models.dream.extract_atoms', UNPRICED_CHAT);

    const { result, stderr } = await runOnce();
    expect(result.status).toBe('ok');
    expect(chatCalls).toBe(1);
    expect(result.details?.atoms_extracted).toBe(1);
    expect(stderr).toContain('running without a cost gate');
    expect(stderr).toContain(`foresights pricing set ${UNPRICED_CHAT} --input`);
    expect(await readExtractAtomsNoPricing(engine)).toEqual([]);
  }, 60_000);
});
