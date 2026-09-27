import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { registerLocalWriter, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, compactWriteReceipts, getWriteRequest, getWriteRequestById, receiptFor, type WriteAdmission } from '../src/core/persistence/journal.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { publishMutation, recoverPublication } from '../src/core/persistence/coordinator.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
const roots: string[] = [];
let closePostgres:(()=>Promise<void>)|undefined;
const sourceId = 'persistence-journal-test';
const hostId = randomUUID();
const input = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
const ctx = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind }, sourceId, remote: false,
  dryRun: false, logger: { info() {}, warn() {}, error() {} } });

beforeAll(async () => {
  const pg = process.env.DATABASE_URL;
  const local = new PGLiteEngine();
  await local.connect({}); await local.initSchema(); engines.push(local);
  if (pg) {
    assertSafeE2eDatabaseUrl(pg);
    const isolated=await isolatedPersistencePostgres(pg);
    closePostgres=isolated.close;engines.push(isolated.engine);
  }
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await registerLocalWriter(engine, 'cli');
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]); await engine.disconnect(); }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closePostgres?.();
});
async function admission(engine: BrainEngine, slug: string, content = 'new', extra: Partial<WriteAdmission> = {}): Promise<WriteAdmission> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  const authority = await submissionAuthority(ctx(engine), 'put_page', sourceId, source.incarnation, slug);
  const page = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  return { principal: authority.principal, operation: 'put_page', sourceId, sourceIncarnation: source.incarnation, slug,
    pageId: page?.page.id ?? null, requestId: randomUUID(), callerIntent: { content }, intent: { content }, authority, ...extra };
}

