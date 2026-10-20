/**
 * #6966: `extract timeline --from-meetings` must not write "Discussed in ..." rows
 * for a retained calendar invite that has not happened yet. The first valid
 * declared end, else start, else the meeting date decides; the meeting page is
 * left as it is and a later run admits the rows once the meeting has ended.
 * Real engines, no module mocks; dates are far apart so the wall clock never sits
 * on a boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState, resetPgliteStateNarrow } from './helpers/reset-pglite.ts';
import { testBackends } from './helpers/test-backends.ts';

const person = 'people/alice-example';
const meeting = 'meetings/acme-example-sync';
const PAST = '2000-01-01T00:00:00Z';
const FUTURE = '2999-01-01T00:00:00Z';

for (const kind of testBackends()) describe(`meeting timeline waits for future invites (${kind})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 240_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); });
  beforeEach(async () => {
    if (engine instanceof PGLiteEngine) await resetPgliteState(engine);
    else await resetPgliteStateNarrow(engine, ['sources', 'config']);
  });

  async function seedMeeting(frontmatter: Record<string, unknown>, effectiveDate: Date) {
    await engine.putPage(person, { type: 'person', title: 'Alice Example', compiled_truth: 'Profile.', timeline: '', frontmatter: {} });
    await engine.putPage(meeting, { type: 'meeting', title: 'Acme example sync', compiled_truth: 'Agenda.', timeline: '',
      frontmatter, effective_date: effectiveDate });
    await engine.addLinksBatch([{ from_slug: person, to_slug: meeting, link_type: 'attended', link_source: 'manual' }]);
  }
  const rows = async () => (await engine.executeRaw<{ summary: string }>(
    `SELECT t.summary FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1`, [person])).map(r => r.summary);
  const extract = () => extractTimelineFromMeetings(engine, { gazetteer: new Map() });

  test.each([
    ['future end', { start: PAST, end: FUTURE }, PAST, 0],
    ['future start, no end', { start: FUTURE }, PAST, 0],
    ['unparseable end falls back to a future start', { start: FUTURE, end: 'soon' }, PAST, 0],
    ['future meeting date, no start or end', {}, FUTURE, 0],
    ['ended meeting', { start: PAST, end: PAST }, PAST, 1],
    ['a past end wins over a later start', { start: FUTURE, end: PAST }, PAST, 1],
    ['ended with a timezone offset', { start: '2000-01-01T09:00:00+08:00', end: '2000-01-01T10:00:00+08:00' }, PAST, 1],
    ['unparseable start and end keep the past meeting date', { start: 'tbd', end: false }, PAST, 1],
  ] as const)('%s', async (_label, frontmatter, date, expected) => {
    await seedMeeting({ ...frontmatter }, new Date(date));
    const result = await extract();
    expect(result).toMatchObject({ entries_created: expected, meetings_scanned: expected, batch_errors: 0 });
    expect(await rows()).toEqual(expected ? ['Discussed in Acme example sync'] : []);
  });

  test('a deferred invite keeps its page and is admitted by a later run once it has ended', async () => {
    await seedMeeting({ start: PAST, end: FUTURE }, new Date(PAST));
    expect((await extract()).entries_created).toBe(0);
    const page = await engine.getPage(meeting);
    expect(page?.frontmatter).toMatchObject({ start: PAST, end: FUTURE });
    await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"end": "${PAST}"}'::jsonb WHERE slug = $1`, [meeting]);
    expect((await extract()).entries_created).toBe(1);
    expect(await rows()).toEqual(['Discussed in Acme example sync']);
  });
});
