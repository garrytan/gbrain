import { test, expect } from 'bun:test';
import { restartBackoffMs } from '../src/core/docling-supervisor.ts';

test('backoff grows exponentially and is capped, with jitter in [exp/2, exp]', () => {
  const a0 = restartBackoffMs(0, 500, 30_000); // exp 500 → [250, 500]
  expect(a0).toBeGreaterThanOrEqual(250);
  expect(a0).toBeLessThanOrEqual(500);

  const a4 = restartBackoffMs(4, 500, 30_000); // exp 8000 → [4000, 8000]
  expect(a4).toBeGreaterThanOrEqual(4_000);
  expect(a4).toBeLessThanOrEqual(8_000);

  const aBig = restartBackoffMs(20, 500, 30_000); // capped at 30000 → [15000, 30000]
  expect(aBig).toBeGreaterThanOrEqual(15_000);
  expect(aBig).toBeLessThanOrEqual(30_000);
});

test('negative attempt clamps to attempt 0', () => {
  const a = restartBackoffMs(-5, 500, 30_000);
  expect(a).toBeGreaterThanOrEqual(250);
  expect(a).toBeLessThanOrEqual(500);
});
