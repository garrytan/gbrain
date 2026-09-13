import { describe, expect, test } from 'bun:test';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { TimelineOpts, PageReadPolicy } from '../src/core/types.ts';

const getTimeline = operationsByName['get_timeline'];

function makeCtx(): OperationContext {
  const calls: Array<{ slug: string; opts?: TimelineOpts & PageReadPolicy }> = [];
  const engine = {
    getTimeline: async (slug: string, opts?: TimelineOpts & PageReadPolicy) => {
      calls.push({ slug, opts });
      return [];
    },
    // Remote callers resolve the private-pages config (no opt-out here).
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
    auth: {
      token: 'test',
      clientId: 'client',
      scopes: ['read'],
      sourceId: 'default',
      allowedSources: ['alpha', 'beta'],
    },
    __calls: calls,
  } as unknown as OperationContext & { __calls: Array<{ slug: string; opts?: TimelineOpts & PageReadPolicy }> };
}

describe('get_timeline op', () => {
  test('declares date-window and limit params', () => {
    expect(getTimeline.params.after.type).toBe('string');
    expect(getTimeline.params.before.type).toBe('string');
    expect(getTimeline.params.since.type).toBe('string');
    expect(getTimeline.params.until.type).toBe('string');
    expect(getTimeline.params.limit.type).toBe('number');
  });

  test('threads after/before/limit with federated source scope', async () => {
    const ctx = makeCtx();
    await getTimeline.handler(ctx, {
      slug: 'people/alice-example',
      after: '2026-01-01',
      before: '2026-03-31',
      limit: 7,
    });

    expect((ctx as typeof ctx & { __calls: Array<{ slug: string; opts?: TimelineOpts & PageReadPolicy }> }).__calls).toEqual([{
      slug: 'people/alice-example',
      opts: {
        sourceIds: ['alpha', 'beta'],
        excludePrivate: true,
        requireSafeChunks: true,
        takesHoldersAllowList: ['world'],
        after: '2026-01-01',
        before: '2026-03-31',
        limit: 7,
      },
    }]);
  });

  test('accepts since/until as aliases for after/before', async () => {
    const ctx = makeCtx();
    await getTimeline.handler(ctx, {
      slug: 'people/alice-example',
      since: '2026-04-01',
      until: '2026-04-30',
    });

    expect((ctx as typeof ctx & { __calls: Array<{ slug: string; opts?: TimelineOpts & PageReadPolicy }> }).__calls[0]?.opts).toMatchObject({
      sourceIds: ['alpha', 'beta'],
      excludePrivate: true,
      requireSafeChunks: true,
      takesHoldersAllowList: ['world'],
      after: '2026-04-01',
      before: '2026-04-30',
    });
  });
});
