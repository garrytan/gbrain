/**
 * #5216 / #4738: doctor's child_table_orphans used to print cleanup SQL that
 * no gbrain command could run. `gbrain repair orphan-children` previews and
 * removes orphaned child rows (clearing the two ON DELETE SET NULL
 * references), and its preview probes every page body for torn TOAST values.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { orphanChildrenRepair } from '../src/core/repair/orphan-children.ts';
import { childTableOrphansCheck } from '../src/commands/doctor/checks/core-health.ts';
import { probeTornPages } from '../src/core/engine-sql/repair-page-reads.ts';

let engine: PGLiteEngine;
const ctx = () => ({ engine, config: { engine: 'pglite' }, remote: false, logger: console } as unknown as OperationContext);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const slug of ['notes/kept-example', 'notes/removed-example']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` }, { sourceId: 'default' });
  }
  const ids = Object.fromEntries((await engine.executeRaw<{ slug: string; id: number }>('SELECT slug, id FROM pages')).map(r => [r.slug, r.id]));
  await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, origin_page_id) VALUES ($1, $1, 'mention', $2)`,
    [ids['notes/kept-example'], ids['notes/removed-example']]);
  // Recreate storage damage: child rows of a page whose row is gone without the cascade.
  await engine.executeRaw('SET session_replication_role = replica');
  await engine.executeRaw('DELETE FROM pages WHERE id = $1', [ids['notes/removed-example']]);
  await engine.executeRaw(`INSERT INTO tags (page_id, tag) VALUES ($1, 'orphan-tag')`, [ids['notes/removed-example']]);
  await engine.executeRaw('SET session_replication_role = DEFAULT');
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('preview lists orphan groups, apply removes them and clears dangling references, doctor goes ok', async () => {
  const before = await childTableOrphansCheck(engine);
  expect(before.status).toBe('warn');
  expect(before.message).toContain('gbrain repair orphan-children');
  const scope = await resolveRepairScope(engine);
  await expect(runRepair(ctx(), orphanChildrenRepair, scope, { apply: false })).rejects.toThrow();
  const preview = await runRepair(ctx(), orphanChildrenRepair, scope, { apply: false, explicit: true });
  expect(preview.sample).toEqual(['brain:tags.page_id', 'brain:links.origin_page_id']);
  expect(preview.residuals).toEqual({});
  const applied = await runRepair(ctx(), orphanChildrenRepair, scope, { apply: true, explicit: true });
  expect(applied.applied).toBe(2);
  expect(await engine.executeRaw("SELECT tag FROM tags WHERE tag = 'orphan-tag'")).toEqual([]);
  const [link] = await engine.executeRaw<{ origin_page_id: number | null }>('SELECT origin_page_id FROM links');
  expect(link!.origin_page_id).toBeNull();
  expect((await childTableOrphansCheck(engine)).status).toBe('ok');
});

test('the preview probes page bodies and reports a torn one by id and slug without changing it', async () => {
  const [{ id }] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = 'notes/kept-example'");
  // The probe is the engine member probeTornPages; its statements run here through an executeRaw that fails on the torn row.
  const executeRaw = (sql: string, params?: unknown[]) => {
    if (sql.includes('length(compiled_truth)') && JSON.stringify(params).includes(String(id))) {
      return Promise.reject(Object.assign(new Error('unexpected chunk number 21 (expected 1) for toast value 141869 in pg_toast_16808'), { code: 'XX000' }));
    }
    return engine.executeRaw(sql, params as never);
  };
  const torn = new Proxy(engine, { get(target, prop, receiver) {
    if (prop === 'probeTornPages') return () => probeTornPages({ executeRaw, dialect: 'pglite' } as never);
    return Reflect.get(target, prop, receiver);
  } }) as PGLiteEngine;
  const plan = await orphanChildrenRepair.plan(torn, await resolveRepairScope(engine), null);
  expect(plan.residuals).toEqual({ torn_pages: 1 });
  expect(plan.warnings?.[0]).toContain(`#${id} default:notes/kept-example`);
  expect(plan.warnings?.[0]).toContain('docs/guides/repair.md#orphan-children');
  expect(await engine.getPage('notes/kept-example', { sourceId: 'default' })).not.toBeNull();
});
