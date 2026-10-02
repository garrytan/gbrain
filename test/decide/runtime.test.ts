/**
 * decide runtime on PGLite: the egress gate (private page, #5525 derived
 * page, denied source, multi-source private, private fact, conversation text,
 * missing provenance, missing consent), the runner (spend rows including
 * failed requests charged at their estimate, daily cap and remote share,
 * mixed resolved models, malformed responses, egress fallback as its own
 * sub-decision), receipts (hashes only) and the HMAC salt (insert-if-absent,
 * never a config key).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { checkEgress } from '../../src/core/ai/decide/egress.ts';
import { runDecide } from '../../src/core/ai/decide/index.ts';
import { buildReceiptRows } from '../../src/core/ai/decide/receipts.ts';
import {
  dailySpend, flushDecideWrites, receiptSalt, recordReceipts, __resetDecideStoreForTests,
} from '../../src/core/ai/decide/store.ts';
import type { DecideQuestion, EvidenceItem } from '../../src/core/ai/decide/types.ts';

let engine: PGLiteEngine;

const cand = (slug: string, source_id = 'default'): EvidenceItem => ({ text: `text of ${slug}`, class: 'candidates', slug, source_id });
const q = (id: string, input: EvidenceItem): DecideQuestion => ({ id, kind: 'noul', instructions: 'Is `c` evidence?', inputs: { c: input } });
const CONSENT = { 'decide.provider': 'typesafe:jev-1.13.0', 'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow', 'decide.egress.typesafe.facts': 'allow', 'decide.egress.typesafe.conversation': 'allow' };
const STATE = { query: { text: 'q', class: 'query' as const } };

async function page(slug: string, type: string, frontmatter: Record<string, unknown>, sourceId?: string) {
  const r = await importFromContent(engine, slug, serializeMarkdown(frontmatter, `body of ${slug}`, '', { type, title: slug, tags: [] }), { noEmbed: true, forceRechunk: true, ...(sourceId ? { sourceId } : {}) });
  expect(r.status).toBe('imported');
}

function answerAll(model = () => 'jev-1.13.0', status = 200) {
  const bodies: any[] = [];
  __setDecideTransportForTests(async (_u, init) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    if (status !== 200) return new Response('echoed secret text', { status });
    return new Response(JSON.stringify({
      model: model(), usage: { input_tokens: 200, output_tokens: 5 },
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.7 }])),
    }));
  });
  return bodies;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setDecideTransportForTests(null);
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetDecideStoreForTests();
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test' } });
  await page('notes/world', 'note', {});
  await page('notes/private', 'note', { visibility: 'private' });
  await page('notes/private-origin', 'note', { visibility: 'private' });
  await page('atoms/derived', 'atom', { source_slug: 'notes/private-origin', visibility: 'world' });
});

describe('egress gate', () => {
  test('private pages and #5525 derived pages are refused; world pages pass', async () => {
    const cfg = readDecideConfig(CONSENT);
    const v = await checkEgress(engine, cfg, 'typesafe:jev-1.13.0', STATE, [q('w', cand('notes/world')), q('p', cand('notes/private')), q('d', cand('atoms/derived'))]);
    expect(v.refused).toEqual({ p: 'egress_private_denied', d: 'egress_private_denied' });
    const allowed = await checkEgress(engine, readDecideConfig({ ...CONSENT, 'decide.egress.private': 'allow' }), 'typesafe:jev-1.13.0', STATE, [q('p', cand('notes/private'))]);
    expect(allowed.refused).toEqual({});
  });

  test('multi-source: the same slug is judged per (source, slug)', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING`);
    await page('notes/world', 'note', { visibility: 'private' }, 'other');
    const v = await checkEgress(engine, readDecideConfig(CONSENT), 'typesafe:jev-1.13.0', STATE, [q('a', cand('notes/world', 'default')), q('b', cand('notes/world', 'other'))]);
    expect(v.refused).toEqual({ b: 'egress_private_denied' });
  });

  test('denied sources apply to every provider, including llm:', async () => {
    const cfg = readDecideConfig({ ...CONSENT, 'decide.egress.deny_sources': '["default"]' });
    expect((await checkEgress(engine, cfg, 'llm:openai:gpt-4o-mini', STATE, [q('a', cand('notes/world'))])).refused).toEqual({ a: 'denied_source' });
    expect((await checkEgress(engine, cfg, 'typesafe:jev-1.13.0', STATE, [q('a', cand('notes/world'))])).refused).toEqual({ a: 'denied_source' });
  });

  test('facts default private, conversation needs private=allow, provenance is required, consent is per class', async () => {
    const cfg = readDecideConfig(CONSENT);
    const fact = (visibility?: 'world' | 'private'): EvidenceItem => ({ text: 'fact', class: 'facts', fact_id: 1, source_id: 'default', ...(visibility ? { visibility } : {}) });
    const v = await checkEgress(engine, cfg, 'typesafe:jev-1.13.0', STATE, [
      q('f1', fact()), q('f2', fact('world')), q('c', { text: 'turn', class: 'conversation', transcript_ref: 't1' }),
      q('m', { text: 'no slug', class: 'candidates' }),
    ]);
    expect(v.refused).toEqual({ f1: 'egress_private_denied', c: 'egress_private_denied', m: 'missing_provenance' });
    const noConsent = await checkEgress(engine, readDecideConfig({ 'decide.provider': 'typesafe:jev-1.13.0' }), 'typesafe:jev-1.13.0', STATE, [q('w', cand('notes/world'))]);
    expect(noConsent.stateRefused).toBe('egress_class_denied');
  });

  test('llm: provider follows chat egress rules (private content allowed there)', async () => {
    const v = await checkEgress(engine, readDecideConfig({}), 'llm:openai:gpt-4o-mini', STATE, [q('p', cand('notes/private'))]);
    expect(v.refused).toEqual({});
  });
});

describe('runner', () => {
  test('writes one spend row per request; failed requests are charged their estimate', async () => {
    const cfg = readDecideConfig(CONSENT);
    answerAll();
    const r = await runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] }, { engine, config: cfg });
    expect(r.answers.w).toEqual({ kind: 'noul', p: 0.7 });
    expect(r.model_resolved).toBe('jev-1.13.0');
    answerAll(undefined, 503);
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] }, { engine, config: cfg })).rejects.toMatchObject({ reason: 'provider_error' });
    await flushDecideWrites();
    const rows = await engine.executeRaw<{ outcome: string; input_tokens: number; cost_usd: number }>('SELECT outcome, input_tokens, cost_usd FROM decide_spend ORDER BY created_at');
    expect(rows.map((x) => x.outcome)).toEqual(['ok', 'failed']);
    expect(rows[0]!.input_tokens).toBe(200);
    expect(rows[1]!.input_tokens).toBeGreaterThan(0);
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(200 * 0.042 / 1e6, 12);
  });

  test('the daily cap and the remote share refuse before sending', async () => {
    const bodies = answerAll();
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] },
      { engine, config: readDecideConfig({ ...CONSENT, 'decide.budget.daily_usd': '0' }) })).rejects.toMatchObject({ reason: 'budget_exhausted' });
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))], remote: true },
      { engine, config: readDecideConfig({ ...CONSENT, 'decide.budget.remote_share': '0' }) })).rejects.toMatchObject({ reason: 'budget_exhausted' });
    expect(bodies).toHaveLength(0);
    expect((await dailySpend(engine)).total).toBe(0);
  });

  test('mixed resolved models across batches fail the decision; malformed fails it too', async () => {
    let n = 0;
    answerAll(() => (n++ === 0 ? 'jev-1.13.0' : 'jev-1.14.0'));
    const many = Array.from({ length: 40 }, (_, i) => q(`q${i}`, { ...cand('notes/world'), text: 'evidence '.repeat(1200) }));
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: many }, { engine, config: readDecideConfig({ ...CONSENT, 'decide.egress.private': 'allow' }) }))
      .rejects.toMatchObject({ reason: 'mixed_model' });
    __setDecideTransportForTests(async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { w: { type: 'noul', noul: 7 } } })));
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] }, { engine, config: readDecideConfig(CONSENT) }))
      .rejects.toMatchObject({ reason: 'malformed_response' });
  });

  test('egress-refused items go to decide.egress_fallback as their own sub-decision; private text never reaches TypeSafe', async () => {
    const bodies = answerAll();
    __setChatTransportForTests(async () => ({
      text: JSON.stringify({ answers: { p: { type: 'noul', noul: 0.2 } } }), blocks: [], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:gpt-4o-mini', responseModel: 'gpt-4o-mini-2024-07-18', providerId: 'openai',
    }) as never);
    configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-test' } });
    const r = await runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world')), q('p', cand('notes/private'))] },
      { engine, config: readDecideConfig({ ...CONSENT, 'decide.egress_fallback': 'llm:openai:gpt-4o-mini' }) });
    expect(Object.keys(r.answers)).toEqual(['w']);
    expect(r.refused).toEqual({ p: 'egress_private_denied' });
    expect(r.fallback?.answers.p).toEqual({ kind: 'noul', p: 0.2 });
    expect(r.fallback?.model_resolved).toBe('gpt-4o-mini-2024-07-18');
    expect(r.fallback?.decision_id).not.toBe(r.decision_id);
    expect(JSON.stringify(bodies)).not.toContain('notes/private');
  });

  test('no provider and no key are named refusals', async () => {
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] }, { engine, config: readDecideConfig({}) }))
      .rejects.toMatchObject({ reason: 'no_provider' });
    configureGateway({ env: {} });
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w', cand('notes/world'))] }, { engine, config: readDecideConfig(CONSENT) }))
      .rejects.toMatchObject({ reason: 'no_key' });
  });
});

describe('receipts and salt', () => {
  test('receipts store HMAC hashes only, never query, candidate or slug text', async () => {
    const rows = await buildReceiptRows(engine, {
      slot: 'evidence', mode: 'on', callSite: 'search', lane: 'hot', provider: 'typesafe:jev-1.13.0',
      questions: [q('w', { ...cand('notes/world'), text: 'SECRET CANDIDATE TEXT' })],
      state: { query: { text: 'SECRET QUERY TEXT', class: 'query' } }, outcomes: { w: 'kept' }, subjects: { w: 'page:default:notes/world' },
    });
    recordReceipts(engine, rows);
    await flushDecideWrites();
    const stored = JSON.stringify(await engine.executeRaw('SELECT * FROM decision_receipts'));
    for (const text of ['SECRET', 'notes/world']) expect(stored).not.toContain(text);
    expect(() => recordReceipts(engine, [{ ...rows[0]!, outcome: 'invented' }])).toThrow(/canonical vocabulary/);
  });

  test('the salt is insert-if-absent (concurrent callers agree) and is never a config key', async () => {
    __resetDecideStoreForTests();
    const [a, b] = await Promise.all([receiptSalt(engine), receiptSalt(engine)]);
    __resetDecideStoreForTests();
    const c = await receiptSalt(engine);
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const config = JSON.stringify(await engine.getAllConfig());
    expect(config).not.toContain(a);
  });
});
