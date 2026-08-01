/**
 * #3442 — `query --since` relative durations ('7d', '2w', '1y').
 *
 * The SearchOpts contract (types.ts, since v0.29.1) and the query op's
 * --help both document relative durations, but the raw string ('60d')
 * flowed straight into the engines' `::timestamptz` casts. Every search
 * arm failed fail-open and the date filter was SILENTLY ignored — the
 * command still returned results, so the user could not tell the filter
 * never applied.
 *
 * Fix: resolveDateBoundary at the single hybridSearch seam resolves
 * relative durations to concrete timestamps, lands a plain YYYY-MM-DD
 * `until` at end-of-day (also documented, also never implemented), and
 * throws loudly on unparseable input instead of degrading.
 *
 * Serial: mutates OPENAI_API_KEY to force the keyword-only path.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch, resolveDateBoundary } from '../src/core/search/hybrid.ts';
import type { PageInput } from '../src/core/types.ts';

const DAY_MS = 86400000;

describe('resolveDateBoundary (#3442)', () => {
  test('relative durations resolve to a concrete past timestamp', () => {
    const cases: Array<[string, number]> = [
      ['7d', 7],
      ['60d', 60],
      ['2w', 14],
      ['3m', 90],
      ['1y', 365],
    ];
    for (const [raw, days] of cases) {
      const out = resolveDateBoundary(raw, 'since');
      expect(out).toBeDefined();
      const delta = Date.now() - Date.parse(out!);
      // Within a minute of the expected offset.
      expect(Math.abs(delta - days * DAY_MS)).toBeLessThan(60_000);
    }
  });

  test('ISO dates and timestamps pass through', () => {
    expect(resolveDateBoundary('2026-06-01', 'since')).toBe('2026-06-01');
    expect(resolveDateBoundary('2026-06-01T10:00:00Z', 'since')).toBe('2026-06-01T10:00:00Z');
  });

  test('plain-date `until` lands at end-of-day (documented SearchOpts semantics)', () => {
    expect(resolveDateBoundary('2026-06-01', 'until')).toBe('2026-06-01T23:59:59.999Z');
  });

  test('empty/undefined stay undefined', () => {
    expect(resolveDateBoundary(undefined, 'since')).toBeUndefined();
    expect(resolveDateBoundary('  ', 'since')).toBeUndefined();
  });

  test('unparseable input throws loudly instead of silently degrading', () => {
    expect(() => resolveDateBoundary('sixty days', 'since')).toThrow(/Invalid since value/);
    expect(() => resolveDateBoundary('60x', 'until')).toThrow(/Invalid until value/);
  });
});

describe('hybridSearch since/until end-to-end (#3442)', () => {
  let engine: PGLiteEngine;
  const savedKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    delete process.env.OPENAI_API_KEY; // keyword-only path, no embedding calls
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('notes/widget-old', {
      type: 'note',
      title: 'Widget Old',
      compiled_truth:
        'Widget foundation repair notes from the original crawlspace assessment two years back.',
    });
    await engine.putPage('notes/widget-new', {
      type: 'note',
      title: 'Widget New',
      compiled_truth:
        'Widget foundation repair follow-up: contractor quote for the pier replacement arrived yesterday.',
    });
    // putPage does not chunk; give the keyword arm content to match.
    await engine.upsertChunks('notes/widget-old', [{
      chunk_index: 0,
      chunk_text: 'Widget foundation repair notes from the original crawlspace assessment two years back.',
      chunk_source: 'compiled_truth',
    }]);
    await engine.upsertChunks('notes/widget-new', [{
      chunk_index: 0,
      chunk_text: 'Widget foundation repair follow-up: contractor quote for the pier replacement arrived yesterday.',
      chunk_source: 'compiled_truth',
    }]);
    await engine.executeRaw(
      `UPDATE pages SET effective_date = $1 WHERE slug = 'notes/widget-old'`,
      [new Date(Date.now() - 400 * DAY_MS).toISOString()],
    );
    await engine.executeRaw(
      `UPDATE pages SET effective_date = $1 WHERE slug = 'notes/widget-new'`,
      [new Date(Date.now() - 1 * DAY_MS).toISOString()],
    );
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    await engine.disconnect();
  });

  test('since "60d" filters out old pages (was silently ignored)', async () => {
    const out = await hybridSearch(engine, 'widget repair', { since: '60d' });
    const slugs = out.map((r) => r.slug);
    expect(slugs).toContain('notes/widget-new');
    expect(slugs).not.toContain('notes/widget-old');
  });

  test('until "60d" filters out recent pages', async () => {
    const out = await hybridSearch(engine, 'widget repair', { until: '60d' });
    const slugs = out.map((r) => r.slug);
    expect(slugs).toContain('notes/widget-old');
    expect(slugs).not.toContain('notes/widget-new');
  });

  test('control: no filter returns both', async () => {
    const out = await hybridSearch(engine, 'widget repair', {});
    const slugs = out.map((r) => r.slug);
    expect(slugs).toContain('notes/widget-new');
    expect(slugs).toContain('notes/widget-old');
  });
});
