/**
 * #7241 / #7242: computed job fields (submitted_by, blocked_by, liveness, spend), the wait_job op and the
 * terminal-event cursor, on PGLite. The owner fence cases pin the Captain's conditions: a foreign holder,
 * submitter, parent or child is reported by kind only and never adds to a fenced caller's spend.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { describeJobs, setSubmitterLabelForTests } from '../../src/core/minions/job-insight.ts';
import { listFinishedSince, parseTerminalCursor } from '../../src/core/minions/terminal-events.ts';
import { assertNoUnreviewedJobs } from '../../src/core/minions/submission-authority.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  setSubmitterLabelForTests(null);
  await engine.disconnect();
});

beforeEach(async () => {
  setSubmitterLabelForTests('cli:test');
  await engine.executeRaw('DELETE FROM mcp_spend_reservations');
  await engine.executeRaw('DELETE FROM minion_inbox');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
});

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine, config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false, remote: true, sourceId: 'default', ...over,
  } as OperationContext;
}
const agentCtx = (clientId: string) => ctx({ auth: { clientId, scopes: ['agent'] } as OperationContext['auth'] });
const localCtx = () => ctx({ remote: false });

let seq = 0;
async function add(name: string, data: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  return queue.add(name, { n: ++seq, ...data }, { queue: 'default', ...opts }, { allowProtectedSubmit: true });
}
async function activate(id: number, lockDurationMs: number | null, untilOffsetMs: number) {
  await engine.executeRaw(
    `UPDATE minion_jobs SET status = 'active', claim_generation = claim_generation + 1, lock_token = 'w:' || id::text, lock_duration_ms = $2::int,
       lock_until = now() + ($3::double precision * interval '1 millisecond'), started_at = now(), attempts_started = 1
     WHERE id = $1`, [id, lockDurationMs, untilOffsetMs]);
}
async function reservation(jobId: number, cents: number | null, status = 'settled', client = 'c') {
  await engine.executeRaw(
    `INSERT INTO mcp_spend_reservations (reservation_id, client_id, job_id, estimated_cents, actual_cents, model, provider, status, expires_at)
     VALUES (gen_random_uuid(), $4, $1, 1, $2, 'm', 'p', $3, now() + interval '1 hour')`, [jobId, cents, status, client]);
}
async function holdSyncLock(source: string, holderJobId: number) {
  const token = '00000000-0000-4000-8000-' + String(holderJobId).padStart(12, '0');
  await engine.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, ttl_expires_at, acquisition_token)
     VALUES ($1, 4242, 'host-example', now() + interval '10 minutes', $2::uuid)`, [`gbrain-sync:${source}`, token]);
  await engine.executeRaw(
    `INSERT INTO minion_jobs (name, queue, status, submission_authority, data, max_attempts, max_stalled, lock_token, lock_until, started_at)
     VALUES ('sync', 'gbrain-drain-lease', 'active', '{"version":1,"kind":"application"}'::jsonb, $1::text::jsonb, 1, 0, $2, now() + interval '10 minutes', now())`,
    [JSON.stringify({ sourceId: source, drain_lease_beacon: { kind: 'job', id: String(holderJobId), version: 'test' } }), token]);
}

const get_job = operationsByName['get_job']!;
const list_jobs = operationsByName['list_jobs']!;
const wait_job = operationsByName['wait_job']!;

describe('submitted_by', () => {
  test('a local job names its submitter label; a child names its parent', async () => {
    const parent = await add('noop');
    const child = await add('noop', {}, { parent_job_id: parent.id });
    const insight = await describeJobs(engine, [parent, child]);
    expect(insight.get(parent.id)!.submitted_by).toEqual({ kind: 'local', via: 'cli:test' });
    expect(insight.get(child.id)!.submitted_by).toEqual({ kind: 'parent_job', id: parent.id });
  });

  test('the label is not authority: a differently labelled submit coalesces on the same idempotency key', async () => {
    const first = await add('noop', {}, { idempotency_key: 'k-label' });
    setSubmitterLabelForTests('autopilot');
    const second = await add('noop', {}, { idempotency_key: 'k-label' });
    expect(second.id).toBe(first.id);
    expect(first.data.__submitter).toBe('cli:test');
    expect(first.submission_authority).toEqual({ version: 1, kind: 'application' });
    await assertNoUnreviewedJobs(engine);
  });

  test('a re-submit carrying another process\'s label still coalesces on its params', async () => {
    const first = await queue.add('noop', { target: 'source-a' }, { coalesce_params: true });
    setSubmitterLabelForTests('autopilot');
    const second = await queue.add('noop', { ...first.data }, { coalesce_params: true });
    expect(second.id).toBe(first.id);
    expect(second.coalesced).toBe(true);
  });

  test('a caller-supplied __submitter is dropped: the stored label is always the real local process', async () => {
    const labelled = await add('noop', { __submitter: 'autopilot' });
    expect(labelled.data.__submitter).toBe('cli:test');
    setSubmitterLabelForTests(null);
    const library = await add('noop', { __submitter: 'autopilot' });
    expect(library.data.__submitter).toBeUndefined();
    const insight = await describeJobs(engine, [labelled, library]);
    expect(insight.get(labelled.id)!.submitted_by).toEqual({ kind: 'local', via: 'cli:test' });
    expect(insight.get(library.id)!.submitted_by).toEqual({ kind: 'local' });
  });
});

describe('blocked_by', () => {
  test('waiting jobs report their queue position and the active jobs holding the queue', async () => {
    const running = await add('long-runner');
    await activate(running.id, 30_000, 30_000);
    const a = await add('short');
    const b = await add('short');
    const c = await add('short', {}, { priority: -1 });
    const insight = await describeJobs(engine, [a, b, c]);
    const queueOf = (id: number) => insight.get(id)!.blocked_by!.find(r => r.kind === 'queue');
    expect(queueOf(c.id)).toMatchObject({ kind: 'queue', queue: 'default', queue_position: 1, ahead: 0, active: 1 });
    expect(queueOf(a.id)).toMatchObject({ queue_position: 2, ahead: 1 });
    expect(queueOf(b.id)).toMatchObject({ queue_position: 3, ahead: 2, active_jobs: [{ id: running.id, name: 'long-runner' }] });
  });

  test('a legacy job with no authority names the review command as argv', async () => {
    const job = await add('noop');
    await engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = $1', [job.id]);
    const [row] = await queue.getJobs({ status: 'waiting' }).then(rows => rows.filter(r => r.id === job.id));
    const insight = await describeJobs(engine, [row]);
    expect(insight.get(job.id)!.blocked_by![0]).toMatchObject({ kind: 'unreviewed_authority',
      fix: { argv: ['gbrain', 'jobs', 'authorize-legacy', '--ids', String(job.id)], actor: 'user', consent: [] } });
    expect(insight.get(job.id)!.submitted_by).toEqual({ kind: 'unreviewed' });
  });

  test('waiting-children, delayed and paused jobs say why', async () => {
    const parent = await add('noop');
    const kid = await add('noop', {}, { parent_job_id: parent.id });
    const later = await add('noop', {}, { delay: 60_000 });
    const [p, l] = await Promise.all([queue.getJob(parent.id), queue.getJob(later.id)]);
    const insight = await describeJobs(engine, [p!, l!]);
    expect(insight.get(parent.id)!.blocked_by).toEqual([{ kind: 'waiting_children', pending: 1, child_ids: [kid.id] }]);
    expect(insight.get(later.id)!.blocked_by![0]).toMatchObject({ kind: 'delayed', reason: 'scheduled' });
    expect(insight.get(later.id)!.blocked_by![0]).toHaveProperty('delay_until');
  });

  test('a waiting sync job names the job holding its source lock', async () => {
    const holder = await add('sync', { sourceId: 'source-a' });
    await activate(holder.id, 30_000, 30_000);
    await holdSyncLock('source-a', holder.id);
    const waiting = await add('sync', { sourceId: 'source-a' });
    const lock = (await describeJobs(engine, [waiting])).get(waiting.id)!.blocked_by!.find(r => r.kind === 'lock');
    expect(lock).toMatchObject({ kind: 'lock', held: true, lock: 'gbrain-sync:source-a', holder_job_id: holder.id, holder: { kind: 'job', pid: 4242 } });
  });

  test('running and finished jobs are not blocked', async () => {
    const job = await add('noop');
    await activate(job.id, 30_000, 30_000);
    expect((await describeJobs(engine, [(await queue.getJob(job.id))!])).get(job.id)!.blocked_by).toBeNull();
  });
});

describe('liveness', () => {
  test('heartbeat age comes from the lease, and an expired lock reads stalled', async () => {
    const live = await add('noop');
    const dead = await add('noop');
    await activate(live.id, 60_000, 50_000);
    await activate(dead.id, 60_000, -5_000);
    const rows = await Promise.all([queue.getJob(live.id), queue.getJob(dead.id)]);
    const insight = await describeJobs(engine, rows.map(r => r!));
    const l = insight.get(live.id)!, d = insight.get(dead.id)!;
    expect(l).toMatchObject({ stalled: false, heartbeat_basis: 'lease' });
    expect(l.heartbeat_age_ms!).toBeGreaterThanOrEqual(9_000);
    expect(l.heartbeat_age_ms!).toBeLessThan(15_000);
    expect(l.lock_expires_in_ms!).toBeGreaterThan(40_000);
    expect(d.stalled).toBe(true);
    expect(d.lock_expires_in_ms!).toBeLessThan(0);
  });
});

describe('spend', () => {
  test('settled reservations price the job and its children; none means unpriced, not zero', async () => {
    const parent = await add('noop');
    const child = await add('noop', {}, { parent_job_id: parent.id });
    const bare = await add('noop');
    await reservation(parent.id, 10);
    await reservation(child.id, 2.5);
    await reservation(child.id, null, 'pending');
    const insight = await describeJobs(engine, [parent, bare]);
    expect(insight.get(parent.id)!.spend).toMatchObject({ cost_usd: 0.125, cost_basis: 'settled_reservations', includes_children: true, unsettled_reservations: 1 });
    expect(insight.get(bare.id)!.spend).toMatchObject({ cost_usd: null, cost_basis: 'unpriced', unsettled_reservations: 0 });
  });
});

describe('owner fence (remote agent callers)', () => {
  test('a foreign lock holder is reported as held with no job id; an owned holder is named', async () => {
    const foreignHolder = await add('sync', { sourceId: 'source-a', __owner_client_id: 'agent-b' });
    await activate(foreignHolder.id, 30_000, 30_000);
    await holdSyncLock('source-a', foreignHolder.id);
    const mine = await add('sync', { sourceId: 'source-a', __owner_client_id: 'agent-a' });

    const seen = await get_job.handler(agentCtx('agent-a'), { id: mine.id }) as { blocked_by: Array<Record<string, unknown>> };
    expect(seen.blocked_by.find(r => r.kind === 'lock')).toEqual({ kind: 'lock', held: true });
    const queueRow = seen.blocked_by.find(r => r.kind === 'queue')!;
    expect(queueRow.active).toBe(1);
    expect(queueRow.active_jobs).toEqual([]);

    const local = await get_job.handler(localCtx(), { id: mine.id }) as { blocked_by: Array<Record<string, unknown>> };
    expect(local.blocked_by.find(r => r.kind === 'lock')).toMatchObject({ holder_job_id: foreignHolder.id });

    await engine.executeRaw(`UPDATE minion_jobs SET data = data || '{"__owner_client_id":"agent-a"}'::jsonb WHERE id = $1`, [foreignHolder.id]);
    const owned = await get_job.handler(agentCtx('agent-a'), { id: mine.id }) as { blocked_by: Array<Record<string, unknown>> };
    expect(owned.blocked_by.find(r => r.kind === 'lock')).toEqual({ kind: 'lock', held: true, lock: 'gbrain-sync:source-a', holder_job_id: foreignHolder.id });
  });

  test('a foreign parent is redacted to its kind, and foreign children never reach a fenced spend rollup', async () => {
    const foreignParent = await add('noop', { __owner_client_id: 'agent-b' });
    const mineUnderForeign = await add('noop', { __owner_client_id: 'agent-a' }, { parent_job_id: foreignParent.id });
    const seenChild = await get_job.handler(agentCtx('agent-a'), { id: mineUnderForeign.id }) as Record<string, unknown>;
    expect(seenChild.submitted_by).toEqual({ kind: 'parent_job' });

    const myParent = await add('noop', { __owner_client_id: 'agent-a' });
    const foreignChild = await add('noop', { __owner_client_id: 'agent-b' }, { parent_job_id: myParent.id });
    const myChild = await add('noop', { __owner_client_id: 'agent-a' }, { parent_job_id: myParent.id });
    await reservation(myParent.id, 1);
    await reservation(foreignChild.id, 40);
    await reservation(myChild.id, 2);
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'completed', finished_at = now(), tokens_input = 700, tokens_output = 70 WHERE id = $1`, [foreignChild.id]);
    await engine.executeRaw(`UPDATE minion_jobs SET tokens_input = 1000, tokens_output = 100 WHERE id = $1`, [myParent.id]);

    const fenced = await get_job.handler(agentCtx('agent-a'), { id: myParent.id }) as Record<string, any>;
    expect(fenced.spend).toMatchObject({ cost_usd: 0.03, tokens_input: 300, tokens_output: 30, excludes_foreign_children: true });
    expect(fenced.tokens_input).toBe(300);
    const local = await get_job.handler(localCtx(), { id: myParent.id }) as Record<string, any>;
    expect(local.spend).toMatchObject({ cost_usd: 0.43, tokens_input: 1000 });
    expect(local.spend.excludes_foreign_children).toBeUndefined();
  });

  test('a job whose recorded MCP submitter is another client is never shown to a fenced caller, even when its data names the caller', async () => {
    const job = await add('noop', { __owner_client_id: 'agent-a' });
    await engine.executeRaw(
      `UPDATE minion_jobs SET submission_authority = $2::text::jsonb WHERE id = $1`,
      [job.id, JSON.stringify({ version: 1, kind: 'remote_agent', principal: { kind: 'oauth_client', id: 'agent-b' },
        grant: { scopes: ['agent'], sourceId: 'default', sourceCreatedAt: new Date().toISOString(), allowedTools: ['get_page'], allowedSlugPrefixes: [] },
        payloadHash: 'a'.repeat(64) })]);
    // GST-4010: the recorded principal owns a remote job; caller-visible data never claims it.
    await expect(get_job.handler(agentCtx('agent-a'), { id: job.id })).rejects.toThrow(/not found/i);
    const local = await get_job.handler(localCtx(), { id: job.id }) as Record<string, unknown>;
    expect(local.submitted_by).toEqual({ kind: 'mcp_client', id: 'agent-b', principal_kind: 'oauth_client' });
  });

  test('list_jobs carries the same fields and projects them', async () => {
    const job = await add('noop', { __owner_client_id: 'agent-a' });
    const rows = await list_jobs.handler(agentCtx('agent-a'), { fields: ['id', 'blocked_by', 'spend'] }) as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['blocked_by', 'id', 'spend']);
    expect(rows[0].id).toBe(job.id);
    expect(rows[0].blocked_by[0]).toMatchObject({ kind: 'queue', queue_position: 1 });
  });
});

describe('wait_job', () => {
  test('a foreign job id gets exactly the get_job refusal, at once', async () => {
    const theirs = await add('noop', { __owner_client_id: 'agent-b' });
    const errOf = async (op: typeof get_job, args: Record<string, unknown>) => {
      try { await op.handler(agentCtx('agent-a'), args); return null; } catch (e) { return e as Error & Record<string, unknown>; }
    };
    const started = Date.now();
    const waitErr = await errOf(wait_job, { id: theirs.id, timeout_s: 30 });
    const elapsed = Date.now() - started;
    const getErr = await errOf(get_job, { id: theirs.id });
    expect(waitErr).not.toBeNull();
    expect(elapsed).toBeLessThan(1_000);
    expect(String(waitErr)).toBe(String(getErr));
    expect(JSON.stringify(waitErr)).toBe(JSON.stringify(getErr));
    expect({ code: waitErr!.code, why: waitErr!.why, fix: waitErr!.fix }).toEqual({ code: getErr!.code, why: getErr!.why, fix: getErr!.fix });
    const missing = await errOf(wait_job, { id: 987_654 });
    expect(String(missing).replace('987654', 'N')).toBe(String(waitErr).replace(String(theirs.id), 'N'));
  });

  test('returns terminal: true once the job finishes, and terminal: false at the timeout', async () => {
    const job = await add('noop', { __owner_client_id: 'agent-a' });
    const pending = await wait_job.handler(agentCtx('agent-a'), { id: job.id, timeout_s: 1 }) as Record<string, unknown>;
    expect(pending).toMatchObject({ id: job.id, status: 'waiting', terminal: false });
    expect(pending.blocked_by).toBeDefined();
    setTimeout(() => {
      void engine.executeRaw(`UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1`, [job.id]);
    }, 300);
    const done = await wait_job.handler(agentCtx('agent-a'), { id: job.id, timeout_s: 10 }) as Record<string, unknown>;
    expect(done).toMatchObject({ id: job.id, status: 'completed', terminal: true });
  });

  test('the server caps one call at 55 s and the op is read-only and agent-callable', () => {
    expect(wait_job).toMatchObject({ scope: 'admin', agentCallable: true, mutating: false });
    expect(wait_job.description).toContain('55 s');
  });
});

describe('terminal event cursor', () => {
  test('pages every finished job once, oldest first, and respects the owner fence', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const j = await add('noop', i % 2 === 0 ? { __owner_client_id: 'agent-a' } : {});
      ids.push(j.id);
    }
    await add('noop');
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', finished_at = '2026-10-21T00:00:00.000001Z'::timestamptz WHERE id = ANY($1::int[])`, [ids.slice(0, 3)]);
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'failed', finished_at = '2026-10-21T00:00:01Z'::timestamptz WHERE id = ANY($1::int[])`, [ids.slice(3)]);
    const first = await listFinishedSince(engine, '2026-10-20T00:00:00Z', { limit: 2 });
    expect(first.jobs.map(j => j.id)).toEqual(ids.slice(0, 2));
    const second = await listFinishedSince(engine, first.next_cursor, { limit: 2 });
    expect(second.jobs.map(j => j.id)).toEqual(ids.slice(2, 4));
    const third = await listFinishedSince(engine, second.next_cursor, { limit: 2 });
    expect(third.jobs.map(j => j.id)).toEqual([ids[4]]);
    const empty = await listFinishedSince(engine, third.next_cursor, { limit: 2 });
    expect(empty.jobs).toEqual([]);
    expect(empty.next_cursor).toBe(third.next_cursor);

    const fenced = await list_jobs.handler(agentCtx('agent-a'), { finished_since: '2026-10-20T00:00:00Z', fields: ['id', 'status'] }) as { jobs: Array<{ id: number }>; next_cursor: string };
    expect(fenced.jobs.map(j => j.id)).toEqual([ids[0], ids[2], ids[4]]);
    expect(() => parseTerminalCursor('yesterday')).toThrow(/ISO time/);
    await expect(list_jobs.handler(agentCtx('agent-a'), { finished_since: 'nope' })).rejects.toThrow(/finished_since/);
  });
});
