/**
 * Agent contract v1 D4 (typed validation from ParamDef) and D6 (a bare `--`
 * ends options in parseOpArgs, matching findUnknownOpFlag).
 */
import { describe, expect, test } from 'bun:test';
import { parseOpArgs, findUnknownOpFlag } from '../src/cli.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const op = (name: string) => operations.find(o => o.name === name)!;

function usageErrorOf(fn: () => unknown): OperationError {
  try { fn(); } catch (e) { if (e instanceof OperationError) return e; throw e; }
  throw new Error('expected a usage error');
}

describe('D6: bare -- ends options', () => {
  test('a positional after -- that looks like a flag binds to the positional slot', () => {
    expect(parseOpArgs(op('get_page'), ['--', '--yes'])).toEqual({ slug: '--yes' });
  });
  test('flags before -- still parse; nothing after -- is read as a flag', () => {
    const p = parseOpArgs(op('search'), ['--limit', '3', '--', '--limit']);
    expect(p).toEqual({ limit: 3, query: '--limit' });
    expect(findUnknownOpFlag(op('search'), ['--', '--not-a-flag'])).toBeNull();
  });
});

describe('D4: typed op flag values', () => {
  test('a non-numeric number flag is invalid_params naming the flag and an example', () => {
    const e = usageErrorOf(() => parseOpArgs(op('search'), ['x', '--limit', 'abc']));
    expect(e.code).toBe('invalid_params');
    expect(e.message).toContain('--limit must be a number');
    expect(e.suggestion).toContain('--limit');
  });
  test('the inline = form is validated the same way', () => {
    expect(usageErrorOf(() => parseOpArgs(op('search'), ['x', '--limit=NaN'])).code).toBe('invalid_params');
  });
  test('an enum value outside the declared set lists the choices', () => {
    const e = usageErrorOf(() => parseOpArgs(op('search'), ['x', '--salience', 'loud']));
    expect(e.message).toContain('off, on, strong');
  });
  test('valid values still parse', () => {
    expect(parseOpArgs(op('search'), ['x', '--limit', '5', '--salience', 'on'])).toEqual({ query: 'x', limit: 5, salience: 'on' });
  });
  test('end to end: exit 2 with an invalid_params envelope, before any brain is opened', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-typed-args-'));
    const r = await runCli(['search', 'needle', '--limit', 'abc', '--json'], { home, cwd: home });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ code: 'invalid_params', contract_version: 1 });
    expect(r.stdout + r.stderr).not.toContain('No brain configured');
  });
});
