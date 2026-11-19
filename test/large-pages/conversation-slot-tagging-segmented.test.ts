/**
 * GBRA-574: slot tagging on a segmented conversation page (the incremental path, conversation-incremental.ts).
 *
 * Protects: the per-page cap reserves the tagging call with the extraction call, so a cap that fits only the
 * extraction refuses before any call; a failed tagging call leaves its window settled (facts kept without slots, the
 * failure counted, no repeat on the next run); an exhausted budget during tagging stops the run while the windows
 * finished before it stay published.
 * Seams: gateway chat transport stub (no provider call), segmented PGLite brain with no git repository.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import { __setChatTransportForTests, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';
import { getFactsExtractionMaxTokens } from '../../src/core/facts/extract.ts';
import { SLOT_TAG_INPUT_CHARS, SLOT_TAG_MAX_TOKENS, SLOT_TAG_SYSTEM } from '../../src/core/facts/slot-tagging.ts';
import { estimateChatCallUsd, estimateFactsExtractionUsd, PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../src/core/page-spend.ts';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { chatDays, chatPage, derivations, PAID_MODEL, SOURCE } from '../helpers/conversation-facts-incremental-cases.ts';

const ALICE = 'people/alice-example';
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const reply = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end', model: PAID_MODEL, providerId: 'anthropic',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } }) as ChatResult;
const userText = (o: ChatOpts) => String(o.messages[0]?.content ?? '');
/** The main call answers one fact about Alice per window, distinct per window. */
const mainReply = (o: ChatOpts) => reply(JSON.stringify({ facts: [
  { fact: `Alice Example works at Acme Example (note ${sha(userText(o))}).`, kind: 'fact', entity: ALICE, confidence: 1, notability: 'high' }] }));

let brain: AppendBrain;
beforeAll(async () => {
  brain = await openAppendBrain('pglite');
  const { engine } = brain;
  await engine.setConfig(PAGE_EMBED_CAP_KEY, 'off');
  await engine.setConfig(PAGE_DERIVATION_CAP_KEY, 'off');
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('facts.default_visibility', 'world');
  await engine.setConfig('facts.extraction_model', PAID_MODEL);
  await engine.putPage(ALICE, { type: 'person' as never, title: 'Alice Example', compiled_truth: '# Alice Example', timeline: '', frontmatter: {} });
}, 120_000);
afterAll(async () => { await brain.close(); }, 120_000);
afterEach(() => { __setChatTransportForTests(null); });

async function run(slug: string, tag: (o: ChatOpts, n: number) => ChatResult) {
  const seen: ChatOpts[] = [];
  let tags = 0;
  __setChatTransportForTests(async o => { seen.push(o); return o.system === SLOT_TAG_SYSTEM ? tag(o, ++tags) : mainReply(o); });
  const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try { return { seen, result: await runExtractConversationFactsCore(brain.engine, { sourceId: 'default', slugs: [slug], sleepMs: 0 }) }; }
  finally { spy.mockRestore(); }
}
const slotsOf = (slug: string) => brain.engine.executeRaw<{ fact: string; dimension: string | null; value: string | null }>(
  'SELECT fact, dimension, value FROM facts WHERE source_markdown_slug = $1 AND source = $2 AND expired_at IS NULL ORDER BY id', [slug, SOURCE]);

/** Over the inline page size, so the page is stored segmented and extracted window by window. */
const BODY = chatPage('Chat', chatDays(10, 100, 7));

describe('slot tagging on a segmented page', () => {
  let firstWindow = '';

  test('a failed tagging call keeps its window settled: facts without slots, counted, not repeated', async () => {
    const slug = `notes/slot-fail-${randomUUID().slice(0, 8)}`;
    await brain.seed(slug, BODY);
    const { seen, result } = await run(slug, (_o, n) => n === 1 ? reply('not json') : reply('{"slots":[{"i":1,"dimension":"employer","value":"Acme Example"}]}'));
    const main = seen.filter(o => o.system !== SLOT_TAG_SYSTEM);
    firstWindow = userText(main[0]!);
    expect(main.length).toBeGreaterThan(1);
    expect(seen.filter(o => o.system === SLOT_TAG_SYSTEM)).toHaveLength(main.length);
    expect(result.slot_tagging_failed).toBe(1);
    const rows = await slotsOf(slug);
    expect(rows).toHaveLength(main.length);
    expect(rows.filter(r => r.dimension === null)).toHaveLength(1);
    expect(rows.filter(r => r.dimension === 'employer' && r.value === 'Acme Example')).toHaveLength(main.length - 1);
    expect([...new Set((await derivations(brain.engine, slug)).states)]).toEqual(['done']);
    expect((await run(slug, () => reply('{"slots":[]}'))).seen).toHaveLength(0);
  }, 600_000);

  test('the per-page cap reserves the tagging call: a cap that fits only the extraction refuses before any call', async () => {
    const slug = `notes/slot-cap-${randomUUID().slice(0, 8)}`;
    await brain.seed(slug, BODY);
    expect(firstWindow).not.toBe('');
    const extraction = estimateFactsExtractionUsd(PAID_MODEL, firstWindow.length, await getFactsExtractionMaxTokens(brain.engine));
    const tagging = estimateChatCallUsd(PAID_MODEL, SLOT_TAG_INPUT_CHARS, SLOT_TAG_MAX_TOKENS);
    await brain.engine.setConfig(PAGE_DERIVATION_CAP_KEY, String(extraction + tagging / 2));
    try {
      expect((await run(slug, () => reply('{"slots":[]}'))).seen).toHaveLength(0);
    } finally { await brain.engine.setConfig(PAGE_DERIVATION_CAP_KEY, 'off'); }
  }, 600_000);

  test('an exhausted budget during tagging stops the run; windows finished before it stay published', async () => {
    const slug = `notes/slot-budget-${randomUUID().slice(0, 8)}`;
    await brain.seed(slug, chatPage('Chat', chatDays(10, 100, 9)));
    const { result } = await run(slug, (_o, n) => {
      if (n === 2) throw new BudgetExhausted('cap reached', { reason: 'cost', spent: 1, cap: 1 });
      return reply('{"slots":[{"i":1,"dimension":"employer","value":"Acme Example"}]}');
    });
    expect(result.budget_exhausted).toBe(true);
    expect(await slotsOf(slug)).toEqual([{ fact: expect.stringContaining('Alice Example works at Acme Example'), dimension: 'employer', value: 'Acme Example' }]);
  }, 600_000);
});
