/**
 * W0 fix-wave (Tier-1 #5) — runImport must THROW a typed ImportAbortError on
 * preflight/argv failures, never process.exit(1).
 *
 * runImport is invoked in-process by the sync_brain MCP op (performFullSync),
 * the autopilot daemon, and the minion sync handler. Pre-fix, a first sync
 * against a brain with unusable embedding credentials TERMINATED the calling
 * process — the stdio MCP server just vanished mid-tool-call. The CLI dispatch
 * site maps the typed error back to exit(1), keeping CLI behavior identical.
 */

import { test, expect } from 'bun:test';
import { runImport, ImportAbortError } from '../src/commands/import.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// The abort sites fire before any WRITE; the preamble runs a couple of
// read-only lookups (sources, config), so the stub answers those with
// empty sets.
const engineStub = {
  kind: 'pglite',
  executeRaw: async () => [],
  getConfig: async () => null,
} as unknown as BrainEngine;

async function expectAbort(args: string[], reasonFragment: string): Promise<void> {
  let thrown: unknown;
  try {
    await runImport(engineStub, args);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ImportAbortError);
  const err = thrown as ImportAbortError;
  expect(err.exitCode).toBe(1);
  expect(err.alreadyReported).toBe(true);
  expect(err.message).toContain(reasonFragment);
}

test('missing dir arg → typed abort, not process death', async () => {
  await expectAbort(['--no-embed'], 'no import directory');
});

test('invalid --workers → typed abort', async () => {
  await expectAbort(['--no-embed', '--workers', '0', '/tmp'], 'invalid --workers');
});

test('unreadable import target → typed abort', async () => {
  await expectAbort(['--no-embed', '/definitely/not/a/real/dir-w0-test'], 'not readable');
});

test('the calling process survives the abort (the actual Tier-1 bug)', async () => {
  // Trivially true if we got here after three aborts above, but assert it
  // explicitly: the process is alive and can keep dispatching.
  expect(process.pid).toBeGreaterThan(0);
});
