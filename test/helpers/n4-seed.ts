/**
 * Raw-row seed for the N4 describeJobs read tests (test/n4-sql-move-parity.test.ts, test/engine-parity/jobs-insight.test.ts).
 *
 * BrainEngine has no typed job writer on this base, so job rows and cycle-lock leases go in through `executeRaw`: one
 * INSERT per row, every time given as an offset from `now()`. Rows carry an authority (the queue-protocol trigger
 * requires one). SQL arms only; the Rust arm has no raw SQL.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './persistence-postgres.ts';

interface Row {
  name: string;
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'dead' | 'cancelled' | 'paused' | 'waiting-children';
  queue?: string;
  priority?: number;
  /** Offsets from now(), as Postgres interval text, e.g. '-2 hours'. */
  created?: string;
  started?: string;
  finished?: string;
  delayUntil?: string;
  parent?: number;
  lockToken?: string;
  data?: Record<string, unknown>;
  tokens?: [number, number, number];
  authority?: Record<string, unknown>;
}

const APPLICATION = { kind: 'application' };

async function insert(e: BrainEngine, r: Row): Promise<number> {
  const at = (offset: string | undefined) => (offset === undefined ? null : offset);
  const [row] = await e.executeRaw<{ id: number | string }>(
    `INSERT INTO minion_jobs (name, queue, status, priority, created_at, started_at, finished_at, updated_at, delay_until, parent_job_id, lock_token, data,
       tokens_input, tokens_output, tokens_cache_read, submission_authority)
     VALUES ($1, $2, $3, $4, now() + COALESCE($5::text, '0 seconds')::interval,
       CASE WHEN $6::text IS NULL THEN NULL ELSE now() + $6::text::interval END,
       CASE WHEN $7::text IS NULL THEN NULL ELSE now() + $7::text::interval END,
       now(),
       CASE WHEN $8::text IS NULL THEN NULL ELSE now() + $8::text::interval END,
       $9, $10, $11::text::jsonb, $12, $13, $14, $15::text::jsonb) RETURNING id`,
    [r.name, r.queue ?? 'default', r.status, r.priority ?? 0, at(r.created), at(r.started), at(r.finished), at(r.delayUntil), r.parent ?? null, r.lockToken ?? null,
      JSON.stringify(r.data ?? {}), r.tokens?.[0] ?? 0, r.tokens?.[1] ?? 0, r.tokens?.[2] ?? 0, JSON.stringify(r.authority ?? APPLICATION)]);
  return Number(row!.id);
}

export interface InsightJobs {
  /** Every seeded job id, in insertion order. */
  all: number[];
  /** The `waiting` jobs whose queue position is read. */
  waiting: number[];
  /** The `waiting-children` parent. */
  parent: number;
  /** Lease ids: a live one named by a drain-lease beacon, a live plain one, and a lapsed one. */
  lockIds: string[];
  byName: Record<string, number>;
}

const BEACON_TOKEN = '11111111-1111-4111-8111-111111111111';
const PLAIN_TOKEN = '22222222-2222-4222-8222-222222222222';
const LAPSED_TOKEN = '33333333-3333-4333-8333-333333333333';

