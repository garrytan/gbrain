/**
 * #6898 follow-up (wave 19 L3, item 5): the conversation entity hints never
 * name a retired alias page.
 *
 * Protects: a hinted page the #6898 resolver treats as retired
 * (retiredPageSql: `canonical: false`, a `superseded_by`/`merged_into`
 * target, or an alias/redirect `status`) is replaced by the live page its
 * redirect names, in its place and once; a retired page whose redirect
 * cannot be followed drops out; the canonical page's own type and privacy
 * decide whether it is hinted.
 * Regression: the hint query read only `deleted_at` and the page type, so a
 * meeting that linked the retired copy `root/people/alice-example` (type
 * concept, title "People Alice Example") sent that slug to the extractor,
 * and the extractor named the retired page instead of `people/alice-example`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { conversationEntityHints } from '../src/core/facts/conversation-entity-hints.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const MEETING = 'meetings/2026-08-12-alice-sync';
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

const RETIRED = { status: 'historical-retired-alias', canonical: false, superseded_by: 'people/alice-example' };

beforeEach(async () => {
  await resetPgliteState(engine);
  const page = (slug: string, type: string, title: string, frontmatter: Record<string, unknown> = {}) =>
    engine.putPage(slug, { type: type as never, title, compiled_truth: `# ${title}`, timeline: '', frontmatter });
  await page(MEETING, 'meeting', 'Alice sync', { date: '2026-08-12' });
  await page('people/alice-example', 'person', 'Aliceexample', { canonical: true, aliases: ['alice-example', 'Alice'] });
  await page('root/people/alice-example', 'concept', 'People Alice Example', RETIRED);
  await page('people/beta-example', 'person', 'Beta Example');
  await page('root/people/beta-example', 'concept', 'People Beta Example', { status: 'redirect' });
  await page('people/secret-example', 'person', 'Secret Example', { visibility: 'private' });
  await page('root/people/secret-example', 'concept', 'People Secret Example', { canonical: false, superseded_by: '[[people/secret-example|Secret]]' });
});

test('a linked retired alias page hints its canonical page instead', async () => {
  await engine.addLink(MEETING, 'root/people/alice-example', '', 'mentions', 'wikilink-resolved');
  await engine.addLink(MEETING, 'people/beta-example', '', 'mentions', 'markdown');
  expect(await conversationEntityHints(engine, 'default', MEETING, 'private')).toEqual(['people/alice-example', 'people/beta-example']);
});

test('the canonical page is hinted once when the meeting links it and its retired copy', async () => {
  await engine.addLink('people/alice-example', MEETING, '', 'attended', 'frontmatter', MEETING, 'attendees');
  await engine.addLink(MEETING, 'root/people/alice-example', '', 'mentions', 'markdown');
  expect(await conversationEntityHints(engine, 'default', MEETING, 'private')).toEqual(['people/alice-example']);
});

test('a retired page without a followable target drops out', async () => {
  await engine.addLink(MEETING, 'root/people/beta-example', '', 'mentions', 'markdown');
  expect(await conversationEntityHints(engine, 'default', MEETING, 'private')).toEqual([]);
});

test('the canonical page keeps its own privacy: a private target is hinted into private facts only', async () => {
  await engine.addLink(MEETING, 'root/people/secret-example', '', 'mentions', 'markdown');
  expect(await conversationEntityHints(engine, 'default', MEETING, 'private')).toEqual(['people/secret-example']);
  expect(await conversationEntityHints(engine, 'default', MEETING, 'world')).toEqual([]);
});
