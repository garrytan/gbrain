import { describe, expect, test } from 'bun:test';
import { parseOpArgs } from '../src/cli.ts';
import { operationsByName } from '../src/core/operations.ts';

describe('parseOpArgs', () => {
  test('rejects unknown long flags instead of silently forwarding them', () => {
    expect(() => parseOpArgs(operationsByName.put_page, [
      'notes/repro',
      '--file',
      '/tmp/repro.md',
    ])).toThrow('Unknown flag: --file');
  });

  test('rejects unknown short flags when there is no positional slot', () => {
    expect(() => parseOpArgs(operationsByName.list_pages, [
      '--type',
      'session-summary',
      '-n',
      '500',
    ])).toThrow('Unknown flag: -n');
  });

  test('accepts --json as a CLI render flag for shared operations', () => {
    const params = parseOpArgs(operationsByName.query, [
      'type:concept',
      '--limit',
      '10000',
      '--json',
    ]);

    expect(params).toEqual({
      query: 'type:concept',
      limit: 10000,
      __cli_render_json: true,
    });
  });

  test('accepts get --raw as a CLI render flag', () => {
    const params = parseOpArgs(operationsByName.get_page, [
      'notes/example',
      '--raw',
    ]);

    expect(params).toEqual({
      slug: 'notes/example',
      __cli_render_raw: true,
    });
  });

  test('honors -- as end-of-options for dash-leading positional text', () => {
    const params = parseOpArgs(operationsByName.query, [
      '--',
      '--json',
    ]);

    expect(params).toEqual({
      query: '--json',
    });
  });

  test('accepts --type on search and query as a page-type filter', () => {
    expect(parseOpArgs(operationsByName.search, [
      'founders',
      '--type',
      'person',
      '--limit',
      '10',
    ])).toEqual({
      query: 'founders',
      type: 'person',
      limit: 10,
    });

    expect(parseOpArgs(operationsByName.query, [
      'imported_from:markdown-greenfield',
      '--type',
      'atom',
      '--json',
    ])).toEqual({
      query: 'imported_from:markdown-greenfield',
      type: 'atom',
      __cli_render_json: true,
    });
  });

  test('keeps dash-leading positional text for commands that accept it', () => {
    const params = parseOpArgs(operationsByName.query, [
      '-why does this still parse?',
      '--limit',
      '5',
    ]);

    expect(params).toEqual({
      query: '-why does this still parse?',
      limit: 5,
    });
  });

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
});
