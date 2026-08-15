/**
 * Tests for resolveWorkersWithClamp (v0.41.15.0, D9).
 *
 * Pins the PGLite-clamp + stderr-warn contract that every bulk command
 * routes through. No real engine needed — the wrapper branches on
 * `engine.kind` only, so synthetic stubs satisfy the contract.
 *
 * R1+R2 compliant: no process.env mutation, no mock.module. Lives in
 * the parallel fast loop.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  resolveWorkersWithClamp,
  _resetWorkersClampWarningsForTest,
  DEFAULT_PARALLEL_WORKERS,
} from '../src/core/sync-concurrency.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const PGLITE: Pick<BrainEngine, 'kind'> = { kind: 'pglite' };
const POSTGRES: Pick<BrainEngine, 'kind'> = { kind: 'postgres' };

/**
 * Capture console.error output for the duration of `fn`. Returns the
 * collected lines. Restores the original spy on exit, including on
 * throw. Avoids env mutation per the test-isolation lint.
 */
async function captureStderr<T>(fn: () => Promise<T> | T): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = orig;
  }
}

beforeEach(() => {
  _resetWorkersClampWarningsForTest();
});

describe('resolveWorkersWithClamp — PGLite branch', () => {
  test('PGLite + override=5 → clamp to 1 + stderr warn + reason=pglite_clamp', async () => {
    const { result, lines } = await captureStderr(() =>
      resolveWorkersWithClamp(PGLITE as BrainEngine, 5, 'extract-conversation-facts', 0),
    );
    expect(result.workers).toBe(1);
    expect(result.wasClamped).toBe(true);
    expect(result.requested).toBe(5);
    expect(result.reason).toBe('pglite_clamp');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('[extract-conversation-facts]');
    expect(lines[0]).toContain('workers=5 requested');
    expect(lines[0]).toContain('clamped to 1');
    expect(lines[0]).toContain('PGLite');
  });

  test('PGLite + override=1 → no clamp, no warn, reason=override', async () => {
    const { result, lines } = await captureStderr(() =>
      resolveWorkersWithClamp(PGLITE as BrainEngine, 1, 'extract-conversation-facts', 0),
    );
    expect(result.workers).toBe(1);
    expect(result.wasClamped).toBe(false);
    expect(result.requested).toBe(1);
    expect(result.reason).toBe('override');
    expect(lines.length).toBe(0);
  });

  test('PGLite + no override → silent default to 1', async () => {
    const { result, lines } = await captureStderr(() =>
      resolveWorkersWithClamp(PGLITE as BrainEngine, undefined, 'extract', 0),
    );
    expect(result.workers).toBe(1);
    expect(result.wasClamped).toBe(false);
    expect(result.requested).toBeUndefined();
    expect(result.reason).toBe('default');
    expect(lines.length).toBe(0);
  });

  test('PGLite warning emits ONCE per (command, requested) pair within a process', async () => {
    const { lines } = await captureStderr(async () => {
      resolveWorkersWithClamp(PGLITE as BrainEngine, 20, 'extract-conversation-facts', 0);
      resolveWorkersWithClamp(PGLITE as BrainEngine, 20, 'extract-conversation-facts', 0);
      resolveWorkersWithClamp(PGLITE as BrainEngine, 20, 'extract-conversation-facts', 0);
    });
    expect(lines.length).toBe(1);
  });

  test('different (command, requested) tuples each warn once', async () => {
    const { lines } = await captureStderr(async () => {
      resolveWorkersWithClamp(PGLITE as BrainEngine, 5, 'extract', 0);
      resolveWorkersWithClamp(PGLITE as BrainEngine, 20, 'extract', 0);
      resolveWorkersWithClamp(PGLITE as BrainEngine, 5, 'reindex-code', 0);
    });
    expect(lines.length).toBe(3);
  });
});

describe('resolveWorkersWithClamp — Postgres branch', () => {
  test('Postgres + override=5 → passthrough, no warn, reason=override', async () => {
    const { result, lines } = await captureStderr(() =>
      resolveWorkersWithClamp(POSTGRES as BrainEngine, 5, 'extract-conversation-facts', 0),
    );
    expect(result.workers).toBe(5);
    expect(result.wasClamped).toBe(false);
    expect(result.requested).toBe(5);
    expect(result.reason).toBe('override');
    expect(lines.length).toBe(0);
  });

  test('Postgres + override=0 normalized to 1 via Math.max in autoConcurrency', async () => {
    const r = resolveWorkersWithClamp(POSTGRES as BrainEngine, 0, 'extract', 0);
    expect(r.workers).toBe(1);
    expect(r.requested).toBe(0);
  });

  test('Postgres + no override + large fileCount → DEFAULT_PARALLEL_WORKERS, reason=auto', async () => {
    const r = resolveWorkersWithClamp(POSTGRES as BrainEngine, undefined, 'extract', 1000);
    expect(r.workers).toBe(DEFAULT_PARALLEL_WORKERS);
    expect(r.reason).toBe('auto');
  });

  test('Postgres + no override + small fileCount → 1, reason=default', async () => {
    const r = resolveWorkersWithClamp(POSTGRES as BrainEngine, undefined, 'extract', 10);
    expect(r.workers).toBe(1);
    expect(r.reason).toBe('default');
  });
});

describe('resolveWorkersWithClamp — stderr message shape regression', () => {
  test('warning includes paste-ready engine-switch hint', async () => {
    const { lines } = await captureStderr(() =>
      resolveWorkersWithClamp(PGLITE as BrainEngine, 20, 'reindex-code', 0),
    );
    expect(lines[0]).toContain('use Postgres for parallel writes');
    expect(lines[0]).toContain('single-writer');
  });
});