/** Seed the jobs and leases `describeJobs` reads; ids come back in a fixed order, the same on identically seeded brains. */
export async function seedInsightJobs(e: BrainEngine): Promise<InsightJobs> {
  const byName: Record<string, number> = {};
  const all: number[] = [];
  const add = async (key: string, r: Row) => { const id = await insert(e, r); byName[key] = id; all.push(id); return id; };

  // Waiting: priority 1 sorts before priority 5; of two priority-5 jobs the older sorts first.
  await add('w1', { name: 'w1', status: 'waiting', priority: 5, created: '-3 hours' });
  await add('w2', { name: 'w2', status: 'waiting', priority: 5, created: '-2 hours' });
  await add('w3', { name: 'w3', status: 'waiting', priority: 1, created: '-1 hour' });
  await add('w4', { name: 'w4', status: 'waiting', queue: 'q2', priority: 5, created: '-3 hours' });
  // Active holders: out of start order, one never started; the drain-lease queue holds the beacon row.
  await add('act1', { name: 'act1', status: 'active', started: '-3 hours', lockToken: 'tok-1', data: { __owner_client_id: 'o1' } });
  await add('act2', { name: 'act2', status: 'active', started: '-1 hour', lockToken: 'tok-2', data: { __owner_client_id: 'o2' } });
  await add('act3', { name: 'act3', status: 'active', lockToken: 'tok-3' });
  await add('act4', { name: 'act4', status: 'active', queue: 'q2', started: '-2 hours', lockToken: 'tok-4', data: { __owner_client_id: 'o1' } });
  await add('beacon', { name: 'beacon', status: 'active', queue: 'gbrain-drain-lease', started: '-1 hour', lockToken: BEACON_TOKEN,
    data: { drain_lease_beacon: { kind: 'job', id: byName.act1 } } });
  await add('plain-beacon', { name: 'plain-beacon', status: 'active', queue: 'gbrain-drain-lease', started: '-1 hour', lockToken: LAPSED_TOKEN,
    data: { drain_lease_beacon: { kind: 'sync' } } });
  // Submitter: an application job names it; another authority kind does not.
  await add('submitted', { name: 'submitted', status: 'completed', finished: '-1 hour', data: { __submitter: 'cli:import' } });
  await add('principal', { name: 'principal', status: 'completed', finished: '-1 hour', data: { __submitter: 'cli:hidden' }, authority: { kind: 'principal', principal: { id: 'p1' } } });
  // A parent and its children: live ones (delayed, active), finished ones (completed by three owners, dead, cancelled).
  const parent = await add('parent', { name: 'parent', status: 'waiting-children', data: { __owner_client_id: 'o1' } });
  await add('child1', { name: 'child1', status: 'delayed', delayUntil: '1 hour', parent, data: { __owner_client_id: 'o1' } });
  await add('child2', { name: 'child2', status: 'active', queue: 'q3', started: '-5 minutes', parent, lockToken: 'tok-c2', data: { __owner_client_id: 'o2' } });
  await add('child3', { name: 'child3', status: 'completed', finished: '-1 hour', parent, data: { __owner_client_id: 'o2' }, tokens: [10, 20, 30] });
  await add('child4', { name: 'child4', status: 'completed', finished: '-1 hour', parent, data: { __owner_client_id: 'o1' }, tokens: [1, 2, 3] });
  await add('child5', { name: 'child5', status: 'completed', finished: '-1 hour', parent, tokens: [5, 5, 5] });
  await add('child6', { name: 'child6', status: 'dead', finished: '-1 hour', parent, data: { __owner_client_id: 'o2' }, tokens: [100, 100, 100] });
  await add('child7', { name: 'child7', status: 'cancelled', finished: '-1 hour', parent });

  // Leases: two live (one claimed by the beacon row, one plain) and one lapsed.
  await e.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, ttl_expires_at, acquisition_token) VALUES
       ('lock-live-beacon', 111, 'host-a', now() + interval '1 hour', $1::uuid),
       ('lock-live-plain', 222, NULL, now() + interval '1 hour', $2::uuid),
       ('lock-lapsed', 333, 'host-c', now() - interval '1 hour', $3::uuid)`,
    [BEACON_TOKEN, PLAIN_TOKEN, LAPSED_TOKEN]);

  return { all, waiting: [byName.w1!, byName.w2!, byName.w3!, byName.w4!], parent, lockIds: ['lock-live-beacon', 'lock-live-plain', 'lock-lapsed'], byName };
}

/** Two identically schemaed, empty brains on one backend: the master-text side and the member side. */
export async function makePair(kind: 'pglite' | 'postgres', closers: Array<() => Promise<void>>): Promise<BrainEngine[]> {
  const engines: BrainEngine[] = [];
  for (let i = 0; i < 2; i++) {
    if (kind === 'postgres') {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 2);
      engines.push(pg.engine);
      closers.push(pg.close);
    } else {
      const engine = new PGLiteEngine();
      await engine.connect({ engine: 'pglite' } as never);
      await engine.initSchema();
      engines.push(engine);
      closers.push(() => engine.disconnect());
    }
  }
  return engines;
}
