/**
 * #6712 PR 0: `gbrain sync status --json` always carries `checkpoint_blockers` as an array, so the convergence
 * gate's status oracle (and an operator agent) can read it without guessing whether its absence means "nothing
 * blocks" or "not computed".
 *
 * Protects: the rendered JSON of `sync status --source <id> --json` (the command's own renderer,
 * `runSyncStatus`) has `checkpoint_blockers` as an array in all four states of a managed source: no cursor
 * (empty), an unfinished cursor before its checkpoint step (empty: no checkpoint is pending yet), a finished
 * cursor (empty), and a cursor at its checkpoint behind a receipt that still holds a publication recovery record
 * (that receipt, marked `recovery`). `cursors` stays an array in each.
 * Fails when: the field is left out for an absent, unfinished or finished cursor (master before this change
 * omitted it in all three).
 * #6712 PR 2 (L5): the blocker list is a heavy read a plain status skips; the array stays (empty) and
 * `checkpoint_blockers_read` says `not_read` with the --detail command, which lists the receipt. The fourth test pinned
 * the list on a plain status; it now asserts both reads.
 * PGLite in-memory; no production seam.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSyncStatus } from '../src/commands/sync/operator.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'shape-src';
let engine: PGLiteEngine;
let home: string;
let worktreeId: string;
let incarnation: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-status-shape-'));
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  const root = join(home, 'repo');
  mkdirSync(root);
  execFileSync('git', ['-C', root, 'init', '-q']);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [SOURCE, root]);
    await claimWorktree(engine, SOURCE, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  });
  worktreeId = (await getWorktreeBinding(engine, SOURCE))!.worktree_id;
  incarnation = (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [SOURCE]))[0]!.incarnation;
}, 60_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(async () => {
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync'");
  await engine.executeRaw('DELETE FROM persistence_requests');
});

/** The JSON document `gbrain sync status --source <id> --json` prints. */
async function statusJson(...extra: string[]): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_HOME: home }, () => runSyncStatus(engine, ['--source', SOURCE, '--json', ...extra])); } finally { console.log = log; }
  return JSON.parse(lines.join('\n')) as Record<string, unknown>;
}
async function cursor(header: Record<string, unknown>): Promise<string> {
  const runId = randomUUID();
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)`, [`fp-${runId}`, JSON.stringify([{
    runId, sourceId: SOURCE, incarnation, target: 'a'.repeat(40), binding: { worktree_id: worktreeId }, ...header }])]);
  return runId;
}

describe('sync status --json checkpoint_blockers is always an array', () => {
  test('no cursor: an empty array', async () => {
    const status = await statusJson();
    expect(status.cursor).toBeNull();
    expect(status.checkpoint_blockers).toEqual([]);
    expect(status.cursors).toEqual([]);
  });

  test('an unfinished cursor before its checkpoint step: an empty array (no checkpoint is pending yet)', async () => {
    await cursor({ index: 1, total: 3, pending: { requestId: randomUUID(), intent: { kind: 'managed_sync_import', path: 'notes/two.md' } } });
    const status = await statusJson();
    expect(status.cursor).toMatchObject({ index: 1, total: 3, done: false });
    expect(status.checkpoint_blockers).toEqual([]);
    expect(Array.isArray(status.cursors)).toBe(true);
  });

  test('a finished cursor: an empty array', async () => {
    await cursor({ index: 3, total: 3, done: true });
    const status = await statusJson();
    expect(status.cursor).toMatchObject({ done: true });
    expect(status.checkpoint_blockers).toEqual([]);
    expect(Array.isArray(status.cursors)).toBe(true);
  });

  test('a cursor at its checkpoint behind a receipt that holds a recovery record: that receipt', async () => {
    const runId = randomUUID(), blocker = randomUUID();
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,
          terminal_reservation,state,error_code,error_message,recovery,intent,completed_at,updated_at,admitter_version,worktree_id)
        VALUES('local_cli','fixture',$1::uuid,'submit_job',$2,$3::uuid,'notes/two',$4,'{}'::jsonb,0,0,'failed','storage_error','x',$5::text::jsonb,$6::text::jsonb,
          now()-interval '1 hour',now()-interval '1 hour','0.60.243.0',$7::uuid)`,
      [blocker, SOURCE, incarnation, randomUUID(), JSON.stringify({ version: 1, path: '/nonexistent/x.md', root: '/nonexistent', beforeHash: null, afterHash: 'a' }),
        JSON.stringify({ kind: 'managed_sync_import', runId, index: 2 }), worktreeId]);
    });
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)`, [`fp-${runId}`, JSON.stringify([{
      runId, sourceId: SOURCE, incarnation, index: 3, total: 3, target: 'a'.repeat(40), binding: { worktree_id: worktreeId },
      pending: { requestId: randomUUID(), intent: { kind: 'managed_sync_checkpoint' } } }])]);
    const plain = await statusJson();
    expect(plain.checkpoint_blockers).toEqual([]);
    expect(plain.checkpoint_blockers_read).toMatchObject({ status: 'not_read', fix: { next: 'run', argv: ['gbrain', 'sync', 'status', '--source', SOURCE, '--detail', '--json'] } });
    const status = await statusJson('--detail');
    expect(status.cursor).toMatchObject({ index: 3, total: 3, done: false });
    expect(status.checkpoint_blockers).toEqual([expect.objectContaining({ request_id: blocker, slug: 'notes/two', recovery: true, knock_on: false })]);
    expect(status.checkpoint_blockers_read).toEqual({ status: 'read' });
    expect(Array.isArray(status.cursors)).toBe(true);
  });
});
