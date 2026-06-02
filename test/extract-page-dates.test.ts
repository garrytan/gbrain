import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  extractTimelineFromPageDates,
  timelineDateFromEffectiveDate,
} from '../src/commands/extract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('extractTimelineFromPageDates', () => {
  test('normalizes timestamptz page dates to the intended UTC calendar date', () => {
    expect(timelineDateFromEffectiveDate('2026-05-31 19:00:00-05')).toBe('2026-06-01');
  });

  test('creates timeline rows from non-fallback effective dates', async () => {
    await engine.putPage('notes/dated', {
      type: 'note',
      title: 'Dated Operating Note',
      compiled_truth: 'body',
      timeline: '',
      frontmatter: {},
      effective_date: new Date('2026-06-01T00:00:00Z'),
      effective_date_source: 'date',
    });

    const result = await extractTimelineFromPageDates(
      engine as unknown as BrainEngine,
      false,
      true,
      undefined,
      undefined,
    );

    expect(result).toEqual({ created: 1, pages: 1 });
    const timeline = await engine.getTimeline('notes/dated');
    expect(timeline).toHaveLength(1);
    expect(new Date(timeline[0].date).toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(timeline[0].source).toBe('page-effective-date:date');
    expect(timeline[0].summary).toBe('Dated Operating Note');
    expect(timeline[0].detail).toContain('Effective date source: date');
  });

  test('ignores fallback effective dates to avoid sync-timestamp timeline noise', async () => {
    await engine.putPage('notes/fallback', {
      type: 'note',
      title: 'Fallback Only',
      compiled_truth: 'body',
      timeline: '',
      frontmatter: {},
      effective_date: new Date('2026-06-01T00:00:00Z'),
      effective_date_source: 'fallback',
    });

    const result = await extractTimelineFromPageDates(
      engine as unknown as BrainEngine,
      false,
      true,
      undefined,
      undefined,
    );

    expect(result).toEqual({ created: 0, pages: 0 });
    expect(await engine.getTimeline('notes/fallback')).toHaveLength(0);
  });
});
