/**
 * #8741: op_checkpoints has no FK to sources, so removing a source mid-sync
 * left its unfinished managed-sync cursor behind. Doctor managed_sync_backlog
 * then warned forever with a resume command that fails `unknown_source`, and
 * the managed-sync-orphans repair (which joins sources) never saw the row.
 * The cursor now goes with the source row on both removal paths
 * (deleteSourceRow and the managed lifecycle remove), and the backlog reader
 * skips a cursor whose source no longer exists or whose recorded incarnation
 * is not the live source's.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkManagedSyncBacklog } from '../src/commands/doctor/checks/managed-sync-backlog.ts';
import { deleteSourceRow } from '../src/core/source-delete.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const twoHoursAgo = () => new Date(Date.now() - 120 * 60_000).toISOString();
const putCursor = (fingerprint: string, sourceId: string, incarnation?: string) => engine.executeRaw(
  "INSERT INTO op_checkpoints(op, fingerprint, completed_keys, updated_at) VALUES('managed-sync', $1, jsonb_build_array($2::jsonb), now())",
  [fingerprint, JSON.stringify({ sourceId, ...(incarnation ? { incarnation } : {}), index: 1, total: 4, done: false, discoveredAt: twoHoursAgo() })]);
const incarnationOf = async (id: string) => (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id = $1', [id]))[0]!.incarnation;
const cursorCount = async (fingerprint: string) => (await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op = 'managed-sync' AND fingerprint = $1", [fingerprint])).length;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

test('removing a source drops its unfinished managed-sync cursor', async () => {
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a'), ('source-b', 'source-b')");
  await putCursor('cursor-a', 'source-a');
  await putCursor('cursor-b', 'source-b');
  expect(await checkManagedSyncBacklog(engine, ['source-a'])).toMatchObject({ status: 'warn' });
  expect(await deleteSourceRow(engine, 'source-a')).toBe(true);
  expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op = 'managed-sync' AND fingerprint = 'cursor-a'")).toHaveLength(0);
  expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op = 'managed-sync' AND fingerprint = 'cursor-b'")).toHaveLength(1);
  expect(await checkManagedSyncBacklog(engine, ['source-a'])).toBeNull();
});

test('a cursor already left behind by a removed source is not a backlog', async () => {
  await putCursor('cursor-gone', 'source-gone');
  expect(await checkManagedSyncBacklog(engine, ['source-gone'])).toBeNull();
  expect((await checkManagedSyncBacklog(engine))?.message ?? '').not.toContain('source-gone');
});

test('a cursor of an earlier incarnation of a re-created source is not a backlog', async () => {
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-c', 'source-c')");
  await putCursor('cursor-c-old', 'source-c', await incarnationOf('source-c'));
  expect(await checkManagedSyncBacklog(engine, ['source-c'])).toMatchObject({ status: 'warn' });
  await engine.executeRaw("DELETE FROM sources WHERE id = 'source-c'");
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-c', 'source-c')");
  expect(await cursorCount('cursor-c-old')).toBe(1);
  expect(await checkManagedSyncBacklog(engine, ['source-c'])).toBeNull();
  await putCursor('cursor-c-new', 'source-c', await incarnationOf('source-c'));
  expect(await checkManagedSyncBacklog(engine, ['source-c'])).toMatchObject({ status: 'warn' });
});

test('deleteSourceRow then re-creating the same id leaves no backlog', async () => {
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-d', 'source-d')");
  await putCursor('cursor-d', 'source-d', await incarnationOf('source-d'));
  expect(await deleteSourceRow(engine, 'source-d')).toBe(true);
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-d', 'source-d')");
  expect(await cursorCount('cursor-d')).toBe(0);
  expect(await checkManagedSyncBacklog(engine, ['source-d'])).toBeNull();
});

test('managed source removal drops its cursors, and re-adding the same id leaves no backlog', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-8741-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const source = 'source-managed', root = join(home, 'canonical');
      mkdirSync(root);
      writeFileSync(join(root, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
      await registerLocalWriter(engine, 'cli');
      await engine.executeRaw('INSERT INTO sources(id, name, local_path) VALUES($1, $1, $2)', [source, root]);
      await claimWorktree(engine, source, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const original = (await getWorktreeBinding(engine, source))!;
      await putCursor('cursor-managed', source, original.source_incarnation);
      expect(await checkManagedSyncBacklog(engine, [source])).toMatchObject({ status: 'warn' });
      await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId: randomUUID() });
      expect(await cursorCount('cursor-managed')).toBe(0);
      await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: source, path: root });
      expect((await getWorktreeBinding(engine, source))!.source_incarnation).not.toBe(original.source_incarnation);
      expect(await checkManagedSyncBacklog(engine, [source])).toBeNull();
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 60_000);
