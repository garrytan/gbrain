/**
 * Unit tests for parsePruneStatuses (PR #2282) — `jobs prune --status` parsing.
 */

import { describe, test, expect } from 'bun:test';
import { parsePruneStatuses, PRUNE_STATUSES } from '../src/commands/jobs.ts';

describe('parsePruneStatuses', () => {
  test('parses a single status', () => {
    expect(parsePruneStatuses('failed')).toEqual(['failed']);
  });

  test('parses a comma-separated list with whitespace', () => {
    expect(parsePruneStatuses(' completed, dead ')).toEqual(['completed', 'dead']);
  });

  test('accepts every documented terminal status', () => {
    expect(parsePruneStatuses(PRUNE_STATUSES.join(','))).toEqual([...PRUNE_STATUSES]);
  });

  test('throws on non-terminal statuses', () => {
    expect(() => parsePruneStatuses('waiting')).toThrow(/Invalid: waiting/);
    expect(() => parsePruneStatuses('completed,active')).toThrow(/Invalid: active/);
  });

  test('throws on empty value', () => {
    expect(() => parsePruneStatuses('')).toThrow(/comma-separated subset/);
    expect(() => parsePruneStatuses(',')).toThrow(/comma-separated subset/);
  });
});
