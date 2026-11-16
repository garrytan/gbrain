import { describe, expect, test } from 'bun:test';
import { onlyNeedsEngine } from '../src/commands/doctor/registry.ts';

describe('doctor --only memory_writeback (#9513)', () => {
  test('requests the engine so the check does not report the database unreachable', () => {
    expect(onlyNeedsEngine(new Set(['memory_writeback']))).toBe(true);
  });
  test('the engine-free relay check still runs without the engine', () => {
    expect(onlyNeedsEngine(new Set(['memorable_relay_health']))).toBe(false);
  });
});
