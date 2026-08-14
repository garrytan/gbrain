/**
 * Real-Postgres regression coverage for source-boundary mutation races.
 *
 * A hard delete that already owns the parent-row lock must linearize before
 * addLink/addTimelineEntry. The mutation should wait, then report the missing
 * endpoint through the engine contract — never leak SQLSTATE 23503.
 *
 * Run:
 *   DATABASE_URL=postgresql://... bun test test/e2e/source-boundary-mutation-postgres.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seedPage(engine: PostgresEngine, slug: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'test',
    title: slug,
    compiled_truth: 'concurrency fixture',
  });
}

describe.skipIf(skip)('Postgres source-boundary mutation deletion races (E2E)', () => {
  let engine: PostgresEngine;
  let deleter: Sql;
  const prefix = `test/source-boundary-race-${process.pid}-${Date.now()}`;
  const cleanupSlugs = new Set<string>();

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
    deleter = postgres(DATABASE_URL!, { max: 1, prepare: false });
  }, 30_000);

  afterAll(async () => {
    const sql = (engine as unknown as { sql: Sql }).sql;
    if (cleanupSlugs.size > 0) {
      await sql`DELETE FROM pages WHERE source_id = 'default' AND slug = ANY(${[...cleanupSlugs]})`;
    }
    await deleter.end({ timeout: 5 });
    await engine.disconnect();
  });

  test('addLink waits for a winning hard delete, then identifies the missing to endpoint', async () => {
    const from = `${prefix}-link-from`;
    const to = `${prefix}-link-to`;
    cleanupSlugs.add(from);
    cleanupSlugs.add(to);
    await seedPage(engine, from);
    await seedPage(engine, to);

    const deleteLocked = deferred();
    const releaseDelete = deferred();
    const deletion = deleter.begin(async (tx) => {
      await tx`DELETE FROM pages WHERE slug = ${to} AND source_id = 'default'`;
      deleteLocked.resolve();
      await releaseDelete.promise;
    });
    await deleteLocked.promise;

    let settled = false;
    const mutation = engine.addLink(from, to).finally(() => {
      settled = true;
    });
    await Bun.sleep(50);
    expect(settled).toBeFalse();

    releaseDelete.resolve();
    await deletion;
    await expect(mutation).rejects.toThrow(
      `addLink failed: to page "${to}" (source=default) not found`,
    );
  }, 15_000);

  test('addTimelineEntry waits for a winning hard delete, then identifies the missing page', async () => {
    const slug = `${prefix}-timeline`;
    cleanupSlugs.add(slug);
    await seedPage(engine, slug);

    const deleteLocked = deferred();
    const releaseDelete = deferred();
    const deletion = deleter.begin(async (tx) => {
      await tx`DELETE FROM pages WHERE slug = ${slug} AND source_id = 'default'`;
      deleteLocked.resolve();
      await releaseDelete.promise;
    });
    await deleteLocked.promise;

    let settled = false;
    const mutation = engine
      .addTimelineEntry(slug, {
        date: '2026-08-14',
        source: 'test',
        summary: 'concurrency fixture',
      })
      .finally(() => {
        settled = true;
      });
    await Bun.sleep(50);
    expect(settled).toBeFalse();

    releaseDelete.resolve();
    await deletion;
    await expect(mutation).rejects.toThrow(
      `addTimelineEntry failed: page "${slug}" (source=default) not found`,
    );
  }, 15_000);
});
