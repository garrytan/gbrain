/**
 * GBRA-218: pages written before member access fail closed until repaired.
 *
 * 1. Protects: a page whose frontmatter named readable_by before the migration
 *    (no derived page_readers yet) is readable by no remote caller, the listed
 *    member included, and `gbrain repair access` restores exactly the listed
 *    member's read without widening anything else.
 * 2. Fails when: an unrepaired row reads as open, the repair widens a read,
 *    touches a row whose value is already right, or bumps the page revision.
 * 3. Real seams: migrated repo-less PGLite schema; the derive trigger disabled
 *    to reproduce a pre-migration row; the registered repair handler.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { privatePagesFilterForCaller, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { accessRepair } from '../src/core/repair/access.ts';

let engine: PGLiteEngine;
const SRC = 'ar-src';
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
  for (const slug of ['notes/old-restricted', 'notes/old-open', 'notes/new-restricted']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'x', timeline: '', frontmatter: {} }, { sourceId: SRC } as never);
  }
  await engine.executeRaw('ALTER TABLE pages DISABLE TRIGGER pages_access_derive_readers');
  await engine.executeRaw(`UPDATE pages SET frontmatter = '{"readable_by": ["alice-example"]}'::jsonb WHERE slug = 'notes/old-restricted'`);
  await engine.executeRaw('ALTER TABLE pages ENABLE TRIGGER pages_access_derive_readers');
  await engine.executeRaw(`UPDATE pages SET frontmatter = '{"readable_by": ["alice-example"]}'::jsonb WHERE slug = 'notes/new-restricted'`);
});
afterAll(async () => { await engine.disconnect(); });

async function visible(identity: string[]): Promise<string[]> {
  return withCallerAccess({ identity, hidePrivate: true, privateReadableSources: [] }, async () =>
    (await engine.executeRaw<{ slug: string }>(`SELECT p.slug FROM pages p WHERE p.source_id = $1 AND ${privatePagesFilterForCaller('p')} ORDER BY p.slug`, [SRC])).map(r => r.slug));
}

describe('repair access', () => {
  test('an unrepaired row is readable by nobody, the listed member included', async () => {
    expect(await visible(['member:alice-example'])).toEqual(['notes/new-restricted', 'notes/old-open']);
    expect(await visible([])).toEqual(['notes/old-open']);
  });

  test('the repair plans only the stale row and restores the listed member alone, without a revision bump', async () => {
    const scope = { brain_id: 'host', source_ids: [SRC] };
    const plan = await accessRepair.plan(engine, scope, null);
    expect(plan.items.map(i => i.slug)).toEqual(['notes/old-restricted']);
    const [before] = await engine.executeRaw<{ rev: string; gen: number }>("SELECT knowledge_revision::text AS rev, generation AS gen FROM pages WHERE slug = 'notes/old-restricted'");
    expect(await accessRepair.apply({ engine } as never, plan.items[0])).toBe(true);
    expect(await accessRepair.apply({ engine } as never, plan.items[0])).toBe(false);
    const [after] = await engine.executeRaw<{ rev: string; gen: number }>("SELECT knowledge_revision::text AS rev, generation AS gen FROM pages WHERE slug = 'notes/old-restricted'");
    expect(after).toEqual(before);
    expect(await visible(['member:alice-example'])).toEqual(['notes/new-restricted', 'notes/old-open', 'notes/old-restricted']);
    expect(await visible(['member:bob-example'])).toEqual(['notes/old-open']);
    expect((await accessRepair.plan(engine, scope, null)).items).toEqual([]);
  });
});
