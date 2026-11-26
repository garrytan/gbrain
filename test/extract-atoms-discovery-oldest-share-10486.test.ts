/**
 * #10486: atom discovery took only the newest pages, so a backlog larger than
 * one drain never reached its oldest pages. Each batch now holds an
 * oldest-first share alongside the newest.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { discoverExtractablePages } from '../src/core/cycle/extract-atoms.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const prose = (n: string) => `A durable decision about ${n}, recorded in prose with context. `.repeat(12);
  for (let i = 1; i <= 6; i++) {
    await engine.putPage(`meetings/m${i}`, { type: 'meeting', title: `M${i}`, compiled_truth: prose(`m${i}`) } as never);
    await engine.executeRaw(
      'UPDATE pages SET updated_at = $1::timestamptz WHERE slug = $2',
      [`2026-0${i}-01T00:00:00Z`, `meetings/m${i}`],
    );
  }
});
afterAll(async () => { await engine.disconnect(); });

test('a limited batch includes the oldest pending page, not only the newest', async () => {
  const slugs = (await discoverExtractablePages(engine, 'default', undefined, 4)).map(p => p.slug);
  expect(slugs).toHaveLength(4);
  expect(slugs).toContain('meetings/m1');
  expect(slugs).toContain('meetings/m6');
  expect(slugs).toContain('meetings/m5');
});
