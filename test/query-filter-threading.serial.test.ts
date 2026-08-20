/**
 * Query operation filter threading.
 *
 * Serial: mock.module must bind before operations.ts imports hybridSearchCached.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { HybridSearchOpts } from '../src/core/search/hybrid.ts';

let capturedOpts: HybridSearchOpts | undefined;

mock.module('../src/core/search/hybrid.ts', () => ({
  ...realHybrid,
  hybridSearchCached: async (
    _engine: BrainEngine,
    _query: string,
    opts?: HybridSearchOpts,
  ) => {
    capturedOpts = opts;
    return [];
  },
}));

const { operationsByName } = await import('../src/core/operations.ts');

const engine = {
  getConfig: async () => null,
} as unknown as BrainEngine;

const ctx = {
  engine,
  config: { engine: 'pglite' as const },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  dryRun: false,
  remote: true,
  sourceId: 'default',
};

beforeEach(() => {
  capturedOpts = undefined;
});

describe('query operation filters', () => {
  test('declares all three filters on the public operation contract', () => {
    expect(operationsByName.query.params.types?.type).toBe('array');
    expect(operationsByName.query.params.exclude_slug_prefixes?.type).toBe('array');
    expect(operationsByName.query.params.include_slug_prefixes?.type).toBe('array');
  });

  test('threads page types to the ordinary cached-hybrid path', async () => {
    await operationsByName.query.handler(ctx, {
      query: 'acme-example',
      expand: false,
      types: ['company', '', 17, ' company '],
    });

    expect(capturedOpts?.types).toEqual(['company']);
  });

  test('threads additive hard-exclude prefixes to the ordinary cached-hybrid path', async () => {
    await operationsByName.query.handler(ctx, {
      query: 'acme-example',
      expand: false,
      exclude_slug_prefixes: ['private/', '', ' private/ '],
    });

    expect(capturedOpts?.exclude_slug_prefixes).toEqual(['private/']);
  });

  test('threads search-policy opt-back-in prefixes to the ordinary cached-hybrid path', async () => {
    await operationsByName.query.handler(ctx, {
      query: 'acme-example',
      expand: false,
      include_slug_prefixes: ['test/', '', ' test/ '],
    });

    expect(capturedOpts?.include_slug_prefixes).toEqual(['test/']);
  });
});
