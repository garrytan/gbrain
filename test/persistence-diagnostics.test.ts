import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { initializeLocalPersistence, submitPageMutation } from '../src/core/persistence/page-mutations.ts';
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
    await engine.executeRaw('DROP INDEX persistence_effects_parked');
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
    expect(await runMigrations(engine)).toEqual({ applied: LATEST_VERSION - 164, current: LATEST_VERSION });
    const [upgraded] = await engine.executeRaw<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname='persistence_requests_database_pending'");
    expect(upgraded.indexdef).toBe(fresh.indexdef);
    const [parked] = await engine.executeRaw<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname='persistence_effects_parked'");
    expect(parked.indexdef).toContain('parked');
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
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

test('writer status labels the answering process consumer instead of reporting it as brain ingress (C-NEW-4)', async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    const diagnostics = await readWriterDiagnostics(engine) as Record<string, unknown> & { local_process_ingress: { state: string; scope: string } };
    expect(diagnostics.ingress).toBeUndefined();
    expect(diagnostics.local_process_ingress.state).toBe('not_running');
    expect(diagnostics.local_process_ingress.scope).toContain('another process may own');
  }
});

test('#5984 4.5: health never reports an overtaking claimed write as waiting, nor skips the overtaken sync row', async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    const ctx: OperationContext = { engine, config: { engine: engine.kind }, sourceId: 'default',
      remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    await initializeLocalPersistence(ctx);
    await engine.executeRaw("DELETE FROM config WHERE key LIKE 'persistence.limits.%'");
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    const admit = async (slug: string, intent: Record<string, unknown>) => {
      const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, slug);
      return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
        sourceIncarnation: source.incarnation, slug, requestId: randomUUID(), callerIntent: {}, intent });
    };
    const sync = await admit('inbox/overtaken-sync', { kind: 'managed_sync_import', content: 'a' });
    const laterSync = await admit('inbox/later-sync', { kind: 'managed_sync_import', content: 'b' });
    const foreground = await admit('inbox/overtaking-foreground', { content: 'c' });
    const worktree = randomUUID();
    await engine.executeRaw("INSERT INTO persistence_worktrees(id,owner_host_id,state) VALUES($1,$2,'active')", [worktree, randomUUID()]);
    await engine.executeRaw('UPDATE persistence_requests SET worktree_id=$2 WHERE id=ANY($1::uuid[])', [[sync.id, laterSync.id, foreground.id], worktree]);
    const read = async () => engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [[sync.id, laterSync.id, foreground.id]]);
    const earlier = async () => {
      const rows = await read();
      const facts = await writeHealthFacts(engine, rows);
      return Object.fromEntries(rows.filter(row => facts.has(row.id)).map(row => [row.slug, facts.get(row.id)!.earlier_write]));
    };
    // The later-sequence foreground write is claimed ahead of the queued sync rows that do not name its page.
    await engine.executeRaw("UPDATE persistence_requests SET state='running',execution_token=$2::uuid WHERE id=$1::uuid", [foreground.id, randomUUID()]);
    expect(await earlier()).toEqual({ 'inbox/overtaken-sync': false, 'inbox/later-sync': true, 'inbox/overtaking-foreground': false });
    // It commits first: the overtaken sync row is still the head and still reported pending, never skipped.
    await engine.executeRaw("UPDATE persistence_requests SET state='committed',execution_token=NULL,completed_at=now() WHERE id=$1::uuid", [foreground.id]);
    expect(await earlier()).toEqual({ 'inbox/overtaken-sync': false, 'inbox/later-sync': true });
    // The overtaken row is then claimed and publishes; the later sync row still waits on it while it runs.
    await engine.executeRaw("UPDATE persistence_requests SET state='running',execution_token=$2::uuid WHERE id=$1::uuid", [sync.id, randomUUID()]);
    expect(await earlier()).toEqual({ 'inbox/overtaken-sync': false, 'inbox/later-sync': true });
    await engine.executeRaw("UPDATE persistence_requests SET state='committed',execution_token=NULL,completed_at=now() WHERE id=$1::uuid", [sync.id]);
    expect(await earlier()).toEqual({ 'inbox/later-sync': false });
    await engine.executeRaw("UPDATE persistence_requests SET state='cancelled',completed_at=now() WHERE id=$1::uuid", [laterSync.id]);
  }
});

