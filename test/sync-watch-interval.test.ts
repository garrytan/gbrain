/**
 * `sync --watch --interval` must reject values that Node/Bun timers coerce to
 * an approximately immediate delay. This protects the CLI boundary without
 * starting a sync loop or touching a brain.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { parseSyncFlags } from '../src/commands/sync/args.ts';

const originalExit = process.exit;
const originalError = console.error;

afterEach(() => {
  process.exit = originalExit;
  console.error = originalError;
});

describe('sync watch interval', () => {
  test('keeps the default and accepts a positive integer number of seconds', () => {
    expect(parseSyncFlags([]).interval).toBe(60);
    expect(parseSyncFlags(['--watch', '--interval', '15']).interval).toBe(15);
  });

  test.each(['oops', '0', '-1', '1.5', '3abc', '9007199254740992'])('%s is rejected before watch starts', (value) => {
    let exitCode: number | undefined;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}`);
    }) as typeof process.exit;

    expect(() => parseSyncFlags(['--watch', '--interval', value])).toThrow('__exit_1');
    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toContain('--interval');
  });

  test.each(['missing', 'flag-shaped'])('a %s interval value is rejected', (caseName) => {
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}`);
    }) as typeof process.exit;

    const args = ['--watch', '--interval'];
    if (caseName === 'flag-shaped') args.push('--watch');
    expect(() => parseSyncFlags(args)).toThrow('__exit_1');
    expect(exitCode).toBe(1);
  });

  test('rejects intervals that exceed the maximum delay supported by timers', () => {
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}`);
    }) as typeof process.exit;

    expect(() => parseSyncFlags(['--watch', '--interval', '2147484'])).toThrow('__exit_1');
    expect(exitCode).toBe(1);
    expect(parseSyncFlags(['--watch', '--interval', '2147483']).interval).toBe(2147483);
  });
});
