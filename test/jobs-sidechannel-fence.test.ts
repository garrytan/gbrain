/**
 * A9 — send_job_message sidechannel sender fence (fail-closed).
 *
 * The op-layer contract for src/core/ops/jobs.ts `send_job_message`:
 *   - remote caller (ctx.remote !== false) with NO authenticated identity
 *     (no ctx.auth?.clientId) → OperationError('permission_denied'), and
 *     NOTHING is persisted to the job's inbox. The `sender` param cannot
 *     bypass the fence (no self-nominated identity).
 *   - remote caller WITH an authenticated clientId → the persisted sender is
 *     the derived identity `mcp:<clientId8>` (same actor convention as
 *     ops/schema-packs.ts audit rows), NEVER the literal 'admin' and never
 *     the caller-supplied `sender` param.
 *   - local caller (ctx.remote === false) keeps today's behavior: explicit
 *     `sender` param passes through to the queue layer; omitted sender
 *     defaults to 'admin'.
 *   - terminal-status job → OperationError('invalid_params') on both the
 *     local and the remote-authenticated path.
 *
 * Queue-LEVEL sender auth (admin/parent-only, unauthorized → null) is pinned
 * in test/minions.test.ts ("Inbox" describe block) — this file deliberately
 * does not duplicate it; it pins the OP layer's identity derivation and its
 * error mapping.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
const send_job_message = operationsByName['send_job_message'];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as any,
    dryRun: false,
    remote: true,
    transport: 'stdio',
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

/** AuthInfo carrying a clientId whose 8-char prefix is 'client-a'. */
const AUTHED = {
  token: 'test-token',
  clientId: 'client-abcdef0123456789',
  scopes: ['admin'],
} as OperationContext['auth'];

/** Direct SQL seed (same shape as test/jobs-ops-token-redaction.test.ts). */
async function seedJob(status = 'waiting'): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, queue, status, data)
     VALUES ('embed', 'default', $1, '{}'::jsonb)
     RETURNING id`,
    [status],
  );
  return Number(rows[0].id);
}

async function inboxRows(jobId: number): Promise<Array<{ sender: string; payload: unknown }>> {
  return engine.executeRaw<{ sender: string; payload: unknown }>(
    `SELECT sender, payload FROM minion_inbox WHERE job_id = $1 ORDER BY id`,
    [jobId],
  );
}

async function callErr(ctx: OperationContext, params: Record<string, unknown>): Promise<OperationError> {
  try {
    await send_job_message.handler(ctx, params);
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    return e as OperationError;
  }
  throw new Error('expected send_job_message to throw, but it resolved');
}

describe('send_job_message — remote sidechannel fence (fail-closed)', () => {
  it('remote + no authenticated identity → permission_denied, inbox stays EMPTY', async () => {
    const id = await seedJob();

    const err = await callErr(ctxOf(), { id, payload: { directive: 'x' } });
    expect(err.code).toBe('permission_denied');

    // The sender param cannot self-nominate an identity past the fence.
    const errWithParam = await callErr(ctxOf(), { id, payload: { directive: 'x' }, sender: 'admin' });
    expect(errWithParam.code).toBe('permission_denied');

    expect(await inboxRows(id)).toHaveLength(0);
  });

  it('remote + authenticated clientId → persisted sender is the derived mcp:<clientId8>, never admin', async () => {
    const id = await seedJob();
    const res = (await send_job_message.handler(
      ctxOf({ auth: AUTHED }),
      { id, payload: { directive: 'focus on X' } },
    )) as Record<string, unknown>;
    expect(res.sent).toBe(true);
    expect(res.job_id).toBe(id);

    const rows = await inboxRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].sender).toBe('mcp:client-a');
    expect(rows[0].sender).not.toBe('admin');
    expect(rows[0].payload).toEqual({ directive: 'focus on X' });
  });

  it('remote + authenticated: a caller-supplied sender param is IGNORED, derived identity wins', async () => {
    const id = await seedJob();
    await send_job_message.handler(
      ctxOf({ auth: AUTHED }),
      { id, payload: { spoof: true }, sender: 'admin' },
    );
    const rows = await inboxRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].sender).toBe('mcp:client-a');
  });
});

describe('send_job_message — local caller behavior preserved', () => {
  it('local caller with no sender param persists the default sender admin', async () => {
    const id = await seedJob();
    const res = (await send_job_message.handler(
      ctxOf({ remote: false, transport: undefined }),
      { id, payload: { note: 'hello' } },
    )) as Record<string, unknown>;
    expect(res.sent).toBe(true);

    const rows = await inboxRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].sender).toBe('admin');
  });

  it('local caller with an explicit sender param passes it through (parent job id)', async () => {
    const parentId = await seedJob();
    const childRows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, queue, status, data, parent_job_id)
       VALUES ('research', 'default', 'waiting', '{}'::jsonb, $1)
       RETURNING id`,
      [parentId],
    );
    const childId = Number(childRows[0].id);

    await send_job_message.handler(
      ctxOf({ remote: false, transport: undefined }),
      { id: childId, payload: { hint: 'dig deeper' }, sender: String(parentId) },
    );
    const rows = await inboxRows(childId);
    expect(rows).toHaveLength(1);
    expect(rows[0].sender).toBe(String(parentId));
  });
});

describe('send_job_message — terminal-status job → invalid_params (both trust branches)', () => {
  it('local: terminal job refuses with invalid_params, nothing persisted', async () => {
    const id = await seedJob('completed');
    const err = await callErr(
      ctxOf({ remote: false, transport: undefined }),
      { id, payload: { too: 'late' } },
    );
    expect(err.code).toBe('invalid_params');
    expect(await inboxRows(id)).toHaveLength(0);
  });

  it('remote-authenticated: terminal job refuses with invalid_params, nothing persisted', async () => {
    const id = await seedJob('cancelled');
    const err = await callErr(ctxOf({ auth: AUTHED }), { id, payload: { too: 'late' } });
    expect(err.code).toBe('invalid_params');
    expect(await inboxRows(id)).toHaveLength(0);
  });
});
