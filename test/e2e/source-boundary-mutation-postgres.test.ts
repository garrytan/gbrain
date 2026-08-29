/**
 * #4109 — real-Postgres regression coverage for source-boundary mutation
 * deletion races.
 *
 * A hard delete that already owns the parent-row lock must linearize before
 * addLink / addTimelineEntry: the FOR KEY SHARE endpoint resolution waits for
 * the deleting transaction, then reports the missing endpoint through the
 * typed engine contract (PageMissingError message shape) — never a raw
 * SQLSTATE 23503 FK violation and never a zero-row upsert reported as
 * success. PGLite is single-writer in-process, so this class only exists on
 * real Postgres.
 *
 * DATABASE_URL-gated: self-skips without a real Postgres (same placement
 * pattern as test/e2e/dream-triage-postgres.test.ts — picked up by the
 * existing Postgres-service CI job).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';

const describePg = hasDatabase() ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describePg('#4109 source-boundary mutation deletion races — Postgres', () => {
  let deleter: Sql;

  beforeAll(async () => {
    await setupDB();
    // Dedicated single-connection session so the racing DELETE holds its
    // transaction open independently of the engine's pool.
    deleter = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  }, 90_000);

  afterAll(async () => {
    await deleter.end({ timeout: 5 });
    await teardownDB();
  }, 30_000);

  async function seedPage(slug: string): Promise<void> {
    await getEngine().putPage(slug, {
      type: 'concept',
      title: slug,
      compiled_truth: 'deletion-race fixture',
    });
  }

  test('addLink waits for a winning hard delete, then identifies the missing to endpoint', async () => {
    const from = 'topics/race-link-from';
    const to = 'topics/race-link-to';
    await seedPage(from);
    await seedPage(to);

    const deleteLocked = deferred();
    const releaseDelete = deferred();
    const deletion = deleter.begin(async (tx) => {
      await tx`DELETE FROM pages WHERE slug = ${to} AND source_id = 'default'`;
      deleteLocked.resolve();
      await releaseDelete.promise;
    });
    await deleteLocked.promise;

    let settled = false;
    const mutation = getEngine().addLink(from, to).finally(() => {
      settled = true;
    });
    // The FOR KEY SHARE endpoint lookup must block on the open delete.
    await Bun.sleep(50);
    expect(settled).toBeFalse();

    releaseDelete.resolve();
    await deletion;
    await expect(mutation).rejects.toThrow(
      `addLink failed: to page "${to}" (source=default) not found`,
    );
  }, 15_000);

  test('addTimelineEntry waits for a winning hard delete, then identifies the missing page', async () => {
    const slug = 'topics/race-timeline';
    await seedPage(slug);

    const deleteLocked = deferred();
    const releaseDelete = deferred();
    const deletion = deleter.begin(async (tx) => {
      await tx`DELETE FROM pages WHERE slug = ${slug} AND source_id = 'default'`;
      deleteLocked.resolve();
      await releaseDelete.promise;
    });
    await deleteLocked.promise;

    let settled = false;
    const mutation = getEngine()
      .addTimelineEntry(slug, {
        date: '2026-08-14',
        source: 'test',
        summary: 'deletion-race fixture',
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
