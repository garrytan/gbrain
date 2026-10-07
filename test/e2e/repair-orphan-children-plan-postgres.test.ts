/**
 * #6084 / #5328: doctor `child_table_orphans` and `gbrain repair
 * orphan-children` share `orphanPredicate`. `col NOT IN (SELECT id FROM pages)`
 * plans as a per-row SubPlan once the page ids outgrow work_mem, so the count
 * never finishes on a large brain. The correlated NOT EXISTS plans as an
 * anti-join. This pins the Postgres plan under a work_mem smaller than the
 * page-id set, and the repair semantics (orphans removed, valid and allowed-NULL
 * references kept) on real Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { resolveRepairScope, runRepair } from '../../src/core/repair/core.ts';
import { PAGE_CHILD_FK_TARGETS, orphanChildrenRepair, orphanPredicate } from '../../src/core/repair/orphan-children.ts';
import { childTableOrphansCheck } from '../../src/commands/doctor/checks/core-health.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePg = hasDatabase() ? describe : describe.skip;

describePg('orphan-children predicate on Postgres (#6084)', () => {
  beforeAll(async () => {
    const engine = await setupDB();
    for (const slug of ['notes/kept-example', 'notes/removed-example']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` }, { sourceId: 'default' });
    }
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth)
      SELECT 'default', 'notes/bulk-' || g, 'note', 'bulk', '' FROM generate_series(1, 6000) g`);
    const ids = Object.fromEntries((await engine.executeRaw<{ slug: string; id: number }>(
      "SELECT slug, id FROM pages WHERE slug IN ('notes/kept-example', 'notes/removed-example')")).map(r => [r.slug, Number(r.id)]));
    await engine.executeRaw(`INSERT INTO tags (page_id, tag) VALUES ($1, 'valid-tag')`, [ids['notes/kept-example']]);
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, origin_page_id) VALUES ($1, $1, 'mention', NULL), ($1, $1, 'reference', $2)`,
      [ids['notes/kept-example'], ids['notes/removed-example']]);
    await engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL session_replication_role = replica');
      await tx.executeRaw('DELETE FROM pages WHERE id = $1', [ids['notes/removed-example']]);
      await tx.executeRaw(`INSERT INTO tags (page_id, tag) VALUES ($1, 'orphan-tag')`, [ids['notes/removed-example']]);
    });
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE tags');
  }, 120_000);

  afterAll(async () => { await teardownDB(); });

  test('every target plans as an anti-join, never a per-row SubPlan, when page ids exceed work_mem', async () => {
    const plans = await getEngine().transaction(async tx => {
      await tx.executeRaw("SET LOCAL work_mem = '64kB'");
      const out: Array<{ target: string; plan: string }> = [];
      for (const target of PAGE_CHILD_FK_TARGETS) {
        const rows = await tx.executeRaw<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT count(*)::int AS n FROM ${target.table} WHERE ${orphanPredicate(target)}`);
        out.push({ target: `${target.table}.${target.col}`, plan: rows.map(r => r['QUERY PLAN']).join('\n') });
      }
      return out;
    });
    for (const { target, plan } of plans) {
      expect({ target, subplan: /SubPlan/.test(plan) }).toEqual({ target, subplan: false });
      expect({ target, antiJoin: /Anti Join/.test(plan) }).toEqual({ target, antiJoin: true });
    }
  });

  test('doctor warns, the repair removes only orphans, valid and NULL references survive', async () => {
    const engine = getEngine();
    const before = await childTableOrphansCheck(engine);
    expect(before.status).toBe('warn');
    expect(before.details?.orphans).toEqual(['tags.page_id=1', 'links.origin_page_id=1']);
    const ctx = { engine, config: { engine: 'postgres' }, remote: false, logger: console } as unknown as OperationContext;
    const applied = await runRepair(ctx, orphanChildrenRepair, await resolveRepairScope(engine), { apply: true, explicit: true });
    expect(applied.applied).toBe(2);
    expect((await engine.executeRaw<{ tag: string }>('SELECT tag FROM tags ORDER BY tag')).map(r => r.tag)).toEqual(['valid-tag']);
    const links = await engine.executeRaw<{ link_type: string; origin_page_id: number | null }>('SELECT link_type, origin_page_id FROM links ORDER BY link_type');
    expect(links).toEqual([{ link_type: 'mention', origin_page_id: null }, { link_type: 'reference', origin_page_id: null }]);
    expect((await childTableOrphansCheck(engine)).status).toBe('ok');
  });
});
