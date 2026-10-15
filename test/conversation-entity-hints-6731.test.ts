/**
 * #6731 — extract-conversation-facts forwards the page's own entities
 * (frontmatter attendees + linked entity pages) to the extractor as hints,
 * and the prompt offers their slugs as the canonical entity output.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { CONVERSATION_ENTITY_HINTS_CAP, conversationEntityHints } from '../src/core/facts/conversation-entity-hints.ts';
import {
  ENTITY_HINTS_CAP,
  extractFactsFromTurnWithOutcome,
  renderEntityHints,
  type ExtractInput,
} from '../src/core/facts/extract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const BODY = [
  '**Alice Example** (2026-08-12 10:00 AM): Paul says the Maple is 92% preleased.',
  '**Beta Example** (2026-08-12 10:01 AM): Good, renewals open Monday.',
].join('\n');

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

async function page(slug: string, type: string, title: string, body = `# ${title}`): Promise<void> {
  await engine.putPage(slug, { type: type as never, title, compiled_truth: body, timeline: '', frontmatter: {} });
}

describe('renderEntityHints', () => {
  test('names a hint by slug and display name, and asks for the slug as the entity', () => {
    const text = renderEntityHints([{ slug: 'people/paul-example', name: 'Paul Example' }, 'companies/acme'], 10);
    expect(text).toContain('people/paul-example (Paul Example), companies/acme');
    expect(text).toContain('set entity to its exact slug');
  });

  test('keeps the extract_facts default cap and honours a larger one', () => {
    const hints = Array.from({ length: 12 }, (_, i) => `people/p-${i}`);
    expect(renderEntityHints(hints)).toContain(`people/p-${ENTITY_HINTS_CAP - 1}.`);
    expect(renderEntityHints(hints)).not.toContain(`people/p-${ENTITY_HINTS_CAP},`);
    expect(renderEntityHints(hints, 12)).toContain('people/p-11.');
  });

  test('no hints renders nothing; a name equal to the slug is not repeated', () => {
    expect(renderEntityHints(undefined)).toBe('');
    expect(renderEntityHints([], 40)).toBe('');
    expect(renderEntityHints([{ slug: 'projects/x', name: 'projects/x' }])).toContain('slug: projects/x.');
  });
});

describe('the extractor prompt carries the hints', () => {
  test('hinted slugs and names reach the model in the user turn', async () => {
    const seen: string[] = [];
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      seen.push(String(opts.messages[0]?.content ?? ''));
      return {
        text: JSON.stringify({ facts: [] }), blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      };
    });
    const outcome = await extractFactsFromTurnWithOutcome({
      turnText: 'Paul says the Maple is 92% preleased.',
      source: 'test',
      embedding: null,
      entityHints: [{ slug: 'people/paul-example', name: 'Paul Example' }, { slug: 'projects/the-maple', name: 'The Maple' }],
      entityHintsCap: CONVERSATION_ENTITY_HINTS_CAP,
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('people/paul-example (Paul Example), projects/the-maple (The Maple)');
  });
});

describe('conversation pages forward their own entities', () => {
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
    await page('meetings/example', 'meeting', 'Maple Leasing', BODY);
    await page('people/alice-example', 'person', 'Alice Example');
    await page('people/paul-example', 'person', 'Paul Example');
    await page('projects/the-maple', 'project', 'The Maple');
    await page('companies/mentioned-co', 'company', 'Mentioned Co');
    await page('meetings/earlier', 'meeting', 'An earlier call');
    // sync's link extraction: attendees are frontmatter edges into the meeting, with the meeting as origin
    await engine.addLink('people/alice-example', 'meetings/example', '', 'attended', 'frontmatter', 'meetings/example', 'attendees');
    await engine.addLink('people/paul-example', 'meetings/example', '', 'attended', 'frontmatter', 'meetings/example', 'attendees');
    // body wikilinks: an entity page and another meeting
    await engine.addLink('meetings/example', 'projects/the-maple', '', 'mentions', 'markdown');
    await engine.addLink('meetings/example', 'meetings/earlier', '', 'mentions', 'markdown');
    // an auto-derived mention edge is not the page's own reference
    await engine.addLink('meetings/example', 'companies/mentioned-co', '', 'mentions', 'mentions');
  });

  test('attendees first, then linked entity pages; meetings, self and derived mentions left out', async () => {
    expect(await conversationEntityHints(engine, 'default', { slug: 'meetings/example' })).toEqual([
      { slug: 'people/alice-example', name: 'Alice Example' },
      { slug: 'people/paul-example', name: 'Paul Example' },
      { slug: 'projects/the-maple', name: 'The Maple' },
    ]);
  });

  test('every segment extraction receives the hints at the conversation cap', async () => {
    const inputs: ExtractInput[] = [];
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'meetings/example',
        types: ['meeting'],
        sleepMs: 0,
        extractor: async (input) => { inputs.push(input); return []; },
      });
    } finally {
      writeSpy.mockRestore();
    }
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.entityHintsCap).toBe(CONVERSATION_ENTITY_HINTS_CAP);
      expect(input.entityHints?.map((h) => (typeof h === 'string' ? h : h.slug))).toEqual([
        'people/alice-example', 'people/paul-example', 'projects/the-maple',
      ]);
    }
  });
});
