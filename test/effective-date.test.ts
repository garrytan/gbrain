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
  test('chat-export "<time> on <day> <Month>, <year>" parses to the calendar day', () => {
    expect(parseDateLoose('1:56 pm on 8 May, 2023')?.toISOString()).toBe('2023-05-08T00:00:00.000Z');
    expect(parseDateLoose('10:04 am on March 3, 2024')?.toISOString()).toBe('2024-03-03T00:00:00.000Z');
    expect(computeEffectiveDate({ slug: 'chat/x', frontmatter: { date: '1:56 pm on 8 May, 2023' }, updatedAt: new Date(), createdAt: new Date() }).source).toBe('date');
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

  test('fallback to the stable creation anchor, not the last write, when chain exhausted', () => {
    const r = run({});
    expect(r.source).toBe('fallback');
    expect(r.date?.toISOString()).toBe(baseCreated.toISOString());
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
    expect(r.date?.toISOString()).toBe(baseCreated.toISOString());
  });
});

describe('computeEffectiveDate range validation [1990, NOW + 1y]', () => {
  test('placeholder frontmatter date drops to next chain element', () => {
    const r = run({ fm: { event_date: '0001-01-01', date: '2024-04-01' } });
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

// #5742: explicit frontmatter dates accept any year >= 1 (historical works),
// except the epoch-0 and 0001-01-01 placeholders; inferred dates keep 1990.
describe('computeEffectiveDate: explicit historical dates (#5742)', () => {
  test.each([
    ['event_date', '1851-10-18', '1851-10-18T00:00:00.000Z'],
    ['date', '1776-07-04', '1776-07-04T00:00:00.000Z'],
    ['published', 'October 18, 1851', '1851-10-18T00:00:00.000Z'],
    ['created', '1920-05-01', '1920-05-01T00:00:00.000Z'],
    ['event_date', '0044-03-15', '0044-03-15T00:00:00.000Z'],
    ['event_date', '0001-01-02', '0001-01-02T00:00:00.000Z'],
    ['event_date', '1970-01-02', '1970-01-02T00:00:00.000Z'],
  ])('%s: %s is kept', (key, value, iso) => {
    const r = run({ fm: { [key]: value } });
    expect(r.source).toBe(key as never);
    expect(r.date?.toISOString()).toBe(iso);
  });

  test('a YAML-parsed Date before 1990 is kept', () => {
    const r = run({ fm: { event_date: new Date('1851-10-18T00:00:00Z') } });
    expect(r.source).toBe('event_date');
    expect(r.date?.toISOString()).toBe('1851-10-18T00:00:00.000Z');
  });

  test.each([
    ['0001-01-01'],
    ['0001-01-01T00:00:00Z'],
    ['1970-01-01'],
    ['1970-01-01T00:00:00Z'],
    ['0000-06-01'],
  ])('placeholder or year-0 value %s falls through', (value) => {
    const r = run({ fm: { event_date: value, date: '2024-04-01' } });
    expect(r.source).toBe('date');
  });

  test('epoch-0 Date and bare numbers keep the 1990 floor', () => {
    expect(run({ fm: { event_date: new Date(0), date: '2024-04-01' } }).source).toBe('date');
    expect(run({ fm: { event_date: 1851, date: '2024-04-01' } }).source).toBe('date');
  });

  test('filename inference keeps the 1990 floor', () => {
    expect(run({ filename: '1851-10-18-moby-dick' }).source).toBe('fallback');
    expect(run({ slug: 'daily/1985-01-01', filename: '1985-01-01', fm: { date: '1985-01-02' } }).source).toBe('date');
  });

  test('an explicit date still loses to a filename-first prefix date inside the window', () => {
    const r = run({ slug: 'meetings/2024-03-15-sync', filename: '2024-03-15-sync', fm: { event_date: '1851-10-18' } });
    expect(r.source).toBe('filename');
  });
});
