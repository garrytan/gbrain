/**
 * #8951: `sync --all --parallel N` is documented as the number of sources run at once, but only --max-sources
 * reached the dispatcher. --parallel now caps sources too; --max-sources wins when both are given.
 */
import { describe, expect, test } from 'bun:test';
import { parseSyncFanoutFlags } from '../src/commands/sync/args.ts';

describe('sync --all source cap (#8951)', () => {
  test('--parallel N caps the sources run at once', () => {
    expect(parseSyncFanoutFlags(['--all', '--parallel', '2'], true).maxSources).toBe(2);
  });
  test('--max-sources wins over --parallel, in either order', () => {
    expect(parseSyncFanoutFlags(['--all', '--parallel', '2', '--max-sources', '3'], true).maxSources).toBe(3);
    expect(parseSyncFanoutFlags(['--all', '--max-sources', '3', '--parallel', '5'], true).maxSources).toBe(3);
  });
  test('neither flag leaves the cap to the dispatcher default', () => {
    expect(parseSyncFanoutFlags(['--all'], true).maxSources).toBeUndefined();
  });
});
