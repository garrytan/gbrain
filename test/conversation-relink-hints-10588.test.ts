/**
 * #10588: the free conversation relink uses the page's authored links as hints.
 * 1. Protects: a fact extracted before its conversation page had links, naming a person by a first name that is
 *    ambiguous across the source, links to the one participant the page now links, with no model call; a fact that
 *    names two hinted people stays unlinked; a non-person hint is matched only by its full title, so a common first
 *    word such as "The" never names it; a page the relink already tried is picked again once it gains an authored
 *    link, and only once.
 * 2. Fails when: the relink ignores authored links (0 linked), matches a non-person title's first word, or keeps a
 *    tried page out of the default run after its links arrived (the user would have to name every page by hand).
 * 3. Real seams: runConversationRelink on PGLite (unmanaged, maintenance transaction), addLink with link_source manual.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { conversationRelinkPages, runConversationRelink } from '../src/core/facts/conversation-relink.ts';

const config = { engine: 'pglite', embedding_disabled: true } as unknown as GBrainConfig;
const CHAT = 'conversations/2026-08-12-direct';
const FIRST_NAME = 'Alex prefers morning calls';
const THE_WORD = 'Sam said the deadline moved';
const BOTH = 'Alex and Sam both joined late';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const put = (slug: string, type: string, title: string) =>
    engine.putPage(slug, { type: type as never, title, compiled_truth: '# ' + title, timeline: '', frontmatter: {} });
  await put(CHAT, 'conversation', 'Direct chat');
  await put('people/alex-one', 'person', 'Alex One');
  await put('people/alex-two', 'person', 'Alex Two');
  await put('people/sam-example', 'person', 'Sam Example');
  await put('projects/the-maple', 'project', 'The Maple');
  let n = 0;
  for (const fact of [FIRST_NAME, THE_WORD, BOTH]) await engine.executeRaw(
    "INSERT INTO facts (source_id, entity_slug, fact, source, context, row_num, source_markdown_slug, created_at, valid_from) " +
    "VALUES ('default', NULL, $1, 'cli:extract-conversation-facts', 'from chat', $2, $3, now(), now())", [fact, n++, CHAT]);
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

const linked = async () => Object.fromEntries((await engine.executeRaw<{ fact: string; entity_slug: string | null; context: string | null }>(
  'SELECT fact, entity_slug, context FROM facts WHERE source_markdown_slug = $1 ORDER BY row_num', [CHAT])).map(r => [r.fact, r]));

test('facts extracted before the page had links link to the participant its authored links name, on the next default run', async () => {
  const before = await runConversationRelink(engine, config, { sourceId: 'default' });
  expect(before.linked).toBe(0);
  expect(await conversationRelinkPages(engine, 'default')).toEqual([]);

  for (const target of ['people/alex-one', 'people/sam-example', 'projects/the-maple']) await engine.addLink(CHAT, target, '', 'participant', 'manual');
  expect(await conversationRelinkPages(engine, 'default')).toEqual([CHAT]);

  const after = await runConversationRelink(engine, config, { sourceId: 'default' });
  const rows = await linked();
  expect({ linked: after.linked, unresolved: after.unresolved }).toEqual({ linked: 2, unresolved: 1 });
  expect(rows[FIRST_NAME].entity_slug).toBe('people/alex-one');
  expect(rows[FIRST_NAME].context).toContain('entity relinked from page links');
  expect(rows[THE_WORD].entity_slug).toBe('people/sam-example');
  expect(rows[BOTH].entity_slug).toBeNull();
  expect(await conversationRelinkPages(engine, 'default')).toEqual([]);
});
