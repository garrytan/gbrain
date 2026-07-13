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

  test('--json is a CLI-local formatter flag for shared operations', () => {
    const params = parseOpArgs(operationsByName.search, [
      'needle',
      '--json',
    ]);

    expect(params).toEqual({
      query: 'needle',
      json: true,
    });
  });
});
