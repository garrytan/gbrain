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

  test('array params accept comma-separated, repeated, and inline flag forms', () => {
    const params = parseOpArgs(operationsByName.query, [
      'acme-example',
      '--types',
      'person, company',
      '--types=note',
      '--exclude-slug-prefixes',
      'private/,scratch/',
      '--include-slug-prefixes=test/',
    ]);

    expect(params).toMatchObject({
      query: 'acme-example',
      types: ['person', 'company', 'note'],
      exclude_slug_prefixes: ['private/', 'scratch/'],
      include_slug_prefixes: ['test/'],
    });
  });
});
