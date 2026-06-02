/**
 * v0.41.39 (#1700) — P1#4 regression: the multi-source `--background` fan-out
 * idempotency key must incorporate the full run config, so a re-run with
 * different flags enqueues NEW work instead of returning the old job.
 * Pure (no engine) — runs in the fast parallel loop.
 */
import { describe, test, expect } from 'bun:test';
import { backgroundIdempotencyKey } from '../../src/commands/enrich.ts';

describe('backgroundIdempotencyKey (P1#4)', () => {
  test('namespaced by source id', () => {
    expect(backgroundIdempotencyKey('dept-x', ['--thin'])).toMatch(/^enrich:dept-x:/);
  });

  test('same flags → same key (idempotent re-submit dedups)', () => {
    const a = backgroundIdempotencyKey('default', ['--thin', '--model', 'anthropic:x']);
    const b = backgroundIdempotencyKey('default', ['--thin', '--model', 'anthropic:x']);
    expect(a).toBe(b);
  });

  test('different --model → different key (new job)', () => {
    const a = backgroundIdempotencyKey('default', ['--thin', '--model', 'anthropic:x']);
    const b = backgroundIdempotencyKey('default', ['--thin', '--model', 'anthropic:y']);
    expect(a).not.toBe(b);
  });

  test('different --limit / --force / --dry-run → different key', () => {
    const base = ['--thin'];
    const k0 = backgroundIdempotencyKey('default', base);
    expect(backgroundIdempotencyKey('default', [...base, '--limit', '50'])).not.toBe(k0);
    expect(backgroundIdempotencyKey('default', [...base, '--force'])).not.toBe(k0);
    expect(backgroundIdempotencyKey('default', [...base, '--dry-run'])).not.toBe(k0);
  });

  test('different source id → different key', () => {
    expect(backgroundIdempotencyKey('a', ['--thin'])).not.toBe(
      backgroundIdempotencyKey('b', ['--thin']),
    );
  });
});
