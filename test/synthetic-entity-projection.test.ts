/** Protect explicit fixture exclusion; existing suites lack marked/genuine pairs.
 * Reverting guards admits fixture evidence. Uses real storage, no new seam. */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { enrichEntity } from '../src/core/enrichment-service.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { runEnrichCore } from '../src/commands/enrich.ts';
import { timelineOperations } from '../src/core/ops/timeline.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
const text = 'Example Person discussed the canary evaluation fixture project.';
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function seed(slug: string, synthetic: unknown, type = 'note') {
  return engine.putPage(slug, {
    title: type === 'person' ? 'Example Person' : 'Project discussion', type,
    compiled_truth: text, timeline: '',
    frontmatter: { synthetic, legacy_type: 'meeting', date: '2026-04-20' },
  });
}

test('fixture ingestion survives but cannot create or update entity evidence', async () => {
  const fixture = await seed('notes/fixture', true);
  const genuine = await seed('notes/genuine', false);
  const request = { entityName: 'Example Person', entityType: 'person' as const,
    context: text, sourceSlug: fixture.slug };
  expect((await enrichEntity(engine, request)).action).toBe('skipped');
  expect(await engine.getPage('people/example-person', { sourceId: 'default' })).toBeNull();
  const created = await enrichEntity(engine, { ...request, sourceSlug: genuine.slug });
  expect(created.action).toBe('created');
  const before = await engine.getPage(created.slug, { sourceId: 'default' });
  const timeline = await engine.getTimeline(created.slug);
  expect((await enrichEntity(engine, request)).action).toBe('skipped');
  expect(await engine.getPage(created.slug, { sourceId: 'default' })).toEqual(before);
  expect(await engine.getTimeline(created.slug)).toEqual(timeline);
  const add = timelineOperations.find(op => op.name === 'add_timeline_entry')!;
  await add.handler({ engine, remote: false, sourceId: 'default' } as unknown as OperationContext,
    { slug: created.slug, source: fixture.slug, date: '2026-04-20', summary: text });
  expect(await engine.getTimeline(created.slug)).toEqual(timeline);
  expect((await engine.getPage(fixture.slug, { sourceId: 'default' }))?.compiled_truth).toBe(text);
});

test('meeting projection excludes only explicitly marked fixtures', async () => {
  await seed('people/attendee-example', false, 'person');
  for (const [suffix, marker] of [['marked', true], ['ordinary', false], ['string', 'true']] as const) {
    await seed(`meetings/${suffix}`, marker);
    await engine.addLinksBatch([{ from_slug: `meetings/${suffix}`, to_slug: 'people/attendee-example',
      link_type: 'attended', link_source: 'manual' }]);
  }
  await extractTimelineFromMeetings(engine, { gazetteer: new Map() });
  const rows = await engine.getTimeline('people/attendee-example');
  expect(rows.map(r => r.source).sort()).toEqual([
    'extract-timeline-from-meetings:meetings/ordinary',
    'extract-timeline-from-meetings:meetings/string',
  ]);
});

test('grounded enrichment skips fixture targets and fixture backlink evidence', async () => {
  await seed('people/marked-example', true, 'person');
  await seed('people/genuine-example', false, 'person');
  await seed('notes/marked-evidence', true);
  for (const slug of ['people/marked-example', 'people/genuine-example']) {
    await engine.addLink('notes/marked-evidence', slug, text.repeat(8));
  }
  const result = await runEnrichCore(engine, { sourceId: 'default', dryRun: true,
    types: ['person'], minContextChars: 1 });
  expect(result.would_enrich ?? 0).toBe(0);
  await seed('notes/ordinary-evidence', false);
  await engine.addLink('notes/ordinary-evidence', 'people/genuine-example', text.repeat(8));
  const genuine = await runEnrichCore(engine, { sourceId: 'default', dryRun: true,
    types: ['person'], minContextChars: 1 });
  expect(genuine.would_enrich).toBe(1);
});
