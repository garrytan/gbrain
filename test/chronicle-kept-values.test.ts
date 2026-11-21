/**
 * Chronicle date readers over frontmatter kept as written (pages-03).
 *
 * Protects: a value the old parser typed as a number (`end: 1.10`, `end: 1e308`) is never a meeting time, as before
 * pages-03; a YAML timestamp spelling only YAML reads (`2024-3-1T10:00:00+2`) projects to an ISO `when` the proposal
 * check accepts, as the old Date typing did.
 * Fails when: a numeric end becomes a 1970 instant that bypasses the future-meeting wait or projects an invite, an
 * out-of-range number crashes the cutoff, or a YAML-only timestamp spelling yields a malformed proposal.
 * Existing coverage: chronicle-invite-projection and chronicle-date-quality run quoted ISO dates only.
 * Seams: none; the readers are pure.
 */
import { describe, expect, test } from 'bun:test';
import { isChronicleEligible } from '../src/core/chronicle/eligibility.ts';
import { endedInviteProposal } from '../src/core/chronicle/invite-projection.ts';
import { chronicleEventCutoff, chronicleJudgeContext, isValidProposal } from '../src/core/chronicle/extract-events.ts';
import { keptInstant } from '../src/core/effective-date.ts';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const FUTURE = '2026-11-27T10:00:00Z';
const BODY = 'Alice and Bob reviewed the launch plan and agreed to ship the beta next week. '.repeat(3);

describe('numeric text is never a meeting time', () => {
  test('a future meeting with end: 1.10 still waits', () => {
    const verdict = isChronicleEligible({ type: 'meeting', slug: 'meetings/sync', body: BODY, frontmatter: { start: FUTURE, end: '1.10' } },
      { now: NOW, recentDays: null });
    expect(verdict).toMatchObject({ ok: false, reason: 'not_yet_happened' });
  });

  test('a future invite with end: 1.10 is not projected as ended', () => {
    expect(endedInviteProposal({ slug: 'calendar/sync', type: 'calendar-event', title: 'Sync', frontmatter: { start: FUTURE, end: '1.10' } },
      [], NOW)).toBeNull();
  });

  test('end: 1e308 does not crash the event cutoff', () => {
    const ctx = chronicleJudgeContext({ slug: 'meetings/sync', type: 'meeting', title: 'Sync', compiled_truth: BODY,
      frontmatter: { date: '2026-11-18', end: '1e308' } });
    expect(ctx.pageDates.every(d => Number.isFinite(d.getTime()))).toBe(true);
    expect(chronicleEventCutoff(ctx, 'UTC', NOW)).toBe('2026-11-18');
  });

  test('keptInstant reads timestamps and refuses old-typed numbers', () => {
    expect(keptInstant('2024-03-01T10:00:00+02:00')?.toISOString()).toBe('2024-03-01T08:00:00.000Z');
    expect(keptInstant('2024-03-01')?.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    for (const text of ['1.10', '02134', '1e308', '1e20', '+5', '']) expect(keptInstant(text)).toBeNull();
    expect(keptInstant(1_700_000_000_000)).toBeNull();
    expect(keptInstant(new Date('nope'))).toBeNull();
  });
});

describe('an ended invite projects a valid when', () => {
  test('a YAML-only timestamp spelling becomes ISO', () => {
    const proposal = endedInviteProposal({ slug: 'calendar/sync', type: 'calendar-event', title: 'Sync',
      frontmatter: { start: '2024-3-1T10:00:00+2', end: '2024-3-1T11:00:00+2' } }, [], NOW);
    expect(proposal?.when).toBe('2024-03-01T08:00:00.000Z');
    expect(isValidProposal(proposal)).toBe(true);
  });

  test('a start that is not a YAML timestamp keeps its text', () => {
    const proposal = endedInviteProposal({ slug: 'calendar/sync', type: 'calendar-event', title: 'Sync',
      frontmatter: { start: 'March 1, 2024', end: '2024-03-01T11:00:00Z' } }, [], NOW);
    expect(proposal?.when).toBe('March 1, 2024');
  });
});
