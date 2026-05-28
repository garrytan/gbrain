import { describe, expect, test } from 'bun:test';
import { buildSourceStatusWarnings } from '../src/commands/sources.ts';

describe('sources status warnings', () => {
  test('default without local_path is treated as legacy DB-only, not an active sync target', () => {
    expect(buildSourceStatusWarnings({
      source_id: 'default',
      local_path: null,
      lag_seconds: null,
    })).toEqual([]);
  });

  test('non-default source without local_path is DB-only and does not get a sync command', () => {
    expect(buildSourceStatusWarnings({
      source_id: 'archive',
      local_path: null,
      lag_seconds: null,
    })).toEqual(['DB-only source (no local_path; sync disabled)']);
  });

  test('local source that never synced still gets the sync command', () => {
    expect(buildSourceStatusWarnings({
      source_id: 'sawyer-brain',
      local_path: '/Users/sawbeck/brain',
      lag_seconds: null,
    })).toEqual(['never synced — run `gbrain sync --source sawyer-brain`']);
  });
});
