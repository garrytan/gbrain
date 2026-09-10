/** Generic remote jobs reject spend identities in data; authority comes only
 * from the verifier. Trusted local application submitters retain attribution. */
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
  sourceId: 'default',
  principal: { kind: 'oauth_client', id: 'client-abcdef0123456789' },
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
  it('remote authenticated caller cannot supply a spend identity in data', async () => {
    await expect(submit_job.handler(ctxOf({ auth: AUTHED }), {
      name: 'lint', data: { client_id: 'victim-client' },
    })).rejects.toThrow('unsupported remote job parameter');
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  });

  it('remote caller without a durable identity cannot submit generic work', async () => {
    await expect(submit_job.handler(ctxOf(), { name: 'lint', data: {} })).rejects.toThrow('persistent principal');
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
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
