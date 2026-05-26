/**
 * v0.41.6.0 D5 — process-cleanup registry.
 *
 * Covers the registry contract:
 *   - registerCleanup adds + returned deregister removes
 *   - triggerCleanupAndExit walks registry via Promise.allSettled
 *   - cleanup callback throw doesn't break other callbacks (allSettled)
 *   - idempotent on double-trigger (second call during cleanup is NO-OP)
 *   - 3s deadline honored (longer callbacks don't block exit)
 *   - deregister-then-release race: no double-fire
 *
 * Signal-handler installation contract is verified by:
 *   - installSignalHandlers() idempotency (this file)
 *   - E2E sync-lock-cleanup-on-sigterm.test.ts (real SIGTERM → real DELETE)
 *   - E2E sync-pipe-sigpipe.test.ts (real EPIPE → real DELETE)
 *
 * NOT covered here: the SIGINT coexistence test (eng-review D9) — moved
 * to E2E because spawning a subprocess and verifying both AbortController
 * + cleanup-registry coexist requires real process boundaries.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  registerCleanup,
  triggerCleanupAndExit,
  installSignalHandlers,
  _registeredCleanupCountForTests,
  _resetForTests,
} from '../src/core/process-cleanup.ts';

// Avoid mocking process.exit globally. The triggerCleanupAndExit tests
// monkey-patch it via a closure-local exit holder so tests stay hermetic.

beforeEach(() => { _resetForTests(); });
afterEach(() => { _resetForTests(); });

describe('registerCleanup', () => {
  test('adds an entry to the registry', () => {
    expect(_registeredCleanupCountForTests()).toBe(0);
    registerCleanup('test-1', async () => {});
    expect(_registeredCleanupCountForTests()).toBe(1);
  });

  test('returned deregister removes the entry', () => {
    const dereg = registerCleanup('test-2', async () => {});
    expect(_registeredCleanupCountForTests()).toBe(1);
    dereg();
    expect(_registeredCleanupCountForTests()).toBe(0);
  });

  test('deregister is idempotent (second call is NO-OP)', () => {
    const dereg = registerCleanup('test-3', async () => {});
    dereg();
    dereg(); // should not throw or under-count
    expect(_registeredCleanupCountForTests()).toBe(0);
  });

  test('multiple entries co-exist independently', () => {
    const d1 = registerCleanup('a', async () => {});
    const d2 = registerCleanup('b', async () => {});
    const d3 = registerCleanup('c', async () => {});
    expect(_registeredCleanupCountForTests()).toBe(3);
    d2();
    expect(_registeredCleanupCountForTests()).toBe(2);
    d1();
    d3();
    expect(_registeredCleanupCountForTests()).toBe(0);
  });
});

describe('triggerCleanupAndExit', () => {
  // Helper: monkey-patch process.exit to capture the code without actually exiting.
  function patchExit(): { codes: number[]; restore: () => void } {
    const codes: number[] = [];
    const orig = process.exit;
    (process as any).exit = (code?: number) => {
      codes.push(code ?? 0);
      // Don't actually exit — let the test continue.
    };
    return { codes, restore: () => { (process as any).exit = orig; } };
  }

  test('walks every registered callback', async () => {
    const fired: string[] = [];
    registerCleanup('a', async () => { fired.push('a'); });
    registerCleanup('b', async () => { fired.push('b'); });
    registerCleanup('c', async () => { fired.push('c'); });

    const { codes, restore } = patchExit();
    try {
      await triggerCleanupAndExit(0);
    } finally { restore(); }

    expect(fired.sort()).toEqual(['a', 'b', 'c']);
    expect(codes).toEqual([0]);
  });

  test('callback throw does not block other callbacks (Promise.allSettled)', async () => {
    const fired: string[] = [];
    registerCleanup('throwing', async () => { fired.push('throwing'); throw new Error('boom'); });
    registerCleanup('quiet', async () => { fired.push('quiet'); });

    const { codes, restore } = patchExit();
    try {
      await triggerCleanupAndExit(0);
    } finally { restore(); }

    expect(fired.sort()).toEqual(['quiet', 'throwing']);
    expect(codes).toEqual([0]);
  });

  test('second concurrent trigger is NO-OP (idempotent)', async () => {
    let fireCount = 0;
    registerCleanup('once', async () => { fireCount++; await new Promise(r => setTimeout(r, 20)); });

    const { codes, restore } = patchExit();
    try {
      const p1 = triggerCleanupAndExit(0);
      const p2 = triggerCleanupAndExit(0); // should be no-op since cleanup is in flight
      await Promise.all([p1, p2]);
    } finally { restore(); }

    expect(fireCount).toBe(1);
    expect(codes).toHaveLength(2); // both calls reached process.exit
  });

  test('deadline honored — long-running callback does not block exit beyond 3s', async () => {
    let blockerStarted = false;
    let blockerFinished = false;
    registerCleanup('blocker', async () => {
      blockerStarted = true;
      await new Promise(r => setTimeout(r, 5000)); // longer than 3s deadline
      blockerFinished = true;
    });

    const { codes, restore } = patchExit();
    const start = Date.now();
    try {
      await triggerCleanupAndExit(0);
    } finally { restore(); }
    const elapsed = Date.now() - start;

    expect(blockerStarted).toBe(true);
    expect(blockerFinished).toBe(false); // killed by deadline
    expect(elapsed).toBeLessThan(4000); // exited well before blocker would have finished
    expect(codes).toEqual([0]);
  });

  test('empty registry triggers exit immediately', async () => {
    const { codes, restore } = patchExit();
    try { await triggerCleanupAndExit(0); }
    finally { restore(); }
    expect(codes).toEqual([0]);
  });

  test('deregister-then-trigger: deregistered callback does not fire', async () => {
    const fired: string[] = [];
    const dereg = registerCleanup('dropped', async () => { fired.push('dropped'); });
    registerCleanup('kept', async () => { fired.push('kept'); });
    dereg();

    const { codes, restore } = patchExit();
    try { await triggerCleanupAndExit(0); }
    finally { restore(); }

    expect(fired).toEqual(['kept']);
    expect(codes).toEqual([0]);
  });
});

describe('installSignalHandlers', () => {
  test('is idempotent (second call is NO-OP)', () => {
    const beforeListeners = process.listenerCount('SIGTERM');
    installSignalHandlers();
    const afterFirstCall = process.listenerCount('SIGTERM');
    installSignalHandlers();
    const afterSecondCall = process.listenerCount('SIGTERM');
    expect(afterFirstCall - beforeListeners).toBe(1);
    expect(afterSecondCall).toBe(afterFirstCall); // no new listener
  });

  test('does NOT install a SIGINT handler (the existing AbortController owns SIGINT)', () => {
    const sigintListeners = process.listenerCount('SIGINT');
    _resetForTests();
    installSignalHandlers();
    // We didn't add a SIGINT listener — count is unchanged.
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
  });

  test('installs SIGTERM / SIGHUP / SIGPIPE handlers', () => {
    _resetForTests();
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sighup: process.listenerCount('SIGHUP'),
      sigpipe: process.listenerCount('SIGPIPE'),
    };
    installSignalHandlers();
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
    expect(process.listenerCount('SIGHUP')).toBe(before.sighup + 1);
    expect(process.listenerCount('SIGPIPE')).toBe(before.sigpipe + 1);
  });
});
