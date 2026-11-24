/**
 * Parity for the chronicle advisor's coverage-gap read (`listChronicleCoverageGapRows`, engine-sql/chronicle-events.ts)
 * and the finding it feeds (advisor/collect-chronicle.ts, `chronicle_coverage_gap`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    the read lists the live meeting, conversation and calendar-event pages updated in the last 30 days that own no
 *    timeline row with an event page, with their type, stored date and frontmatter `date`/`start` text; the advisor's
 *    chronicle collector then reports the same `chronicle_coverage_gap` finding.
 *  - Regression: the collector sent this read as raw SQL inside a catch that ignored every error, so on a Rust brain the
 *    refusal was swallowed and the finding quietly went missing (lane 8's refusal-swallow triage, swap blocker,
 *    collect-chronicle.ts:161). The read is now a typed member, and the catch lets a capability refusal through.
 *  - Why existing coverage misses it: test/chronicle-advisor.test.ts runs PGLite only.
 *  - Seam: none. Real engines; pages are written with putPage, the event projection with restoreEventProjection; dates
 *    are compared as present or absent, never to a clock value.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { collectChronicle } from '../../src/core/advisor/collect-chronicle.ts';

const { parityTest } = parityArms(testBackends());

const page = (type: string, title: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type, title, compiled_truth: `${title} body.`, timeline: '', frontmatter }) as Parameters<BrainEngine['putPage']>[1];

describe('engine parity: the chronicle advisor coverage gap', () => {
  parityTest('listChronicleCoverageGapRows lists recent chronicle-shaped pages with no event projection, and the advisor reports them', {
    methods: ['putPage', 'softDeletePage', 'restoreEventProjection', 'listChronicleCoverageGapRows', 'getConfig'],
  }, async (engine) => {
    await engine.putPage('meetings/standup', page('meeting', 'Standup', { date: '2099-01-02' }));
    await engine.putPage('conversations/chat', page('conversation', 'Chat', { start: '2099-01-03T10:00:00Z' }));
    await engine.putPage('calendar/review', page('calendar-event', 'Review'));
    const covered = await engine.putPage('meetings/covered', page('meeting', 'Covered'));
    const event = await engine.putPage('events/covered-event', page('event', 'Covered event'));
    await engine.restoreEventProjection({ depthPageId: Number(covered.id), date: '2099-01-04', source: 'life-chronicle:event:events/covered-event',
      summary: 'Covered.', detail: '', eventPageId: Number(event.id) });
    await engine.putPage('meetings/gone', page('meeting', 'Gone'));
    await engine.softDeletePage('meetings/gone');
    await engine.putPage('notes/plain', page('note', 'Plain'));
    const rows = (await engine.listChronicleCoverageGapRows())
      .map(r => ({ type: r.type, dated: r.effective_date instanceof Date || r.effective_date === null, fm_date: r.fm_date, fm_start: r.fm_start }))
      .sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : 0);
    const findings = await collectChronicle.collect({ engine, config: {} as never, version: 'test', workspace: null, skillsDir: null,
      now: new Date('2099-01-05T00:00:00Z'), remote: false });
    const gap = findings.find(f => f.id === 'chronicle_coverage_gap');
    // The title lists the types in the order the read returns its rows, which no engine sets (the statement has no
    // ORDER BY), so the parts in parentheses are compared as a set.
    const parts = (title: string) => / \(([^()]*)\)$/.exec(title)?.[1].split(', ').sort() ?? [];
    const out = { rows, gap: gap ? { severity: gap.severity, head: gap.title.replace(/ \(.*\)$/, ''), parts: parts(gap.title) } : null };
    expect(out).toEqual({
      rows: [
        { type: 'calendar-event', dated: true, fm_date: null, fm_start: null },
        { type: 'conversation', dated: true, fm_date: null, fm_start: '2099-01-03T10:00:00Z' },
        { type: 'meeting', dated: true, fm_date: '2099-01-02', fm_start: null },
      ],
      gap: { severity: 'info', head: "3 recent meeting, conversation or calendar page(s) aren't in the timeline yet",
        parts: ['1 calendar-event', '1 conversation', '1 meeting'] },
    });
    return out;
  });
});
