/**
 * `foresights get --lines 100-140` (and `--lines 100`, `--bytes 0-999`) take the
 * range form an agent tries first. Before, the generic parser JSON-parsed the
 * object param and refused with "--lines requires a JSON object".
 */
import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { parseOpArgs } from '../src/cli/main.ts';

const getPage = operations.find(o => o.name === 'get_page')! as never;

describe('get_page window ranges on the CLI', () => {
  test('--lines N-M is the inclusive line range', () => {
    expect(parseOpArgs(getPage, ['notes/acme-example', '--lines', '100-140']).lines).toEqual({ from: 100, count: 41 });
    expect(parseOpArgs(getPage, ['notes/acme-example', '--lines=100 - 140']).lines).toEqual({ from: 100, count: 41 });
  });

  test('--lines N is one line', () => {
    expect(parseOpArgs(getPage, ['notes/acme-example', '--lines', '100']).lines).toEqual({ from: 100, count: 1 });
  });

  test('--bytes N-M is the inclusive byte range', () => {
    expect(parseOpArgs(getPage, ['notes/acme-example', '--bytes', '0-999']).bytes).toEqual({ offset: 0, length: 1000 });
  });

  test('JSON still works', () => {
    expect(parseOpArgs(getPage, ['notes/acme-example', '--lines', '{"from":5,"count":10}']).lines).toEqual({ from: 5, count: 10 });
  });

  test('a reversed range and an unparseable value are usage errors that name the range form', () => {
    expect(() => parseOpArgs(getPage, ['notes/acme-example', '--lines', '140-100'])).toThrow('--lines 140-100 ends before it starts.');
    expect(() => parseOpArgs(getPage, ['notes/acme-example', '--lines', 'first'])).toThrow('--lines takes a range N-M (inclusive) or N, or a JSON object.');
  });
});
