/**
 * effective_date is a calendar fact, not a property of the syncing machine.
 *
 *  - Date-only values ("2024-03-15", "2024/03/15", "March 5, 2024") are UTC
 *    calendar dates, and a naive datetime ("2024-03-15 10:00") is read as UTC,
 *    so every host stores the same instant whatever its TZ.
 *  - Calendar-invalid dates ("2024-02-30", including an unquoted YAML value)
 *    are rejected instead of rolling over to March 1.
 *  - An undated page no longer takes the import time: `created` frontmatter
 *    keys are content dates, a new file falls back to its own timestamp, and
 *    a later edit keeps the page's fallback date instead of moving it.
 *
 * Pure functions plus one PGLite import ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { computeEffectiveDate, parseDateLoose } from '../src/core/effective-date.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { withEnv } from './helpers/with-env.ts';

const iso = (value: unknown) => parseDateLoose(value)?.toISOString() ?? null;

describe('parseDateLoose is host-timezone independent', () => {
  const cases: Array<[string, string]> = [
    ['March 5, 2024', '2024-03-05T00:00:00.000Z'],
    ['5 March 2024', '2024-03-05T00:00:00.000Z'],
    ['2024/03/15', '2024-03-15T00:00:00.000Z'],
    ['2024-03-15', '2024-03-15T00:00:00.000Z'],
    ['2024-03-15 10:00', '2024-03-15T10:00:00.000Z'],
    ['2024-03-15T10:00:00', '2024-03-15T10:00:00.000Z'],
    ['2024-03-15T10:00:00+09:00', '2024-03-15T01:00:00.000Z'],
  ];
  for (const tz of ['Asia/Tokyo', 'America/Los_Angeles', 'UTC']) {
    test(`TZ=${tz}`, async () => {
      await withEnv({ TZ: tz }, async () => {
        for (const [input, expected] of cases) expect([input, iso(input)]).toEqual([input, expected]);
      });
    });
  }

  test('calendar-invalid dates are rejected, not rolled over', () => {
    for (const input of ['2024-02-30', '2023-02-29', '2024/13/01', 'February 30, 2024', '2024-04-31 09:00']) {
      expect([input, iso(input)]).toEqual([input, null]);
    }
    expect(iso('2024-02-29')).toBe('2024-02-29T00:00:00.000Z');
  });

  test('an unquoted invalid YAML date is not rolled over by the frontmatter parser', () => {
    const parsed = parseMarkdown('---\ntitle: x\ndate: 2024-02-30\n---\nbody\n', 'notes/x.md');
    expect(iso(parsed.frontmatter.date)).toBeNull();
    const valid = parseMarkdown('---\ntitle: x\ndate: 2024-02-29\n---\nbody\n', 'notes/x.md');
    expect(iso(valid.frontmatter.date)).toBe('2024-02-29T00:00:00.000Z');
  });

  test('an invalid filename date falls through the chain', () => {
    const r = computeEffectiveDate({
      slug: 'daily/2024-02-30', frontmatter: {}, filename: '2024-02-30',
      updatedAt: new Date('2025-01-02T00:00:00Z'), createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    expect(r.source).toBe('fallback');
  });
});

describe('undated pages', () => {
  test('created frontmatter keys are content dates', () => {
    for (const key of ['created', 'created_at', 'date_created', 'date created']) {
      const r = computeEffectiveDate({
        slug: 'notes/x', frontmatter: { [key]: '2019-06-01' }, filename: 'x',
        updatedAt: new Date('2025-01-02T00:00:00Z'), createdAt: new Date('2025-01-01T00:00:00Z'),
      });
      expect([key, r.source, r.date?.toISOString()]).toEqual([key, 'created', '2019-06-01T00:00:00.000Z']);
    }
  });

  test('the fallback prefers the stable creation anchor over the last write', () => {
    const r = computeEffectiveDate({
      slug: 'notes/x', frontmatter: {}, filename: 'x',
      updatedAt: new Date('2025-01-02T00:00:00Z'), createdAt: new Date('2019-01-01T00:00:00Z'),
    });
    expect(r).toEqual({ date: new Date('2019-01-01T00:00:00Z'), source: 'fallback' });
  });

  describe('import', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }, 60_000);
    afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

    test('a new undated file takes its own timestamp and keeps it across edits', async () => {
      const root = mkdtempSync(join(tmpdir(), 'undated-'));
      const file = join(root, 'old-note.md');
      writeFileSync(file, '---\ntitle: Old note\n---\n\nWritten long ago.\n');
      const written = new Date('2016-05-04T12:00:00Z');
      utimesSync(file, written, written);
      await importFromFile(engine, file, 'old-note.md', { noEmbed: true });
      const read = async () => (await engine.executeRaw<{ effective_date: string; effective_date_source: string }>(
        `SELECT effective_date, effective_date_source FROM pages WHERE slug = 'old-note'`))[0];
      const first = await read();
      expect(new Date(first.effective_date).toISOString()).toBe(written.toISOString());
      expect(first.effective_date_source).toBe('fallback');

      writeFileSync(file, '---\ntitle: Old note\n---\n\nWritten long ago, edited today.\n');
      await importFromFile(engine, file, 'old-note.md', { noEmbed: true });
      expect(new Date((await read()).effective_date).toISOString()).toBe(written.toISOString());
    });
  });
});
