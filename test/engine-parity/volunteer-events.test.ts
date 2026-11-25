/**
 * BrainEngine parity — the context-volunteer event members (`insertVolunteerEvents`, `listVolunteerChannels`,
 * `readVolunteerUsage`, `deleteVolunteerEventsOlderThan`, and the purge scrub and receipt check the log shares with
 * `deletePurgedNameStoreRows` and the `context_volunteer_events` store probe of `countPurgeProbe`)
 * that `src/core/context/volunteer-events.ts` and `volunteer.ts` call instead of raw SQL, and the scrubs that remove the rows
 * with their page or source.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the insert writes only the rows whose page exists (a soft-deleted page counts), so a write built before a page
 *    purge drops that page's slug and rationale; the 7-day channel listing counts them per channel in byte order, scoped to
 *    sources or brain-wide; the usage read groups them by arm and channel and counts a page retrieved after the event as
 *    used; the retention delete removes only rows older than its window. A hard delete of a page (deletePages,
 *    purgeDeletedPages) and a source delete remove the rows that name the page or the source and keep every other row;
 *    a soft delete keeps them, because restore_page can bring the page back.
 *  - Regression: the Rust engine kept no volunteer events: the insert was raw SQL that the fire-and-forget logger
 *    swallowed, so push-context telemetry was dropped silently and the channel listing always answered nothing. A store that
 *    keeps the rows must also scrub them, or a purged page's slug and rationale survive on that engine.
 *  - Why existing coverage misses it: test/volunteer-context.test.ts and the purge tests run on PGLite and Postgres only,
 *    and the doctor case in collate-doctor.test.ts seeded the rows with raw SQL.
 *  - Seam: none. Real engines, typed members only; the pages go through putPage and the deletes through the product members.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { insertVolunteerEvents, purgeStaleVolunteerEvents, type VolunteerEventRow } from '../../src/core/context/volunteer-events.ts';
import { volunteerUsageStats } from '../../src/core/context/volunteer.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title} body`, frontmatter: {} });

const event = (sourceId: string, slug: string, channel = 'op', extra: Partial<VolunteerEventRow> = {}): VolunteerEventRow => ({
  source_id: sourceId, slug, confidence: 0.9, match_arm: 'exact', rationale: `matched ${slug}`, channel: channel as VolunteerEventRow['channel'], ...extra,
});

/** How many events still name the slug of the source: the page purge receipt's `context_volunteer_events` store probe. */
const countFor = (engine: BrainEngine, sourceId: string, slug: string): Promise<number> =>
  engine.countPurgeProbe({ kind: 'slug_key', store: 'context_volunteer_events', sourceId, slug }, 10_000);

/** How many events name each (source, slug), as `source:slug=n` lines in byte order. */
async function named(engine: BrainEngine, pairs: ReadonlyArray<readonly [string, string]>): Promise<string[]> {
  const out: string[] = [];
  for (const [sourceId, slug] of pairs) out.push(`${sourceId}:${slug}=${await countFor(engine, sourceId, slug)}`);
  return out;
}

async function seedTwoSources(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, 'alpha', {});
  await createSource(engine, backend, 'beta', {});
  for (const sourceId of ['alpha', 'beta']) {
    await engine.putPage('notes/a', note('A'), { sourceId });
    await engine.putPage('notes/b', note('B'), { sourceId });
  }
  await insertVolunteerEvents(engine, [
    event('alpha', 'notes/a', 'op'), event('alpha', 'notes/b', 'hook'), event('beta', 'notes/a', 'op'), event('beta', 'notes/b', 'hook'),
  ]);
}

const ALL = [['alpha', 'notes/a'], ['alpha', 'notes/b'], ['beta', 'notes/a'], ['beta', 'notes/b']] as const;

