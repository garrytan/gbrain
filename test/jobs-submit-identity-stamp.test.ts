/**
 * submit_job `data.client_id` identity stamp (pre-landing review fix).
 *
 * `data.client_id` is a spend-attribution identity: minion handlers settle
 * their LLM/embedding spend against it via getJobClientId →
 * recordMinionJobSpend (src/core/minion-spend.ts), charging the named OAuth
 * client's mcp_spend_log / daily cap. Pre-fix, submit_job passed the
 * caller-supplied `data` payload through to queue.add unmodified, so a
 * remote caller could stamp ANOTHER client's id (billing/cap spoof) or
 * invent one. Mirroring send_job_message's derived-identity fence:
 *
 *   - remote caller (ctx.remote !== false) WITH an authenticated clientId →
 *     data.client_id is OVERWRITTEN with ctx.auth.clientId (the same
 *     identity source run_onboard/A23 uses for spend attribution).
 *   - remote caller WITHOUT an authenticated identity (e.g. stdio pipe) →
 *     the key is DELETED (a job with no client_id records spend with
 *     clientId=null; it never counts against a specific client's cap).
 *   - trusted local caller (ctx.remote === false) keeps today's behavior:
 *     the caller-supplied value passes through (the CLI/autopilot path is
 *     the trusted surface that legitimately sets it, e.g. run_onboard).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const submit_job = operationsByName['submit_job'];

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

const AUTHED = {
  token: 'test-token',
  clientId: 'client-abcdef0123456789',
  scopes: ['admin'],
} as OperationContext['auth'];

async function storedData(jobId: number): Promise<Record<string, unknown>> {
  const rows = await engine.executeRaw<{ data: Record<string, unknown> }>(
    `SELECT data FROM minion_jobs WHERE id = $1`,
    [jobId],
  );
  expect(rows).toHaveLength(1);
  return rows[0].data;
}

describe('submit_job — data.client_id derived-identity stamp', () => {
  it('remote + authenticated: caller-supplied client_id is OVERWRITTEN with the authenticated id', async () => {
    const res = (await submit_job.handler(
      ctxOf({ auth: AUTHED }),
      { name: 'lint', data: { client_id: 'victim-client', nonce: 'stamp-1' } },
    )) as { id: number };
    const data = await storedData(res.id);
    expect(data.client_id).toBe('client-abcdef0123456789');
    expect(data.client_id).not.toBe('victim-client');
    expect(data.nonce).toBe('stamp-1'); // rest of the payload untouched
  });

  it('remote + NO authenticated identity: the key is stripped, never persisted', async () => {
    const res = (await submit_job.handler(
      ctxOf(),
      { name: 'lint', data: { client_id: 'victim-client', nonce: 'stamp-2' } },
    )) as { id: number };
    const data = await storedData(res.id);
    expect(data.client_id).toBeUndefined();
    expect(data.nonce).toBe('stamp-2');
  });

  it('local caller (ctx.remote === false) preserves the caller-supplied value', async () => {
    const res = (await submit_job.handler(
      ctxOf({ remote: false, transport: undefined }),
      { name: 'lint', data: { client_id: 'cli-picked-client', nonce: 'stamp-3' } },
    )) as { id: number };
    const data = await storedData(res.id);
    expect(data.client_id).toBe('cli-picked-client');
  });
});
