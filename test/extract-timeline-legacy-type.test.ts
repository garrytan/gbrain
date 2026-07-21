// #2109 — gbrain-base-v2's unify-types retypes meeting pages to `note`
// with frontmatter.legacy_type='meeting'. extract-timeline-from-meetings
// used to hardcode type='meeting' and silently scan 0 meetings on migrated
// brains. These tests fail without the legacy_type fallback in both SQL
// sites (meeting walk + attended-edge join).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function insertPage(opts: {
  slug: string;
  type: string;
  title: string;
  effectiveDate?: string;
  legacyType?: string;
}): Promise<number> {
  const frontmatterLiteral = opts.legacyType
    ? `'{"legacy_type": "${opts.legacyType}"}'::jsonb`
    : `'{}'::jsonb`;
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, effective_date, frontmatter)
     VALUES ($1, 'default', $2, $3, '', '', $4, ${frontmatterLiteral})
     RETURNING id`,
    [opts.slug, opts.type, opts.title, opts.effectiveDate ?? null],
  );
  return rows[0]!.id;
}

describe('extractTimelineFromMeetings — legacy_type fallback (#2109)', () => {
  it('scans pages retyped to note with legacy_type=meeting and walks their attended edges', async () => {
    const meetingId = await insertPage({
      slug: 'meetings/2026-01-05',
      type: 'note', // post-unify-types shape on a gbrain-base-v2 brain
      legacyType: 'meeting',
      title: 'Weekly sync',
      effectiveDate: '2026-01-05',
    });
    const personId = await insertPage({
      slug: 'people/alice-example',
      type: 'person',
      title: 'Alice Example',
    });
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'attended')`,
      [meetingId, personId],
    );

    const result = await extractTimelineFromMeetings(engine);
    expect(result.meetings_scanned).toBe(1);
    expect(result.entries_created).toBe(1);
    expect(result.entities_touched).toBe(1);
    expect(result.batch_errors).toBe(0);
  });

  it('still scans pre-unify pages with type=meeting (v1 behavior preserved)', async () => {
    const meetingId = await insertPage({
      slug: 'meetings/2026-02-01',
      type: 'meeting',
      title: 'Board prep',
      effectiveDate: '2026-02-01',
    });
    const personId = await insertPage({
      slug: 'people/charlie-example',
      type: 'person',
      title: 'Charlie Example',
    });
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'attended')`,
      [meetingId, personId],
    );

    const result = await extractTimelineFromMeetings(engine);
    expect(result.meetings_scanned).toBe(1);
    expect(result.entries_created).toBe(1);
  });

  it('does not scan unrelated note pages without legacy_type=meeting', async () => {
    await insertPage({
      slug: 'notes/random',
      type: 'note',
      title: 'Random note',
      effectiveDate: '2026-03-01',
    });
    const result = await extractTimelineFromMeetings(engine);
    expect(result.meetings_scanned).toBe(0);
    expect(result.entries_created).toBe(0);
  });
});
