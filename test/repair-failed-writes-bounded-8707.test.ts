/**
 * #8707: `gbrain repair failed-writes` previews stay bounded on a large request table, with the same classes as before.
 *
 * The preview used to read the request table once per refused write, several times over (replay attempts by request id,
 * the later requests of the page, a correlated fact-recovery check the planner ran for every candidate), so on a large
 * brain one statement outlasted the statement timeout and the preview died with `internal_error`. The test pins that
 * the preview's request-table statements do not grow with the number of refused writes, that each class it lists is
 * the one the per-row rules give, and that a statement the server ends at its timeout comes back as the
 * `repair_preview_timeout` refusal with a fix, nothing saved. Runs on PGLite and, through test/e2e, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { digest } from '../src/core/persistence/digest.ts';
import { FACTS_ENTITY_MOVED_MESSAGES } from '../src/core/persistence/verb-errors.ts';
import { PERSISTENCE_REQUEST_REPLAY_ID_INDEX, PERSISTENCE_REQUEST_SLUG_SEQUENCE_INDEX } from '../src/core/persistence/schema.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { deadlineBoundEngine, StatementDeadlineError, withStatementDeadline, type StatementDeadline } from '../src/core/statement-deadline.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const logger = { info() {}, warn() {}, error() {} };
const replayId = (failedId: string, attempt: number) => {
  const h = digest(['failed-writes-replay-v1', failedId, attempt]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Counts the statements that read the request table, through the engine the repair runner is given. */
function counting(engine: BrainEngine): { engine: BrainEngine; reads: () => number } {
  let reads = 0;
  const view = new Proxy(engine, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key !== 'executeRaw') return typeof value === 'function' ? value.bind(target) : value;
    return (sql: string, ...rest: unknown[]) => { if (sql.includes('persistence_requests')) reads++; return (value as Function).call(target, sql, ...rest); };
  } }) as BrainEngine;
  return { engine: view, reads: () => reads };
}

async function receipt(engine: BrainEngine, sourceId: string, incarnation: string, row: { operation: string; slug: string; state: string; digest?: string;
  intent?: Record<string, unknown> | null; outcome?: Record<string, unknown>; error_code?: string; error_message?: string; request_id?: string; compacted?: boolean }): Promise<string> {
  const [inserted] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,
      authority,state,intent_bytes,terminal_reservation,outcome,error_code,error_message,compacted)
    VALUES('local_cli','cli',$1::uuid,$2,$3,$4::uuid,$5,$6,$7::text::jsonb,'{}'::jsonb,$8,100,100,$9::text::jsonb,$10,$11,$12) RETURNING id::text`,
    [row.request_id ?? randomUUID(), row.operation, sourceId, incarnation, row.slug, row.digest ?? randomUUID(), row.intent === null ? null : JSON.stringify(row.intent ?? {}),
      row.state, row.outcome ? JSON.stringify(row.outcome) : null, row.error_code ?? null, row.error_message ?? null, row.compacted ?? false]);
  return inserted!.id;
}

/** A source with a committed history and every preview class among its refused writes; `extra` more plain refused remembers. */
async function seed(engine: BrainEngine, extra: number): Promise<{ sourceId: string; expected: Map<string, string> }> {
  const sourceId = `b8707-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,NULL)', [sourceId]);
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const add = (row: Parameters<typeof receipt>[3]) => receipt(engine, sourceId, incarnation, row);
  const refused = { state: 'conflict', error_code: 'source_changed', error_message: 'refused' };
  const expected = new Map<string, string>();
  for (let i = 0; i < 30; i++) await add({ operation: 'put_page', slug: `people/history-${i}`, state: 'committed', intent: i % 3 ? { kind: 'managed_sync_import' } : null, compacted: i % 3 === 0 });
  expected.set(await add({ operation: 'remember', slug: 'people/alice-example', ...refused, intent: { entity_slug: 'people/alice-example', claim: 'a' } }), 'replay');
  const same = randomUUID();
  expected.set(await add({ operation: 'remember', slug: 'people/alice-example', ...refused, digest: same, intent: { entity_slug: 'people/alice-example', claim: 'b' } }), 'already_written');
  await add({ operation: 'remember', slug: 'people/alice-example', state: 'committed', digest: same, intent: { entity_slug: 'people/alice-example', claim: 'b' } });
  const twin = randomUUID();
  expected.set(await add({ operation: 'remember', slug: 'people/bob-example', ...refused, digest: twin, intent: { entity_slug: 'people/bob-example', claim: 'c' } }), 'duplicate');
  expected.set(await add({ operation: 'remember', slug: 'people/bob-example', state: 'failed', error_code: 'writer_coordinator_required', digest: twin,
    intent: { entity_slug: 'people/bob-example', claim: 'c' } }), 'replay');
  expected.set(await add({ operation: 'remember', slug: 'people/carol-example', ...refused, intent: { claim: 'unpinned' } }), 'unpinned_target');
  const replayed = await add({ operation: 'add_timeline_entry', slug: 'people/carol-example', state: 'failed', error_code: 'writer_coordinator_required', intent: { slug: 'people/carol-example', summary: 's' } });
  await add({ operation: 'add_timeline_entry', slug: 'people/carol-example', state: 'conflict', error_code: 'source_changed', request_id: replayId(replayed, 0), intent: { slug: 'people/carol-example', summary: 's' } });
  await add({ operation: 'add_timeline_entry', slug: 'people/carol-example', state: 'committed', request_id: replayId(replayed, 1), intent: { slug: 'people/carol-example', summary: 's' } });
  expected.set(replayed, 'already_written');
  expected.set(await add({ operation: 'put_page', slug: 'people/dana-example', ...refused, intent: { slug: 'people/dana-example', content: 'x' } }), 'superseded');
  await add({ operation: 'delete_page', slug: 'people/dana-example', state: 'committed', intent: { slug: 'people/dana-example' }, compacted: true });
  const moved = { state: 'conflict', error_code: 'revision_conflict', error_message: FACTS_ENTITY_MOVED_MESSAGES[0] };
  const recovered = await add({ operation: 'extract_facts', slug: 'people/erin-example', ...moved, intent: { kind: 'managed_facts_entity', inputDigest: 'd1', batchKey: '0' } });
  await add({ operation: 'extract_facts', slug: 'people/erin-example', state: 'committed', intent: null, compacted: true, outcome: { input_digest: 'd1', batch_key: '1' } });
  expected.set(recovered, 'not_listed');
  expected.set(await add({ operation: 'extract_facts', slug: 'people/erin-example', ...moved, intent: { kind: 'managed_facts_entity', inputDigest: 'd2', batchKey: '0' } }), 'producer_owned');
  for (let i = 0; i < extra; i++) {
    expected.set(await add({ operation: 'remember', slug: `people/extra-${i % 7}`, ...refused, intent: { entity_slug: `people/extra-${i % 7}`, claim: `e${i}` } }), 'replay');
    await add({ operation: 'put_page', slug: `people/history-${i}`, state: 'committed', intent: { kind: 'managed_sync_import' } });
  }
  return { sourceId, expected };
}

