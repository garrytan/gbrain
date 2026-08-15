/**
 * Probe fixture for test/database-url-guard-preload.test.ts.
 *
 * Deliberately trivial: the parent test spawns `bun test` on this file with
 * controlled env and asserts on the RUN's exit code — the preload guard fires
 * (or doesn't) before this file executes. If the guard refuses, this test
 * never runs; if the guard allows, this passes and the run exits 0.
 */
import { test, expect } from 'bun:test';

test('probe: run started, preload guard allowed it', () => {
  expect(true).toBe(true);
});
