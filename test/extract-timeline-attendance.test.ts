import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { prepareAutomaticLinks } from '../src/core/persistence/links-preparation.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState, resetPgliteStateNarrow } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const person = 'people/alice-example';
const meeting = 'meetings/planning';

for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])]) {
  describe(`meeting timeline attendance roles (${kind})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
      }
    }, 240_000);

    afterAll(async () => {
      if (close) await close();
      else await engine.disconnect();
    });

    beforeEach(async () => {
      if (engine instanceof PGLiteEngine) await resetPgliteState(engine);
      else await resetPgliteStateNarrow(engine, ['sources', 'config']);
      await engine.executeRaw("INSERT INTO sources(id, name) VALUES ('team-b', 'Team B')");
    });

    async function seed(slug: string, type: string, sourceId = 'default', frontmatter: Record<string, unknown> = {}) {
      await engine.putPage(slug, {
        type, title: slug === meeting ? 'Planning' : slug,
        compiled_truth: 'No entity names in this discussion.', timeline: '', frontmatter,
        effective_date: new Date('2026-04-20T00:00:00Z'),
      }, { sourceId });
    }

    async function attended(direction: string, meetingSource = 'default', personSource = 'default', target = person) {
      const canonical = direction === 'canonical';
      await engine.addLinksBatch([{
        from_slug: canonical ? target : meeting,
        from_source_id: canonical ? personSource : meetingSource,
        to_slug: canonical ? meeting : target,
        to_source_id: canonical ? meetingSource : personSource,
        link_type: 'attended', link_source: 'manual',
      }]);
    }

    const extract = (sourceIdFilter?: string) => extractTimelineFromMeetings(engine, {
      gazetteer: new Map(), sourceIdFilter,
    });

    test.each([
      ['gbrain-base-v2', person, meeting],
      ['gbrain-base', meeting, person],
    ])('%s qualified evidence reaches the attendee timeline', async (pack, from, to) => {
      await engine.setConfig('schema_pack', pack);
      await seed(person, 'person');
      const page = {
        type: 'meeting', title: 'Planning', compiled_truth: 'Attendees: [[people/alice-example]]',
        timeline: '', frontmatter: {}, effective_date: new Date('2026-04-20T00:00:00Z'),
      };
      await engine.putPage(meeting, page);
      const prepared = await prepareAutomaticLinks(engine, meeting, page, 'default');
      await engine.transaction(async tx => {
        await tx.lockPageKeys(prepared.pageKeys);
        return prepared.apply(tx);
      });
      expect(await engine.executeRaw(`SELECT f.slug AS from_slug, t.slug AS to_slug FROM links l
        JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE l.link_type='attended'`)).toEqual([{ from_slug: from, to_slug: to }]);
      expect(await extract()).toMatchObject({ entries_created: 1, entities_touched: 1, batch_errors: 0 });
      expect(await engine.getTimeline(person, { sourceId: 'default' })).toHaveLength(1);
      expect(await engine.getTimeline(meeting, { sourceId: 'default' })).toHaveLength(0);
    });

    test.each(['canonical', 'outgoing'])('%s roles preserve legacy notes, source gates, and duplicate-slug isolation', async direction => {
      for (const source of ['default', 'team-b']) {
        await seed(person, 'person', source);
        await seed(meeting, 'note', source, { legacy_type: 'meeting' });
      }
      await attended(direction, 'team-b', 'default');
      const off = await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: undefined }, () => extract('team-b'));
      expect(off).toMatchObject({ meetings_scanned: 1, entries_created: 0 });
      expect(await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '1' }, () => extract('default')))
        .toMatchObject({ meetings_scanned: 1, entries_created: 0 });
      expect(await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '1' }, () => extract('team-b')))
        .toMatchObject({ meetings_scanned: 1, entries_created: 1, entities_touched: 1 });
      expect(await engine.getTimeline(person, { sourceId: 'default' })).toHaveLength(1);
      expect(await engine.getTimeline(person, { sourceId: 'team-b' })).toHaveLength(0);
    });

    test.each(['canonical', 'outgoing'])('%s private meetings do not fan out', async direction => {
      await seed(person, 'person');
      await seed(meeting, 'meeting', 'default', { visibility: 'private' });
      await attended(direction);
      expect(await extract()).toMatchObject({ meetings_scanned: 0, entries_created: 0 });
      expect(await engine.getTimeline(person, { sourceId: 'default' })).toHaveLength(0);
    });

    test('both orientations deduplicate with frontmatter dates and repeated extraction', async () => {
      await seed(person, 'person');
      await seed(meeting, 'note', 'default', { legacy_type: 'meeting', date: '2026-03-12' });
      await engine.executeRaw('UPDATE pages SET effective_date=NULL WHERE slug=$1', [meeting]);
      await attended('canonical');
      await attended('outgoing');
      expect(await extract()).toMatchObject({ meetings_scanned: 1, entries_created: 1, entities_touched: 1 });
      expect(await extract()).toMatchObject({ entries_created: 0 });
      expect(await engine.executeRaw('SELECT date::text AS date, source, summary FROM timeline_entries')).toEqual([{
        date: '2026-03-12', source: `extract-timeline-from-meetings:${meeting}`, summary: 'Discussed in Planning',
      }]);
    });

    test.each(['canonical', 'outgoing'])('%s attendance respects since and refuses import-only dates', async direction => {
      await seed(person, 'person');
      await seed(meeting, 'meeting');
      await attended(direction);
      await engine.executeRaw("UPDATE pages SET updated_at='2026-04-20T00:00:00Z' WHERE slug=$1", [meeting]);
      expect(await extractTimelineFromMeetings(engine, { gazetteer: new Map(), since: '2026-04-20T00:00:00Z' }))
        .toMatchObject({ meetings_scanned: 0, entries_created: 0 });
      await engine.executeRaw('UPDATE pages SET effective_date=NULL WHERE slug=$1', [meeting]);
      expect(await extract()).toMatchObject({ meetings_scanned: 0, entries_created: 0 });
      expect(await engine.getTimeline(person, { sourceId: 'default' })).toHaveLength(0);
    });

    test.each(['canonical', 'outgoing'])('%s edges require a person attendee and a live typed meeting', async direction => {
      await seed(person, 'person');
      await seed(meeting, 'meeting');
      for (const type of ['note', 'company', 'meeting']) {
        const slug = `entities/${type}-example`;
        await seed(slug, type);
        await attended(direction, 'default', 'default', slug);
      }
      expect(await extract()).toMatchObject({ entries_created: 0 });
      await attended(direction);
      await engine.executeRaw('UPDATE pages SET deleted_at=NOW() WHERE slug=$1', [person]);
      expect(await extract()).toMatchObject({ entries_created: 0 });
      await engine.executeRaw('UPDATE pages SET deleted_at=NULL WHERE slug=$1', [person]);
      await engine.executeRaw("UPDATE pages SET type='note' WHERE slug=$1", [meeting]);
      expect(await extract()).toMatchObject({ entries_created: 0 });
      await engine.executeRaw("UPDATE pages SET type='meeting', deleted_at=NOW() WHERE slug=$1", [meeting]);
      expect(await extract()).toMatchObject({ entries_created: 0 });
    });
  });
}
