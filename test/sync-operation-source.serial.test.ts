import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { OperationContext } from '../src/core/operations.ts';
import type { SyncOpts } from '../src/commands/sync.ts';

const calls: SyncOpts[] = [];

mock.module('../src/commands/sync.ts', () => ({
  performSync: async (_engine: unknown, opts: SyncOpts) => {
    calls.push(opts);
    return { mode: 'incremental', added: 0, modified: 0, deleted: 0 };
  },
}));

const { operations } = await import('../src/core/operations.ts');

function context(sourceId: string): OperationContext {
  return {
    engine: {} as OperationContext['engine'],
    config: {} as OperationContext['config'],
    logger: console as OperationContext['logger'],
    dryRun: false,
    remote: false,
    sourceId,
  };
}

describe('sync_brain source routing', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  test('explicit source_id overrides the ambient MCP source', async () => {
    const op = operations.find((candidate) => candidate.name === 'sync_brain');
    expect(op).toBeDefined();
    expect(op!.params.source_id).toBeDefined();

    await op!.handler(context('default'), {
      repo: '/tmp/devdocs-brain',
      source_id: 'devdocs-ops',
      no_pull: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sourceId).toBe('devdocs-ops');
  });

  test('ambient MCP source is threaded when source_id is omitted', async () => {
    const op = operations.find((candidate) => candidate.name === 'sync_brain');
    expect(op).toBeDefined();

    await op!.handler(context('devdocs-ops'), {
      repo: '/tmp/devdocs-brain',
      no_pull: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sourceId).toBe('devdocs-ops');
  });
});