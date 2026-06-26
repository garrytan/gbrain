import { describe, expect, test } from 'bun:test';
import { parseOpArgs } from '../src/cli.ts';
import { operationsByName } from '../src/core/operations.ts';

describe('parseOpArgs', () => {
  test('--no-<boolean> maps to false without consuming the next flag', () => {
    const params = parseOpArgs(operationsByName.query, [
      'freshEmbedSourceScope code source',
      '--limit',
      '8',
      '--no-expand',
      '--source-id',
      'gstack-code-repo-0e4763c9',
    ]);

    expect(params).toEqual({
      query: 'freshEmbedSourceScope code source',
      limit: 8,
      expand: false,
      source_id: 'gstack-code-repo-0e4763c9',
    });
  });

  test('--no-cache maps to cache false without consuming limit', () => {
    const params = parseOpArgs(operationsByName.query, [
      'current owner truth',
      '--source-id',
      'issue164-research',
      '--recency',
      'strong',
      '--no-cache',
      '--limit',
      '10',
    ]);

    expect(params).toEqual({
      query: 'current owner truth',
      source_id: 'issue164-research',
      recency: 'strong',
      cache: false,
      limit: 10,
    });
  });
});
