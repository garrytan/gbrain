import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import type { Gazetteer } from '../src/core/by-mention.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedEntity(slug: string, title: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'person',
    title,
    compiled_truth: `${title} profile`,
    timeline: '',
    frontmatter: {},
  });
}

async function seedNote(
  slug: string,
  opts: { title: string; legacyType?: string },
): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: opts.title,
    compiled_truth: 'Meeting discussion notes.',
    timeline: '',
    frontmatter: opts.legacyType ? { legacy_type: opts.legacyType } : {},
    effective_date: new Date('2026-04-20T00:00:00.000Z'),
  });
}

async function addAttended(fromSlug: string, toSlug: string): Promise<void> {
  await engine.addLinksBatch([{
    from_slug: fromSlug,
    to_slug: toSlug,
    link_type: 'attended',
    link_source: 'manual',
  }]);
}

describe('extractTimelineFromMeetings', () => {
  it('scans post-unify legacy meeting notes and follows their attended links', async () => {
    await seedEntity('people/alice-example', 'Alice Example');
    await seedNote('meetings/team-sync', {
      title: 'Team Sync',
      legacyType: 'meeting',
    });
    await addAttended('meetings/team-sync', 'people/alice-example');

    const emptyGazetteer: Gazetteer = new Map();
    const result = await extractTimelineFromMeetings(engine, { gazetteer: emptyGazetteer });

    expect(result).toMatchObject({
      meetings_scanned: 1,
      entries_created: 1,
      entities_touched: 1,
      batch_errors: 0,
    });
    const timeline = await engine.getTimeline('people/alice-example', { sourceId: 'default' });
    expect(timeline).toHaveLength(1);
    expect(new Date(timeline[0]!.date).toISOString().slice(0, 10)).toBe('2026-04-20');
    expect(timeline[0]).toMatchObject({
      source: 'extract-timeline-from-meetings:meetings/team-sync',
      summary: 'Discussed in Team Sync',
    });
  });

  it('does not scan ordinary note pages as meetings', async () => {
    await seedEntity('people/alice-example', 'Alice Example');
    await seedNote('notes/team-sync', { title: 'Team Sync' });
    await addAttended('notes/team-sync', 'people/alice-example');

    const emptyGazetteer: Gazetteer = new Map();
    const result = await extractTimelineFromMeetings(engine, { gazetteer: emptyGazetteer });

    expect(result).toMatchObject({
      meetings_scanned: 0,
      entries_created: 0,
      entities_touched: 0,
      batch_errors: 0,
    });
    const timeline = await engine.getTimeline('people/alice-example', { sourceId: 'default' });
    expect(timeline).toHaveLength(0);
  });
});
