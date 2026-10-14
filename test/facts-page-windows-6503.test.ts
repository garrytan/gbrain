/**
 * #6503: page fact extraction reads text past the 8,000-char extractor
 * ceiling as overlapping windows instead of dropping the tail.
 *
 * Protects: a page body (or extract_facts turn text) longer than
 * MAX_TURN_TEXT_CHARS reaches the model in full, one call per window, each
 * call within the ceiling with its part header; a fact only the tail states
 * is stored; the same claim repeated by two windows is stored once; any
 * failed window fails the whole text (no partial "success"); and text within
 * the ceiling is the single historical call with its input untouched.
 * Before the fix the backstop handed the whole body to one call and
 * extract.ts sliced it at 8,000 chars, so the tail assertions fail.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop, runFactsPipeline, windowRepeatVerdict } from '../src/core/facts/backstop.ts';
import { __setChatTransportForTests, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import { FactsExtractionError, MAX_TURN_TEXT_CHARS, type ExtractedFact, type ExtractFactsOutcome, type ExtractInput } from '../src/core/facts/extract.ts';
import {
  extractFactsFromTextWithOutcome, FACT_WINDOW_HEADER_RESERVE, FACT_WINDOW_OP, factWindowText, mergeWindowFacts, planFactWindows,
} from '../src/core/facts/page-windows.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
afterEach(() => { __setChatTransportForTests(null); resetGateway(); __resetFactsQueueForTests(); });

/** ~20,000 chars of paragraphs; only the last paragraph holds TAIL-MARK. */
function longBody(label: string): string {
  const paras = Array.from({ length: 220 }, (_, i) => `${label} paragraph ${i}: the weekly sync covered routine status with nothing decided.`);
  return `${paras.join('\n\n')}\n\nTAIL-MARK ${label}: Dana committed to ship the pricing page by Friday.`;
}

const turnOf = (opts: ChatOpts) => {
  const last = opts.messages[opts.messages.length - 1];
  return /<turn>\n([\s\S]*)\n<\/turn>/.exec(typeof last.content === 'string' ? last.content : '')?.[1] ?? '';
};