async function preview(engine: BrainEngine, sourceId: string) {
  const scope = await resolveRepairScope(engine, sourceId);
  return (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
}

for (const backend of testBackends()) describe(`[${backend}] #8707 the failed-writes preview on a large request table`, () => {
  let engine: BrainEngine;
  let databaseUrl: string | undefined;
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; databaseUrl = pg.databaseUrl; closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); await closePostgres?.(); }, 60_000);

  test('request-table reads do not grow with the refused writes, and each write gets the class its rules give', async () => {
    const reads: number[] = [];
    for (const extra of [5, 60]) {
      const { sourceId, expected } = await seed(engine, extra);
      const view = counting(engine);
      const result = await preview(view.engine, sourceId);
      reads.push(view.reads());
      const listed = new Map((result.listing ?? []).map(entry => [/request ([0-9a-f-]{36})\)/.exec(entry.item)![1]!, entry.class]));
      for (const [id, klass] of expected) expect([id, listed.get(id) ?? 'not_listed']).toEqual([id, klass]);
      expect(listed.size).toBe([...expected.values()].filter(klass => klass !== 'not_listed').length);
      expect(result.residuals).toMatchObject({ already_written: 2, duplicate: 1, unpinned_target: 1, superseded: 1 });
    }
    expect(reads[1]).toBe(reads[0]);
  }, 120_000);

  test('a preview read the server ends at its timeout is a repair_preview_timeout refusal with a fix; nothing is saved', async () => {
    const { sourceId } = await seed(engine, 3);
    const checkpoints = async () => Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM op_checkpoints WHERE op='repair-approval'"))[0]!.n);
    const before = await checkpoints();
    const refused = async (target: BrainEngine) => {
      const error = await preview(target, sourceId).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(OperationError);
      const refusal = error as OperationError;
      expect(refusal.code).toBe('repair_preview_timeout');
      expect(refusal.retryable).toBe(false);
      expect(refusal.message).toContain('Nothing was saved');
      return refusal;
    };
    if (backend === 'postgres') {
      // A real server timeout: another session holds the request table, and the preview's connection has a 1 s statement timeout.
      const timed = await withEnv({ GBRAIN_STATEMENT_TIMEOUT: '1s' }, async () => { const e = new PostgresEngine(); await e.connect({ database_url: databaseUrl!, poolSize: 1 }); return e; });
      try {
        const refusal = await engine.transaction(async tx => {
          await tx.executeRaw('LOCK TABLE persistence_requests IN ACCESS EXCLUSIVE MODE');
          return refused(timed);
        });
        expect(refusal.fix).toMatchObject({ actor: 'host_admin', argv: ['env', 'GBRAIN_STATEMENT_TIMEOUT=15min', 'gbrain', 'repair', 'failed-writes', '--source', sourceId, '--json'] });
      } finally { await timed.disconnect(); }
    } else {
      const timeout = new Proxy(engine, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== 'executeRaw') return typeof value === 'function' ? value.bind(target) : value;
        return (sql: string, ...rest: unknown[]) => sql.includes('request_id = ANY')
          ? Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))
          : (value as Function).call(target, sql, ...rest);
      } }) as BrainEngine;
      expect((await refused(timeout)).fix).toMatchObject({ actor: 'host_admin', argv: ['env', 'GBRAIN_STATEMENT_TIMEOUT=15min', 'gbrain', 'repair', 'failed-writes', '--source', sourceId, '--json'] });
      await engine.executeRaw(`DROP INDEX ${PERSISTENCE_REQUEST_REPLAY_ID_INDEX.name}`);
      try {
        const refusal = await refused(timeout);
        expect(refusal.fix).toMatchObject({ actor: 'agent', argv: ['gbrain', 'repair', 'request-indexes', '--json'] });
        expect(refusal.suggestion).toContain(`${PERSISTENCE_REQUEST_REPLAY_ID_INDEX.name} (missing)`);
        expect(refusal.suggestion).not.toContain(PERSISTENCE_REQUEST_SLUG_SEQUENCE_INDEX.name);
        // The caller's own deadline ends the read: the index states are still read, outside that expired deadline.
        const scope: StatementDeadline = { startedAt: Date.now(), deadlineAt: Date.now() + 60_000, expired: false };
        const bound = deadlineBoundEngine(engine);
        const expiring = new Proxy(bound, { get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key !== 'executeRaw') return typeof value === 'function' ? value.bind(target) : value;
          return (sql: string, ...rest: unknown[]) => {
            if (sql.includes('request_id = ANY')) { scope.deadlineAt = Date.now() - 1; scope.expired = true; return Promise.reject(new StatementDeadlineError(1)); }
            return (value as Function).call(target, sql, ...rest);
          };
        } }) as BrainEngine;
        const deadlined = await withStatementDeadline(scope, () => refused(expiring));
        expect(deadlined.fix).toMatchObject({ actor: 'agent', argv: ['gbrain', 'repair', 'request-indexes', '--json'] });
        expect(deadlined.suggestion).toContain(`${PERSISTENCE_REQUEST_REPLAY_ID_INDEX.name} (missing)`);
      } finally { await engine.executeRaw(PERSISTENCE_REQUEST_REPLAY_ID_INDEX.sql); }
    }
    expect(await checkpoints()).toBe(before);
  }, 120_000);
  test('#8714 lock waits and user cancellation do not recommend statement-timeout or index repairs', async () => {
    const { sourceId } = await seed(engine, 0);
    const snapshot = async () => engine.executeRaw(`SELECT
      (SELECT count(*)::int FROM op_checkpoints WHERE op='repair-approval') AS approvals,
      (SELECT count(*)::int FROM pages) AS pages,
      (SELECT count(*)::int FROM persistence_requests) AS requests`);
    const before = await snapshot();
    const cases = [
      { code: '55P03', message: 'canceling statement due to lock timeout', expected: 'repair_preview_locked' },
      { code: '57014', message: 'canceling statement due to user request', expected: 'cancelled' },
    ];
    for (const scenario of cases) {
      const failure = Object.assign(new Error(scenario.message), { code: scenario.code });
      let indexReads = 0;
      const view = new Proxy(engine, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== 'executeRaw') return typeof value === 'function' ? value.bind(target) : value;
        return (sql: string, ...rest: unknown[]) => {
          if (sql.includes('pg_index')) indexReads++;
          if (sql.includes('request_id = ANY')) return Promise.reject(failure);
          return (value as Function).call(target, sql, ...rest);
        };
      } }) as BrainEngine;
      const error = await preview(view, sourceId).then(() => null, caught => caught);
      expect(error).toBeInstanceOf(OperationError);
      expect(error.code).toBe(scenario.expected);
      expect(error.suggestion).not.toContain('raise the statement timeout');
      expect(error.fix.argv).toEqual(['gbrain', 'repair', 'failed-writes', '--source', sourceId, '--json']);
      expect(indexReads).toBe(0);
    }
    // SQLSTATE alone is not proof of a timeout or of an operator cancellation.
    for (const failure of [Object.assign(new Error('other query cancellation'), { code: '57014' }),
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '42501' })]) {
      const view = new Proxy(engine, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== 'executeRaw') return typeof value === 'function' ? value.bind(target) : value;
        return (sql: string, ...rest: unknown[]) => sql.includes('request_id = ANY')
          ? Promise.reject(failure) : (value as Function).call(target, sql, ...rest);
      } }) as BrainEngine;
      expect(await preview(view, sourceId).then(() => null, caught => caught)).toBe(failure);
    }
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  if (backend === 'postgres') test('#8714 real lock timeout and pg_cancel_backend retain distinct remedies', async () => {
    const { sourceId } = await seed(engine, 0);
    const scope = await resolveRepairScope(engine, sourceId);
    const timed = await withEnv({ GBRAIN_STATEMENT_TIMEOUT: '10s' }, async () => {
      const e = new PostgresEngine(); await e.connect({ database_url: databaseUrl!, poolSize: 1 }); return e;
    });
    const run = async () => (await repairRunner(timed, { apply: false, logger }))
      .run('failed-writes', scope, { explicit: true, sourceFlag: sourceId }).then(() => null, caught => caught);
    // Count rather than inspect checkpoint contents: no approval may be saved by either refusal.
    const count = async () => Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM op_checkpoints WHERE op='repair-approval'"))[0]!.n);
    const before = await count();
    try {
      await timed.executeRaw("SET lock_timeout='100ms'");
      const locked = await engine.transaction(async tx => {
        await tx.executeRaw('LOCK TABLE persistence_requests IN ACCESS EXCLUSIVE MODE');
        return run();
      });
      expect(locked.code).toBe('repair_preview_locked');
      expect(locked.suggestion).toContain('lock');
      await timed.executeRaw('SET lock_timeout=0');
      const [{ pid }] = await timed.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const cancelled = await engine.transaction(async tx => {
        await tx.executeRaw('LOCK TABLE persistence_requests IN ACCESS EXCLUSIVE MODE');
        const pending = run();
        try {
          const until = Date.now() + 5_000;
          let waiting = false;
          while (Date.now() < until) {
            const rows = await tx.executeRaw<{ waiting: boolean }>("SELECT wait_event_type='Lock' AND query LIKE '%persistence_requests%' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid]);
            if (rows[0]?.waiting) { waiting = true; break; }
            await Bun.sleep(10);
          }
          expect(waiting).toBe(true);
          expect((await tx.executeRaw<{ cancelled: boolean }>('SELECT pg_cancel_backend($1) AS cancelled', [pid]))[0]!.cancelled).toBe(true);
        } finally {
          // Always drain the blocked preview before releasing the table lock.
          await pending;
        }
        return pending;
      });
      expect(cancelled.code).toBe('cancelled');
      expect(cancelled.message).toContain('cancelled');
      expect(cancelled.fix.argv).toEqual(['gbrain', 'repair', 'failed-writes', '--source', sourceId, '--json']);
      expect(await count()).toBe(before);
      expect(await run()).toBeNull();
    } finally { await timed.disconnect(); }
  }, 120_000);

  if (backend === 'postgres') test('one page with many refused writes and a long later history stays inside the statement timeout', async () => {
    const sourceId = `b8707-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,NULL)', [sourceId]);
    const insert = (state: string, n: number, tag: string) => engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,
        source_incarnation,slug,digest,intent,authority,state,intent_bytes,terminal_reservation,error_code,error_message)
      SELECT 'local_cli','cli',gen_random_uuid(),'put_page',s.id,s.incarnation,'people/alice-example',md5($2||i),jsonb_build_object('slug','people/alice-example','content',$2||i),
        '{}'::jsonb,$3,100,100,CASE WHEN $3='conflict' THEN 'source_changed' END,CASE WHEN $3='conflict' THEN 'refused' END
      FROM sources s, generate_series(1,$4::int) i WHERE s.id=$1`, [sourceId, tag, state, n]);
    await insert('conflict', 500, 'refused-');
    await insert('committed', 20_000, 'later-');
    await engine.executeRaw('ANALYZE persistence_requests');
    const timed = await withEnv({ GBRAIN_STATEMENT_TIMEOUT: '1s' }, async () => { const e = new PostgresEngine(); await e.connect({ database_url: databaseUrl!, poolSize: 1 }); return e; });
    try {
      const result = await preview(timed, sourceId);
      expect(result.residuals).toMatchObject({ superseded: 500 });
      expect((result.listing ?? []).filter(entry => entry.class === 'superseded')).toHaveLength(500);
    } finally { await timed.disconnect(); }
  }, 120_000);
});
