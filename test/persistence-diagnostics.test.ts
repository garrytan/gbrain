import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, writeHealthFacts } from '../src/core/persistence/journal.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { writerDiagnostics } from '../src/core/persistence/control.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { waitFor } from './helpers/wait-for.ts';
import { readWriterDiagnostics, WRITER_NEXT_ACTIONS } from '../src/core/persistence/diagnostics.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const local = new PGLiteEngine(); await local.connect({}); await local.initSchema(); engines.push(local);
  if (process.env.DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(isolated.engine); closePostgres = isolated.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
});

test('optional health enrichment bounds unresolved work and never invents fresh observations', async () => {
  const release = Promise.withResolvers<Record<string, unknown>[]>();
  let queries = 0;
  const engine = { kind: 'pglite', executeRaw: async () => { queries++; return release.promise; } } as unknown as BrainEngine;
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(), state: 'queued',
    worktree_id: null, source_incarnation: 'd7599b95-65c2-4d54-aa4e-cb5745af90cf', sequence: index + 1 } as WriteRequest));
  try {
    expect((await writeHealthFacts(engine, [])).size).toBe(0);
    expect((await writeHealthFacts(engine, rows.map(row => ({ ...row, state: 'committed' })))).size).toBe(0);
    expect(queries).toBe(0);
    const started = performance.now();
    expect((await writeHealthFacts(engine, rows)).size).toBe(0);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(queries).toBe(1);
    await Promise.all(Array.from({ length: 20 }, () => writeHealthFacts(engine, rows)));
    expect(queries).toBe(1);
    await expect(writeHealthFacts(engine, [...rows, rows[0]])).rejects.toThrow(RangeError);
  } finally { release.resolve([]); }
  await Bun.sleep(0);
  await writeHealthFacts(engine, rows);
  expect(queries).toBe(2);
});

test('failed optional enrichment returns no facts without making database writes', async () => {
  const engine = { kind: 'postgres', executeRaw: async (sql: string) => {
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/);
    throw new Error('PRIVATE_DRIVER_MARKER');
  } } as unknown as BrainEngine;
  expect((await writeHealthFacts(engine, [{ state: 'queued', source_incarnation: randomUUID() } as WriteRequest])).size).toBe(0);
});

for (const reason of ['writer_busy', 'database_contention']) test.each([0, 180000])(`trusted ${reason} advice agrees with health at age %d`, async age => {
  const row = { request_id: randomUUID(), state: 'queued', blocked_reason: reason, error_code: null,
    worktree_id: null, created_at: new Date(Date.now() - age) };
  const engine = { kind: 'pglite', executeRaw: async (sql: string) =>
    sql.startsWith('SELECT request_id,worktree_id,state,blocked_reason') ? [row] : [] } as unknown as BrainEngine;
  const [blocker] = (await readWriterDiagnostics(engine)).blockers;
  expect(blocker.diagnostic?.next_action).toBe(age >= 120000 ? 'inspect_owner' : 'poll');
  expect(blocker.next_action).toContain(WRITER_NEXT_ACTIONS[reason]);
  if (age >= 120000) expect(blocker.next_action).toContain('Inspect gbrain sources writer status');
  else expect(blocker.next_action).toBe(WRITER_NEXT_ACTIONS[reason]);
});

test('fresh and upgraded engines agree on the database-only pending index', async () => {
  for (const engine of engines) {
    const [fresh] = await engine.executeRaw<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname='persistence_requests_database_pending'");
    expect(fresh.indexdef).toContain('source_incarnation, sequence');
    expect(fresh.indexdef).toContain('worktree_id IS NULL');
    await engine.executeRaw('DROP INDEX persistence_requests_database_pending');
    if (engine.kind === 'postgres') {
      const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const holding = engine.transaction(async tx => {
        await tx.executeRaw('LOCK TABLE persistence_requests IN ROW EXCLUSIVE MODE');
        held.resolve(); await release.promise;
      });
      await held.promise;
      const abort = new AbortController();
      const interrupted = engine.executeRawDirect(fresh.indexdef.replace('CREATE INDEX ', 'CREATE INDEX CONCURRENTLY '), [], { signal: abort.signal })
        .then(() => false, () => true);
      try {
        await waitFor(async () => (await engine.executeRaw<{ indisvalid: boolean }>(
          "SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass('persistence_requests_database_pending')"))[0]?.indisvalid === false);
        abort.abort();
        expect(await interrupted).toBe(true);
      } finally { abort.abort(); release.resolve(); await holding; await interrupted; }
    }
    await engine.setConfig('version', '164');
    expect(await runMigrations(engine)).toEqual({ applied: 2, current: 166 });
    const [upgraded] = await engine.executeRaw<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname='persistence_requests_database_pending'");
    expect(upgraded.indexdef).toBe(fresh.indexdef);
    expect(await engine.getConfig('version')).toBe('166');
  }
}, 15000);

test('admin diagnostics account for queued work and configured limits without exposing intent', async () => {
  for (const engine of engines) {
    const ctx: OperationContext = { engine, config: { engine: engine.kind }, sourceId: 'default',
      remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'inbox/committed', content: 'Visible example', request_id: randomUUID() } });
    await disposePersistenceConsumer(engine);
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'inbox/queued');
    const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source.incarnation, slug: 'inbox/queued', requestId: randomUUID(),
      callerIntent: {}, intent: { content: 'PRIVATE_DIAGNOSTIC_INTENT_CANARY' } });
    await engine.executeRaw("UPDATE persistence_requests SET blocked_reason='owner_unavailable' WHERE id=$1::uuid", [row.id]);
    await engine.setConfig('persistence.limits.brain_outstanding', '1');
    const status = await writerDiagnostics(engine);
    expect(status.queue).toMatchObject([{ state: 'queued', count: 1 }]);
    const capacity = status.capacity.find(c => c.scope === 'brain' && c.resource === 'outstanding_count')!;
    expect(capacity).toMatchObject({ used: 1, limit: 1, remaining: 0, approaching_capacity: true });
    expect(capacity.next_action).toContain('persistence.limits.brain_outstanding');
    expect(status.blockers[0]).toMatchObject({ request_id: row.request_id });
    expect(status.blockers[0].next_action).toContain('designated owner');
    expect(JSON.stringify(status)).not.toContain('PRIVATE_DIAGNOSTIC_INTENT_CANARY');
    expect(JSON.stringify(status)).not.toContain('execution_token');
  }
});
