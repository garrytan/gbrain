/**
 * #5980 — TypeSafe decide behind a gateway: provider-namespaced model ids and
 * a custom base URL.
 *
 * `decide.provider` only accepted `typesafe:jev-<…>`, so a gateway-fronted or
 * self-hosted Jev published as `typesafe:oc/jev-1.13-free` read back as
 * `none`. The id is now accepted (no whitespace, no `:`), and
 * `provider_base_urls.typesafe` is pinned as the request's origin.
 *
 * [R18]: widening the id alone would have admitted an id with no tariff as
 * $0 against the daily and remote-share budgets (`usageCostUsd(...) ?? 0`).
 * An unpriced id is refused BEFORE transport with `unpriced_model` unless the
 * operator registered a price (`pricing.overrides`, written by
 * `gbrain pricing set`); the spend ledger never records $0 for an unknown
 * cost. Pinned here with NO outer budget tracker, so the decide-level policy
 * itself is what protects the budgets.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { configureGateway, resetGateway, getCurrentBudgetTracker, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { isValidProvider, readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { runDecide } from '../../src/core/ai/decide/index.ts';
import { REFUSAL_CATALOG, SKIP_REASONS } from '../../src/core/ai/decide/outcomes.ts';
import { dailySpend, flushDecideWrites, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import type { DecideQuestion, EvidenceItem } from '../../src/core/ai/decide/types.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import type { GBrainConfig } from '../../src/core/config.ts';

let engine: PGLiteEngine;

const NAMESPACED = 'typesafe:oc/jev-1.13-free';
const cand = (slug: string): EvidenceItem => ({ text: `text of ${slug}`, class: 'candidates', slug, source_id: 'default' });
const q = (id: string, input: EvidenceItem): DecideQuestion => ({ id, kind: 'noul', instructions: 'Is `c` evidence?', inputs: { c: input } });
const consentFor = (provider: string) => ({
  'decide.provider': provider,
  'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow',
  'decide.egress.typesafe.facts': 'allow', 'decide.egress.typesafe.conversation': 'allow',
});
const STATE = { query: { text: 'q', class: 'query' as const } };

function answerAll(model: string) {
  const calls: Array<{ url: string; body: any }> = [];
  __setDecideTransportForTests(async (url, init) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify({
      model, usage: { input_tokens: 200, output_tokens: 5 },
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.7 }])),
    }));
  });
  return calls;
}

async function spendRows() {
  await flushDecideWrites();
  return engine.executeRaw<{ provider: string; outcome: string; cost_usd: number }>('SELECT provider, outcome, cost_usd FROM decide_spend ORDER BY created_at');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const r = await importFromContent(engine, 'notes/world', serializeMarkdown({}, 'body of notes/world', '', { type: 'note', title: 'notes/world', tags: [] }), { noEmbed: true, forceRechunk: true });
  expect(r.status).toBe('imported');
});

afterAll(async () => {
  __setDecideTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetDecideStoreForTests();
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test' } });
  const r = await importFromContent(engine, 'notes/world', serializeMarkdown({}, 'body of notes/world', '', { type: 'note', title: 'notes/world', tags: [] }), { noEmbed: true, forceRechunk: true });
  expect(r.status).toBe('imported');
  expect(getCurrentBudgetTracker() ?? undefined).toBeUndefined();
});

describe('isValidProvider accepts provider-namespaced TypeSafe ids', () => {
  test('gateway and self-hosted ids pass; whitespace, a second colon and an empty tail do not', () => {
    expect(isValidProvider('typesafe:jev-1.13.0')).toBe(true);
    expect(isValidProvider(NAMESPACED)).toBe(true);
    expect(isValidProvider('typesafe:jev_custom')).toBe(true);
    expect(isValidProvider('typesafe:org@gw/jev.1')).toBe(true);
    expect(isValidProvider('typesafe:')).toBe(false);
    expect(isValidProvider('typesafe:jev 1.13')).toBe(false);
    expect(isValidProvider('typesafe:jev:1.13')).toBe(false);
    expect(isValidProvider('typesafe:/jev')).toBe(false);
    expect(isValidProvider('none')).toBe(true);
    expect(isValidProvider('llm:openai:gpt-4o-mini')).toBe(true);
  });

  test('readDecideConfig keeps a namespaced global provider instead of reading it back as none', () => {
    expect(readDecideConfig(consentFor(NAMESPACED)).provider).toBe(NAMESPACED);
    expect(readDecideConfig({ 'decide.provider': 'typesafe:jev 1.13' }).provider).toBe('none');
  });
});

describe('[R18] unpriced-model policy, with no outer budget tracker', () => {
  test('an unpriced namespaced id is refused before transport; no spend row, nothing sent', async () => {
    const calls = answerAll('oc/jev-1.13-free');
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] },
      { engine, config: readDecideConfig(consentFor(NAMESPACED)) }))
      .rejects.toMatchObject({ reason: 'unpriced_model' });
    expect(calls).toHaveLength(0);
    expect(await spendRows()).toEqual([]);
    expect((await dailySpend(engine)).total).toBe(0);
  });

  test('the refusal is terminal with no engine too (probe path), and the daily budget is not consulted first', async () => {
    const calls = answerAll('oc/jev-1.13-free');
    await expect(runDecide({ slot: 'evidence', callSite: 'probe', state: {}, questions: [q('w', { text: 'We decided to ship.', class: 'query' })], provider: NAMESPACED, lane: 'background' },
      { engine: null, config: { ...readDecideConfig(consentFor(NAMESPACED)), consent: { query: true, candidates: true, facts: true, conversation: true } } }))
      .rejects.toMatchObject({ reason: 'unpriced_model' });
    expect(calls).toHaveLength(0);
  });

  test('an operator price in pricing.overrides admits the id; the ledger records that price, never $0', async () => {
    const calls = answerAll('oc/jev-1.13-free');
    const cfg = readDecideConfig({ ...consentFor(NAMESPACED), 'pricing.overrides': JSON.stringify({ [NAMESPACED]: 0.05 }) });
    const r = await runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] }, { engine, config: cfg });
    expect(r.answers.w).toEqual({ kind: 'noul', p: 0.7 });
    expect(r.model_resolved).toBe('oc/jev-1.13-free');
    expect(r.cost_usd).toBeCloseTo(200 * 0.05 / 1e6, 12);
    expect(calls).toHaveLength(1);
    const rows = await spendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe(NAMESPACED);
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(200 * 0.05 / 1e6, 12);
    expect(Number(rows[0]!.cost_usd)).toBeGreaterThan(0);
  });

  test('a priced override id still honours the daily cap and the remote share', async () => {
    const calls = answerAll('oc/jev-1.13-free');
    const base = { ...consentFor(NAMESPACED), 'pricing.overrides': JSON.stringify({ [NAMESPACED]: 0.05 }) };
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] },
      { engine, config: readDecideConfig({ ...base, 'decide.budget.daily_usd': '0' }) })).rejects.toMatchObject({ reason: 'budget_exhausted' });
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))], remote: true },
      { engine, config: readDecideConfig({ ...base, 'decide.budget.remote_share': '0' }) })).rejects.toMatchObject({ reason: 'budget_exhausted' });
    expect(calls).toHaveLength(0);
  });

  test('the shipped tariff ids are unaffected', async () => {
    const calls = answerAll('jev-1.13.0');
    const r = await runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] },
      { engine, config: readDecideConfig(consentFor('typesafe:jev-1.13.0')) });
    expect(r.cost_usd).toBeCloseTo(200 * 0.042 / 1e6, 12);
    expect(calls).toHaveLength(1);
  });

  test('unpriced_model is a catalogued refusal and a receipt skip reason', () => {
    expect(SKIP_REASONS).toContain('unpriced_model');
    expect(REFUSAL_CATALOG.unpriced_model?.fix).toContain('gbrain pricing set');
    expect(REFUSAL_CATALOG.unpriced_model?.anchor).toBe('#unpriced_model');
  });
});

describe('provider_base_urls.typesafe', () => {
  test('the decide request goes to the configured origin, path preserved', async () => {
    // The user-facing key is config `provider_base_urls.typesafe`; buildGatewayConfig folds it into the gateway's base_urls.
    const built = buildGatewayConfig({ engine: 'pglite', provider_base_urls: { typesafe: 'https://gw.example.test/typesafe/v1/' } } as GBrainConfig);
    expect(built.base_urls?.typesafe).toBe('https://gw.example.test/typesafe/v1/');
    configureGateway({ ...built, env: { ...built.env, TYPESAFE_API_KEY: 'sk-test' } });
    const calls = answerAll('jev-1.13.0');
    await runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] },
      { engine, config: readDecideConfig(consentFor('typesafe:jev-1.13.0')) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gw.example.test/typesafe/v1/systemone');
  });

  test('without an override the request goes to api.typesafe.ai', async () => {
    const calls = answerAll('jev-1.13.0');
    await runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] },
      { engine, config: readDecideConfig(consentFor('typesafe:jev-1.13.0')) });
    expect(calls[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
  });
});
