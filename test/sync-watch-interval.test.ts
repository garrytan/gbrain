/**
 * #5931 (absorbed in agent contract v1 D4): `sync --watch --interval` rejects
 * values that Node/Bun timers coerce to an approximately immediate delay, as
 * an invalid_params usage error (exit 2 via renderCliError). Protects the CLI
 * boundary without starting a sync loop or touching a brain.
 */
import { describe, expect, test } from 'bun:test';
import { parseSyncFlags } from '../src/commands/sync/args.ts';

describe('sync watch interval', () => {
  test('keeps the default and accepts a positive integer number of seconds', () => {
    expect(parseSyncFlags([]).interval).toBe(60);
    expect(parseSyncFlags(['--watch', '--interval', '15']).interval).toBe(15);
    expect(parseSyncFlags(['--watch', '--interval', '2147483']).interval).toBe(2147483);
  });

  test.each(['oops', '0', '-1', '1.5', '3abc', '2147484', '9007199254740992'])('%s is rejected before watch starts', (value) => {
    expect(() => parseSyncFlags(['--watch', '--interval', value]))
      .toThrow(expect.objectContaining({ code: 'invalid_params', message: expect.stringContaining('--interval must be an integer from 1 to 2147483') }));
  });

  test.each(['missing', 'flag-shaped'])('a %s interval value is rejected', (caseName) => {
    const args = ['--watch', '--interval'];
    if (caseName === 'flag-shaped') args.push('--watch');
    expect(() => parseSyncFlags(args))
      .toThrow(expect.objectContaining({ code: 'invalid_params', message: expect.stringContaining('--interval requires a value') }));
  });
});
