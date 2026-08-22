/**
 * #4098 — agent-scoped access to the generic jobs ops (PGLite lane; the
 * Postgres parity twin is test/e2e/jobs-agent-scope-postgres.test.ts).
 *
 * get_job / list_jobs / get_job_progress / cancel_job are admin ops that
 * gained `agentCallable: true`: an agent-scoped OAuth client can monitor and
 * cancel ONLY the jobs it owns (fenced SQL-side on
 * `data->>'__owner_client_id'` — the predicate submit_agent stamps).
 * Foreign-owned and missing ids share one uniform error (anti-enumeration).
 * Admin/local callers stay unfenced.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_inbox');
  await engine.executeRaw('DELETE FROM minion_jobs');
});

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

const agentCtx = (clientId = 'agent-a') =>
  ctx({ auth: { clientId, scopes: ['agent'] } as OperationContext['auth'] });
const adminCtx = () =>
  ctx({ auth: { clientId: 'admin-tok', scopes: ['admin'] } as OperationContext['auth'] });
const localCtx = () => ctx({ remote: false });

let seedSeq = 0;
async function seedJob(owner: string | null, name = 'subagent'): Promise<number> {
  // Unique payload per seed — identical waiting jobs get coalesced by add().
  const data: Record<string, unknown> = { prompt: `x-${++seedSeq}` };
  if (owner) data.__owner_client_id = owner;
  const job = await queue.add(name, data, { queue: 'default' }, { allowProtectedSubmit: true });
  return job.id;
}

const get_job = operationsByName['get_job']!;
const list_jobs = operationsByName['list_jobs']!;
const get_job_progress = operationsByName['get_job_progress']!;
const cancel_job = operationsByName['cancel_job']!;

describe('op surface flags (#4098)', () => {
  test('the four generic jobs ops are agentCallable, still admin-scoped', () => {
    for (const op of [get_job, list_jobs, get_job_progress, cancel_job]) {
      expect(op.agentCallable).toBe(true);
      expect(op.scope).toBe('admin');
    }
  });
});

describe('get_job / get_job_progress — ownership fence', () => {
  test('agent sees its own job; foreign job = uniform not-found', async () => {
    const mine = await seedJob('agent-a');
    const theirs = await seedJob('agent-b');

    const job = (await get_job.handler(agentCtx('agent-a'), { id: mine })) as { id: number };
    expect(job.id).toBe(mine);

    let foreignErr: Error | null = null;
    let missingErr: Error | null = null;
    await get_job.handler(agentCtx('agent-a'), { id: theirs }).catch((e) => { foreignErr = e; });
    await get_job.handler(agentCtx('agent-a'), { id: 999_999 }).catch((e) => { missingErr = e; });
    expect(foreignErr).not.toBeNull();
    expect(missingErr).not.toBeNull();
    // Anti-enumeration: byte-identical envelopes modulo the id.
    expect(String(foreignErr).replace(String(theirs), 'N')).toBe(
      String(missingErr).replace('999999', 'N'),
    );

    const prog = (await get_job_progress.handler(agentCtx('agent-a'), { id: mine })) as { id: number };
    expect(prog.id).toBe(mine);
    await expect(get_job_progress.handler(agentCtx('agent-a'), { id: theirs })).rejects.toThrow(/not found/i);
  });

  test('agent scope WITHOUT a client identity is refused (fail closed)', async () => {
    const id = await seedJob('agent-a');
    const noIdentity = ctx({ auth: { scopes: ['agent'] } as OperationContext['auth'] });
    await expect(get_job.handler(noIdentity, { id })).rejects.toThrow(/client identity/);
  });

  test('admin token and local CLI stay unfenced', async () => {
    const theirs = await seedJob('agent-b');
    expect(((await get_job.handler(adminCtx(), { id: theirs })) as { id: number }).id).toBe(theirs);
    expect(((await get_job.handler(localCtx(), { id: theirs })) as { id: number }).id).toBe(theirs);
  });
});

describe('list_jobs — ownership fence', () => {
  test('agent lists only its own jobs; admin sees all', async () => {
    await seedJob('agent-a');
    await seedJob('agent-a');
    await seedJob('agent-b');
    await seedJob(null, 'embed'); // unowned operator job

    const mine = (await list_jobs.handler(agentCtx('agent-a'), {})) as Array<{ data: Record<string, unknown> }>;
    expect(mine.length).toBe(2);
    for (const j of mine) expect(j.data.__owner_client_id).toBe('agent-a');

    const all = (await list_jobs.handler(adminCtx(), {})) as unknown[];
    expect(all.length).toBe(4);
    const local = (await list_jobs.handler(localCtx(), {})) as unknown[];
    expect(local.length).toBe(4);
  });
});

describe('cancel_job — ownership fence rides the recursive cancel', () => {
  test('agent cancels its own job tree; children cascade', async () => {
    const rootId = await seedJob('agent-a');
    // Child spawned by the job itself — carries no owner tag of its own.
    const child = await queue.add('subagent', { prompt: 'child' }, { queue: 'default' }, { allowProtectedSubmit: true });
    await engine.executeRaw('UPDATE minion_jobs SET parent_job_id = $1 WHERE id = $2', [rootId, child.id]);

    const cancelled = (await cancel_job.handler(agentCtx('agent-a'), { id: rootId })) as { id: number; status: string };
    expect(cancelled.id).toBe(rootId);
    expect(cancelled.status).toBe('cancelled');

    const childRow = await engine.executeRaw<{ status: string }>(
      'SELECT status FROM minion_jobs WHERE id = $1', [child.id],
    );
    expect(childRow[0]!.status).toBe('cancelled');
  });

  test('agent cannot cancel a foreign job — job stays waiting, uniform envelope', async () => {
    const theirs = await seedJob('agent-b');
    await expect(cancel_job.handler(agentCtx('agent-a'), { id: theirs })).rejects.toThrow(/Cannot cancel/);
    const row = await engine.executeRaw<{ status: string }>(
      'SELECT status FROM minion_jobs WHERE id = $1', [theirs],
    );
    expect(row[0]!.status).toBe('waiting');
  });

  test('admin cancel stays unfenced', async () => {
    const theirs = await seedJob('agent-b');
    const cancelled = (await cancel_job.handler(adminCtx(), { id: theirs })) as { status: string };
    expect(cancelled.status).toBe('cancelled');
  });
});
