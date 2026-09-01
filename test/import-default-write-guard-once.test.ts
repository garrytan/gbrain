/**
 * #4583 ship-review fix — runImport assesses the unscoped default-write guard
 * ONCE per engine per process.
 *
 * assessDefaultWriteGuard is an unindexed full-`pages` aggregate. runImport
 * ran it on EVERY unscoped call — including the in-process callers (sync_brain
 * MCP op, autopilot daemon, minion sync) that invoke runImport repeatedly on
 * one engine. Its inputs are process-stable, so the assessment is now
 * memoized per engine (assessDefaultWriteGuardOnce), mirroring the stdio
 * advisory latch in mcp/server.ts.
 *
 * Hermetic PGLite in-memory, non-git temp dirs, isolated GBRAIN_HOME (the
 * import checkpoint lives there). The engine's executeRaw is wrapped to count
 * how many times the guard's aggregate actually ran.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import * as sourceResolver from '../src/core/source-resolver.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let other: PGLiteEngine;
let home: string;
let aggregateRuns = 0;
let otherRuns = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Count the guard's aggregate (the only query in the codebase that projects
  // `non_default_sources`) without changing its behavior.
  const realExecuteRaw = engine.executeRaw.bind(engine);
  (engine as unknown as { executeRaw: typeof realExecuteRaw }).executeRaw = (async (sql: string, params?: unknown[]) => {
    if (sql.includes('non_default_sources')) aggregateRuns++;
    return realExecuteRaw(sql, params);
  }) as typeof realExecuteRaw;
  home = mkdtempSync(join(tmpdir(), 'gbrain-import-guard-once-home-'));
  // Second engine for the per-engine memo test; created here so the isolation
  // guard's lifecycle rule (R3/R4: engines live in beforeAll/afterAll) holds.
  other = new PGLiteEngine();
  await other.connect({});
  await other.initSchema();
  const realOtherExecuteRaw = other.executeRaw.bind(other);
  (other as unknown as { executeRaw: typeof realOtherExecuteRaw }).executeRaw = (async (sql: string, params?: unknown[]) => {
    if (sql.includes('non_default_sources')) otherRuns++;
    return realOtherExecuteRaw(sql, params);
  }) as typeof realOtherExecuteRaw;
});

afterAll(async () => {
  await engine.disconnect();
  await other.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  // Namespace access (not a named import) so the red-proof run against the
  // pre-fix module — which has no memo and no seam — still reaches the
  // discriminating assertion instead of failing at link time.
  (sourceResolver as { __resetDefaultWriteGuardMemo?: () => void }).__resetDefaultWriteGuardMemo?.();
  aggregateRuns = 0;
  otherRuns = 0;
});

async function importOnce(dir: string): Promise<void> {
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runImport(engine, [dir, '--no-embed', '--json']);
  } finally {
    errSpy.mockRestore();
  }
}

describe('runImport memoizes the default-write guard assessment per engine', () => {
  test('two unscoped imports on a no-guard brain assess once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-guard-once-'));
    writeFileSync(join(dir, 'a.md'), '---\ntype: note\ntitle: a\n---\n# a\n\nbody a\n');
    writeFileSync(join(dir, 'b.md'), '---\ntype: note\ntitle: b\n---\n# b\n\nbody b\n');
    try {
      await withEnv(
        { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined },
        async () => {
          await importOnce(dir);
          expect(aggregateRuns).toBe(1);
          await importOnce(dir);
          // Pre-fix: 2 — the unindexed aggregate re-ran on the second call.
          expect(aggregateRuns).toBe(1);
        },
      );
      const rows = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE slug IN ('a', 'b') AND source_id = 'default' ORDER BY slug`,
      );
      expect(rows.map(r => r.slug)).toEqual(['a', 'b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the memo is per engine: a fresh engine gets its own assessment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-guard-once-b-'));
    writeFileSync(join(dir, 'c.md'), '---\ntype: note\ntitle: c\n---\n# c\n\nbody c\n');
    try {
      await withEnv(
        { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined },
        async () => {
          await importOnce(dir);
          const errSpy = spyOn(console, 'error').mockImplementation(() => {});
          try {
            await runImport(other, [dir, '--no-embed', '--json', '--fresh']);
          } finally {
            errSpy.mockRestore();
          }
        },
      );
      expect(aggregateRuns).toBe(1);
      expect(otherRuns).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
