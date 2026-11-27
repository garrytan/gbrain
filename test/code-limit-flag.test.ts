/**
 * The code-* commands' --limit is a usage error when it is not a positive whole number.
 *
 * code-callers, code-callees, code-def and code-refs read the flag with a bare parseInt, so `--limit abc` sent NaN
 * and `--limit -5` a negative number to the SQL LIMIT. The database refused it and the caller got exit 1 with code
 * `unknown` and a raw driver message, which tells an agent to report a server bug; `5abc` silently read as 5 and
 * `0` returned an empty list. Each must exit 2 with `invalid_params` naming the value, as `gbrain list` does, and
 * a valid limit must still cap the rows. Runs the real commands against an in-memory PGLite.
 */

import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { runCodeCallers } from '../src/commands/code-callers.ts';
import { runCodeCallees } from '../src/commands/code-callees.ts';
import { runCodeDef } from '../src/commands/code-def.ts';
import { runCodeRefs } from '../src/commands/code-refs.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importCodeFile(engine, 'src/limits.ts', `export function limitHelper(value: number): number {
  const doubled = value * 2;
  console.log('limit helper doubling', doubled);
  return doubled + 1;
}

export function limitCaller(seed: number): number {
  const first = limitHelper(seed);
  const second = limitHelper(first);
  console.log('limit caller computed', first, second);
  return first + second;
}
`, { noEmbed: true });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function run(fn: () => Promise<void>): Promise<{ out: string; err: string; exit: number | null }> {
  const out: string[] = [];
  const err: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exit = code ?? 0;
    throw new Error('EXIT');
  }) as never);
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error) || e.message !== 'EXIT') throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { out: out.join('\n'), err: err.join('\n'), exit };
}

const COMMANDS = [
  { name: 'code-callers', fn: runCodeCallers, symbol: 'limitHelper', rows: 'callers' },
  { name: 'code-callees', fn: runCodeCallees, symbol: 'limitCaller', rows: 'callees' },
  { name: 'code-def', fn: runCodeDef, symbol: 'limitHelper', rows: 'results' },
  { name: 'code-refs', fn: runCodeRefs, symbol: 'limitHelper', rows: 'results' },
] as const;

describe('code-* --limit validation', () => {
  for (const { name, fn, symbol, rows } of COMMANDS) {
    for (const bad of ['abc', '5abc', '-5', '0', '1.5', '', '99999999999999999999']) {
      test(`${name} --limit '${bad}' exits 2 with invalid_params naming the value`, async () => {
        const { out, exit } = await run(() => fn(engine, [symbol, '--all-sources', '--limit', bad, '--json']));
        expect(exit).toBe(2);
        const doc = JSON.parse(out);
        expect(doc.error.code).toBe('invalid_params');
        expect(doc.error.message).toContain(`'${bad}'`);
      });
    }

    test(`${name} --limit=abc (inline) exits 2 with invalid_params`, async () => {
      const { out, exit } = await run(() => fn(engine, [symbol, '--all-sources', '--limit=abc', '--json']));
      expect(exit).toBe(2);
      expect(JSON.parse(out).error.code).toBe('invalid_params');
    });

    test(`${name} --limit abc without --json prints the error to stderr and exits 2`, async () => {
      const { err, exit } = await run(() => fn(engine, [symbol, '--all-sources', '--limit', 'abc', '--no-json']));
      expect(exit).toBe(2);
      expect(err).toContain(`'abc'`);
    });

    test(`${name} with a trailing --limit and no value exits 2 instead of using the default cap`, async () => {
      const { out, exit } = await run(() => fn(engine, [symbol, '--all-sources', '--json', '--limit']));
      expect(exit).toBe(2);
      expect(JSON.parse(out).error.code).toBe('invalid_params');
    });

    test(`${name} --limit +1 is still read as 1, as parseInt read it`, async () => {
      const { out, exit } = await run(() => fn(engine, [symbol, '--all-sources', '--limit', '+1', '--json']));
      expect(exit).toBeNull();
      expect(JSON.parse(out)[rows].length).toBe(1);
    });

    test(`${name} --limit 1 still answers, capped at one row`, async () => {
      const { out, exit } = await run(() => fn(engine, [symbol, '--all-sources', '--limit', '1', '--json']));
      expect(exit).toBeNull();
      const doc = JSON.parse(out);
      expect(doc.error).toBeUndefined();
      expect(doc[rows].length).toBe(1);
    });
  }
});