test('#5984 4.5: a foreground write publishing beside running lane groups is not reported waiting on them', async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    const ctx: OperationContext = { engine, config: { engine: engine.kind }, sourceId: 'default',
      remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    await initializeLocalPersistence(ctx);
    await engine.executeRaw("DELETE FROM config WHERE key LIKE 'persistence.limits.%'");
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    const admit = async (slug: string, intent: Record<string, unknown>) => {
      const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, slug);
      return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
        sourceIncarnation: source.incarnation, slug, requestId: randomUUID(), callerIntent: {}, intent });
    };
    const lane = await admit('inbox/lane-group', { kind: 'managed_sync_import', content: 'a', lane: randomUUID() });
    const foreground = await admit('inbox/beside-foreground', { content: 'b' });
    const worktree = randomUUID();
    await engine.executeRaw("INSERT INTO persistence_worktrees(id,owner_host_id,state) VALUES($1,$2,'active')", [worktree, randomUUID()]);
    await engine.executeRaw('UPDATE persistence_requests SET worktree_id=$2 WHERE id=ANY($1::uuid[])', [[lane.id, foreground.id], worktree]);
    await engine.executeRaw("UPDATE persistence_requests SET operation='submit_job' WHERE id=$1::uuid", [lane.id]);
    await engine.executeRaw("UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid() WHERE id=ANY($1::uuid[])", [[lane.id, foreground.id]]);
    const earlier = async () => {
      const rows = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [foreground.id]);
      return (await writeHealthFacts(engine, rows)).get(foreground.id)?.earlier_write;
    };
    expect(await earlier()).toBe(false);
    // A recovering sync row still comes first.
    await engine.executeRaw("UPDATE persistence_requests SET state='recovering' WHERE id=$1::uuid", [lane.id]);
    expect(await earlier()).toBe(true);
    await engine.executeRaw("UPDATE persistence_requests SET state='cancelled',execution_token=NULL,completed_at=now() WHERE id=ANY($1::uuid[])", [[lane.id, foreground.id]]);
  }
});

test('#6275: a publication in progress with its before-image record is not recovery; a recovering head or a lost claim is', async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    const ctx: OperationContext = { engine, config: { engine: engine.kind }, sourceId: 'default',
      remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    await initializeLocalPersistence(ctx);
    await engine.executeRaw("DELETE FROM config WHERE key LIKE 'persistence.limits.%'");
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    const admit = async (slug: string) => {
      const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, slug);
      return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
        sourceIncarnation: source.incarnation, slug, requestId: randomUUID(), callerIntent: {}, intent: { content: slug } });
    };
    const head = await admit('inbox/publishing-head'), behind = await admit('inbox/waiting-behind');
    const worktree = randomUUID();
    await engine.executeRaw("INSERT INTO persistence_worktrees(id,owner_host_id,state) VALUES($1,$2,'active')", [worktree, randomUUID()]);
    await engine.executeRaw('UPDATE persistence_requests SET worktree_id=$2 WHERE id=ANY($1::uuid[])', [[head.id, behind.id], worktree]);
    const health = async () => {
      const rows = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [[head.id, behind.id]]);
      const facts = await writeHealthFacts(engine, rows);
      return Object.fromEntries(rows.map(row => [row.slug, { recovery: facts.get(row.id)!.recovery_required, earlier: facts.get(row.id)!.earlier_write }]));
    };
    // The head publishes under a live claim with its ordinary recovery record (the file's before-image).
    await engine.executeRaw(`UPDATE persistence_requests SET state='running',execution_token=$2::uuid,claim_expires_at=now()+interval '30 seconds',
      recovery='{"version":1}'::jsonb WHERE id=$1::uuid`, [head.id, randomUUID()]);
    expect(await health()).toEqual({ 'inbox/publishing-head': { recovery: false, earlier: false }, 'inbox/waiting-behind': { recovery: false, earlier: true } });
    // Its claim lapsed with the record still there: recovery is required.
    await engine.executeRaw("UPDATE persistence_requests SET claim_expires_at=now()-interval '1 second' WHERE id=$1::uuid", [head.id]);
    expect((await health())['inbox/waiting-behind']!.recovery).toBe(true);
    // A recovering head is recovery too.
    await engine.executeRaw("UPDATE persistence_requests SET state='recovering',claim_expires_at=now()+interval '30 seconds' WHERE id=$1::uuid", [head.id]);
    expect((await health())['inbox/waiting-behind']!.recovery).toBe(true);
    await engine.executeRaw("UPDATE persistence_requests SET state='cancelled',recovery=NULL,execution_token=NULL,completed_at=now() WHERE id=ANY($1::uuid[])", [[head.id, behind.id]]);
  }
});
