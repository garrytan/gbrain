import { describe, it, expect } from 'bun:test';
import { DREAM_CYCLE_PHASE_FAMILIES } from '../../src/core/services/dream-cycle-runner-service.ts';

describe('auto_promote dream phase', () => {
  it('is registered as the last family', () => {
    const families = DREAM_CYCLE_PHASE_FAMILIES.map((f) => f.family);
    expect(families).toContain('auto_promote');
    expect(families[families.length - 1]).toBe('auto_promote');
  });
  it('keeps registry order contiguous', () => {
    const orders = DREAM_CYCLE_PHASE_FAMILIES.map((f) => f.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });
});
