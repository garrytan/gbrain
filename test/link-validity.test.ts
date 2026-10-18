/**
 * Temporal typed edges — pure relationship-state rules (src/core/link-validity.ts).
 * Pins stint construction, order invariance, statuses, the multirange text
 * form, contradiction date arithmetic and op-param parsing.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildRelationshipState, statusAt, stintsToMultirange, parseMultirange, closeContradiction,
  normalizePartialDate, isCalendarDate, parseDuring, parseTemporalParams, relationSemantics,
  relationshipFilterSql, type AssertionEvidence, type TransitionEvidence,
} from '../src/core/link-validity.ts';

const start = (d: string, origin: number | null = 1): TransitionEvidence => ({ kind: 'start', occurredOn: d, producer: 'timeline', originPageId: origin });
const end = (d: string, origin: number | null = 1): TransitionEvidence => ({ kind: 'end', occurredOn: d, producer: 'timeline', originPageId: origin });
const inferredEnd = (d: string): TransitionEvidence => ({ kind: 'end', occurredOn: d, producer: 'dream', originPageId: 1 });
const present = (origin = 1): AssertionEvidence => ({ tense: 'present', originPageId: origin });
const past = (origin = 1): AssertionEvidence => ({ tense: 'past', originPageId: origin });

describe('relation semantics', () => {
  test('state, event and reference types', () => {
    expect(relationSemantics('works_at')).toBe('state');
    expect(relationSemantics('advises')).toBe('state');
    expect(relationSemantics('invested_in')).toBe('event');
    expect(relationSemantics('founded')).toBe('event');
    expect(relationSemantics('mentions')).toBe('reference');
    expect(relationSemantics('owes_to')).toBe('reference');
    expect(relationSemantics('')).toBe('reference');
    expect(relationSemantics(undefined)).toBe('reference');
  });
});

describe('buildRelationshipState — state relations', () => {
  test('undated present assertion is live forever', () => {
    const s = buildRelationshipState('state', [present()], []);
    expect(s.stints).toEqual([{ from: null, until: null }]);
    expect(statusAt(s, '2026-01-01')).toBe('live');
  });

  test('only past-tense assertions: ended at an unknown date', () => {
    const s = buildRelationshipState('state', [past()], []);
    expect(s.stints).toEqual([]);
    expect(statusAt(s, '2026-01-01')).toBe('ended_unknown_date');
  });

  test('same page present beats past (one assertion row carries present)', () => {
    const s = buildRelationshipState('state', [present(1)], []);
    expect(statusAt(s)).toBe('live');
  });

  test('present and past from different origins with no dates: live but disputed', () => {
    const s = buildRelationshipState('state', [present(1), past(2)], []);
    expect(s.disputed).toBe(true);
    expect(statusAt(s, '2026-01-01')).toBe('disputed');
  });

  test('dated start and end make one closed stint; undated present does not reopen it', () => {
    const s = buildRelationshipState('state', [present()], [start('2021-04-01'), end('2025-03-01')]);
    expect(s.stints).toEqual([{ from: '2021-04-01', until: '2025-03-01' }]);
    expect(s.staleAssertions).toBe(1);
    expect(statusAt(s, '2024-01-01')).toBe('live');
    expect(statusAt(s, '2025-03-01')).toBe('ended');
    expect(statusAt(s, '2020-01-01')).toBe('not_started');
  });

  test('rejoin (A→B→A) keeps two stints', () => {
    const s = buildRelationshipState('state', [present()], [start('2015-01-01'), end('2018-06-01'), start('2021-02-01')]);
    expect(s.stints).toEqual([{ from: '2015-01-01', until: '2018-06-01' }, { from: '2021-02-01', until: null }]);
    expect(statusAt(s, '2019-01-01')).toBe('ended');
    expect(statusAt(s, '2026-01-01')).toBe('live');
  });

  test('a second start while open (promotion) is absorbed', () => {
    const s = buildRelationshipState('state', [], [start('2020-01-01'), start('2022-01-01'), end('2024-01-01')]);
    expect(s.stints).toEqual([{ from: '2020-01-01', until: '2024-01-01' }]);
  });

  test('an end with no start closes an implicit stint; repeated unmatched ends collapse', () => {
    const s = buildRelationshipState('state', [present()], [end('2019-05-01'), end('2020-01-01')]);
    expect(s.stints).toEqual([{ from: null, until: '2019-05-01' }]);
    expect(statusAt(s, '2026-01-01')).toBe('ended');
  });

  test('same-day end then start continues as a new stint (merged when touching)', () => {
    const s = buildRelationshipState('state', [], [start('2020-01-01'), end('2022-01-01'), start('2022-01-01')]);
    expect(s.stints).toEqual([{ from: '2020-01-01', until: null }]);
  });

  test('dated start with only past-tense assertions stays open: only a dated end closes a dated start', () => {
    const s = buildRelationshipState('state', [past()], [start('2021-01-01')]);
    expect(s.stints).toEqual([{ from: '2021-01-01', until: null }]);
    expect(s.firstStart).toBe('2021-01-01');
    expect(statusAt(s, '2026-01-01')).toBe('live');
  });

  test('future end stays live until then', () => {
    const s = buildRelationshipState('state', [present()], [end('2099-01-01')]);
    expect(statusAt(s, '2026-01-01')).toBe('live');
  });

  test('duplicate evidence across producers and origins collapses to one event per (kind, date)', () => {
    const a = buildRelationshipState('state', [], [start('2020-01-01', 1), start('2020-01-01', 2), end('2021-01-01', null)]);
    expect(a.stints).toEqual([{ from: '2020-01-01', until: '2021-01-01' }]);
  });

  test('order invariance: every permutation of the same evidence gives the same state', () => {
    const ev = [start('2015-01-01'), end('2018-06-01', 2), start('2021-02-01', null), end('2018-06-01', 3), start('2015-01-01', 4)];
    const asserts = [present(1), past(2)];
    const baseline = JSON.stringify(buildRelationshipState('state', asserts, ev));
    const perms = (xs: TransitionEvidence[]): TransitionEvidence[][] => xs.length <= 1 ? [xs]
      : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]));
    for (const p of perms(ev)) {
      expect(JSON.stringify(buildRelationshipState('state', [...asserts].reverse(), p))).toBe(baseline);
    }
  });
});

describe('buildRelationshipState — inferred closures are upper bounds (W5)', () => {
  test('a stint closed only by the nightly check ends by that date, an upper bound', () => {
    const s = buildRelationshipState('state', [present()], [start('2019-02-01'), inferredEnd('2025-03-01')]);
    expect(s.stints).toEqual([{ from: '2019-02-01', until: '2025-03-01' }]);
    expect(s).toMatchObject({ lastEnd: '2025-03-01', lastEndUpperBound: true });
  });

  test('an explicit end closes the stint at the gap, earlier than the inferred closure', () => {
    const s = buildRelationshipState('state', [present()], [start('2019-02-01'), end('2024-06-01'), inferredEnd('2025-03-01')]);
    expect(s.stints).toEqual([{ from: '2019-02-01', until: '2024-06-01' }]);
    expect(s).toMatchObject({ lastEnd: '2024-06-01', lastEndUpperBound: false });
  });

  test('an explicit end later than the inferred closure replaces it (the inferred date only bounded it)', () => {
    const s = buildRelationshipState('state', [present()], [start('2019-02-01'), inferredEnd('2025-03-01'), end('2025-06-01')]);
    expect(s.stints).toEqual([{ from: '2019-02-01', until: '2025-06-01' }]);
    expect(s).toMatchObject({ lastEnd: '2025-06-01', lastEndUpperBound: false });
  });

  test('an explicit end of another stint does not override the inferred closure of this one; same-date evidence is exact', () => {
    const s = buildRelationshipState('state', [], [start('2015-01-01'), end('2018-06-01'), start('2021-02-01'), inferredEnd('2025-03-01')]);
    expect(s.stints).toEqual([{ from: '2015-01-01', until: '2018-06-01' }, { from: '2021-02-01', until: '2025-03-01' }]);
    expect(s.lastEndUpperBound).toBe(true);
    expect(buildRelationshipState('state', [], [start('2019-02-01'), inferredEnd('2025-03-01'), end('2025-03-01')]).lastEndUpperBound).toBe(false);
  });

  test('a same-day explicit end and rejoin ends the old stint, so it does not override the new stint\'s inferred closure', () => {
    const s = buildRelationshipState('state', [], [start('2019-02-01'), end('2022-01-01'), start('2022-01-01'), inferredEnd('2025-03-01')]);
    expect(s).toMatchObject({ lastEnd: '2025-03-01', lastEndUpperBound: true });
  });

  test('order invariance holds with inferred and explicit ends mixed', () => {
    const ev = [start('2019-02-01'), inferredEnd('2025-03-01'), end('2025-06-01', 2), start('2026-01-01')];
    const baseline = JSON.stringify(buildRelationshipState('state', [], ev));
    for (const p of [ev, [...ev].reverse(), [ev[2]!, ev[0]!, ev[3]!, ev[1]!]]) expect(JSON.stringify(buildRelationshipState('state', [], p))).toBe(baseline);
  });
});

describe('buildRelationshipState — event relations', () => {
  test('events never end and are invisible before their date', () => {
    const s = buildRelationshipState('event', [present()], [start('2019-03-01'), end('2024-01-01')]);
    expect(s.stints).toEqual([{ from: '2019-03-01', until: null }]);
    expect(statusAt(s, '2018-01-01')).toBe('not_started');
    expect(statusAt(s, '2030-01-01')).toBe('event');
  });
  test('undated events are always visible', () => {
    const s = buildRelationshipState('event', [past()], []);
    expect(statusAt(s, '1990-01-01')).toBe('event');
  });
});

describe('multirange text form', () => {
  test('round trip', () => {
    const stints = [{ from: null, until: '2018-06-01' }, { from: '2021-02-01', until: null }];
    const text = stintsToMultirange(stints);
    expect(text).toBe('{(,2018-06-01),[2021-02-01,)}');
    expect(parseMultirange(text)).toEqual(stints);
    expect(stintsToMultirange([])).toBe('{}');
    expect(parseMultirange('{}')).toEqual([]);
    expect(parseMultirange('{[2021-02-01,2022-01-01)}')).toEqual([{ from: '2021-02-01', until: '2022-01-01' }]);
  });
});

describe('closeContradiction', () => {
  const side = (lastStart: string | null, recordedAt = '2026-01-01T00:00:00Z', until: string | null = null) =>
    ({ lastStart, recordedAt, stints: [{ from: lastStart, until }] });
  test('the relationship that started earlier ends when the other started', () => {
    expect(closeContradiction(side('2020-01-01'), side('2023-05-01'))).toEqual({ action: 'close', side: 'a', closeDate: '2023-05-01', bornClosed: false });
    expect(closeContradiction(side('2023-05-01'), side('2020-01-01'))).toEqual({ action: 'close', side: 'b', closeDate: '2023-05-01', bornClosed: false });
  });
  test('out-of-order arrival: the older one recorded later is born closed', () => {
    const r = closeContradiction(side('2020-01-01', '2026-02-01T00:00:00Z'), side('2023-05-01', '2026-01-01T00:00:00Z'));
    expect(r).toEqual({ action: 'close', side: 'a', closeDate: '2023-05-01', bornClosed: true });
  });
  test('undated side never closes (no page or ingestion dates)', () => {
    expect(closeContradiction(side(null), side('2023-05-01'))).toEqual({ action: 'none', reason: 'undated_unresolved' });
  });
  test('same date is ambiguous; already disjoint is a no-op', () => {
    expect(closeContradiction(side('2023-05-01'), side('2023-05-01'))).toEqual({ action: 'none', reason: 'ambiguous_same_date' });
    expect(closeContradiction(side('2020-01-01', undefined, '2022-01-01'), side('2023-05-01'))).toEqual({ action: 'none', reason: 'already_disjoint' });
  });
});

describe('dates and params', () => {
  test('partial dates normalize; impossible dates are rejected', () => {
    expect(normalizePartialDate('2021')).toEqual({ date: '2021-01-01', precision: 'year' });
    expect(normalizePartialDate('2021-04')).toEqual({ date: '2021-04-01', precision: 'month' });
    expect(normalizePartialDate('2021-04-09')).toEqual({ date: '2021-04-09', precision: 'day' });
    expect(normalizePartialDate('2021-02-30')).toBeNull();
    expect(normalizePartialDate('April 2021')).toBeNull();
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2023-02-29')).toBe(false);
  });
  test('during ranges', () => {
    expect(parseDuring('2022')).toEqual({ from: '2022-01-01', until: '2023-01-01' });
    expect(parseDuring('2022-03')).toEqual({ from: '2022-03-01', until: '2022-04-01' });
    expect(parseDuring('2021..2023-06')).toEqual({ from: '2021-01-01', until: '2023-07-01' });
    expect(parseDuring('2023..2021')).toBeNull();
  });
  test('op params validate', () => {
    expect(parseTemporalParams({ status: 'all', as_of: '2022-01-01' })).toEqual({ ok: true, opts: { status: 'all', asOf: '2022-01-01' } });
    expect(parseTemporalParams({ status: 'former' }).ok).toBe(false);
    expect(parseTemporalParams({ as_of: '2022-13-01' }).ok).toBe(false);
    expect(parseTemporalParams({ during: 'last year' }).ok).toBe(false);
  });
  test('filter SQL inlines only validated dates and is TRUE when off', () => {
    expect(relationshipFilterSql('l', { status: 'all' })).toBe('TRUE');
    expect(relationshipFilterSql('l', { disabled: true })).toBe('TRUE');
    expect(relationshipFilterSql('l', { asOf: '2022-01-01' })).toContain("DATE '2022-01-01'");
    expect(relationshipFilterSql('l', { excludePrivate: true })).toContain("lr.scope = 'world'");
    expect(() => relationshipFilterSql('l', { asOf: "2022-01-01'; DROP TABLE links; --" })).toThrow();
  });
});
