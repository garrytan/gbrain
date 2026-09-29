/**
 * Fence date cells are lossless: a TTL or a default "now" valid_from is
 * written as a UTC timestamp, while a date-only (UTC midnight) value keeps its
 * `YYYY-MM-DD` cell. Before, both were truncated to the UTC date, so a
 * `remember(ttl: '1h')` fact was already expired once the fence was re-read,
 * and a fact written in the evening west of UTC was stamped with tomorrow.
 *
 * Real PGLite + a real filesystem under a per-test tempdir.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeFactsToFence, type FenceInputFact } from '../src/core/facts/fence-write.ts';
import { formatFenceDate, parseFactsFence } from '../src/core/facts-fence.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'fence-dates-test-'));
  _resetWriteThroughCacheForTest();
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
});

const input = (overrides: Partial<FenceInputFact> = {}): FenceInputFact => ({
  fact: 'Is traveling this week',
  kind: 'fact',
  notability: 'medium',
  source: 'mcp:remember',
  visibility: 'world',
  confidence: 1.0,
  embedding: null,
  sessionId: null,
  ...overrides,
});

const target = { sourceId: 'default', localPath: '', slug: 'people/ttl-example', resolutionSource: 'exact_page' as const };

describe('formatFenceDate', () => {
  test('UTC midnight renders as a date, anything else as a UTC timestamp', () => {
    expect(formatFenceDate(new Date('2026-03-01T00:00:00.000Z'))).toBe('2026-03-01');
    expect(formatFenceDate(new Date('2026-03-01T22:02:52.123Z'))).toBe('2026-03-01T22:02:52Z');
  });
});

describe('fence date round trip', () => {
  test('a short TTL survives the fence and a rebuild still active', async () => {
    const until = new Date(Date.now() + 60_000);
    const result = await writeFactsToFence(engine, { ...target, localPath: brainDir }, [input({ validUntil: until })]);
    expect(result.inserted).toBe(1);

    const file = readFileSync(join(brainDir, 'people/ttl-example.md'), 'utf-8');
    const [row] = parseFactsFence(parseMarkdown(file, 'people/ttl-example.md').compiled_truth).facts;
    expect(new Date(row.validUntil!).getTime()).toBe(Math.floor(until.getTime() / 1000) * 1000);

    const active = await engine.listFactsByEntity('default', 'people/ttl-example', { activeOnly: true });
    expect(active.map(f => f.fact)).toEqual(['Is traveling this week']);

    // Rebuild from the fence: import the file, drop the index, reconcile.
    await importFromContent(engine, 'people/ttl-example', file, { noEmbed: true });
    await engine.executeRaw('DELETE FROM facts');
    await runExtractFacts(engine, { slugs: ['people/ttl-example'] });
    const rebuilt = await engine.listFactsByEntity('default', 'people/ttl-example', { activeOnly: true });
    expect(rebuilt.map(f => new Date(f.valid_until!).getTime())).toEqual([Math.floor(until.getTime() / 1000) * 1000]);
  });

  test('a default valid_from is the write instant, not the UTC date', async () => {
    const before = Date.now();
    await writeFactsToFence(engine, { ...target, localPath: brainDir }, [input()]);
    const file = readFileSync(join(brainDir, 'people/ttl-example.md'), 'utf-8');
    const [row] = parseFactsFence(parseMarkdown(file, 'people/ttl-example.md').compiled_truth).facts;
    const stamped = new Date(row.validFrom!).getTime();
    expect(stamped).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  test('a date-only valid_from keeps its date cell', async () => {
    await writeFactsToFence(engine, { ...target, localPath: brainDir }, [input({ validFrom: new Date(Date.UTC(2017, 0, 1)) })]);
    const file = readFileSync(join(brainDir, 'people/ttl-example.md'), 'utf-8');
    const [row] = parseFactsFence(parseMarkdown(file, 'people/ttl-example.md').compiled_truth).facts;
    expect(row.validFrom).toBe('2017-01-01');
  });
});
