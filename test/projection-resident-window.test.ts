/**
 * #6803 part 2: the resident's projection selector and the consumer's idle
 * probe read a bounded window of the queue (page-state/projection-window.ts)
 * instead of walking every row v153 queued. Protects: a fresh edit behind a
 * large image queue is reached through the recency lane; the primary-key
 * window wraps so an old row behind the cursor is reached; image rows the
 * resident never builds are remembered and not probed again; the idle probe
 * advances the shared cursor; a rebuild_failed row is retried only after its
 * cooldown. PGLite (the resident's engine).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_PROJECTION_ACTIVATION_SQL } from '../src/core/page-state/projection-schema.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { newProjectionScanCursor, residentProjectionCursor, RESIDENT_PROBE_BUDGET } from '../src/core/page-state/projection-window.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';

let engine: PGLiteEngine;
const IMAGES = 1000;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { if (engine) await engine.disconnect(); });

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM page_projection_jobs');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,page_kind,title,compiled_truth,timeline,chunker_version)
    SELECT 'default','images/img-'||lpad(i::text,4,'0')||'.png','image','image','img','','',0 FROM generate_series(1,$1::int) i`, [IMAGES]);
  for (const statement of PAGE_PROJECTION_ACTIVATION_SQL.split(';').map(part => part.trim()).filter(Boolean)) await engine.executeRaw(statement);
  await engine.executeRaw("UPDATE page_projection_jobs SET updated_at = now() - interval '1 hour'");
});

async function queueNote(slug: string, opts: { old?: boolean; failed?: boolean } = {}) {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Example note ${slug}.` });
  await engine.executeRaw(`UPDATE pages SET text_projection_revision = NULL WHERE slug = $1`, [slug]);
  await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,'pages_trigger' FROM pages p JOIN sources s ON s.id = p.source_id WHERE p.slug = $1
    ON CONFLICT DO NOTHING`, [slug]);
  if (opts.failed) await engine.executeRaw(`UPDATE page_projection_jobs SET reason = 'rebuild_failed', updated_at = now() WHERE slug = $1`, [slug]);
  if (opts.old) await engine.executeRaw(`UPDATE page_projection_jobs SET updated_at = now() - interval '1 hour' WHERE slug = $1`, [slug]);
}

const queued = async (slug: string) => (await engine.executeRaw('SELECT 1 FROM page_projection_jobs WHERE slug = $1', [slug])).length > 0;
/** A high-water mark of now: the recency lane then skips every row queued an hour ago, so only the window can reach them. */
const highWater = async () => (await engine.executeRaw<{ at: string }>('SELECT now()::text AS at'))[0]!.at;

describe('bounded resident projection window', () => {
  test('a fresh edit behind a large image queue is rebuilt through the recency lane', async () => {
    const cursor = newProjectionScanCursor();
    cursor.after = { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' };
    expect(await rebuildPendingPageProjections(engine, 100, { window: cursor, retryCooldown: true })).toMatchObject({ rebuilt: 0 });
    await queueNote('zz/fresh-edit');
    expect(await rebuildPendingPageProjections(engine, 100, { window: cursor, retryCooldown: true })).toMatchObject({ rebuilt: 1 });
    expect(await queued('zz/fresh-edit')).toBe(false);
  }, 60_000);

  test('the window wraps to an old row behind its cursor, and remembered image rows are not probed again', async () => {
    await queueNote('aa/old-note', { old: true });
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id = 'default'");
    const cursor = newProjectionScanCursor();
    cursor.after = { source_incarnation: incarnation, slug: 'images/img-0700.png' };
    cursor.highWater = await highWater();
    const probes: number[] = [];
    const spy = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (sql.includes('jsonb_to_recordset($1::text::jsonb) AS k(i int')) probes.push(JSON.parse(String(params![0])).length);
        return target.executeRaw(sql, params);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as PGLiteEngine;
    const laps: number[] = [];
    for (let tick = 0; tick < 3 && await queued('aa/old-note'); tick++) laps.push((await rebuildPendingPageProjections(spy, 100, { window: cursor, retryCooldown: true })).rebuilt);
    expect(laps[0]).toBe(1);
    expect(await queued('aa/old-note')).toBe(false);
    expect(Math.max(...probes)).toBeLessThanOrEqual(RESIDENT_PROBE_BUDGET);
    const remembered = cursor.ineligible.size;
    expect(remembered).toBeGreaterThan(0);
    probes.length = 0;
    for (let tick = 0; tick < Math.ceil(IMAGES / 400) + 1; tick++) await rebuildPendingPageProjections(spy, 100, { window: cursor, retryCooldown: true });
    expect(cursor.ineligible.size).toBe(IMAGES);
    probes.length = 0;
    await rebuildPendingPageProjections(spy, 100, { window: cursor, retryCooldown: true });
    expect(probes).toEqual([]);
  }, 120_000);

  test('the idle probe walks the shared window and advances its cursor', async () => {
    const consumer = new PersistenceConsumer(engine, {} as never, async () => { throw new Error('no preparation in this probe'); });
    const probe = consumer as unknown as { hasWork(): Promise<boolean> };
    const cursor = residentProjectionCursor(engine);
    cursor.after = { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' };
    cursor.highWater = await highWater();
    expect(await probe.hasWork()).toBe(false);
    const first = cursor.after.slug;
    expect(first).toBe('images/img-0400.png');
    expect(await probe.hasWork()).toBe(false);
    expect(cursor.after.slug).toBe('images/img-0800.png');
    await queueNote('aa/old-note', { old: true });
    cursor.after = { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' };
    expect(await probe.hasWork()).toBe(true);
    expect(cursor.after.slug).toBe('');
  }, 60_000);

  test('a segmented row outside the window still wakes the idle probe (its route reads the whole queue)', async () => {
    await queueNote('zz/segmented', { old: true });
    await engine.executeRaw("UPDATE pages SET body_storage = 'segmented', compiled_truth = NULL, timeline = NULL, body_bytes = 1 WHERE slug = 'zz/segmented'");
    await engine.executeRaw("UPDATE page_projection_jobs SET updated_at = now() - interval '1 hour' WHERE slug = 'zz/segmented'");
    const consumer = new PersistenceConsumer(engine, {} as never, async () => { throw new Error('no preparation in this probe'); });
    const cursor = residentProjectionCursor(engine);
    cursor.after = { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' };
    cursor.highWater = await highWater();
    expect(await (consumer as unknown as { hasWork(): Promise<boolean> }).hasWork()).toBe(true);
  }, 60_000);

  test('a rebuild_failed row is retried only after its cooldown', async () => {
    await queueNote('notes/failed', { failed: true });
    const cursor = newProjectionScanCursor();
    expect(await rebuildPendingPageProjections(engine, 100, { window: cursor, retryCooldown: true })).toMatchObject({ rebuilt: 0 });
    expect(await queued('notes/failed')).toBe(true);
    await engine.executeRaw("UPDATE page_projection_jobs SET updated_at = now() - interval '1 minute' WHERE slug = 'notes/failed'");
    let rebuilt = 0;
    for (let tick = 0; tick < Math.ceil(IMAGES / 400) + 1 && await queued('notes/failed'); tick++) {
      rebuilt += (await rebuildPendingPageProjections(engine, 100, { window: cursor, retryCooldown: true })).rebuilt;
    }
    expect(rebuilt).toBe(1);
    expect(await queued('notes/failed')).toBe(false);
  }, 60_000);
});
