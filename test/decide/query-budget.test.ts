/**
 * decide query budget: bounds the latency decide work adds, not retrieval time.
 */
import { describe, expect, test } from 'bun:test';
import { MIN_STAGE_MS, createQueryBudget, stageDeadlineMs } from '../../src/core/ai/decide/runtime.ts';

describe('decide query budget', () => {
  test('before anchor the clock runs from creation', () => {
    const b = createQueryBudget(1500, 0);
    expect(b.remaining(1400)).toBe(100);
    expect(stageDeadlineMs(b, 1500, 1400)).toBe(100);
    expect(stageDeadlineMs(b, 1500, 1500 - MIN_STAGE_MS + 1)).toBeNull();
  });

  test('anchor restarts the clock after retrieval, minus charged S2 wait', () => {
    const b = createQueryBudget(1500, 0);
    b.charge(250);
    b.anchor(3000);
    expect(b.remaining(3000)).toBe(1250);
    expect(stageDeadlineMs(b, 1500, 3000)).toBe(1250);
  });

  test('anchor is idempotent and charges after it are ignored', () => {
    const b = createQueryBudget(1000, 0);
    b.anchor(2000);
    b.charge(500);
    b.anchor(5000);
    expect(b.deadlineAt).toBe(3000);
  });

  test('charges beyond the budget leave nothing, never a negative deadline', () => {
    const b = createQueryBudget(300, 0);
    b.charge(900);
    b.anchor(100);
    expect(b.remaining(100)).toBe(0);
    expect(stageDeadlineMs(b, 1500, 100)).toBeNull();
  });
});
