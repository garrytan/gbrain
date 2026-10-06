/**
 * Quote grounding for think answers and saved syntheses: every quoted span is
 * checked against exactly the evidence the prompt carried. Exact quotes stay,
 * near matches are repaired to the evidence's words, quotes found nowhere are
 * unquoted and marked [unverified] in the live answer, and a saved synthesis
 * keeps the failing claim out of its body (frontmatter unverified_claims).
 * Numbers are not checked here (answers compute them). On by default:
 * think.quote_verify (false turns it off).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runThink, persistSynthesis, type ThinkLLMClient } from '../src/core/think/index.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { groundAnswerQuotes, groundSource, verifyBody, UNVERIFIED_QUOTE_MARK } from '../src/core/cycle/synthesize-verify.ts';

let engine: PGLiteEngine;

function stub(answer: string): ThinkLLMClient {
  return {
    create: async () => ({
      id: 'msg_quote', type: 'message', role: 'assistant', model: 'stub', stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      content: [{ type: 'text', text: JSON.stringify({ answer, citations: [], gaps: [] }) }],
    }) as never,
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, 'meetings/pricing-review',
    '---\ntype: meeting\ntitle: Pricing review\n---\nAlice Example said "we will move to annual billing in March" and the team agreed. Revenue grew 40 percent.\n',
    { noEmbed: true, sourceId: 'default' });
  await engine.setConfig('think.quote_verify', 'true');
});
afterAll(async () => { await engine.disconnect(); });

describe('groundAnswerQuotes (pure)', () => {
  const sources = [groundSource('evidence', 'Alice Example said we will move to annual billing in March. Bob Example asked about seats.')];

  test('exact stays, near match is repaired, a fabricated quote is unquoted and marked', () => {
    const r = groundAnswerQuotes('She said "we will move to annual billing in March". She also said "we will double prices tomorrow".', sources);
    expect(r.quote_check).toEqual({ grounded: 1, repaired: 0, unverified: 1 });
    expect(r.answer).toContain('"we will move to annual billing in March"');
    expect(r.answer).toContain(`we will double prices tomorrow ${UNVERIFIED_QUOTE_MARK}`);
    expect(r.answer).not.toContain('"we will double prices tomorrow"');
    expect(r.unverified_quotes).toEqual([{ text: 'we will double prices tomorrow', reason: 'quote_not_in_source' }]);
  });

  test('a normalized match is repaired to the evidence words', () => {
    const r = groundAnswerQuotes('She said “We will move to annual billing in March”.', sources);
    expect(r.quote_check.unverified).toBe(0);
    expect(r.quote_check.grounded + r.quote_check.repaired).toBe(1);
  });

  test('punctuation and elision marks at a quote\'s edges are the writer\'s: the words still ground', () => {
    const tolerant = [groundSource('evidence', 'Alice Example said we will move to annual billing in March. Bob Example asked about seats.', { tolerant: true })];
    const r = groundAnswerQuotes('She called it "move to annual billing," then "…Bob Example asked about seats." and "annual billing in M…".', tolerant);
    expect(r.quote_check).toEqual({ grounded: 3, repaired: 0, unverified: 0 });
    expect(r.answer).toContain('"move to annual billing,"');
    const fabricated = groundAnswerQuotes('She said "we will move to quarterly billing."', tolerant);
    expect(fabricated.quote_check.unverified).toBe(1);
  });

  test('markdown link syntax in the evidence does not hide the quoted words; repairs carry no link targets', () => {
    const linked = [groundSource('evidence', '[Elena](people/elena-example) said the [Meridian](companies/meridian-example) deal is moving faster than expected.', { tolerant: true })];
    const r = groundAnswerQuotes('Elena: "the Meridian deal is moving faster than expected" and "Elena said the meridian deal".', linked);
    expect(r.quote_check.unverified).toBe(0);
    expect(r.answer).not.toContain('](');
  });

  test('link display text kept as [Name] without its target grounds against the linked source', () => {
    const linked = [groundSource('evidence', '[Elena Example](people/elena-example) said the [Meridian](companies/meridian-example) deal is moving faster than expected.', { tolerant: true })];
    const r = groundAnswerQuotes('Notes: "[Elena Example] said the [Meridian] deal is moving faster than expected".', linked);
    expect(r.quote_check).toEqual({ grounded: 1, repaired: 0, unverified: 0 });
    expect(r.answer).toContain('"[Elena Example] said the [Meridian] deal is moving faster than expected"');
  });

  test("the source's inner double quotes written as single quotes inside a quotation still ground, and repairs never carry a double quote", () => {
    const quoted = [groundSource('evidence', 'Bob Example wrote that the plan is "ship it by Friday" and moved on.', { tolerant: true })];
    const r = groundAnswerQuotes('He wrote "the plan is \'ship it by Friday\' and moved on".', quoted);
    expect(r.quote_check).toEqual({ grounded: 1, repaired: 0, unverified: 0 });
    const repaired = groundAnswerQuotes('He wrote "The Plan is \'ship it by Friday\'".', quoted);
    expect(repaired.quote_check.unverified).toBe(0);
    expect(repaired.answer).toBe('He wrote "the plan is \'ship it by Friday\'".');
  });

  test('editorial brackets inside or at the end of a word ground: [T]he, decide[s], want[ed]', () => {
    const src = [groundSource('evidence', 'Carol Example said the board will decide the budget once we want clarity on hiring.', { tolerant: true })];
    const r = groundAnswerQuotes('She said "[T]he board will decide the budget", that it "decide[s] the budget once we want[ed] clarity on hiring".', src);
    expect(r.quote_check).toEqual({ grounded: 2, repaired: 0, unverified: 0 });
    expect(r.answer).toContain('"decide[s] the budget once we want[ed] clarity on hiring"');
    expect(groundAnswerQuotes('She said "the board will decide[s] the payroll".', src).quote_check.unverified).toBe(1);
  });

  test('the tolerance is opt-in coverage only: a default source (dream synthesis) grounds as before', () => {
    const text = 'She said "the Meridian deal," twice.';
    const evidence = 'Elena said the [Meridian](companies/meridian-example) deal is moving faster than expected.';
    expect(groundAnswerQuotes(text, [groundSource('evidence', evidence)]).quote_check.unverified).toBe(1);
    expect(groundAnswerQuotes(text, [groundSource('evidence', evidence, { tolerant: true })]).quote_check.unverified).toBe(0);
  });

  test('quotes-only mode never flags computed numbers; full mode does', () => {
    const body = 'Revenue grew 75 percent across 3 quarters.';
    expect(verifyBody(body, sources, { checks: 'quotes' }).quarantined).toEqual([]);
    expect(verifyBody(body, sources).quarantined.length).toBeGreaterThan(0);
  });
});

describe('think and saved syntheses', () => {
  test('the live answer is safe; answer_raw keeps what the model wrote', async () => {
    const r = await runThink(engine, {
      question: 'annual billing pricing review',
      client: stub('Per the review, Alice said "we will move to annual billing in March" and later "we will triple prices". Revenue grew 52 percent.'),
    });
    expect(r.quote_check).toEqual({ grounded: 1, repaired: 0, unverified: 1 });
    expect(r.answer).toContain(`we will triple prices ${UNVERIFIED_QUOTE_MARK}`);
    expect(r.answer_raw).toContain('"we will triple prices"');
    expect(r.warnings).toContain('QUOTE_NOT_IN_EVIDENCE');
    expect(r.answer).toContain('52 percent');
  });

  test("a quote of the user's own question counts as supported", async () => {
    const question = 'did we agree to move pricing to annual billing for enterprise seats';
    const r = await runThink(engine, { question, client: stub(`You asked "did we agree to move pricing to annual billing for enterprise seats": yes, Alice said "we will move to annual billing in March".`) });
    expect(r.quote_check).toEqual({ grounded: 2, repaired: 0, unverified: 0 });
  });

  test('a saved synthesis keeps the failing claim out of its body', async () => {
    const r = await runThink(engine, {
      question: 'annual billing decision',
      client: stub('Alice said "we will move to annual billing in March".\n\nShe also promised "free upgrades for everyone".'),
    });
    const saved = await persistSynthesis(engine, r);
    const page = await engine.getPage(saved.slug);
    expect(page!.compiled_truth).toContain('annual billing in March');
    expect(page!.compiled_truth).not.toContain('free upgrades for everyone');
    const claims = page!.frontmatter.unverified_claims as Array<{ text: string; reason: string }>;
    expect(claims.map(c => c.reason)).toEqual(['quote_not_in_source']);
    expect(claims[0]!.text).toContain('free upgrades for everyone');
  });

  test('on by default; think.quote_verify false leaves the answer as written', async () => {
    await engine.unsetConfig('think.quote_verify');
    try {
      const on = await runThink(engine, { question: 'annual billing', client: stub('She said "we will triple prices".') });
      expect(on.quote_check).toEqual({ grounded: 0, repaired: 0, unverified: 1 });
      await engine.setConfig('think.quote_verify', 'false');
      const off = await runThink(engine, { question: 'annual billing', client: stub('She said "we will triple prices".') });
      expect(off.answer).toBe('She said "we will triple prices".');
      expect(off.quote_check).toBeUndefined();
    } finally {
      await engine.setConfig('think.quote_verify', 'true');
    }
  });
});
