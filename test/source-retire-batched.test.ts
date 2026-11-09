/**
 * #7702 / #8905 on PGLite: a managed remove or purge deletes a source's pages in bounded batches behind the same
 * preconditions as its final transaction, never deletes for a dry run or a refused operation, and a retry with the
 * same request_id resumes after an interrupted batch.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle, SOURCE_RETIRE_BATCH_PAGES } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { journalLimitKey } from '../src/core/persistence/limits.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const PAGES = SOURCE_RETIRE_BATCH_PAGES * 2 + 17;
const source = 'retire-batched';

async function fixture(run: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-retire-batched-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await registerLocalWriter(engine, 'cli');
      for (const id of [source, 'keep-other']) {
        const root = join(home, id); mkdirSync(root);
        writeFileSync(join(root, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
        await claimWorktree(engine, id, root);
        await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
          SELECT $1,'notes/p-'||g,'note','Page '||g,'Body '||g FROM generate_series(1,$2::int) g`, [id, id === source ? PAGES : 20]);
        await engine.executeRaw(`INSERT INTO content_chunks(page_id,chunk_index,chunk_text)
          SELECT id,0,'chunk of '||slug FROM pages WHERE source_id=$1`, [id]);
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await run();
      expect(await pages('keep-other')).toBe(20);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const pages = async (id: string) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [id]))[0].n;
const registered = async () => (await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [source])).length;

test('remove and purge of a source larger than one batch delete every page and count them all', () => fixture(async () => {
  await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: source });
  expect(await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: source, confirmDestructive: true }))
    .toMatchObject({ state: 'committed', operation: 'purge', pages_deleted: PAGES });
  expect(await registered()).toBe(0);
  expect(await pages(source)).toBe(0);
  expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks c LEFT JOIN pages p ON p.id=c.page_id WHERE p.id IS NULL`))[0].n).toBe(0);
}), 60_000);

test('a dry run or a refused remove/purge deletes no page', () => fixture(async () => {
  await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, dryRun: true });
  await expect(runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: source, confirmDestructive: true })).rejects.toMatchObject({ code: 'invalid_params' });
  await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: source });
  expect(await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: source, confirmDestructive: true, expiredOnly: true }))
    .toMatchObject({ state: 'committed', noop: true });
  await expect(runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, expectedIncarnation: randomUUID() }))
    .rejects.toMatchObject({ code: 'source_changed' });
  expect(await pages(source)).toBe(PAGES);
  expect(await registered()).toBe(1);
}), 60_000);

test('a lock wait stops the remove with write_pending instead of shrinking the batch; the retry resumes at full size', () => fixture(async () => {
  await engine.executeRaw('CREATE SEQUENCE retire_lock_seq');
  await engine.executeRaw(`CREATE FUNCTION retire_lock_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF nextval('retire_lock_seq') = 1 THEN RAISE EXCEPTION 'canceling statement due to lock timeout' USING ERRCODE = 'lock_not_available'; END IF;
    RETURN NULL; END $$`);
  await engine.executeRaw('CREATE TRIGGER retire_lock AFTER DELETE ON pages FOR EACH STATEMENT EXECUTE FUNCTION retire_lock_fn()');
  try {
    const requestId = randomUUID();
    const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
    await expect(remove()).rejects.toMatchObject({ code: 'write_pending', reason: 'lock_timeout' });
    expect(await pages(source)).toBe(PAGES);
    expect(await remove()).toMatchObject({ state: 'committed', operation: 'remove', pages_deleted: PAGES });
    expect(await pages(source)).toBe(0);
  } finally {
    for (const sql of ['DROP TRIGGER IF EXISTS retire_lock ON pages', 'DROP FUNCTION IF EXISTS retire_lock_fn()', 'DROP SEQUENCE IF EXISTS retire_lock_seq']) await engine.executeRaw(sql);
  }
}), 60_000);

test('a bounded wait at COMMIT stops the remove without halving, and only committed batches count', () => fixture(async () => {
  await engine.executeRaw('CREATE SEQUENCE retire_commit_seq');
  await engine.executeRaw(`CREATE FUNCTION retire_commit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF nextval('retire_commit_seq') = ${SOURCE_RETIRE_BATCH_PAGES + 1} THEN RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = TG_ARGV[0]; END IF;
    RETURN NULL; END $$`);
  try {
    for (const errcode of ['query_canceled', 'lock_not_available']) {
      await engine.executeRaw('SELECT setval($1, 1, false)', ['retire_commit_seq']);
      await engine.executeRaw(`CREATE CONSTRAINT TRIGGER retire_commit AFTER DELETE ON pages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION retire_commit_fn('${errcode}')`);
      const before = await pages(source);
      const err = await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true }).then(() => null, (e: Error & { code?: string; suggestion?: string }) => e);
      await engine.executeRaw('DROP TRIGGER retire_commit ON pages');
      expect({ errcode, code: err?.code }).toEqual({ errcode, code: 'write_pending' });
      expect(await pages(source)).toBe(before - SOURCE_RETIRE_BATCH_PAGES);
      expect(err?.suggestion).toContain(`already deleted ${SOURCE_RETIRE_BATCH_PAGES} page(s)`);
    }
  } finally {
    for (const sql of ['DROP TRIGGER IF EXISTS retire_commit ON pages', 'DROP FUNCTION IF EXISTS retire_commit_fn()', 'DROP SEQUENCE IF EXISTS retire_commit_seq']) await engine.executeRaw(sql);
  }
}), 60_000);

test('an interrupted batch keeps the committed batches and the same request_id resumes to completion', () => fixture(async () => {
  await engine.executeRaw('CREATE TABLE retire_fail(armed boolean NOT NULL, seen integer NOT NULL)');
  await engine.executeRaw(`CREATE FUNCTION retire_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n integer; BEGIN
    UPDATE retire_fail SET seen=seen+1 WHERE armed RETURNING seen INTO n;
    IF n > ${SOURCE_RETIRE_BATCH_PAGES * 2} THEN RAISE EXCEPTION 'injected retire batch failure'; END IF; RETURN OLD; END $$`);
  await engine.executeRaw('CREATE TRIGGER retire_fail BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION retire_fail_fn()');
  try {
    await engine.executeRaw('INSERT INTO retire_fail VALUES(true,0)');
    const requestId = randomUUID();
    const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
    await expect(remove()).rejects.toThrow('injected retire batch failure');
    expect(await pages(source)).toBe(PAGES - SOURCE_RETIRE_BATCH_PAGES * 2);
    expect(await registered()).toBe(1);
    expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes WHERE request_id=$1::uuid', [requestId])).toHaveLength(0);
    await engine.executeRaw('DELETE FROM retire_fail');
    const receipt = await remove();
    expect(receipt).toMatchObject({ state: 'committed', operation: 'remove', pages_deleted: PAGES - SOURCE_RETIRE_BATCH_PAGES * 2 });
    expect(await remove()).toEqual(receipt);
    expect(await pages(source)).toBe(0);
    expect(await registered()).toBe(0);
  } finally {
    for (const sql of ['DROP TRIGGER IF EXISTS retire_fail ON pages', 'DROP FUNCTION IF EXISTS retire_fail_fn()', 'DROP TABLE IF EXISTS retire_fail']) await engine.executeRaw(sql);
  }
}), 60_000);

test('a remove refuses before deleting when the receipt quota is spent, and a CLI writer revoked mid-run stops it at the next batch', () => fixture(async () => {
  const [brain] = await engine.executeRaw<{ n: string }>("SELECT lifetime_ids::text AS n FROM persistence_counters WHERE key='brain'");
  await engine.executeRaw('INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [journalLimitKey('brainLifetimeIds'), brain?.n ?? '0']);
  await expect(runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true })).rejects.toMatchObject({ code: 'write_quota_exhausted' });
  expect(await pages(source)).toBe(PAGES);
  await engine.executeRaw('DELETE FROM config WHERE key=$1', [journalLimitKey('brainLifetimeIds')]);
  const revoke = "CREATE FUNCTION retire_revoke_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE persistence_local_writers SET revoked_at=now() WHERE lane='cli'; RETURN NULL; END $$";
  await engine.executeRaw(revoke);
  await engine.executeRaw('CREATE TRIGGER retire_revoke AFTER DELETE ON pages FOR EACH STATEMENT EXECUTE FUNCTION retire_revoke_fn()');
  try {
    await expect(runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true }))
      .rejects.toMatchObject({ code: 'permission_denied', suggestion: expect.stringContaining(`already deleted ${SOURCE_RETIRE_BATCH_PAGES} page(s)`) });
    expect(await pages(source)).toBe(PAGES - SOURCE_RETIRE_BATCH_PAGES);
    expect(await registered()).toBe(1);
  } finally {
    for (const sql of ['DROP TRIGGER IF EXISTS retire_revoke ON pages', 'DROP FUNCTION IF EXISTS retire_revoke_fn()']) await engine.executeRaw(sql);
  }
}), 60_000);

test('a batch that hits the statement bound is retried at half the size until it fits', () => fixture(async () => {
  await engine.executeRaw(`CREATE FUNCTION retire_bound_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF (SELECT count(*) FROM gone) > 100 THEN RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = 'query_canceled'; END IF; RETURN NULL; END $$`);
  await engine.executeRaw('CREATE TRIGGER retire_bound AFTER DELETE ON pages REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION retire_bound_fn()');
  try {
    expect(await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true }))
      .toMatchObject({ state: 'committed', operation: 'remove', pages_deleted: PAGES });
    expect(await pages(source)).toBe(0);
  } finally {
    for (const sql of ['DROP TRIGGER IF EXISTS retire_bound ON pages', 'DROP FUNCTION IF EXISTS retire_bound_fn()']) await engine.executeRaw(sql);
  }
}), 60_000);
