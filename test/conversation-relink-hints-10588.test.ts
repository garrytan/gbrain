/**
 * #10588: the free conversation relink uses the page's authored links as hints.
 * A first name that is ambiguous across the source names one participant among the page's linked people.
 * Regression: facts extracted before the page had links staying unlinked after the links were added.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { runConversationRelink } from '../src/core/facts/conversation-relink.ts';

const config = { engine: 'pglite', embedding_disabled: true } as unknown as GBrainConfig;
const CHAT = 'conversations/2026-08-12-direct';
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('an unlinked first-name fact links to the participant the page links', async () => {
  const put = (slug: string, type: string, title: string, body: string) =>
    engine.putPage(slug, { type: type as never, title, compiled_truth: body, timeline: '', frontmatter: {} });
  await put(CHAT, 'conversation', 'Direct chat', 'Alex and Sam talked.');
  await put('people/alex-one', 'person', 'Alex One', '# Alex One');
  await put('people/alex-two', 'person', 'Alex Two', '# Alex Two');
  await put('people/sam-example', 'person', 'Sam Example', '# Sam Example');
  await engine.addLink(CHAT, 'people/alex-one', '', 'participant', 'manual');
  await engine.addLink(CHAT, 'people/sam-example', '', 'participant', 'manual');
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, source, context, row_num, source_markdown_slug, created_at, valid_from)
     VALUES ('default', NULL, 'Alex prefers morning calls', 'cli:extract-conversation-facts', 'from chat', 0, $1, now(), now())`, [CHAT]);
  const report = await runConversationRelink(engine, config, { sourceId: 'default', slugs: [CHAT] });
  const rows = await engine.executeRaw<{ entity_slug: string | null }>(
    `SELECT entity_slug FROM facts WHERE source_markdown_slug = $1`, [CHAT]);
  expect({ linked: report.linked, entity: rows[0]?.entity_slug }).toEqual({ linked: 1, entity: 'people/alex-one' });
});
