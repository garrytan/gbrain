/**
 * #4098 — agent-scoped jobs ops, LIVE Postgres parity.
 *
 * The PGLite coverage lives in test/jobs-agent-scope.test.ts; this file
 * re-runs the SQL-touching pieces (the `data->>'__owner_client_id'` fence in
 * assertJobOwned / MinionQueue.getJobs / the recursive-cancel CTE seed) on a
 * real Postgres so postgres.js parameter binding is proven on both engines.
 *
 * Gated by DATABASE_URL via hasDatabase(); skips cleanly when unset.
 *
 *   Run: DATABASE_URL=... bun test test/e2e/jobs-agent-scope-postgres.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

let engine: PostgresEngine;
let queue: MinionQueue;

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...over,
  } as OperationContext;
}

const agentCtx = (clientId: string) =>
  ctx({ auth: { clientId, scopes: ['agent'] } as OperationContext['auth'] });

let seedSeq = 0;
async function seedJob(owner: string | null): Promise<number> {
  const data: Record<string, unknown> = { prompt: `pg-x-${++seedSeq}` };
  if (owner) data.__owner_client_id = owner;
  const job = await queue.add('subagent', data, { queue: 'default' }, { allowProtectedSubmit: true });
  return job.id;
}

d('jobs agent-scope fence (live Postgres)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    queue = new MinionQueue(engine);
  }, 60_000);

  afterAll(async () => {
    await teardownDB();
  }, 60_000);

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM minion_inbox', []);
    await engine.executeRaw('DELETE FROM minion_jobs', []);
  });

  test('get_job fence: own visible, foreign uniform not-found', async () => {
    const get_job = operationsByName['get_job']!;
    const mine = await seedJob('pg-agent-a');
    const theirs = await seedJob('pg-agent-b');
    const job = (await get_job.handler(agentCtx('pg-agent-a'), { id: mine })) as { id: number };
    expect(job.id).toBe(mine);
    await expect(get_job.handler(agentCtx('pg-agent-a'), { id: theirs })).rejects.toThrow(/not found/i);
  });

  test('list_jobs fence rides the SQL WHERE', async () => {
    const list_jobs = operationsByName['list_jobs']!;
    await seedJob('pg-agent-a');
    await seedJob('pg-agent-b');
    const mine = (await list_jobs.handler(agentCtx('pg-agent-a'), {})) as Array<{ data: Record<string, unknown> }>;
    expect(mine.length).toBe(1);
    expect(mine[0]!.data.__owner_client_id).toBe('pg-agent-a');
  });

  test('cancel_job fence gates the recursive CTE seed; children cascade', async () => {
    const cancel_job = operationsByName['cancel_job']!;
    const rootId = await seedJob('pg-agent-a');
    const foreign = await seedJob('pg-agent-b');
    const child = await queue.add('subagent', { prompt: `pg-child-${++seedSeq}` }, { queue: 'default' }, { allowProtectedSubmit: true });
    await engine.executeRaw('UPDATE minion_jobs SET parent_job_id = $1 WHERE id = $2', [rootId, child.id]);

    // Foreign root refused; stays waiting.
    await expect(cancel_job.handler(agentCtx('pg-agent-a'), { id: foreign })).rejects.toThrow(/Cannot cancel/);
    const foreignRow = await engine.executeRaw<{ status: string }>(
      'SELECT status FROM minion_jobs WHERE id = $1', [foreign],
    );
    expect(foreignRow[0]!.status).toBe('waiting');

    // Owned root cancels + cascades.
    const cancelled = (await cancel_job.handler(agentCtx('pg-agent-a'), { id: rootId })) as { status: string };
    expect(cancelled.status).toBe('cancelled');
    const childRow = await engine.executeRaw<{ status: string }>(
      'SELECT status FROM minion_jobs WHERE id = $1', [child.id],
    );
    expect(childRow[0]!.status).toBe('cancelled');
  });
});
