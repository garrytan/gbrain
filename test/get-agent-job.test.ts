/**
 * Minions-visibility wave — `get_agent_job` MCP op tests (amendment 27,
 * ENG-16/18).
 *
 * Mirrors the `test/submit-agent.test.ts` harness (the file that pins the
 * `__owner_client_id` semantics) and covers the trust boundary:
 *   - ctx.auth.clientId REQUIRED on EVERY transport (absent → permission_denied,
 *     including local ctx.remote === false — closes the stdio/legacy bypass)
 *   - cross-client isolation: client A cannot read client B's job
 *   - foreign vs missing id: uniform not_found envelope (no enumeration oracle)
 *   - agent-lane only: a non-subagent job with a matching id is invisible
 *   - trimmed view: no data/prompt leak in the response
 *   - queue_position: claim-order (priority ASC, created_at ASC) count of
 *     waiting jobs ahead, present ONLY while status = 'waiting'
 *
 * Engine parity note: these run on PGLite. The ownership fence is the plain
 * `data->>'__owner_client_id' = $2` JSONB predicate — byte-identical SQL on
 * both engines and the same expression submit_agent's concurrency cap already
 * exercises; the DATABASE_URL-gated e2e parity suite covers the executeRaw
 * seam on real Postgres.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName, OperationError } from '../src/core/operations.ts';

const get_agent_job = operationsByName['get_agent_job'];
if (!get_agent_job) {
  throw new Error('get_agent_job op missing from operations registry — test fixture invalid');
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', '85');
});

function makeCtx(opts: { clientId?: string; remote?: boolean } = {}): any {
  return {
    engine,
    config: {},
    logger: console,
    dryRun: false,
    remote: opts.remote ?? true,
    auth: opts.clientId ? { clientId: opts.clientId } : undefined,
  };
}

/** Insert a minion job row directly; returns the job id. */
async function seedJob(opts: {
  owner?: string;
  name?: string;
  status?: string;
  queue?: string;
  priority?: number;
  createdAtSql?: string;
  errorText?: string | null;
  result?: Record<string, unknown> | null;
}): Promise<number> {
  const data: Record<string, unknown> = { prompt: 'seeded' };
  if (opts.owner) data.__owner_client_id = opts.owner;
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at, error_text, result)
     VALUES ($1, $2, $3::text::jsonb, $4, $5, ${opts.createdAtSql ?? 'now()'}, $6, $7::text::jsonb)
     RETURNING id`,
    [
      opts.name ?? 'subagent',
      opts.status ?? 'waiting',
      JSON.stringify(data),
      opts.queue ?? 'default',
      opts.priority ?? 0,
      opts.errorText ?? null,
      opts.result ? JSON.stringify(opts.result) : null,
    ],
  );
  return Number(rows[0].id);
}

describe('get_agent_job op surface', () => {
  it('declares scope=agent and a required numeric id param', () => {
    expect(get_agent_job.scope).toBe('agent');
    expect(get_agent_job.mutating).toBeUndefined();
    expect((get_agent_job.params.id as any).required).toBe(true);
    expect((get_agent_job.params.id as any).type).toBe('number');
    expect(typeof (get_agent_job.params.id as any).description).toBe('string');
  });
});

describe('client identity requirement (amendment 27 — every transport)', () => {
  it('refuses without ctx.auth.clientId on a remote transport', async () => {
    const id = await seedJob({ owner: 'alice' });
    await expect(get_agent_job.handler(makeCtx({ remote: true }), { id })).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });

  it('refuses without ctx.auth.clientId even when remote === false (closes the stdio/legacy bypass)', async () => {
    const id = await seedJob({ owner: 'alice' });
    await expect(get_agent_job.handler(makeCtx({ remote: false }), { id })).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });
});

describe('cross-client isolation + anti-enumeration', () => {
  it('client A reads its own job', async () => {
    const id = await seedJob({ owner: 'alice' });
    const r = (await get_agent_job.handler(makeCtx({ clientId: 'alice' }), { id })) as any;
    expect(r.id).toBe(id);
    expect(r.status).toBe('waiting');
  });

  it('client A cannot read client B\'s job', async () => {
    const id = await seedJob({ owner: 'bob' });
    await expect(get_agent_job.handler(makeCtx({ clientId: 'alice' }), { id })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('foreign and missing ids produce the SAME envelope (code + message shape)', async () => {
    const foreignId = await seedJob({ owner: 'bob' });
    const missingId = foreignId + 100_000;
    const grab = async (id: number): Promise<OperationError> => {
      try {
        await get_agent_job.handler(makeCtx({ clientId: 'alice' }), { id });
      } catch (e) {
        return e as OperationError;
      }
      throw new Error('expected a throw');
    };
    const foreign = await grab(foreignId);
    const missing = await grab(missingId);
    expect(foreign.code).toBe('not_found');
    expect(missing.code).toBe('not_found');
    // Identical wording modulo the id — no "exists but not yours" tell.
    expect(foreign.message.replace(String(foreignId), 'N')).toBe(
      missing.message.replace(String(missingId), 'N'),
    );
    expect(foreign.suggestion).toBe(missing.suggestion);
  });

  it('agent-lane only: a non-subagent job is invisible even with a matching owner field', async () => {
    const id = await seedJob({ owner: 'alice', name: 'sync' });
    await expect(get_agent_job.handler(makeCtx({ clientId: 'alice' }), { id })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects a non-integer id as invalid_params (caller bug, distinct from not_found)', async () => {
    await expect(
      get_agent_job.handler(makeCtx({ clientId: 'alice' }), { id: 'abc' as any }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('trimmed response shape', () => {
  it('returns only the trimmed keys — never data/prompt', async () => {
    const id = await seedJob({
      owner: 'alice',
      status: 'completed',
      errorText: null,
      result: { answer: 42 },
    });
    const r = (await get_agent_job.handler(makeCtx({ clientId: 'alice' }), { id })) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(
      ['created_at', 'error_text', 'finished_at', 'id', 'result', 'started_at', 'status'].sort(),
    );
    expect(r.result).toEqual({ answer: 42 });
    expect(JSON.stringify(r)).not.toContain('__owner_client_id');
    expect(JSON.stringify(r)).not.toContain('prompt');
  });
});

describe('queue_position (claim-order: priority ASC, created_at ASC)', () => {
  it('counts waiting jobs ahead on the same queue, 0 = next to be claimed', async () => {
    // Claim order: p0-older, p0-newer, p5. Owners differ — position counts
    // ALL waiting competitors, not just the caller's own jobs.
    const first = await seedJob({ owner: 'alice', priority: 0, createdAtSql: "now() - interval '3 minutes'" });
    const second = await seedJob({ owner: 'bob', priority: 0, createdAtSql: "now() - interval '2 minutes'" });
    const third = await seedJob({ owner: 'alice', priority: 5, createdAtSql: "now() - interval '4 minutes'" });

    const r1 = (await get_agent_job.handler(makeCtx({ clientId: 'alice' }), { id: first })) as any;
    expect(r1.queue_position).toBe(0);
    const r2 = (await get_agent_job.handler(makeCtx({ clientId: 'bob' }), { id: second })) as any;
    expect(r2.queue_position).toBe(1);
    // Higher priority NUMBER = claimed later (priority ASC) despite being older.
    const r3 = (await get_agent_job.handler(makeCtx({ clientId: 'alice' }), { id: third })) as any;
    expect(r3.queue_position).toBe(2);
  });

  it('scopes the count to the job\'s own queue', async () => {
    await seedJob({ owner: 'bob', queue: 'other', createdAtSql: "now() - interval '10 minutes'" });
    const id = await seedJob({ owner: 'alice', queue: 'default' });
    const r = (await get_agent_job.handler(makeCtx({ clientId: 'alice' }), { id })) as any;
    expect(r.queue_position).toBe(0);
  });

  it('is absent for non-waiting jobs', async () => {
    const id = await seedJob({ owner: 'alice', status: 'active' });
    const r = (await get_agent_job.handler(makeCtx({ clientId: 'alice' }), { id })) as Record<string, unknown>;
    expect('queue_position' in r).toBe(false);
  });
});
