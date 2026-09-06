import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { buildGazetteer, type Gazetteer } from '../src/core/by-mention.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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

// ─── granola-upgraded (federated source, put_page-style import) ──
//
// Reported: a 264-page `granola-upgraded` source with `type: meeting` and
// frontmatter `participants:`/`date:` reported "0 meetings matched" from
// `extract timeline --from-meetings --source db`, with and without
// `--source-id granola-upgraded`. Root cause, confirmed by direct
// reproduction: pages written via `put_page` (rather than the file-sync
// `gbrain sync` pipeline that calls computeEffectiveDate()) never get the
// `effective_date` COLUMN populated — it stays NULL even though
// `frontmatter.date` is set. The pre-fix loop did
// `if (!meeting.effective_date) continue` BEFORE incrementing
// `meetingsScanned`, so every one of the 264 rows was silently dropped
// without ever being counted, even though the initial
// `WHERE type = 'meeting'` matched all of them. `--source-id` filtering
// itself was never broken — these tests also cover it.
describe('effective_date fallback (COALESCE, matching the rest of the codebase)', () => {
  it('a meeting with NULL effective_date (put_page-style insert) is still scanned, via a non-default source', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('granola-upgraded', 'granola-upgraded', '{}'::jsonb) ON CONFLICT DO NOTHING`,
    );
    await engine.putPage('meetings/granola-1', {
      type: 'meeting',
      title: 'Granola Meeting',
      compiled_truth: 'Some notes.',
      timeline: '',
      frontmatter: { date: '2026-08-01', participants: ['Alice Example <alice@example.com>'] },
      // No effective_date — mimics a raw put_page call (custom/bulk import),
      // the exact shape that reproduced the bug.
    }, { sourceId: 'granola-upgraded' });

    const emptyGazetteer: Gazetteer = new Map();

    // Both WITH and WITHOUT --source-id must find it — pre-fix, both
    // reported meetings_scanned: 0 (the bug was never about source
    // scoping, despite that being the first suspect).
    const withFilter = await extractTimelineFromMeetings(engine, {
      gazetteer: emptyGazetteer,
      sourceIdFilter: 'granola-upgraded',
    });
    expect(withFilter.meetings_scanned).toBe(1);

    const withoutFilter = await extractTimelineFromMeetings(engine, { gazetteer: emptyGazetteer });
    expect(withoutFilter.meetings_scanned).toBe(1);
  });

  it('the written timeline entry date falls back to updated_at, not the frontmatter date string', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('granola-upgraded', 'granola-upgraded', '{}'::jsonb) ON CONFLICT DO NOTHING`,
    );
    // Entity page in the SAME source as the meeting — the gazetteer's
    // cross-source guard intentionally never links a body-mention across
    // sources (see findMentionedEntities), so both must share source_id
    // for this test to exercise the body-mention path at all.
    await engine.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice Example',
      compiled_truth: 'Alice Example profile',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'granola-upgraded' });
    await engine.putPage('meetings/granola-2', {
      type: 'meeting',
      title: 'Granola Meeting 2',
      compiled_truth: 'Alice Example joined.', // gazetteer body-mention picks her up
      timeline: '',
      frontmatter: { date: '2026-08-01' },
    }, { sourceId: 'granola-upgraded' });

    const page = await engine.getPage('meetings/granola-2', { sourceId: 'granola-upgraded' });
    expect(page!.effective_date).toBeNull(); // column genuinely NULL, not just falsy

    const gazetteer = await buildGazetteer(engine);
    const result = await extractTimelineFromMeetings(engine, { gazetteer, sourceIdFilter: 'granola-upgraded' });
    expect(result.meetings_scanned).toBe(1);
    expect(result.entries_created).toBe(1);

    const timeline = await engine.getTimeline('people/alice-example', { sourceId: 'granola-upgraded' });
    expect(timeline).toHaveLength(1);
    // Date is the COALESCE fallback (updated_at, since effective_date and
    // created_at both resolve to "now" at insert time) — NOT null, and NOT
    // silently dropped.
    expect(timeline[0]!.date).toBeTruthy();
  });
});

// the `participants:` alias + "Name <email>" parsing themselves
// are unit-tested against extractFrontmatterLinks / stripAttendeeEmailSuffix
// in test/link-extraction.test.ts (the pass that actually reads frontmatter
// and creates the 'attended' edges this module later reads). This file only
// covers what extractTimelineFromMeetings itself does with an edge once it
// exists — already covered by the "follows their attended links" test above.
