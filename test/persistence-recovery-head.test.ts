/** The recovery-head inspector has one job: disclose a safe, owned metadata projection without waking a consumer. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parsePersistenceAdminArgs } from '../src/commands/persistence-admin.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { readRecoveryHead } from '../src/core/persistence/recovery-head.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-recovery-head-'));
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

interface Fixture { engine: PGLiteEngine; sourceId: string; worktreeId: string; principalId: string; }
async function fixture(run: (value: Fixture) => Promise<void>): Promise<void> {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const principalId = (await registerLocalWriter(engine, 'cli')).id;
    const sourceId = `recovery-head-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const worktreeId = randomUUID();
    await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id) VALUES($1::uuid,$2::uuid)', [worktreeId, localHostId()]);
    await engine.executeRaw(`INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id)
      SELECT id,incarnation,$2::uuid FROM sources WHERE id=$1`, [sourceId, worktreeId]);
    await run({ engine, sourceId, worktreeId, principalId });
  });
}

async function recover(f: Fixture, opts: { sourceId?: string; principalId?: string; operation?: string; recovery?: unknown; blockedReason?: string } = {}) {
  const requestId = randomUUID();
  await f.engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,authority,intent,intent_bytes,terminal_reservation,state,recovery,blocked_reason)
    VALUES('local_cli',$1,$2::uuid,$3,$4,(SELECT incarnation FROM sources WHERE id=$4),'private/never-disclose',$5::uuid,'d','{}'::jsonb,'{}'::jsonb,0,0,'recovering',$6::text::jsonb,'write_interrupted')`,
  [opts.principalId ?? f.principalId, requestId, opts.operation ?? 'submit_job', opts.sourceId ?? f.sourceId, f.worktreeId,
    JSON.stringify(opts.recovery ?? { version: 1, private_path: '/do/not/disclose', token: 'never-disclose' })]);
  return requestId;
}

test('recovery-head exposes only the current source writer\'s validated metadata projection', () => fixture(async f => {
  const requestId = await recover(f);
  const out = await readRecoveryHead(f.engine, f.sourceId);
  expect(out).toEqual({ status: 'present', source_id: f.sourceId, worktree_bound: true, request_id: requestId,
    sequence: '1', operation: 'submit_job', state: 'recovering', recovery: true, blocked_reason: 'write_interrupted' });
  expect(JSON.stringify(out)).not.toContain('private/never-disclose');
  expect(JSON.stringify(out)).not.toContain('never-disclose');
}));

test('recovery-head discloses neither another principal\'s head nor unknown fields', () => fixture(async f => {
  const foreignId = await recover(f, { principalId: randomUUID() });
  const foreign = await readRecoveryHead(f.engine, f.sourceId);
  expect(foreign).toEqual({ status: 'unavailable', source_id: f.sourceId, worktree_bound: true, reason: 'recovery_head_not_owned' });
  expect(JSON.stringify(foreign)).not.toContain(foreignId);

  await f.engine.executeRaw('DELETE FROM persistence_requests WHERE request_id=$1::uuid', [foreignId]);
  const unknownId = await recover(f, { operation: 'future_private_operation' });
  const unknown = await readRecoveryHead(f.engine, f.sourceId);
  expect(unknown).toEqual({ status: 'unavailable', source_id: f.sourceId, worktree_bound: true, reason: 'field_unvalidated' });
  expect(JSON.stringify(unknown)).not.toContain(unknownId);

  await f.engine.executeRaw('DELETE FROM persistence_requests WHERE request_id=$1::uuid', [unknownId]);
  const unsafeReason = 'path:/private/never-disclose';
  const unsafeId = await recover(f, { blockedReason: unsafeReason });
  await f.engine.executeRaw('UPDATE persistence_requests SET blocked_reason=$2 WHERE request_id=$1::uuid', [unsafeId, unsafeReason]);
  const unsafe = await readRecoveryHead(f.engine, f.sourceId);
  expect(unsafe).toEqual({ status: 'unavailable', source_id: f.sourceId, worktree_bound: true, reason: 'field_unvalidated' });
  expect(JSON.stringify(unsafe)).not.toContain(unsafeReason);
}));

test('recovery-head refuses an unbound source and a binding that changes between reads', () => fixture(async f => {
  await f.engine.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1', [f.sourceId]);
  expect(await readRecoveryHead(f.engine, f.sourceId)).toEqual({ status: 'unavailable', source_id: f.sourceId, worktree_bound: false, reason: 'source_unbound' });

  await f.engine.executeRaw(`INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id)
    SELECT id,incarnation,$2::uuid FROM sources WHERE id=$1`, [f.sourceId, f.worktreeId]);
  await recover(f);
  const real = f.engine;
  const racing = new Proxy(real, { get(target, key, receiver) {
    if (key !== 'transaction') return Reflect.get(target, key, receiver);
    return async (fn: (tx: BrainEngine) => Promise<Record<string, unknown>>) => target.transaction(async tx => {
      let bindingReads = 0;
      const view = new Proxy(tx, { get(inner, innerKey, innerReceiver) {
        if (innerKey !== 'executeRaw') return Reflect.get(inner, innerKey, innerReceiver);
        return async (sql: string, params?: unknown[]) => {
          const rows = await inner.executeRaw(sql, params);
          if (sql.includes('FROM sources s') && ++bindingReads === 2) return rows.map((row: Record<string, unknown>) => ({ ...row, worktree_id: randomUUID() }));
          return rows;
        };
      } });
      return fn(view as BrainEngine);
    });
  } }) as BrainEngine;
  expect(await readRecoveryHead(racing, f.sourceId)).toEqual({ status: 'unavailable', source_id: f.sourceId, worktree_bound: true, reason: 'binding_changed' });
}));

test('recovery-head reports the bound source with no retained head and is parsed as a source-only command', () => fixture(async f => {
  expect(await readRecoveryHead(f.engine, f.sourceId)).toEqual({ status: 'none', source_id: f.sourceId, worktree_bound: true });
  expect(parsePersistenceAdminArgs('writer', ['recovery-head', f.sourceId, '--json'])).toMatchObject({ operation: 'writer_recovery_head', params: { source_id: f.sourceId }, json: true });
}));
