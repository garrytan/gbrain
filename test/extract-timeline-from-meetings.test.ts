import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { buildGazetteer, type Gazetteer } from '../src/core/by-mention.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240_000); // cold PGLite init can exceed 60s on a loaded CI/dev machine

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
  opts: { title: string; legacyType?: string; body?: string; sourceId?: string },
): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: opts.title,
    compiled_truth: opts.body ?? 'Meeting discussion notes.',
    timeline: '',
    frontmatter: opts.legacyType ? { legacy_type: opts.legacyType } : {},
    effective_date: new Date('2026-04-20T00:00:00.000Z'),
  }, opts.sourceId ? { sourceId: opts.sourceId } : undefined);
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

  it('follows body mentions of an entity in another source only under link_resolution.cross_source', async () => {
    // Entity lives in 'default'; the meeting lives in 'team-b' and names the
    // entity in its body (no attended link). Same shape as a multi-source brain
    // whose entity dictionary sits in one source and meeting notes in another.
    await seedEntity('people/alice-example', 'Alice Example');
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('team-b', 'Team B') ON CONFLICT (id) DO NOTHING`, []);
    await seedNote('meetings/partner-sync', {
      title: 'Partner Sync',
      legacyType: 'meeting',
      body: 'Alice Example presented the roadmap.',
      sourceId: 'team-b',
    });

    const off = await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: undefined }, () =>
      extractTimelineFromMeetings(engine, { dryRun: true }));
    expect(off).toMatchObject({ meetings_scanned: 1, entries_created: 0, entities_touched: 0 });

    const on = await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '1' }, () =>
      extractTimelineFromMeetings(engine));
    expect(on).toMatchObject({ meetings_scanned: 1, entries_created: 1, entities_touched: 1, batch_errors: 0 });
    const timeline = await engine.getTimeline('people/alice-example', { sourceId: 'default' });
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      source: 'extract-timeline-from-meetings:meetings/partner-sync',
      summary: 'Discussed in Partner Sync',
    });
  });
});

// ─── #4542 — CLI surface: a zero-meeting run must WARN, not mimic success ──
//
// `gbrain extract timeline --from-meetings --source db` on a brain with no
// meeting-typed pages printed "0 entries on 0 entity pages from 0 meetings"
// and exited 0 — indistinguishable from a healthy no-op. Worse,
// --from-meetings REPLACES the default timeline pass (extract.ts runs it
// solo), so users expecting "meetings AND the usual pass" silently got
// NEITHER. The CLI now warns on stderr, names the meeting predicate, and
// points at omitting the flag.
describe('#4542 zero-meetings warning at the CLI surface', () => {
  async function runExtractCapturingStderr(args: string[]): Promise<string[]> {
    const { runExtract } = await import('../src/commands/extract.ts');
    const lines: string[] = [];
    const savedError = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      await runExtract(engine, args);
    } finally {
      console.error = savedError;
    }
    return lines;
  }

  it('warns on stderr with the predicate + omit hint when 0 meetings matched', async () => {
    const stderrLines = await runExtractCapturingStderr(['timeline', '--from-meetings', '--source', 'db']);
    const joined = stderrLines.join('\n');
    expect(joined).toContain("type = 'meeting'");
    expect(joined).toContain('omit --from-meetings');
    expect(joined.toLowerCase()).toContain('replaces');
  });

  it('stays quiet when meetings exist', async () => {
    await engine.putPage('meetings/2026-04-20-sync', {
      type: 'meeting',
      title: 'Weekly Sync',
      compiled_truth: 'Discussed roadmap.',
      timeline: '',
      frontmatter: {},
      effective_date: new Date('2026-04-20T00:00:00.000Z'),
    });
    const stderrLines = await runExtractCapturingStderr(['timeline', '--from-meetings', '--source', 'db']);
    expect(stderrLines.join('\n')).not.toContain('omit --from-meetings');
  });
});

// ─── put_page-written meetings: NULL effective_date column ──
//
// Pages written via `put_page` (agent/MCP or bulk custom import, not the
// file-sync pipeline) never get `effective_date` computed — the column stays
// NULL even when frontmatter carries a parseable `date:`. The extractor used
// to `continue` on those rows BEFORE counting them, so a whole agent-written
// meeting corpus reported "0 meetings matched" with and without --source-id.
// The date must come from the same recipe `gbrain backfill effective_date`
// uses (computeEffectiveDate over frontmatter/filename), NOT from updated_at:
// timeline_entries dedups on (page_id, date, summary, source), so an
// import-timestamp row would survive as a duplicate next to the correctly
// dated one written after a later backfill + re-run.
describe('meetings with NULL effective_date (put_page-style insert)', () => {
  const SRC = 'bulk-import';
  async function seedSource(): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('${SRC}', '${SRC}', '{}'::jsonb) ON CONFLICT DO NOTHING`,
    );
  }

  it('is still scanned, with and without --source-id', async () => {
    await seedSource();
    await engine.putPage('meetings/bulk-1', {
      type: 'meeting',
      title: 'Bulk Meeting',
      compiled_truth: 'Some notes.',
      timeline: '',
      frontmatter: { date: '2026-08-01', attendees: ['Alice Example'] },
      // No effective_date — mimics a raw put_page call.
    }, { sourceId: SRC });

    const emptyGazetteer: Gazetteer = new Map();
    const withFilter = await extractTimelineFromMeetings(engine, {
      gazetteer: emptyGazetteer,
      sourceIdFilter: SRC,
    });
    expect(withFilter.meetings_scanned).toBe(1);

    const withoutFilter = await extractTimelineFromMeetings(engine, { gazetteer: emptyGazetteer });
    expect(withoutFilter.meetings_scanned).toBe(1);
  });

  it('writes the timeline entry with the frontmatter date, not the import timestamp', async () => {
    await seedSource();
    // Entity in the SAME source as the meeting: body mentions never cross
    // sources unless link_resolution.cross_source is on.
    await engine.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice Example',
      compiled_truth: 'Alice Example profile',
      timeline: '',
      frontmatter: {},
    }, { sourceId: SRC });
    await engine.putPage('meetings/bulk-2', {
      type: 'meeting',
      title: 'Bulk Meeting 2',
      compiled_truth: 'Alice Example joined.',
      timeline: '',
      frontmatter: { date: '2026-08-01' },
    }, { sourceId: SRC });

    const page = await engine.getPage('meetings/bulk-2', { sourceId: SRC });
    expect(page!.effective_date).toBeNull(); // column genuinely NULL

    const gazetteer = await buildGazetteer(engine);
    const result = await extractTimelineFromMeetings(engine, { gazetteer, sourceIdFilter: SRC });
    expect(result.meetings_scanned).toBe(1);
    expect(result.entries_created).toBe(1);

    const timeline = await engine.getTimeline('people/alice-example', { sourceId: SRC });
    expect(timeline).toHaveLength(1);
    // Read the calendar day as text: the runtime `date` off PGLite is a JS Date.
    const rows = await engine.executeRaw<{ date: string }>(
      `SELECT date::text AS date FROM timeline_entries WHERE id = $1`, [timeline[0]!.id],
    );
    expect(rows[0]!.date).toBe('2026-08-01');
  });
});