describe('durable mutation journal', () => {
  test('admission retries a rolled-back transaction with one retained ID and one quota reservation', async () => {
    for (const engine of engines) {
      const a = await admission(engine, `admission-retry-${engine.kind}`);
      let attempts = 0;
      const retrying = new Proxy(engine, { get(target, property) {
        if (property === 'transaction') return (run: (tx: BrainEngine) => Promise<unknown>) => target.transaction(async tx => {
          const result = await run(tx);
          if (++attempts === 1) throw Object.assign(new Error('injected serialization abort after admission'), { code: '40001' });
          return result;
        });
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const before = await engine.executeRaw<{ outstanding_count: string; lifetime_ids: string }>(
        "SELECT outstanding_count::text,lifetime_ids::text FROM persistence_counters WHERE key='brain'");
      const accepted = await admitWrite(retrying, a);
      expect(attempts).toBe(2);
      expect(accepted.request_id).toBe(a.requestId!);
      const [after] = await engine.executeRaw<{ outstanding_count: string; lifetime_ids: string }>(
        "SELECT outstanding_count::text,lifetime_ids::text FROM persistence_counters WHERE key='brain'");
      expect(Number(after.outstanding_count)).toBe(Number(before[0]?.outstanding_count ?? 0) + 1);
      expect(Number(after.lifetime_ids)).toBe(Number(before[0]?.lifetime_ids ?? 0) + 1);
      expect((await admitWrite(engine, a)).id).toBe(accepted.id);
      await cancelWriteRequest(engine, a.principal, a.requestId!);
    }
  });

  test('Postgres admission survives a real counter lock held beyond one SQL lock deadline', async () => {
    const engine = engines.find(candidate => candidate.kind === 'postgres');
    if (!engine) return;
    const a = await admission(engine, 'admission-counter-contention');
    let held!: () => void;
    const ready = new Promise<void>(resolve => { held = resolve; });
    const blocker = engine.transaction(async tx => {
      await tx.executeRaw("SELECT key FROM persistence_counters WHERE key='brain' FOR UPDATE");
      held();
      await new Promise(resolve => setTimeout(resolve, 1400));
    });
    await ready;
    try {
      const accepted = await admitWrite(engine, a);
      expect(accepted.state).toBe('queued');
      expect(accepted.request_id).toBe(a.requestId!);
      expect((await admitWrite(engine, a)).id).toBe(accepted.id);
      await cancelWriteRequest(engine, a.principal, a.requestId!);
    } finally { await blocker; }
  });

  test('persistent Postgres contention returns a bounded typed error without inventing an accepted receipt', async () => {
    const engine = engines.find(candidate => candidate.kind === 'postgres');
    if (!engine) return;
    const a = await admission(engine, 'admission-bounded-contention');
    let held!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { held = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const blocker = engine.transaction(async tx => {
      await tx.executeRaw("SELECT key FROM persistence_counters WHERE key='brain' FOR UPDATE");
      held();
      await released;
    });
    await ready;
    const started = performance.now();
    try {
      const error = await admitWrite(engine, a).then(() => null, error => error);
      expect(error).toBeInstanceOf(OperationError);
      expect(error).toMatchObject({ code: 'storage_error', writeError: 'storage_error' });
      expect(error.suggestion).toContain(a.requestId!);
      expect(error.writeRequest).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(6000);
      expect(await getWriteRequest(engine, a.principal, a.requestId!)).toBeNull();
    } finally { release(); await blocker; }
    const accepted = await admitWrite(engine, a);
    expect(accepted.request_id).toBe(a.requestId!);
    await cancelWriteRequest(engine, a.principal, a.requestId!);
  });

  test('Postgres admission progresses while short counter transactions keep the lock queue occupied', async () => {
    const engine = engines.find(candidate => candidate.kind === 'postgres');
    if (!engine) return;
    const a = await admission(engine, 'admission-queue-progress');
    await engine.executeRaw("INSERT INTO persistence_counters(key) VALUES('brain') ON CONFLICT DO NOTHING");
    const [before] = await engine.executeRaw<{ lifetime_ids: string }>("SELECT lifetime_ids::text FROM persistence_counters WHERE key='brain'");
    let stop = false;
    let cycles = 0;
    const lockers: Promise<void>[] = [];
    const ready = Array.from({ length: 2 }, () => {
      let held!: () => void;
      const holding = new Promise<void>(resolve => { held = resolve; });
      lockers.push((async () => {
        while (!stop) await engine.transaction(async tx => {
          await tx.executeRaw("SELECT key FROM persistence_counters WHERE key='brain' FOR UPDATE");
          cycles++;
          held();
          await Bun.sleep(40);
        });
      })());
      return holding;
    });
    let accepted: Awaited<ReturnType<typeof admitWrite>>;
    try {
      await Promise.all(ready);
      accepted = await admitWrite(engine, a);
    } finally {
      stop = true;
      await Promise.all(lockers);
    }
    expect(cycles).toBeGreaterThan(2);
    expect(accepted.state).toBe('queued');
    expect(accepted.request_id).toBe(a.requestId!);
    expect((await admitWrite(engine, a)).id).toBe(accepted.id);
    const [after] = await engine.executeRaw<{ lifetime_ids: string }>("SELECT lifetime_ids::text FROM persistence_counters WHERE key='brain'");
    expect(Number(after.lifetime_ids) - Number(before.lifetime_ids)).toBe(1);
    await cancelWriteRequest(engine, a.principal, a.requestId!);
  }, 15000);

  test('contended admissions release PostgreSQL pool capacity for reads before the counter unlocks', async () => {
    const engine = engines.find(candidate => candidate.kind === 'postgres');
    if (!engine) return;
    const inputs = await Promise.all(Array.from({ length: 3 }, (_, i) => admission(engine, `admission-reader-capacity-${i}`)));
    await engine.executeRaw("INSERT INTO persistence_counters(key) VALUES('brain') ON CONFLICT DO NOTHING");
    const [before] = await engine.executeRaw<{ lifetime_ids: string }>("SELECT lifetime_ids::text FROM persistence_counters WHERE key='brain'");
    let release!: () => void; let held!: () => void; let attempted!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { held = resolve; });
    const attemptsReady = new Promise<void>(resolve => { attempted = resolve; });
    const attempts = new Set<string>();
    const blocker = engine.transaction(async tx => {
      await tx.executeRaw("SELECT key FROM persistence_counters WHERE key='brain' FOR UPDATE");
      held(); await released;
    });
    const writes: Promise<Awaited<ReturnType<typeof admitWrite>>>[] = [];
    let read: Promise<unknown> | undefined;
    try {
      await ready;
      for (const input of inputs) {
        const observed = new Proxy(engine, { get(target, property) {
          if (property === 'transaction') return (run: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => run(new Proxy(tx, { get(t, p) {
            if (p === 'executeRaw') return (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) => {
              if (sql.startsWith('INSERT INTO persistence_counters') && params?.[0] === 'brain') {
                attempts.add(input.requestId!);
                if (attempts.size === inputs.length) attempted();
              }
              return t.executeRaw(sql, params, opts);
            };
            const value = Reflect.get(t, p); return typeof value === 'function' ? value.bind(t) : value;
          } })));
          const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
        } });
        writes.push(admitWrite(observed, input));
      }
      expect(await Promise.race([attemptsReady.then(() => true), Bun.sleep(2000).then(() => false)])).toBe(true);
      read = engine.executeRaw('SELECT 1 AS reader_progress');
      expect(await Promise.race([read.then(() => true), Bun.sleep(200).then(() => false)])).toBe(true);
    } finally { release(); await blocker; await Promise.allSettled(writes); await read; }
    const accepted = await Promise.all(writes);
    const [after] = await engine.executeRaw<{ lifetime_ids: string }>("SELECT lifetime_ids::text FROM persistence_counters WHERE key='brain'");
    expect(Number(after.lifetime_ids) - Number(before.lifetime_ids)).toBe(inputs.length);
    for (let i = 0; i < inputs.length; i++) {
      expect(accepted[i].request_id).toBe(inputs[i].requestId!);
      expect(accepted[i].state).toBe('queued');
      expect((await admitWrite(engine, inputs[i])).id).toBe(accepted[i].id);
      await cancelWriteRequest(engine, inputs[i].principal, inputs[i].requestId!);
    }
  }, 15000);

  test('activation rejects legacy canonical writers but accepts guarded publication', async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        await expect(engine.putPage('unguarded', input('No'), { sourceId })).rejects.toThrow('writer_coordinator_required');
        await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
          await tx.putPage('guarded', input('Yes'), { sourceId });
          await tx.addTag('guarded', 'coherent', { sourceId });
        }));
        expect((await engine.readPageSnapshot('guarded', { sourceId }))!.tags).toEqual(['coherent']);
        await expect(engine.addTag('guarded', 'uncoordinated', { sourceId })).rejects.toThrow('writer_coordinator_required');
      } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
    }
  });
  test('concurrent duplicate admissions reserve one ID and conflict on altered intent', async () => {
    for (const engine of engines) {
      const a = await admission(engine, 'duplicate');
      const rows = await Promise.all(Array.from({ length: 8 }, () => admitWrite(engine, a)));
      expect(new Set(rows.map(r => r.id)).size).toBe(1);
      await expect(admitWrite(engine, { ...a, callerIntent: { content: 'altered' } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
      const cancelled = await cancelWriteRequest(engine, a.principal, a.requestId!);
      expect(cancelled!.state).toBe('cancelled');
      expect((await admitWrite(engine, a)).state).toBe('cancelled');
      expect(receiptFor(cancelled!).retry_after_ms).toBeNull();
    }
  });
  test('two accepted create-only intents have exactly one commit', async () => {
    for (const engine of engines) {
      const a = await admission(engine, 'create-race', 'A');
      const b = await admission(engine, 'create-race', 'B');
      await Promise.all([admitWrite(engine, a), admitWrite(engine, b)]);
      const first = (await claimNextWrite(engine, hostId))!;
      const committed = await publishMutation(engine, first, { observedRevision: null,
        apply: async tx => { await tx.putPage(first.slug, input(String(first.intent!.content)), { sourceId }); return { status: 'created' }; } }, hostId);
      expect(committed.state).toBe('committed');
      const second = (await claimNextWrite(engine, hostId))!;
      const conflict = await publishMutation(engine, second, { observedRevision: null, apply: async () => { throw new Error('must not execute'); } }, hostId);
      expect(conflict.state).toBe('conflict');
      expect((await engine.readPageSnapshot(first.slug, { sourceId }))!.revision).toBe(String(committed.outcome!.revision));
    }
  });
  test('stale no-op loses its revision precondition before no-op detection', async () => {
    for (const engine of engines) {
      const page = await engine.putPage('stale-noop', input('Original'), { sourceId });
      const a = await admission(engine, 'stale-noop', 'Original', { intent: { content: 'Original', expected_revision: page.knowledge_revision } });
      const row = await admitWrite(engine, a);
      await engine.addTag('stale-noop', 'changed', { sourceId });
      await expect(preparePageMutation(engine, row, { engine: engine.kind })).rejects.toMatchObject({ code: 'revision_conflict' });
      await cancelWriteRequest(engine, a.principal, a.requestId!);
    }
  });
  test('quota admits exactly its budget, duplicates consume none, terminal reservations remain', async () => {
    for (const engine of engines) {
      const local = await registerLocalWriter(engine, 'stdio');
      const [inc] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
      const authority = await submissionAuthority({ ...ctx(engine), remote: true }, 'put_page', sourceId, inc.incarnation, 'quota');
      const base = await admission(engine, 'quota');
      const requests = Array.from({ length: 3 }, () => ({ ...base, principal: authority.principal, authority, requestId: randomUUID() }));
      const results = await Promise.allSettled(requests.map(a => admitWrite(engine, a, { principalOutstanding: 2 })));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
      for (const a of requests) {
        const row = await getWriteRequest(engine, a.principal, a.requestId);
        if (row) {
          expect((await admitWrite(engine, a, { principalOutstanding: 2 })).id).toBe(row.id);
          await cancelWriteRequest(engine, a.principal, a.requestId);
        }
      }
      const [counter] = await engine.executeRaw<{ outstanding_count: number; lifetime_ids: number; terminal_bytes: number }>(
        'SELECT * FROM persistence_counters WHERE key=$1', [`principal:local_stdio:${local.id}`]);
      expect(Number(counter.outstanding_count)).toBe(0);
      expect(Number(counter.lifetime_ids)).toBe(2);
      expect(Number(counter.terminal_bytes)).toBeGreaterThan(0);
    }
  });
  test('file failure restores original bytes, leaves old database revision, and retains one outcome', async () => {
    for (const engine of engines) {
      const root = mkdtempSync(join(tmpdir(), 'gbrain-journal-root-')); roots.push(root);
      const fileSource = `${sourceId}-${randomUUID().slice(0,8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2) ON CONFLICT(id) DO UPDATE SET local_path=$2', [fileSource, root]);
      const binding = await claimWorktree(engine, fileSource, root, hostId);
      const page = await engine.putPage('file', input('Before'), { sourceId: fileSource });
      const path = join(root, 'file.md'); writeFileSync(path, 'Before');
      const authority = await submissionAuthority({ ...ctx(engine), sourceId: fileSource }, 'put_page', fileSource, binding.source_incarnation, 'file');
      const a = { ...(await admission(engine, 'file')), principal: authority.principal, authority, sourceId: fileSource,
        sourceIncarnation: binding.source_incarnation, pageId: page.id, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation };
      await admitWrite(engine, a);
      const row = (await claimNextWrite(engine, hostId))!;
      const uncertain = await publishMutation(engine, row, { observedRevision: page.knowledge_revision!, file: { path, root, content: 'After' },
        apply: async tx => { await tx.putPage('file', input('After'), { sourceId: fileSource }); return {}; } }, hostId,
      { boundary: async name => { if (name === 'before_commit') throw Object.assign(new Error('simulated serialization rollback'), {code:'40001'}); } });
      expect(uncertain.state).toBe('queued');
      expect(readFileSync(path, 'utf8')).toBe('Before');
      expect((await engine.getPage('file', { sourceId: fileSource }))!.knowledge_revision).toBe(page.knowledge_revision!);
      const retry = (await claimNextWrite(engine, hostId))!;
      const committed = await publishMutation(engine, retry, { observedRevision: page.knowledge_revision!, file: { path, root, content: 'After' },
        apply: async tx => { await tx.putPage('file', input('After'), { sourceId: fileSource }); return { status: 'updated' }; } }, hostId,
      { boundary: async name => { if (name === 'after_commit') throw new Error('lost response'); } });
      expect(committed.state).toBe('committed');
      expect(readFileSync(path, 'utf8')).toBe('After');
      expect((await getWriteRequestById(engine, row.id))!.recovery).toBeNull();
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [fileSource]);
    }
  });
  test('compaction preserves terminal identity and frozen result', async () => {
    for (const engine of engines) {
      const a = await admission(engine, 'compact');
      const row = await admitWrite(engine, a);
      await cancelWriteRequest(engine, a.principal, a.requestId!);
      await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE id=$1::uuid", [row.id]);
      expect(await compactWriteReceipts(engine)).toBeGreaterThan(0);
      const replay = await admitWrite(engine, a);
      expect(replay.compacted).toBe(true); expect(replay.state).toBe('cancelled'); expect(replay.intent).toBeNull();
    }
  });
  test('database-configured quotas govern all admissions and compaction releases only diagnostic space', async () => {
    for (const engine of engines) {
      const a = await admission(engine, 'configured-quota');
      await engine.setConfig('persistence.limits.principal_outstanding', '0');
      try { await expect(admitWrite(engine, a)).rejects.toMatchObject({ code: 'queue_capacity' }); }
      finally { await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.principal_outstanding'"); }
      const accepted = await admitWrite(engine, a);
      await cancelWriteRequest(engine, a.principal, a.requestId!);
      await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE id=$1::uuid", [accepted.id]);
      const before = Number(accepted.terminal_reservation);
      await compactWriteReceipts(engine);
      const compact = (await getWriteRequest(engine, a.principal, a.requestId!))!;
      expect(Number(compact.terminal_reservation)).toBeLessThan(before);
      expect(Number(compact.terminal_reservation)).toBeGreaterThan(1024);
      expect(compact.authority).toEqual(accepted.authority);
      expect((await admitWrite(engine, a)).id).toBe(accepted.id);
    }
  });
});
