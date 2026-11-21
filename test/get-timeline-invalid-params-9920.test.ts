import { describe, expect, test } from 'bun:test';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

const getTimeline = operationsByName['get_timeline'];

function makeCtx(): OperationContext {
  const engine = {
    getTimeline: async () => [],
    getConfig: async () => null,
    executeRaw: async () => [],
  };
  return {
    engine,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    auth: { token: 't', clientId: 'c', scopes: ['read'], sourceId: 'default', allowedSources: ['alpha'] },
  } as unknown as OperationContext;
}

async function capture(params: Record<string, unknown>): Promise<{ code?: string; message?: string } | null> {
  try {
    await getTimeline.handler(makeCtx(), { slug: 'people/x-example', ...params });
    return null;
  } catch (e) {
    return e as { code?: string; message?: string };
  }
}

describe('get_timeline input validation (#9920)', () => {
  for (const [name, params] of [
    ['after', { after: 'nope' }],
    ['before', { before: '2026-13-40' }],
    ['since', { since: 'nope' }],
    ['until', { until: '2026-02-30' }],
    ['limit', { limit: -1 }],
    ['limit', { limit: 1.5 }],
  ] as const) {
    test(`${JSON.stringify(params)} is invalid_params naming ${name}`, async () => {
      const err = await capture(params);
      expect(err?.code).toBe('invalid_params');
      expect(err?.message).toContain(name);
    });
  }

  test('valid window passes', async () => {
    expect(await capture({ after: '2026-01-01', before: '2026-03-31', limit: 5 })).toBeNull();
  });
});
