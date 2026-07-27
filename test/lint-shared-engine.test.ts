/**
 * issue #1678 — lint must REUSE a caller-provided engine for the
 * content-sanity DB-plane config lift, never create + disconnect its own.
 *
 * The bug: resolveLintContentSanity created a module-style engine
 * (createEngine without poolSize wraps the db.ts singleton) and disconnect()ed
 * it, which cascaded to db.disconnect() and NULLED the shared singleton the
 * cycle's lint phase depends on — breaking every subsequent cycle phase with a
 * misleading "connect() has not been called". When the caller passes a live
 * engine, lint must use it directly with zero connection churn.
 *
 * Hermetic: a fake BrainEngine that records disconnect() calls + serves
 * getConfig. No real DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runLintCore } from '../src/commands/lint.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lint-shared-engine-'));
  writeFileSync(join(dir, 'a.md'), '---\ntype: note\ntitle: A\n---\n\nSome content.\n');
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('runLintCore engine reuse (issue #1678)', () => {
  it('reuses a provided engine for the content-sanity lift and NEVER disconnects it', async () => {
    const state = { disconnects: 0, connects: 0, getConfigCalls: 0 };
    const engine = {
      kind: 'postgres' as const,
      getConfig: async () => { state.getConfigCalls++; return null; },
      connect: async () => { state.connects++; },
      disconnect: async () => { state.disconnects++; },
    } as unknown as BrainEngine;

    await runLintCore({ target: dir, fix: false, dryRun: true, engine });

    // The load-bearing assertion: the shared engine was used (getConfig hit)
    // but NEVER disconnected and NEVER re-connected — no connection churn that
    // could null a shared singleton mid-cycle.
    expect(state.getConfigCalls).toBeGreaterThan(0);
    expect(state.disconnects).toBe(0);
    expect(state.connects).toBe(0);
  });
});