// ─── wave review: attendee cross-source gate, date sources, private meetings ──
describe('wave review — attendee gate, date derivation, private meetings', () => {
  async function seedMeeting(slug: string, frontmatter: Record<string, unknown>, sourceId?: string): Promise<void> {
    await engine.putPage(slug, {
      type: 'meeting',
      title: `Meeting ${slug.split('/').pop()}`,
      compiled_truth: 'Notes.',
      timeline: '',
      frontmatter,
      // No effective_date — a raw put_page row.
    }, sourceId ? { sourceId } : undefined);
  }
  const datesBySource = () => engine.executeRaw<{ date: string; source: string }>(
    `SELECT date::text AS date, source FROM timeline_entries ORDER BY date, source`,
  );

  it('dates a NULL-effective_date meeting from its slug tail or import_filename, like the effective_date backfill', async () => {
    await seedEntity('people/alice-example', 'Alice Example');
    // Slug tail carries the date (the common vault layout: meetings/YYYY-MM-DD-*).
    await seedMeeting('meetings/2026-05-02-standup', {});
    await addAttended('meetings/2026-05-02-standup', 'people/alice-example');
    // Slug has no date; the imported filename does.
    await seedMeeting('meetings/standup-two', {});
    await engine.executeRaw(`UPDATE pages SET import_filename = '2026-05-03-standup-two.md' WHERE slug = 'meetings/standup-two'`);
    await addAttended('meetings/standup-two', 'people/alice-example');

    const result = await extractTimelineFromMeetings(engine, { gazetteer: new Map() });
    expect(result).toMatchObject({ meetings_scanned: 2, entries_created: 2, batch_errors: 0 });
    expect((await datesBySource()).map((r) => [r.date, r.source])).toEqual([
      ['2026-05-02', 'extract-timeline-from-meetings:meetings/2026-05-02-standup'],
      ['2026-05-03', 'extract-timeline-from-meetings:meetings/standup-two'],
    ]);
  });

  it('skips a meeting whose only date is the import timestamp instead of dating it from updated_at', async () => {
    // Nothing in frontmatter, slug, or filename parses as a date. Pre-fix the
    // row was dated from updated_at (today) — a twin that survives dedup next
    // to the correctly dated row a later backfill + re-run writes.
    await seedEntity('people/alice-example', 'Alice Example');
    await seedMeeting('meetings/undated-sync', {});
    await addAttended('meetings/undated-sync', 'people/alice-example');

    const result = await extractTimelineFromMeetings(engine, { gazetteer: new Map() });
    expect(result).toMatchObject({ meetings_scanned: 0, entries_created: 0, entities_touched: 0 });
    expect(await datesBySource()).toEqual([]);
  });

  it('attended edges into another source are gated by link_resolution.cross_source, like body mentions', async () => {
    await seedEntity('people/alice-example', 'Alice Example'); // source 'default'
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('team-b', 'Team B') ON CONFLICT (id) DO NOTHING`, []);
    await seedNote('meetings/board-sync', { title: 'Board Sync', legacyType: 'meeting', sourceId: 'team-b' });
    await engine.addLinksBatch([{
      from_slug: 'meetings/board-sync', to_slug: 'people/alice-example',
      link_type: 'attended', link_source: 'manual',
      from_source_id: 'team-b', to_source_id: 'default',
    }]);

    const off = await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: undefined }, () =>
      extractTimelineFromMeetings(engine, { gazetteer: new Map() }));
    expect(off).toMatchObject({ meetings_scanned: 1, entries_created: 0, entities_touched: 0 });

    const on = await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '1' }, () =>
      extractTimelineFromMeetings(engine, { gazetteer: new Map() }));
    expect(on).toMatchObject({ meetings_scanned: 1, entries_created: 1, entities_touched: 1 });
  });

  it('a visibility: private meeting never lands on another page\'s timeline', async () => {
    // The fan-out row carries the meeting's title + slug + date but no
    // event_page_id (the (event_page_id, date) unique index forbids one per
    // attendee), so the remote private-event filter could never hide it.
    await seedEntity('people/alice-example', 'Alice Example');
    await seedMeeting('meetings/2026-05-04-private-1on1', { visibility: 'private' });
    await addAttended('meetings/2026-05-04-private-1on1', 'people/alice-example');
    await seedMeeting('meetings/2026-05-05-public-sync', {});
    await addAttended('meetings/2026-05-05-public-sync', 'people/alice-example');

    const result = await extractTimelineFromMeetings(engine, { gazetteer: new Map() });
    expect(result).toMatchObject({ meetings_scanned: 1, entries_created: 1, entities_touched: 1 });
    expect((await datesBySource()).map((r) => r.source)).toEqual([
      'extract-timeline-from-meetings:meetings/2026-05-05-public-sync',
    ]);
  });
});