function factsReply(facts: Array<{ fact: string; entity?: string | null }>): ChatResult {
  const text = JSON.stringify({ facts: facts.map(f => ({ fact: f.fact, kind: 'fact', entity: f.entity ?? null, confidence: 1, notability: 'high',
    metric: null, value: null, unit: null, period: null })) });
  return { text, blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub', providerId: 'test' };
}

/** Every window states one shared claim; the tail window also states the tail commitment. */
function windowedStub(label: string, onTail?: () => never) {
  const turns: string[] = [];
  __setChatTransportForTests(async (opts: ChatOpts) => {
    const turn = turnOf(opts);
    turns.push(turn);
    if (turn.includes('TAIL-MARK') && onTail) onTail();
    return factsReply([
      { fact: `${label}: the weekly sync is routine` },
      ...(turn.includes('TAIL-MARK') ? [{ fact: `${label}: Dana committed to ship the pricing page by Friday` }] : []),
    ]);
  });
  return turns;
}

const storedFacts = async (like: string) => (await engine.executeRaw<{ fact: string }>(
  'SELECT fact FROM facts WHERE fact LIKE $1 ORDER BY id', [`${like}%`])).map(row => row.fact);

describe('planFactWindows / factWindowText (#6503)', () => {
  test('text within the ceiling is one untouched window', () => {
    const text = 'x'.repeat(MAX_TURN_TEXT_CHARS);
    expect(planFactWindows(text)).toEqual([{ index: 0, count: 1, start: 0, end: text.length, text }]);
  });

  test('longer text: every call (header included) fits the ceiling, the windows cover the text, the header fits its reserve', () => {
    const text = longBody('plan');
    const windows = planFactWindows(text);
    expect(windows.length).toBeGreaterThan(2);
    expect(windows.at(-1)!.end).toBe(text.length);
    for (const w of windows) {
      const sent = factWindowText(w, text.length);
      expect(sent.length).toBeLessThanOrEqual(MAX_TURN_TEXT_CHARS);
      expect(sent.length - w.text.length).toBeLessThanOrEqual(FACT_WINDOW_HEADER_RESERVE);
      expect(sent).toContain(`Part ${w.index + 1} of ${windows.length}`);
    }
    // Paragraph boundaries: each window after the first opens at a line start.
    for (const w of windows.slice(1)) expect(text[w.start - 1]).toBe('\n');
  });
});

describe('extractFactsFromTextWithOutcome (#6503)', () => {
  const fact = (text: string, entity: string | null = null): ExtractedFact =>
    ({ fact: text, kind: 'fact', entity_slug: entity, source: 'test', confidence: 1, notability: 'high' } as ExtractedFact);

  test('within the ceiling: one call with the caller input object itself', async () => {
    const input = { turnText: 'a short turn', source: 'test' } as ExtractInput;
    const seen: ExtractInput[] = [];
    const out = await extractFactsFromTextWithOutcome(input, { extractOne: async i => { seen.push(i); return { ok: true, facts: [fact('one')] }; } });
    expect(seen).toEqual([input]);
    expect(seen[0]).toBe(input);
    expect(out).toEqual({ ok: true, facts: [fact('one')] });
  });

  test('a failed window fails the whole text with its outcome and stops spending', async () => {
    const input = { turnText: longBody('fail'), source: 'test' } as ExtractInput;
    let calls = 0;
    const out = await extractFactsFromTextWithOutcome(input, { extractOne: async (): Promise<ExtractFactsOutcome> => {
      calls++;
      return calls === 2 ? { ok: false, reason: 'malformed_output', model: 'm' } : { ok: true, facts: [fact(`f${calls}`)] };
    } });
    expect(out).toEqual({ ok: false, reason: 'malformed_output', model: 'm' });
    expect(calls).toBe(2);
  });

  test('merge keeps the first of exact repeats (case, spacing, punctuation folded) per entity and asks isRepeat for the rest', async () => {
    const merged = await mergeWindowFacts([
      [fact('Dana ships Friday.', 'people/dana'), fact('Team is small')],
      [fact('dana  ships friday', 'people/dana'), fact('Dana ships Friday', 'people/other'), fact('The team is small')],
    ], async (candidate, kept) => candidate.fact === 'The team is small' && kept.fact === 'Team is small');
    expect(merged.map(f => [f.fact, f.entity_slug])).toEqual([
      ['Dana ships Friday.', 'people/dana'], ['Team is small', null], ['Dana ships Friday', 'people/other'],
    ]);
  });
});

describe('bounded executions resume, merge cost stays bounded (#6503 review)', () => {
  const fact = (text: string, extra: Partial<ExtractedFact> = {}): ExtractedFact =>
    ({ fact: text, kind: 'fact', entity_slug: null, source: 'test', confidence: 1, notability: 'high', ...extra } as ExtractedFact);
  const bankRows = async () => (await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM op_checkpoints WHERE op=$1', [FACT_WINDOW_OP]))[0]!.n;

  test('a run stopped part-way (budget abort) banks its settled windows; the next run continues from there, not window 0', async () => {
    const text = `${longBody('resume')}\n\n${longBody('resume-b')}`;
    const n = planFactWindows(text).length;
    expect(n).toBeGreaterThan(3);
    const input = { turnText: text, source: 'test', engine } as unknown as ExtractInput;
    const partOf = (i: ExtractInput) => Number(/\[Part (\d+) of/.exec(i.turnText)![1]);
    const embedding = new Float32Array([0.25, 0.5, 0.75]);
    const validFrom = new Date('2026-01-02T00:00:00.000Z');
    const reply = (part: number): ExtractFactsOutcome =>
      ({ ok: true, facts: [fact(`resume fact from part ${part}`, part === 1 ? { embedding, valid_from: validFrom } : {})] });

    const firstRun: number[] = [];
    await expect(extractFactsFromTextWithOutcome(input, { bankScope: 'default', extractOne: async i => {
      const part = partOf(i);
      firstRun.push(part);
      if (part === 3) throw new Error('budget exhausted');
      return reply(part);
    } })).rejects.toThrow('budget exhausted');
    expect(firstRun).toEqual([1, 2, 3]);
    expect(await bankRows()).toBe(2);

    const secondRun: number[] = [];
    const out = await extractFactsFromTextWithOutcome(input, { bankScope: 'default', extractOne: async i => {
      const part = partOf(i);
      secondRun.push(part);
      return reply(part);
    } });
    expect(secondRun).toEqual(Array.from({ length: n - 2 }, (_, k) => k + 3));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.facts.map(f => f.fact)).toEqual(Array.from({ length: n }, (_, k) => `resume fact from part ${k + 1}`));
    // A banked fact round-trips its embedding and dates.
    expect(out.facts[0].embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(out.facts[0].embedding!)).toEqual([0.25, 0.5, 0.75]);
    expect(out.facts[0].valid_from).toEqual(validFrom);
    // Every window settled: the bank is cleared.
    expect(await bankRows()).toBe(0);
  });

  test('a banked window is never reused for another scope or changed inputs', async () => {
    const text = longBody('scoped');
    const n = planFactWindows(text).length;
    const base = { turnText: text, source: 'test', engine } as unknown as ExtractInput;
    const stop = async (i: ExtractInput): Promise<ExtractFactsOutcome> => {
      if (i.turnText.startsWith('[Part 2 of')) return { ok: false, reason: 'malformed_output', model: 'm' };
      return { ok: true, facts: [fact('scoped fact')] };
    };
    expect((await extractFactsFromTextWithOutcome(base, { bankScope: 'a', extractOne: stop })).ok).toBe(false);
    let calls = 0;
    const count = async (): Promise<ExtractFactsOutcome> => { calls++; return { ok: true, facts: [] }; };
    await extractFactsFromTextWithOutcome(base, { bankScope: 'b', extractOne: count });
    expect(calls).toBe(n);
    calls = 0;
    await extractFactsFromTextWithOutcome(base, { bankScope: 'a', extractOne: count });
    expect(calls).toBe(n - 1); // same scope and inputs: window 1 reused
    expect((await extractFactsFromTextWithOutcome(base, { bankScope: 'a', extractOne: stop })).ok).toBe(false);
    calls = 0;
    await extractFactsFromTextWithOutcome({ ...base, entityHints: ['people/dana'] }, { bankScope: 'a', extractOne: count });
    expect(calls).toBe(n); // different hints: nothing reused
  });

  test('near-repeat verdicts are asked only against the previous window, not every prior fact', async () => {
    const windows = Array.from({ length: 6 }, (_, w) => Array.from({ length: 4 }, (_, k) => fact(`w${w} distinct claim ${k}`)));
    const asked: Array<[string, string]> = [];
    const merged = await mergeWindowFacts(windows, async (candidate, kept) => { asked.push([candidate.fact, kept.fact]); return false; });
    expect(merged).toHaveLength(24);
    expect(asked).toHaveLength(5 * 4 * 4); // all-prior pairs would be 4*4*(1+2+3+4+5) = 240
    for (const [candidate, kept] of asked) expect(Number(candidate[1]) - Number(kept[1])).toBe(1);
  });

  test('a fact the previous window only restated still counts as that window\'s neighbour', async () => {
    const merged = await mergeWindowFacts([
      [fact('Dana ships Friday')],
      [fact('dana ships friday.')],
      [fact('Dana will ship on Friday')],
    ], async (candidate, kept) => candidate.fact === 'Dana will ship on Friday' && kept.fact === 'Dana ships Friday');
    expect(merged.map(f => f.fact)).toEqual(['Dana ships Friday']);
  });

  test('the production repeat verdict reads the supersession threshold once per text, not once per pair', async () => {
    let reads = 0;
    const fakeEngine = { getConfig: async () => { reads++; return '{"test:model@3": 0.9}'; } };
    const verdict = windowRepeatVerdict({ engine: fakeEngine as never, source: 'mcp:extract_facts' } as never, () => 0.99);
    const emb = (x: number) => new Float32Array([x, 1, 1]);
    const facts = Array.from({ length: 6 }, (_, i) => fact(`claim number ${i} about a different thing`, { embedding: emb(i), embedding_model: 'test:model' }));
    let duplicates = 0;
    for (const a of facts) for (const b of facts) if (a !== b && await verdict(a, b)) duplicates++;
    expect(duplicates).toBe(30);
    expect(reads).toBe(1);
  });
});

describe('fact pipelines read long text in full (#6503)', () => {
  test('page backstop: the tail fact is stored, the shared claim once, every call within the ceiling', async () => {
    const body = longBody('backstop');
    const turns = windowedStub('backstop');
    const r = await runFactsBackstop({ slug: 'meetings/long-weekly-sync', type: 'meeting', compiled_truth: body, frontmatter: {} },
      { engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline' });
    const n = planFactWindows(body).length;
    expect(turns).toHaveLength(n);
    for (const turn of turns) expect(turn.length).toBeLessThanOrEqual(MAX_TURN_TEXT_CHARS);
    expect(turns.at(-1)).toContain('TAIL-MARK');
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.inserted).toBe(2);
    expect(await storedFacts('backstop:')).toEqual(['backstop: the weekly sync is routine', 'backstop: Dana committed to ship the pricing page by Friday']);
  });

  test('extract_facts turn text: same windowing through runFactsPipeline', async () => {
    const turns = windowedStub('pipeline');
    const r = await runFactsPipeline(longBody('pipeline'), { engine, sourceId: 'default', sessionId: 'long-turn', source: 'mcp:extract_facts' });
    expect(turns.length).toBeGreaterThan(2);
    expect(r.inserted).toBe(2);
    expect(await storedFacts('pipeline:')).toContain('pipeline: Dana committed to ship the pricing page by Friday');
  });

  test('a provider error on any window fails the page loudly and stores nothing', async () => {
    windowedStub('throwing', () => { throw new Error('upstream 503'); });
    await expect(runFactsPipeline(longBody('throwing'), { engine, sourceId: 'default', sessionId: 'long-throw', source: 'mcp:extract_facts' }))
      .rejects.toBeInstanceOf(FactsExtractionError);
    expect(await storedFacts('throwing:')).toEqual([]);
  });

  test('text within the ceiling: one call whose turn is the text itself, no part header', async () => {
    const turns = windowedStub('short');
    const text = 'A short note: Dana committed to ship the pricing page by Friday.';
    const r = await runFactsPipeline(text, { engine, sourceId: 'default', sessionId: 'short-turn', source: 'mcp:extract_facts' });
    expect(turns).toEqual([text]);
    expect(r.inserted).toBe(1);
  });
});
