/**
 * #6712 PR 2 (L5): a plain `gbrain sync status` skips its heavy reads but never reads as an all-clear (DX F1).
 *
 * Protects: every field keeps its type when skipped (arrays stay arrays, `terminal_failures` reads `unknown`) and its
 * `<field>_read` sibling says `not_read` with the --detail command; `state` / `reason` are in the outcome vocabulary;
 * the bounded oldest-blocker and recovery probes run without any cursor, so a source whose only problem is a recovery
 * record (or a queued write) is not `synced` and `next` names the recovery step (or the sync that drains the write); a probe that does not answer makes the
 * state `resumable` / `status_unknown`, never `synced`; --detail reads everything. One text headline per state.
 * Fails on the base: no `state`, `reason`, `oldest_blocker`, `recovery` or `*_read` fields.
 * PGLite in-memory.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readSyncStatus, SYNC_STATUS_REASONS, type SyncStatus } from '../src/core/persistence/sync-status.ts';
import { syncStatusHeadline } from '../src/commands/sync/operator.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const SOURCE = 'fast-src';
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM persistence_requests');
  await engine.executeRaw('DELETE FROM persistence_source_bindings');
});

async function seed(o: { state: string; recovery?: unknown; blocked?: string | null; worktreeId?: string }) {
  const requestId = randomUUID();
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,
      state,error_code,error_message,recovery,blocked_reason,intent,completed_at,updated_at,admitter_version,worktree_id)
    VALUES('local_cli','fixture',$1::uuid,'put_page',$2,(SELECT incarnation FROM sources WHERE id=$2),'notes/held',$3,'{}'::jsonb,0,0,$4,NULL,NULL,$5::text::jsonb,$6,'{"content":"x"}'::jsonb,
      CASE WHEN $4 IN ('queued','running') THEN NULL ELSE now()-interval '1 hour' END,now()-interval '1 hour','0.60.256.0',$7::uuid)`,
  [requestId, SOURCE, randomUUID(), o.state, o.recovery === undefined ? null : JSON.stringify(o.recovery), o.blocked ?? null, o.worktreeId ?? null]);
  return requestId;
}
/** A worktree bound to the source, the way every managed write of a source is queued. */
async function bindWorktree(): Promise<string> {
  const worktreeId = randomUUID();
  await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id) VALUES($1::uuid,$2::uuid)', [worktreeId, randomUUID()]);
  await engine.executeRaw('INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) SELECT id,incarnation,$2::uuid FROM sources WHERE id=$1', [SOURCE, worktreeId]);
  return worktreeId;
}
const RECOVERY = { version: 1, path: '/nonexistent/x.md', root: '/nonexistent', beforeHash: null, afterHash: 'a' };

describe('plain sync status', () => {
  test('a clean source: synced/nothing_pending, skipped fields keep their types and say not_read', async () => {
    const status = await readSyncStatus(engine, SOURCE, { detail: false });
    expect(status).toMatchObject({ state: 'synced', reason: 'nothing_pending', oldest_blocker: { status: 'ok', request: null }, recovery: { status: 'ok', count: 0, first: null } });
    expect(status.checkpoint_blockers).toEqual([]);
    expect(status.cursors).toEqual([]);
    expect(status.terminal_failures).toMatchObject({ status: 'unknown' });
    for (const read of [status.checkpoint_blockers_read, status.cursors_read, status.terminal_failures_read]) {
      expect(read).toMatchObject({ status: 'not_read', fix: { argv: ['gbrain', 'sync', 'status', '--source', SOURCE, '--detail', '--json'] } });
    }
    expect(SYNC_STATUS_REASONS).toContain(status.reason);
    expect(status.next).toBeNull();
  });

  test('a recovery record with no cursor is not an all-clear: resumable/recovery_pending and next is the recovery step', async () => {
    const held = await seed({ state: 'committed', recovery: RECOVERY });
    const status = await readSyncStatus(engine, SOURCE, { detail: false });
    expect(status.cursor).toBeNull();
    expect(status).toMatchObject({ state: 'resumable', reason: 'recovery_pending', recovery: { status: 'ok', count: 1, first: { request_id: held, blocked: false } } });
    expect(status.next?.argv).toEqual(['gbrain', 'sync', '--source', SOURCE, '--no-pull', '--json']);
    const detailed = await readSyncStatus(engine, SOURCE);
    expect(detailed.next?.argv).toEqual(status.next?.argv);
  });

  test('a recovery record that found changed bytes blocks the source', async () => {
    await seed({ state: 'committed', recovery: RECOVERY, blocked: 'unexpected_file_bytes' });
    expect(await readSyncStatus(engine, SOURCE, { detail: false })).toMatchObject({ state: 'blocked', reason: 'recovery_blocked' });
  });

  test('an unfinished write with no cursor and no recovery record is not an all-clear: resumable/request_pending and next drains it', async () => {
    const queued = await seed({ state: 'queued', worktreeId: await bindWorktree() });
    const status = await readSyncStatus(engine, SOURCE, { detail: false });
    expect(status.cursor).toBeNull();
    expect(status).toMatchObject({ state: 'resumable', reason: 'request_pending', oldest_blocker: { status: 'ok', request: { request_id: queued, state: 'queued' } }, recovery: { status: 'ok', count: 0 } });
    expect(status.next?.argv).toEqual(['gbrain', 'sync', ...status.resume_argv]);
    expect(status.next?.why).toContain(queued);
  });

  test('a probe that does not answer makes the state unknown, never synced', async () => {
    const failing = new Proxy(engine, { get(target, prop, receiver) {
      if (prop === 'executeRaw') return (sql: string, ...rest: unknown[]) => /recovery IS NOT NULL/.test(sql) && /count\(\*\)/.test(sql)
        ? Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))
        : (target.executeRaw as (...a: unknown[]) => unknown).call(target, sql, ...rest);
      return Reflect.get(target, prop, receiver);
    } }) as unknown as BrainEngine;
    const status = await readSyncStatus(failing, SOURCE, { detail: false });
    expect(status).toMatchObject({ state: 'resumable', reason: 'status_unknown', recovery: { status: 'unknown' } });
    expect(status.next?.argv).toEqual(['gbrain', 'sync', 'status', '--source', SOURCE, '--json']);
  });

  test('--detail reads everything and marks it read', async () => {
    const status = await readSyncStatus(engine, SOURCE, { detail: true });
    expect(status.terminal_failures).toMatchObject({ status: 'ok' });
    for (const read of [status.checkpoint_blockers_read, status.cursors_read, status.terminal_failures_read]) expect(read).toEqual({ status: 'read' });
  });
});

describe('one headline per state', () => {
  const base = { source_id: SOURCE, cursor: null, run_id: null, holds: [], live_job_id: null } as unknown as Pick<SyncStatus, 'source_id' | 'state' | 'reason' | 'cursor' | 'run_id' | 'holds' | 'live_job_id'>;
  test('every reason has a headline that names the state', () => {
    for (const reason of SYNC_STATUS_REASONS) {
      const line = syncStatusHeadline({ ...base, reason, state: 'synced' });
      expect(line.startsWith(`Source ${SOURCE}`)).toBe(true);
      expect(line).toMatch(/is synced|is resumable|is blocked|state unknown/);
    }
  });
});
