/**
 * #8741: op_checkpoints has no FK to sources, so removing a source mid-sync
 * left its unfinished managed-sync cursor behind. Doctor managed_sync_backlog
 * then warned forever with a resume command that fails `unknown_source`, and
 * the managed-sync-orphans repair (which joins sources) never saw the row.
 * The cursor now goes with the source row, and the backlog reader skips a
 * cursor whose source no longer exists.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkManagedSyncBacklog } from '../src/commands/doctor/checks/managed-sync-backlog.ts';
import { deleteSourceRow } from '../src/core/source-delete.ts';

let engine: PGLiteEngine;
const twoHoursAgo = () => new Date(Date.now() - 120 * 60_000).toISOString();
const putCursor = (fingerprint: string, sourceId: string) => engine.executeRaw(
  "INSERT INTO op_checkpoints(op, fingerprint, completed_keys, updated_at) VALUES('managed-sync', $1, jsonb_build_array($2::jsonb), now())",
  [fingerprint, JSON.stringify({ sourceId, index: 1, total: 4, done: false, discoveredAt: twoHoursAgo() })]);

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

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
