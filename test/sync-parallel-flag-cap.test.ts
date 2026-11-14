import { describe, expect, test } from 'bun:test';
import { parseSyncFanoutFlags } from '../src/commands/sync/args.ts';

describe('sync --all --parallel', () => {
  test('--parallel N caps sources like --max-sources', () => {
    expect(parseSyncFanoutFlags(['--all', '--parallel', '2'], true).maxSources).toBe(2);
  });
  test('--max-sources wins over --parallel', () => {
    expect(parseSyncFanoutFlags(['--all', '--parallel', '2', '--max-sources', '3'], true).maxSources).toBe(3);
  });
});
