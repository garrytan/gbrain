/**
 * Tests for src/core/zombie-reap.ts — the SIGCHLD installer that lets
 * Bun/Node reap exited child processes.
 *
 * Background: without a SIGCHLD listener, child processes spawned by the
 * worker (shell jobs, embed batches, sub-agents) become zombies on exit.
 * The runtime only calls waitpid() internally when at least one SIGCHLD
 * listener is registered. A no-op handler is sufficient.
 *
 * Cross-file leak guard (codex review #6): mutating global `process` signal
 * listeners in the parallel test pool can leak across files in the same
 * shard process. `afterAll` MUST call `_uninstallSigchldHandlerForTests()`
 * so the next file in the shard sees a clean listener set.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import {
  installSigchldHandler,
  _uninstallSigchldHandlerForTests,
} from '../src/core/zombie-reap.ts';

afterAll(() => {
  _uninstallSigchldHandlerForTests();
});

describe('installSigchldHandler', () => {
  test('registers a SIGCHLD listener after first call', () => {
    const before = process.listeners('SIGCHLD').length;
    installSigchldHandler();
    const after = process.listeners('SIGCHLD').length;
    expect(after).toBeGreaterThanOrEqual(before + (before === 0 ? 1 : 0));
    expect(process.listeners('SIGCHLD').length).toBeGreaterThanOrEqual(1);
  });

  test('idempotent: two calls leave exactly one of our listeners', () => {
    // Start clean — remove any handler from the previous test (this file's
    // own only — afterAll handles the global cleanup).
    _uninstallSigchldHandlerForTests();
    installSigchldHandler();
    const afterFirst = process.listeners('SIGCHLD').length;
    installSigchldHandler();
    const afterSecond = process.listeners('SIGCHLD').length;
    // The includes() guard in installSigchldHandler must prevent the
    // second call from adding a duplicate. EventEmitter does NOT dedupe.
    expect(afterSecond).toBe(afterFirst);
  });
});
