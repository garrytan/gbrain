/**
 * A11: `brain.timezone` sets the IANA zone offset-less frontmatter datetimes
 * are read in. Unset keeps UTC; date-only values stay UTC calendar dates; the
 * syncing host's TZ never matters.
 *
 * PGLite in-memory ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { computeEffectiveDate } from '../src/core/effective-date.ts';

const at = new Date('2026-01-01T00:00:00Z');
const effective = (frontmatter: Record<string, unknown>, timeZone?: string) =>
  computeEffectiveDate({ slug: 'notes/x', frontmatter, updatedAt: at, createdAt: at, timeZone }).date?.toISOString();

describe('computeEffectiveDate with a brain timezone', () => {
  test('naive datetimes follow the zone, DST included; UTC stays the default', () => {
    expect(effective({ date: '2024-01-15 10:00' })).toBe('2024-01-15T10:00:00.000Z');
    expect(effective({ date: '2024-01-15 10:00' }, 'America/New_York')).toBe('2024-01-15T15:00:00.000Z');
    expect(effective({ date: '2024-07-15 10:00' }, 'America/New_York')).toBe('2024-07-15T14:00:00.000Z');
    expect(effective({ date: '2024-07-15T10:00:00+02:00' }, 'America/New_York')).toBe('2024-07-15T08:00:00.000Z');
    expect(effective({ date: '2024-07-15' }, 'Asia/Tokyo')).toBe('2024-07-15T00:00:00.000Z');
    expect(effective({ date: '2024-07-15 10:00' }, 'Not/AZone')).toBe('2024-07-15T10:00:00.000Z');
  });

  test('the host TZ does not change the result', () => {
    const script = `import { computeEffectiveDate } from '${process.cwd()}/src/core/effective-date.ts';
      const at = new Date('2026-01-01T00:00:00Z');
      console.log(['2024-03-05 23:30', 'March 5, 2024', '2024/03/15'].map(date =>
        computeEffectiveDate({ slug: 'notes/x', frontmatter: { date }, updatedAt: at, createdAt: at, timeZone: 'Europe/Berlin' }).date?.toISOString()).join(','));`;
    const run = (TZ: string) => spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' }).stdout.trim();
    const tokyo = run('Asia/Tokyo');
    expect(tokyo).toBe('2024-03-05T22:30:00.000Z,2024-03-05T00:00:00.000Z,2024-03-15T00:00:00.000Z');
    expect(run('America/Los_Angeles')).toBe(tokyo);
  });
});

describe('import reads brain.timezone', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); }, 30_000);

  const stored = async (slug: string) => (await engine.executeRaw<{ d: string }>(
    `SELECT to_char(effective_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') d FROM pages WHERE slug = $1`, [slug]))[0].d;

  test('a YAML datetime without an offset is read in the brain zone', async () => {
    const page = (n: number) => `---\ntype: note\ntitle: Meeting ${n}\ndate: 2024-01-15T10:00:00\n---\nNotes ${n}.\n`;
    await importFromContent(engine, 'notes/utc', page(1), { noEmbed: true });
    expect(await stored('notes/utc')).toBe('2024-01-15T10:00');
    await engine.setConfig('brain.timezone', 'America/New_York');
    await importFromContent(engine, 'notes/zoned', page(2), { noEmbed: true });
    expect(await stored('notes/zoned')).toBe('2024-01-15T15:00');
  });
});
