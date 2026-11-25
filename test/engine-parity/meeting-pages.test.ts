/**
 * BrainEngine parity: the meetings connector's page lookup (`readMeetingPage`, SQL in engine-sql/meeting-pages.ts),
 * which src/core/meetings/meetings-source.ts `existingPath` used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `existingPath(engine, sourceId, meetingId)` names the recorded path of the live page of that source
 *    whose frontmatter `meeting_id` text is the meeting id, the page's slug file when it records no path, the lowest
 *    page id when two pages hold the meeting, and null when no live page of the source holds it (a soft-deleted page, a
 *    page of another source, a different id). A numeric `meeting_id` matches its text. Each case asserts the exact
 *    answer, so one arm alone also checks it.
 *  - Regression: an engine that refuses the lookup as raw SQL (the Rust engine did, so a meetings sync stopped before it
 *    could find a meeting's page), returns a deleted page or another source's page, or picks a page other than the
 *    lowest id, writes a second page for one meeting or loses the meeting's file.
 *  - Why existing coverage misses it: test/meetings-source.test.ts runs the connector on PGLite only.
 *  - Seam: none. The caller's own function over the typed member.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { existingPath } from '../../src/core/meetings/meetings-source.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { createSource, parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const meeting = (title: string, meetingId: unknown, extra: Partial<PageInput> = {}): PageInput =>
  ({ type: 'meeting' as never, title, compiled_truth: `${title} notes`, timeline: '', frontmatter: { meeting_id: meetingId }, ...extra });

describe('engine parity: meeting pages', () => {
  parityTest('existingPath finds the live page of the source that holds the meeting, lowest id first',
    { methods: ['putPage', 'softDeletePage', 'readMeetingPage'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'meet');
      await createSource(engine, backend, 'other');
      await engine.putPage('meetings/2026-01-02-planning', meeting('Planning', 'm-1', { source_path: 'meetings/2026/planning.md' }), { sourceId: 'meet' });
      await engine.putPage('meetings/2026-01-01-planning-copy', meeting('Planning copy', 'm-1'), { sourceId: 'meet' });
      await engine.putPage('meetings/2026-01-03-review', meeting('Review', 'm-2'), { sourceId: 'meet' });
      await engine.putPage('meetings/2026-01-04-gone', meeting('Gone', 'm-3'), { sourceId: 'meet' });
      await engine.softDeletePage('meetings/2026-01-04-gone', { sourceId: 'meet' });
      await engine.putPage('meetings/2026-01-05-elsewhere', meeting('Elsewhere', 'm-4'), { sourceId: 'other' });
      await engine.putPage('meetings/2026-01-06-numbered', meeting('Numbered', 42), { sourceId: 'meet' });

      const result: Record<string, string | null> = {};
      for (const id of ['m-1', 'm-2', 'm-3', 'm-4', '42', 'm-404']) result[id] = await existingPath(engine, 'meet', id);
      result['other:m-4'] = await existingPath(engine, 'other', 'm-4');
      expect(result).toEqual({
        'm-1': 'meetings/2026/planning.md',
        'm-2': 'meetings/2026-01-03-review.md',
        'm-3': null,
        'm-4': null,
        '42': 'meetings/2026-01-06-numbered.md',
        'm-404': null,
        'other:m-4': 'meetings/2026-01-05-elsewhere.md',
      });
      return result;
    });
});
