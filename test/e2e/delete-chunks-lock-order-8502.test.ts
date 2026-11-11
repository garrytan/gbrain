/**
 * #8502 lock order: deleteChunks clears the page's text projection seal when
 * it deletes chunks. It must lock the owning page row before it touches a
 * chunk row, the order every writer uses (lock the page, then replace its
 * chunks). Deleting the chunks first and updating the page after deadlocked
 * (40P01) against a writer that held the page and then deleted its chunks.
 * An empty fragment upsertChunks clears the seal the same way and already
 * locked the page first; both are pinned here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';

const describeDb = hasDatabase() ? describe : describe.skip;
describeDb('deleteChunks lock order (Postgres)', () => {
  let engine: PostgresEngine;
  const slug = 'notes/lock-order';
  beforeAll(async () => { engine = await setupDB(); }, 60_000);
  afterAll(async () => { await teardownDB(); });

  const removals = [
    ['deleteChunks', () => engine.deleteChunks(slug)],
    ['an empty fragment upsertChunks', () => engine.upsertChunks(slug, [])],
  ] as const;

  test.each(removals)('%s waits on a writer holding the page instead of deadlocking against it', async (_name, remove) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('TRUNCATE pages CASCADE');
    const written = await importFromContent(engine, slug, '---\ntitle: Lock order\ntype: note\n---\nA paragraph about acme-example.\n', { noEmbed: true });
    expect(written.chunks).toBeGreaterThan(0);

    let held!: () => void, release!: () => void;
    const pageHeld = new Promise<void>(resolve => { held = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const writer = engine.transaction(async tx => {
      await tx.executeRaw("SELECT id FROM pages WHERE slug = $1 AND source_id = 'default' FOR UPDATE", [slug]);
      held();
      await proceed;
      await tx.executeRaw("DELETE FROM content_chunks WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')", [slug]);
    }).then(() => null, (error: { code?: string }) => error);
    await pageHeld;
    const deleting = remove().then(() => null, (error: { code?: string }) => error);
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        const [row] = await engine.executeRaw<{ waiting: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS waiting`);
        waiting = row!.waiting;
        if (!waiting) await Bun.sleep(10);
      }
    } finally { release(); }
    const [writerError, deleteError] = await Promise.all([writer, deleting]);
    expect(waiting).toBe(true);
    expect(writerError?.code).toBeUndefined();
    expect(deleteError?.code).toBeUndefined();
    expect(writerError).toBeNull();
    expect(deleteError).toBeNull();
    expect(await engine.executeRaw("SELECT 1 FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1", [slug])).toHaveLength(0);
  }, 60_000);
});
