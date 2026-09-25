import { describe, expect, test } from 'bun:test';
import { constants } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readResidentBytes } from '../scripts/persistence/resource-sampling.ts';

const interrupted = () => Object.assign(new Error('synthetic interrupted observation'), { syscall: 'memoryUsage', errno: constants.errno.EINTR });

test('RSS sampling returns the actual first measurement', () => {
  let calls = 0;
  expect(readResidentBytes(() => { calls++; return 4096; })).toBe(4096);
  expect(calls).toBe(1);
});
test('RSS sampling retries only one or two interrupted observations before returning real bytes', () => {
  for (const interruptions of [1, 2]) {
    let calls = 0;
    expect(readResidentBytes(() => { if (calls++ < interruptions) throw interrupted(); return 8192; })).toBe(8192);
    expect(calls).toBe(interruptions + 1);
  }
});
test('RSS sampling recognizes an explicit EINTR code for the same syscall', () => {
  let calls = 0;
  expect(readResidentBytes(() => {
    if (calls++ === 0) throw Object.assign(new Error('synthetic interruption'), { syscall: 'memoryUsage', code: 'EINTR' });
    return 12288;
  })).toBe(12288);
  expect(calls).toBe(2);
});
test('RSS sampling preserves the original error after exactly three interrupted attempts', () => {
  const failure = interrupted(); let calls = 0; let caught: unknown;
  try { readResidentBytes(() => { calls++; throw failure; }); } catch (error) { caught = error; }
  expect(caught).toBe(failure); expect(calls).toBe(3);
});
test('RSS sampling never retries other syscalls, missing error codes or unrelated failures', () => {
  for (const failure of [
    Object.assign(new Error('synthetic interruption'), { syscall: 'read', errno: constants.errno.EINTR }),
    Object.assign(new Error('synthetic failure'), { syscall: 'memoryUsage', errno: constants.errno.EIO }),
    Object.assign(new Error('Failed to get memory usage'), { syscall: 'memoryUsage' }),
    new Error('synthetic unrelated failure'), 'synthetic thrown value',
  ]) {
    let calls = 0; let caught: unknown;
    try { readResidentBytes(() => { calls++; throw failure; }); } catch (error) { caught = error; }
    expect(caught).toBe(failure); expect(calls).toBe(1);
  }
});
test('RSS sampling refuses invalid measurements instead of fabricating or skipping memory evidence', () => {
  for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    let calls = 0;
    expect(() => readResidentBytes(() => { calls++; return value; })).toThrow('positive integer byte measurement');
    expect(calls).toBe(1);
  }
});
describe('RSS sampler wiring', () => {
  test('both owner observations use the bounded sampler and reproducibility includes its source', () => {
    const root = join(import.meta.dir, '..');
    const worker = readFileSync(join(root, 'scripts/persistence/worker.ts'), 'utf8');
    expect(worker.match(/\breadResidentBytes\(\)/g)).toHaveLength(2);
    expect(worker).not.toContain('process.memoryUsage()');
    expect(readFileSync(join(root, 'scripts/persistence/validate.ts'), 'utf8')).toContain("'scripts/persistence/resource-sampling.ts'");
  });
});
