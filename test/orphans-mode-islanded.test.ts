/**
 * #4524 — `find_orphans` / `gbrain orphans` counted pages with NO INBOUND
 * link, while `get_health.orphan_pages` counted ISLANDED pages (no inbound
 * AND no outbound, endpoint-liveness both ways). Mid-curation the two
 * numbers diverged wildly (145 vs 20 on a real brain), so doctor-driven
 * enrichment loops chased a count the orphans tool disagreed with.
 *
 * One canonical policy now: `findOrphanPages` takes `mode:
 * 'inbound' | 'islanded'` and DEFAULTS to 'islanded' — health's definition —
 * so every consumer (orphans CLI, find_orphans op, doctor orphan_ratio,
 * get_health.orphan_pages) agrees by construction. The old no-inbound view
 * stays reachable via mode: 'inbound'.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { findOrphans } from '../src/commands/orphans.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // island: no inbound, no outbound → orphan under BOTH definitions.
  await engine.putPage('people/island', {
    type: 'person', title: 'Island', compiled_truth: 'body', timeline: '', frontmatter: {},
  });
  // hub: no inbound, but LINKS OUT to spoke → orphan only under 'inbound'.
  await engine.putPage('people/hub', {
    type: 'person', title: 'Hub', compiled_truth: 'body', timeline: '', frontmatter: {},
  });
  // spoke: inbound from hub → not an orphan under either definition.
  await engine.putPage('people/spoke', {
    type: 'person', title: 'Spoke', compiled_truth: 'body', timeline: '', frontmatter: {},
  });
  await engine.addLink('people/hub', 'people/spoke', 'knows', 'knows');
});

afterAll(async () => {
  await engine.disconnect();
});

describe('findOrphanPages mode (#4524)', () => {
  test("default = 'islanded' (health's definition): outbound-only pages are NOT orphans", async () => {
    const rows = await engine.findOrphanPages();
    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain('people/island');
    expect(slugs).not.toContain('people/hub');
    expect(slugs).not.toContain('people/spoke');
  });

  test("mode: 'inbound' preserves the old no-inbound view", async () => {
    const rows = await engine.findOrphanPages({ mode: 'inbound' });
    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain('people/island');
    expect(slugs).toContain('people/hub');
    expect(slugs).not.toContain('people/spoke');
  });

  test("mode: 'islanded' explicit matches the default", async () => {
    const def = (await engine.findOrphanPages()).map(r => r.slug).sort();
    const exp = (await engine.findOrphanPages({ mode: 'islanded' })).map(r => r.slug).sort();
    expect(exp).toEqual(def);
  });

  test('findOrphans (policy fn) agrees with get_health.orphan_pages by construction', async () => {
    const health = await engine.getHealth();
    const result = await findOrphans(engine, {});
    expect(result.total_orphans).toBe(health.orphan_pages);
  });
});
