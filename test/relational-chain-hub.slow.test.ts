/**
 * Bounded work on a dense hub (PGLite): a chain hop from a company with 10,000
 * investors returns at most neighborCap edges and finishes well under the 2 s
 * budget. Regression it catches: a planner that joins pages on source_id per
 * link row (quadratic) or a degree count that fetches every neighbor page.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRelationalChain, linkFamily } from '../src/core/search/relational-chain.ts';
import { cpuMsAsync } from './helpers/cpu-time.ts';

let eng: PGLiteEngine;

beforeAll(async () => {
  eng = new PGLiteEngine();
  await eng.connect({});
  await eng.initSchema();
  await eng.putPage('people/carol-example', { type: 'person', title: 'carol', compiled_truth: '', timeline: '' });
  await eng.putPage('companies/hub-example', { type: 'company', title: 'hub', compiled_truth: '', timeline: '' });
  await eng.addLink('people/carol-example', 'companies/hub-example', '', 'founded', 'markdown');
  await eng.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth, timeline, source_id)
    SELECT 'people/hub-investor-' || g, 'person', 'hub investor ' || g, '', '', 'default' FROM generate_series(1, 10000) g`);
  await eng.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
    SELECT p.id, c.id, 'invested_in', '', 'markdown' FROM pages p, pages c
    WHERE p.slug LIKE 'people/hub-investor-%' AND c.slug = 'companies/hub-example'`);
}, 120_000);

afterAll(async () => {
  await eng.disconnect();
});

describe('relational chain on a 10,000-neighbor hub', () => {
  test('capped, reported, under 2 s', async () => {
    const carol = await eng.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'people/carol-example'`);
    let result!: Awaited<ReturnType<typeof runRelationalChain>>;
    // Thread CPU time: PGLite runs on this thread, so it measures the hop's work rather than how long the scheduler made it wait.
    const ms = await cpuMsAsync(async () => {
      result = await runRelationalChain(eng, [{ page_id: Number(carol[0].id), slug: 'people/carol-example', source_id: 'default' }], {
        hops: [{ linkTypes: ['founded'], toward: 'object' }, { linkTypes: linkFamily('invested_in'), toward: 'subject' }], excludeAnchor: false,
      }, {});
    });
    const { rows, diagnostics } = result;
    expect(ms).toBeLessThan(2000);
    expect(rows.filter(r => r.role === 'answer').length).toBe(100);
    expect(diagnostics.cap_hit).toEqual({ cap: 'neighbor', hop: 2 });
  }, 30_000);
});
