/**
 * GBRA-574: conversation fact slots come from a second, small call after extraction (facts/slot-tagging.ts).
 *
 * Protects: the call reads only facts whose person was named exactly and is a live person page, of a kind that can
 * state a slot; it stores only normalized slots; a failed call keeps the facts without slots and is counted; an
 * exhausted budget stops the run; the --dry-run estimate and the page cap price the call.
 * Seams: gateway chat transport stub (no provider call), PGLite with no git repository.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { CHAT_INPUT_CHARS_PER_TOKEN } from '../../src/core/ai/chat-input-estimate.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';
import { conversationRunEstimate, OUTPUT_TOKENS_PER_SEGMENT } from '../../src/core/facts/conversation-budget.ts';
import { SEGMENT_TEXT_CHAR_LIMIT } from '../../src/core/facts/conversation-windows.ts';
import { buildExtractorSystem, getExtractorVariant } from '../../src/core/facts/extract.ts';
import { SLOT_TAG_INPUT_CHARS, SLOT_TAG_MAX_TOKENS, SLOT_TAG_SYSTEM, tagSlots } from '../../src/core/facts/slot-tagging.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

const ALICE = 'people/alice-example';
const reply = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'test:stub', providerId: 'test',
  usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } }) as ChatResult;
const fact = (text: string, kind: string, entity: string | null) => ({ fact: text, kind, entity_slug: entity });

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('facts.default_visibility', 'world');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  const page = (slug: string, type: string, title: string, frontmatter: Record<string, unknown> = {}) =>
    engine.putPage(slug, { type: type as never, title, compiled_truth: `# ${title}`, timeline: '', frontmatter });
  await page(ALICE, 'person', 'Alice Example');
  await page('people/bob-example', 'person', 'Bob Example', { superseded_by: ALICE });
  await page('companies/acme-example', 'company', 'Acme Example');
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

function stub(answer: (opts: ChatOpts) => ChatResult | Promise<ChatResult>): ChatOpts[] {
  const seen: ChatOpts[] = [];
  __setChatTransportForTests(async opts => { seen.push(opts); return answer(opts); });
  return seen;
}

describe('tagSlots', () => {
  test('makes no call when no fact is an exactly named live person of a slot kind', async () => {
    const seen = stub(() => reply('{"slots":[]}'));
    const rows = [
      fact('Alice Example moved to Lisbon.', 'fact', ALICE),
      fact('Alice Example wants to live in Lisbon.', 'preference', ALICE),
      fact('Acme Example opened an office in Porto.', 'fact', 'companies/acme-example'),
      fact('Bob Example moved to Porto.', 'fact', 'people/bob-example'),
      fact('Someone moved to Porto.', 'fact', null),
    ];
    const out = await tagSlots(engine, 'default', rows, [false, true, true, true, true]);
    expect(out).toEqual({ rows, called: false, failed: false });
    expect(seen).toHaveLength(0);
  });

  test('sends only the candidates and keeps each valid slot once, normalized', async () => {
    const seen = stub(() => reply(JSON.stringify({ slots: [
      { i: 1, dimension: 'location', value: ' Lisbon ' },
      { i: 2, dimension: 'Company', value: 'Acme Example' },
      { i: 2, dimension: 'role', value: 'head of design' },
      { i: 3, dimension: 'location', value: 'Porto' },
      { i: 1.5, dimension: 'role', value: 'x' },
    ] })));
    const rows = [
      fact('Alice Example moved to Lisbon.', 'fact', ALICE),
      fact('Alice Example likes tea.', 'preference', ALICE),
      fact('Alice Example joined Acme Example as head of design.', 'event', ALICE),
    ];
    const out = await tagSlots(engine, 'default', rows, [true, true, true]);
    expect(out.called).toBe(true);
    expect(out.failed).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.system).toBe(SLOT_TAG_SYSTEM);
    expect(seen[0]!.messages).toEqual([{ role: 'user', content:
      '1. [Alice Example] Alice Example moved to Lisbon.\n2. [Alice Example] Alice Example joined Acme Example as head of design.' }]);
    expect(out.rows as unknown[]).toEqual([
      { ...rows[0]!, dimension: 'location', value: 'Lisbon' },
      rows[1]!,
      { ...rows[2]!, dimension: 'employer', value: 'Acme Example' },
    ]);
  });

  test('a reply it cannot read, a truncated reply or a provider error keeps the facts without slots', async () => {
    const rows = [fact('Alice Example moved to Lisbon.', 'fact', ALICE)];
    const answers: Array<() => ChatResult> = [() => reply('not json'), () => reply('{"slots":"none"}'), () => ({ ...reply('{"slots":['), stopReason: 'length' }) as ChatResult,
      () => { throw new Error('provider down'); }];
    for (const answer of answers) {
      stub(answer);
      expect(await tagSlots(engine, 'default', rows, [true])).toEqual({ rows, called: true, failed: true });
    }
  });

  test('makes no call without a chat provider', async () => {
    configureGateway({ env: {} });
    const rows = [fact('Alice Example moved to Lisbon.', 'fact', ALICE)];
    expect(await tagSlots(engine, 'default', rows, [true])).toEqual({ rows, called: false, failed: false });
  });

  test('an exhausted budget stops the run', async () => {
    stub(() => { throw new BudgetExhausted('cap', { reason: 'cost', spent: 1, cap: 1 }); });
    await expect(tagSlots(engine, 'default', [fact('Alice Example moved to Lisbon.', 'fact', ALICE)], [true])).rejects.toBeInstanceOf(BudgetExhausted);
  });
});

describe('through extract-conversation-facts', () => {
  const body = (line: string) => [
    `**user** (2026-03-10 9:00 AM): ${line}`,
    '**assistant** (2026-03-10 9:01 AM): Noted.',
    '**user** (2026-03-10 9:02 AM): I want a quieter desk lamp for the study.',
  ].join('\n');
  const main = (personFact: string) => JSON.stringify({ facts: [
    { fact: personFact, kind: 'event', entity: ALICE, confidence: 1, notability: 'high' },
    { fact: 'Alice moved to Lisbon.', kind: 'fact', entity: 'alice', confidence: 1, notability: 'high' },
    { fact: 'Alice Example works from a studio in Lisbon.', kind: 'fact', entity: 'alice-example', confidence: 1, notability: 'high' },
    { fact: 'User wants a quieter desk lamp for the study.', kind: 'preference', entity: null, confidence: 1, notability: 'high' },
  ] });

  async function run(slug: string, personFact: string, tag: () => ChatResult) {
    await engine.putPage(slug, { type: 'conversation' as never, title: 'Conversation 2026-03-10', compiled_truth: body(personFact),
      timeline: '', frontmatter: { date: '2026-03-10' } });
    const seen = stub(opts => opts.system === SLOT_TAG_SYSTEM ? tag() : reply(main(personFact)));
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    let result;
    try { result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [slug], sleepMs: 0, overrideDisabled: true }); }
    finally { spy.mockRestore(); }
    const rows = await engine.executeRaw<{ fact: string; entity_slug: string | null; dimension: string | null; value: string | null }>(
      'SELECT fact, entity_slug, dimension, value FROM facts WHERE source_markdown_slug = $1 ORDER BY id', [slug]);
    return { seen, result, rows };
  }

  test('the main call stays slot-free; the tagging call sees the person facts named by slug or in full, never a prefix guess; the slot is stored', async () => {
    const { seen, rows, result } = await run('conversations/2026-03-10/slot-tag-ok', 'Alice Example joined Acme Example as head of design.', () => reply('{"slots":[{"i":1,"dimension":"role","value":"head of design"}]}'));
    const main = seen.filter(o => o.system !== SLOT_TAG_SYSTEM);
    const tags = seen.filter(o => o.system === SLOT_TAG_SYSTEM);
    expect(main.length).toBeGreaterThan(0);
    for (const o of main) {
      expect(o.system as string).not.toContain('slot');
      expect(JSON.stringify(o.responseSchema ?? null)).not.toContain('slot');
    }
    expect(tags).toHaveLength(1);
    expect(tags[0]!.messages).toEqual([{ role: 'user', content:
      '1. [Alice Example] Alice Example joined Acme Example as head of design.\n2. [Alice Example] Alice Example works from a studio in Lisbon.' }]);
    expect(rows.filter(r => r.fact.endsWith('Lisbon.')).map(r => [r.fact, r.entity_slug, r.dimension])).toEqual([
      ['Alice moved to Lisbon.', ALICE, null], ['Alice Example works from a studio in Lisbon.', ALICE, null]]);
    expect(rows.filter(r => r.dimension)).toEqual([{ fact: 'Alice Example joined Acme Example as head of design.', entity_slug: ALICE, dimension: 'role', value: 'head of design' }]);
    expect(result.slot_tagging_failed).toBeUndefined();
  });

  test('a failed tagging call keeps the facts, stores no slot and is counted', async () => {
    const { rows, result } = await run('conversations/2026-03-10/slot-tag-fail', 'Alice Example was promoted to design director.', () => reply('not json'));
    expect(rows.map(r => r.fact)).toContain('Alice Example was promoted to design director.');
    expect(rows.every(r => r.dimension === null)).toBe(true);
    expect(result.slot_tagging_failed).toBe(1);
  });
});

test('the --dry-run estimate adds one tagging call per segment at its largest', async () => {
  const e = await conversationRunEstimate(engine, 3);
  const perSegment = Math.ceil((buildExtractorSystem(true, await getExtractorVariant(engine)).length + SEGMENT_TEXT_CHAR_LIMIT) / CHAT_INPUT_CHARS_PER_TOKEN);
  expect(e.input_tokens).toBe(3 * (perSegment + Math.ceil(SLOT_TAG_INPUT_CHARS / CHAT_INPUT_CHARS_PER_TOKEN)));
  expect(e.output_tokens).toBe(3 * (OUTPUT_TOKENS_PER_SEGMENT + SLOT_TAG_MAX_TOKENS));
});
