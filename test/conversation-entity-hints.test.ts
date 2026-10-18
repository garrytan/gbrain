/**
 * #6731: extract-conversation-facts forwards the page's own entities to the
 * extractor as entity hints (slugs only), so a transcript's "Paul" lands on
 * the attendee's page instead of a guess from a first name.
 *
 * Protects: hints come only from edges the page's author wrote (frontmatter
 * attendees with this page as origin, body markdown/wikilinks, manual links),
 * same source, entity pages only; derived mention edges, other meetings and
 * the page itself are left out. A private entity's slug (slugs carry names)
 * is never hinted when the run writes world-visible facts. Both the injected
 * and production extractor branches get the hints, on unmanaged and managed
 * brains, and the extract_facts op prompt keeps its 5-hint cap.
 * Regression: a processPage that passes no hints, or that hints a private
 * entity into world facts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { CONVERSATION_ENTITY_HINTS_CAP, conversationEntityHints } from '../src/core/facts/conversation-entity-hints.ts';
import { ENTITY_HINTS_CAP, extractFactsFromTurnWithOutcome, type ExtractInput } from '../src/core/facts/extract.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const MEETING = 'meetings/2026-08-12-maple-leasing';
const BODY = [
  '**Alice Example** (2026-08-12 10:00 AM): Paul says the Maple is 92% preleased.',
  '**Beta Example** (2026-08-12 10:01 AM): Good, renewals open Monday.',
].join('\n');
const HINTED = ['people/alice-example', 'people/paul-example', 'projects/the-maple'];

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

async function seed(db: BrainEngine): Promise<void> {
  const page = (slug: string, type: string, title: string, body = `# ${title}`, frontmatter: Record<string, unknown> = {}) =>
    db.putPage(slug, { type: type as never, title, compiled_truth: body, timeline: '', frontmatter });
  await page(MEETING, 'meeting', 'Maple Leasing', BODY, { date: '2026-08-12' });
  await page('people/alice-example', 'person', 'Alice Example');
  await page('people/paul-example', 'person', 'Paul Example');
  await page('people/secret-example', 'person', 'Secret Example', '# Secret Example', { visibility: 'private' });
  await page('projects/the-maple', 'project', 'The Maple');
  await page('companies/mentioned-co', 'company', 'Mentioned Co');
  await page('meetings/earlier', 'meeting', 'An earlier call');
  // sync's link extraction: attendees are frontmatter edges into the meeting, with the meeting as origin
  for (const who of ['people/alice-example', 'people/paul-example', 'people/secret-example']) {
    await db.addLink(who, MEETING, '', 'attended', 'frontmatter', MEETING, 'attendees');
  }
  await db.addLink(MEETING, 'projects/the-maple', '', 'mentions', 'markdown');
  await db.addLink(MEETING, 'meetings/earlier', '', 'mentions', 'markdown');
  // an auto-derived mention edge is not the page's own reference
  await db.addLink(MEETING, 'companies/mentioned-co', '', 'mentions', 'mentions');
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try { return await fn(); } finally { spy.mockRestore(); }
}

describe('#6731 conversation pages hint their own entities', () => {
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
    await seed(engine);
  });

  test('attendees first, then linked entity pages; private entities only into private facts', async () => {
    expect(await conversationEntityHints(engine, 'default', MEETING, 'world')).toEqual(HINTED);
    expect(await conversationEntityHints(engine, 'default', MEETING, 'private')).toEqual(
      ['people/alice-example', 'people/paul-example', 'people/secret-example', 'projects/the-maple']);
  });

  test('the injected extractor gets the hints on every segment; world facts never carry a private slug', async () => {
    await engine.setConfig('facts.default_visibility', 'world');
    const inputs: ExtractInput[] = [];
    await quietly(() => runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [MEETING], sleepMs: 0, overrideDisabled: true,
      extractor: async (input) => { inputs.push(input); return []; } }));
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.entityHints).toEqual(HINTED);
      expect(input.entityHintsCap).toBe(CONVERSATION_ENTITY_HINTS_CAP);
    }
  });

  test('the production extractor sends the hints to the model', async () => {
    await engine.setConfig('facts.default_visibility', 'world');
    const seen: string[] = [];
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      seen.push(String(opts.messages.at(-1)?.content ?? ''));
      return { text: JSON.stringify({ facts: [] }), blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    });
    await quietly(() => runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [MEETING], sleepMs: 0, overrideDisabled: true }));
    expect(seen.length).toBeGreaterThan(0);
    for (const prompt of seen) expect(prompt).toContain(`Known entity slugs the user already mentioned: ${HINTED.join(', ')}.`);
  });
});

describe('#6731 the extract_facts prompt keeps its cap', () => {
  test('without a cap the prompt forwards ENTITY_HINTS_CAP hints; a conversation cap forwards more', async () => {
    const seen: string[] = [];
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      seen.push(String(opts.messages.at(-1)?.content ?? ''));
      return { text: JSON.stringify({ facts: [] }), blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    });
    const hints = Array.from({ length: 12 }, (_, i) => `people/p-${i}`);
    await extractFactsFromTurnWithOutcome({ turnText: 'Paul shipped it.', source: 'test', embedding: null, entityHints: hints });
    await extractFactsFromTurnWithOutcome({ turnText: 'Paul shipped it.', source: 'test', embedding: null, entityHints: hints, entityHintsCap: CONVERSATION_ENTITY_HINTS_CAP });
    expect(seen[0]).toContain(`Known entity slugs the user already mentioned: ${hints.slice(0, ENTITY_HINTS_CAP).join(', ')}.`);
    expect(seen[1]).toContain(`Known entity slugs the user already mentioned: ${hints.join(', ')}.`);
  });
});

test('#6731 managed brain: the extractor gets the page hints before the batch publishes', async () => {
  await managedBrain(async ({ engine: db }) => {
    await db.setConfig('facts.extraction_enabled', 'true');
    await db.setConfig('conversation_parser.llm_fallback_enabled', 'false');
    const inputs: ExtractInput[] = [];
    const result = await quietly(() => runExtractConversationFactsCore(db, { sourceId: 'default', slugs: [MEETING], sleepMs: 0, overrideDisabled: true,
      extractor: async (input) => { inputs.push(input); return []; } }));
    expect(result).toMatchObject({ pages_processed: 1, pages_failed: 0 });
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input.entityHints).toEqual(['people/alice-example', 'people/paul-example', 'people/secret-example', 'projects/the-maple']);
  }, { setup: async ({ engine: db }) => { await seed(db); } });
}, 120_000);
