/**
 * v0.41.8.0 — shouldForceExitAfterMain argv parsing unit tests.
 *
 * The function is the safety guard that protects daemons from the
 * narrow timeout-only force-exit in cli.ts. If it misclassifies
 * `gbrain serve` as a non-daemon (or any other intentional long-
 * runner that gets added later), the daemon dies after the first
 * request. Pure function; testable in isolation; deserves its own
 * unit cases beyond the e2e daemon-survival smoke.
 */

import { describe, test, expect } from 'bun:test';
import { shouldForceExitAfterMain } from '../src/core/cli-force-exit.ts';

describe('shouldForceExitAfterMain — daemon survival gate', () => {
  test('returns false for bare `serve` (stdio daemon)', () => {
    expect(shouldForceExitAfterMain(['serve'])).toBe(false);
  });

  test('returns false for `serve --http --port 3131`', () => {
    expect(shouldForceExitAfterMain(['serve', '--http', '--port', '3131'])).toBe(false);
  });

  test('returns false even when global flags precede `serve`', () => {
    // `--quiet`, `--progress-json`, `--progress-interval=Nms` are stripped
    // by parseGlobalFlags BEFORE command dispatch — but shouldForceExitAfterMain
    // may be called with the raw argv. The .find skips flags, so the first
    // positional should resolve to the actual command regardless of global
    // flag position. This is the load-bearing case for `gbrain --quiet serve`.
    expect(shouldForceExitAfterMain(['--quiet', 'serve'])).toBe(false);
    expect(shouldForceExitAfterMain(['--progress-json', 'serve', '--http'])).toBe(false);
    expect(shouldForceExitAfterMain(['--progress-interval=500', '--quiet', 'serve'])).toBe(false);
  });

  test('returns true for op commands (search/query/get)', () => {
    expect(shouldForceExitAfterMain(['search', 'foxtrot'])).toBe(true);
    expect(shouldForceExitAfterMain(['query', 'where is foo'])).toBe(true);
    expect(shouldForceExitAfterMain(['get', 'people/alice'])).toBe(true);
  });

  test('returns true for non-daemon CLI commands', () => {
    expect(shouldForceExitAfterMain(['stats'])).toBe(true);
    expect(shouldForceExitAfterMain(['doctor'])).toBe(true);
    expect(shouldForceExitAfterMain(['sync', '--no-pull'])).toBe(true);
    expect(shouldForceExitAfterMain(['embed', '--stale'])).toBe(true);
  });

  test('returns true for empty argv (no command)', () => {
    // Defensive: with no positional, `--version` / `--help` would have already
    // exited. If we somehow land here with empty args, force-exit is safe
    // (no daemon is running).
    expect(shouldForceExitAfterMain([])).toBe(true);
  });

  test('returns true for flag-only argv', () => {
    expect(shouldForceExitAfterMain(['--help'])).toBe(true);
    expect(shouldForceExitAfterMain(['-h'])).toBe(true);
    expect(shouldForceExitAfterMain(['--version'])).toBe(true);
  });

  test('uses process.argv.slice(2) by default when called with no args', () => {
    // The default is just for the cli.ts call site convenience; the test
    // verifies the default works without crashing.
    expect(typeof shouldForceExitAfterMain()).toBe('boolean');
  });

  test('substring match avoidance: `serves` is NOT `serve`', () => {
    // Future-proofing against a `gbrain serves-foo` subcommand being
    // misclassified as a daemon. Strict equality, not startsWith.
    expect(shouldForceExitAfterMain(['serves'])).toBe(true);
    expect(shouldForceExitAfterMain(['serve-cluster'])).toBe(true);
  });
});
