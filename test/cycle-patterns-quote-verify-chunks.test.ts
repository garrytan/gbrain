/**
 * A managed brain's leftover quote-verify backlog is published in chunks within persistence.limits.principal_outstanding:
 * one batch larger than the cap can never be admitted, so the patterns phase failed every run.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { groundPatternPages } from '../src/core/cycle/patterns.ts';
import * as preparedMaintenance from '../src/core/persistence/prepared-maintenance.ts';

let engine: PGLiteEngine;
const PAGES = 12;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('dream.quote_verify', 'true');
  await engine.setConfig('persistence.limits.principal_outstanding', '6');
  for (let i = 0; i < PAGES; i++) {
    await importFromContent(engine, `wiki/personal/patterns/p${i}`,
      `---\ntype: note\ntitle: P${i}\ndream_generated: true\n---\nYou wrote "thing ${i}".\n`, { noEmbed: true, sourceId: 'default' });
  }
});
afterAll(async () => { await engine.disconnect(); });

describe('patterns quote grounding publication', () => {
  test('leftover pages are published in batches no larger than the principal outstanding cap', async () => {
    const sizes: number[] = [];
    const spy = spyOn(preparedMaintenance, 'publishMaintenancePages').mockImplementation(async (_e, _a, pages) => {
      sizes.push(pages.length);
      return pages.map(() => ({ receipt: {} }));
    });
    try {
      const authority = { writer: { sourceId: 'default' } } as unknown as preparedMaintenance.MaintenanceAuthority;
      const stats = await groundPatternPages(engine, authority, [], [], 'wiki/personal/patterns', 'default', '2026-11-17');
      expect(stats?.pages).toBe(PAGES);
    } finally { spy.mockRestore(); }
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(PAGES);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(6);
  });
});