describe('engine parity: context-volunteer events', () => {
  parityTest('the insert writes only the rows of pages that exist, and the channel listing and usage read count them', {
    methods: ['putPage', 'softDeletePage', 'insertVolunteerEvents', 'listVolunteerChannels', 'readVolunteerUsage', 'countPurgeProbe'],
  }, async (engine) => {
    await engine.putPage('notes/a', note('A'), { sourceId: 'default' });
    await engine.putPage('notes/soft', note('Soft'), { sourceId: 'default' });
    await engine.softDeletePage('notes/soft', { sourceId: 'default' });
    await insertVolunteerEvents(engine, []);
    await insertVolunteerEvents(engine, [
      event('default', 'notes/a', 'op', { session_id: 's1', turn: 2 }), event('default', 'notes/a', 'hook'), event('default', 'notes/a', 'op'),
      event('default', 'notes/soft', 'op'), event('default', 'notes/gone', 'op'), event('nowhere', 'notes/a', 'op'),
    ]);
    const channels = (rows: Awaited<ReturnType<BrainEngine['listVolunteerChannels']>>) => rows.map(r => `${r.channel}=${Number(r.n)}`);
    const out = {
      counts: await named(engine, [['default', 'notes/a'], ['default', 'notes/soft'], ['default', 'notes/gone'], ['nowhere', 'notes/a']]),
      brainWide: channels(await engine.listVolunteerChannels(null)),
      scoped: channels(await engine.listVolunteerChannels(['default'])),
      elsewhere: channels(await engine.listVolunteerChannels(['nowhere'])),
      fired: (await engine.listVolunteerChannels(null)).every(r => !Number.isNaN(new Date(r.last_fired as string).getTime())),
      usage: (await volunteerUsageStats(engine, ['default'], 30)).by_arm,
      noUsage: (await volunteerUsageStats(engine, ['nowhere'], 30)).by_arm,
    };
    expect(out.counts).toEqual(['default:notes/a=3', 'default:notes/soft=1', 'default:notes/gone=0', 'nowhere:notes/a=0']);
    expect(out.brainWide).toEqual(['hook=1', 'op=3']);
    expect(out.scoped).toEqual(out.brainWide);
    expect(out.elsewhere).toEqual([]);
    expect(out.fired).toBe(true);
    expect(out.usage).toEqual([
      { match_arm: 'exact', channel: 'hook', volunteered: 1, used: 0, precision: 0 },
      { match_arm: 'exact', channel: 'op', volunteered: 3, used: 0, precision: 0 },
    ]);
    expect(out.noUsage).toEqual([]);
    return out;
  });

  parityTest('the retention delete removes only the rows older than its window', {
    methods: ['putPage', 'insertVolunteerEvents', 'deleteVolunteerEventsOlderThan', 'countPurgeProbe'],
  }, async (engine) => {
    await engine.putPage('notes/a', note('A'), { sourceId: 'default' });
    await insertVolunteerEvents(engine, [event('default', 'notes/a'), event('default', 'notes/a', 'hook')]);
    const kept = await purgeStaleVolunteerEvents(engine);
    const afterKept = await countFor(engine, 'default', 'notes/a');
    // A window in the past removes everything volunteered so far.
    const removed = await purgeStaleVolunteerEvents(engine, -1);
    const afterRemoved = await countFor(engine, 'default', 'notes/a');
    const out = { kept, afterKept, removed, afterRemoved };
    expect(out).toEqual({ kept: 0, afterKept: 2, removed: 2, afterRemoved: 0 });
    return out;
  });

  parityTest('deletePages removes the volunteer events of the deleted pages and keeps every other row', {
    methods: ['putPage', 'deletePages', 'insertVolunteerEvents', 'countPurgeProbe'],
  }, async (engine, backend) => {
    await seedTwoSources(engine, backend);
    const before = await named(engine, ALL);
    const deleted = await engine.deletePages(['notes/a'], { sourceId: 'alpha' });
    const after = await named(engine, ALL);
    // A write built before the purge and landing after it does not bring the page's rows back.
    await insertVolunteerEvents(engine, [event('alpha', 'notes/a', 'late')]);
    const late = await named(engine, ALL);
    const out = { before, deleted, after, late };
    expect(out.before).toEqual(['alpha:notes/a=1', 'alpha:notes/b=1', 'beta:notes/a=1', 'beta:notes/b=1']);
    expect(out.after).toEqual(['alpha:notes/a=0', 'alpha:notes/b=1', 'beta:notes/a=1', 'beta:notes/b=1']);
    expect(out.late).toEqual(out.after);
    return out;
  });

  parityTest('a soft delete keeps the volunteer events and purgeDeletedPages removes them with the page', {
    methods: ['putPage', 'softDeletePage', 'restorePage', 'purgeDeletedPages', 'insertVolunteerEvents', 'countPurgeProbe'],
  }, async (engine, backend) => {
    await seedTwoSources(engine, backend);
    await engine.softDeletePage('notes/a', { sourceId: 'alpha' });
    const soft = await named(engine, ALL);
    await engine.restorePage('notes/a', { sourceId: 'alpha' });
    await engine.softDeletePage('notes/a', { sourceId: 'alpha' });
    // purgeDeletedPages(0) takes tombstones strictly older than the statement clock; let the clock move past it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const purged = (await engine.purgeDeletedPages(0)).slugs;
    const after = await named(engine, ALL);
    const out = { soft, purged, after };
    expect(out.soft).toEqual(['alpha:notes/a=1', 'alpha:notes/b=1', 'beta:notes/a=1', 'beta:notes/b=1']);
    expect(out.after).toEqual(['alpha:notes/a=0', 'alpha:notes/b=1', 'beta:notes/a=1', 'beta:notes/b=1']);
    return out;
  });

  parityTest('the purge name-store scrub removes the volunteer rows of those slugs of one source and counts them', {
    methods: ['putPage', 'insertVolunteerEvents', 'transaction', 'deletePurgedNameStoreRows', 'countPurgeProbe'],
  }, async (engine, backend) => {
    await seedTwoSources(engine, backend);
    await insertVolunteerEvents(engine, [event('alpha', 'notes/a', 'again')]);
    const scrub = (slugs: string[]) => engine.transaction(async tx => (await tx.deletePurgedNameStoreRows('alpha', slugs)).context_volunteer_events);
    const none = await scrub([]);
    const removed = await scrub(['notes/a', 'notes/missing']);
    const after = await named(engine, ALL);
    const out = { none, removed, after };
    expect(out).toEqual({ none: 0, removed: 2, after: ['alpha:notes/a=0', 'alpha:notes/b=1', 'beta:notes/a=1', 'beta:notes/b=1'] });
    return out;
  });

  parityTest('a source delete removes the volunteer events of the source and keeps the other source\'s', {
    methods: ['putPage', 'insertVolunteerEvents', 'deleteSourceRecord', 'listVolunteerChannels', 'countPurgeProbe'],
  }, async (engine, backend) => {
    await seedTwoSources(engine, backend);
    const before = await named(engine, ALL);
    const deleted = await engine.deleteSourceRecord('alpha');
    const after = await named(engine, ALL);
    const scoped = (await engine.listVolunteerChannels(['alpha'])).length;
    const kept = (await engine.listVolunteerChannels(['beta'])).map(r => `${r.channel}=${Number(r.n)}`);
    // A source created again under the same id starts with no rows of the old one.
    await createSource(engine, backend, 'alpha', {});
    const reborn = await named(engine, ALL);
    const out = { before, deleted, after, scoped, kept, reborn };
    expect(out.after).toEqual(['alpha:notes/a=0', 'alpha:notes/b=0', 'beta:notes/a=1', 'beta:notes/b=1']);
    expect(out.scoped).toBe(0);
    expect(out.kept).toEqual(['hook=1', 'op=1']);
    expect(out.reborn).toEqual(out.after);
    return out;
  });
});
