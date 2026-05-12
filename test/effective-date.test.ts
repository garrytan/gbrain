/**
 * v0.29.1 — Tests for computeEffectiveDate (precedence chain + per-prefix
 * override + range validation + parse-failure fall-through).
 *
 * The function is pure (no DB), so these are fast unit tests.
 */

import { describe, test, expect } from 'bun:test';
import { computeEffectiveDate, parseDateLoose } from '../src/core/effective-date.ts';

const baseUpdated = new Date('2026-05-04T12:00:00Z');
const baseCreated = new Date('2026-05-01T12:00:00Z');

function run(opts: {
  slug?: string;
  fm?: Record<string, unknown>;
  filename?: string | null;
  updatedAt?: Date;
  createdAt?: Date;
}) {
  return computeEffectiveDate({
    slug: opts.slug ?? 'wiki/example',
    frontmatter: opts.fm ?? {},
    filename: opts.filename ?? null,
    updatedAt: opts.updatedAt ?? baseUpdated,
    createdAt: opts.createdAt ?? baseCreated,
  });
}

describe('parseDateLoose', () => {
  test('Date instance passthrough', () => {
    const d = new Date('2024-03-15');
    expect(parseDateLoose(d)?.getTime()).toBe(d.getTime());
  });
  test('ISO string parses', () => {
    const d = parseDateLoose('2024-03-15T00:00:00Z');
    expect(d?.toISOString()).toBe('2024-03-15T00:00:00.000Z');
  });
  test('YYYY-MM-DD string parses', () => {
    const d = parseDateLoose('2024-03-15');
    expect(d?.toISOString().startsWith('2024-03-15')).toBe(true);
  });
  test('null/undefined → null', () => {
    expect(parseDateLoose(null)).toBeNull();
    expect(parseDateLoose(undefined)).toBeNull();
  });
  test('invalid Date → null', () => {
    expect(parseDateLoose(new Date('not a date'))).toBeNull();
  });
  test('unparseable string → null', () => {
    expect(parseDateLoose('tomorrow')).toBeNull();
    expect(parseDateLoose('garbage')).toBeNull();
    expect(parseDateLoose('')).toBeNull();
  });
});

describe('computeEffectiveDate precedence chain (default order)', () => {
  test('event_date wins when present', () => {
    const r = run({ fm: { event_date: '2024-03-15', date: '2024-04-01', published: '2024-05-01' } });
    expect(r.source).toBe('event_date');
    expect(r.date?.toISOString().startsWith('2024-03-15')).toBe(true);
  });

  test('date wins when event_date absent', () => {
    const r = run({ fm: { date: '2024-04-01', published: '2024-05-01' } });
    expect(r.source).toBe('date');
    expect(r.date?.toISOString().startsWith('2024-04-01')).toBe(true);
  });

  test('published wins when event_date + date absent', () => {
    const r = run({ fm: { published: '2024-05-01' } });
    expect(r.source).toBe('published');
    expect(r.date?.toISOString().startsWith('2024-05-01')).toBe(true);
  });

  test('filename wins when no frontmatter dates', () => {
    const r = run({ filename: '2024-06-15-some-meeting' });
    expect(r.source).toBe('filename');
    expect(r.date?.toISOString().startsWith('2024-06-15')).toBe(true);
  });

  test('fallback to updated_at when chain exhausted', () => {
    const r = run({});
    expect(r.source).toBe('fallback');
    expect(r.date?.toISOString()).toBe(baseUpdated.toISOString());
  });
});

describe('computeEffectiveDate per-prefix override (daily/, meetings/)', () => {
  test('daily/ filename wins over event_date', () => {
    const r = run({
      slug: 'daily/2024-03-15',
      fm: { event_date: '2024-04-01' },
      filename: '2024-03-15',
    });
    expect(r.source).toBe('filename');
    expect(r.date?.toISOString().startsWith('2024-03-15')).toBe(true);
  });

  test('meetings/ filename wins over date', () => {
    const r = run({
      slug: 'meetings/2024-06-15-acme-call',
      fm: { date: '2024-07-01' },
      filename: '2024-06-15-acme-call',
    });
    expect(r.source).toBe('filename');
    expect(r.date?.toISOString().startsWith('2024-06-15')).toBe(true);
  });

  test('daily/ falls through to event_date when filename has no date', () => {
    const r = run({
      slug: 'daily/notes',
      fm: { event_date: '2024-04-01' },
      filename: 'notes-some-text',
    });
    expect(r.source).toBe('event_date');
    expect(r.date?.toISOString().startsWith('2024-04-01')).toBe(true);
  });

  test('non-prefixed slug uses default precedence (event_date over filename)', () => {
    const r = run({
      slug: 'wiki/people/widget-ceo',
      fm: { event_date: '2024-04-01' },
      filename: '2024-06-15-widget-ceo',
    });
    expect(r.source).toBe('event_date');
    expect(r.date?.toISOString().startsWith('2024-04-01')).toBe(true);
  });
});

describe('computeEffectiveDate parse failure fall-through', () => {
  test('event_date "tomorrow" falls through to date', () => {
    const r = run({ fm: { event_date: 'tomorrow', date: '2024-04-01' } });
    expect(r.source).toBe('date');
    expect(r.date?.toISOString().startsWith('2024-04-01')).toBe(true);
  });

  test('all frontmatter dates unparseable → filename wins', () => {
    const r = run({
      fm: { event_date: 'garbage', date: 'tomorrow', published: 'last week' },
      filename: '2024-06-15-something',
    });
    expect(r.source).toBe('filename');
    expect(r.date?.toISOString().startsWith('2024-06-15')).toBe(true);
  });

  test('filename without date prefix → fallback', () => {
    const r = run({ filename: 'no-date-here' });
    expect(r.source).toBe('fallback');
    expect(r.date?.toISOString()).toBe(baseUpdated.toISOString());
  });
});

describe('computeEffectiveDate range validation [1990, NOW + 1y]', () => {
  test('pre-1990 frontmatter date drops to next chain element', () => {
    const r = run({ fm: { event_date: '1985-01-01', date: '2024-04-01' } });
    expect(r.source).toBe('date');
  });

  test('far-future frontmatter date drops to next chain element', () => {
    // NOW is 2026-05-04 in test fixtures; 2030 is > NOW + 1y
    const r = run({ fm: { event_date: '2030-01-01', date: '2024-04-01' } });
    expect(r.source).toBe('date');
  });

  test('out-of-range filename date drops to fallback', () => {
    const r = run({ filename: '1850-01-01-ancient' });
    expect(r.source).toBe('fallback');
  });
});
