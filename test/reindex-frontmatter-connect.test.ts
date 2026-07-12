/**
 * v0.37.7.0 #1225 regression test.
 *
 * `gbrain reindex-frontmatter` was instantiating the engine via
 * `createEngine()` (which only constructs) but never calling `connect()`
 * before its first `executeRaw` in `countAffected`. The dry-run path
 * crashed with "PGLite not connected. Call connect() first."
 *
 * This test pins the fix: a connected engine handles the dry-run
 * happy path without throwing.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { reindexFrontmatterCli, runReindexFrontmatter } from '../src/commands/reindex-frontmatter.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await (engine as any).db.exec('DELETE FROM pages');
});

describe('reindex-frontmatter connect-before-query (#1225)', () => {
  test('dry-run on an empty brain does not throw "PGLite not connected"', async () => {
    // Seed nothing — exercises the count-affected pre-flight path that
    // was the original crash site.
    const result = await runReindexFrontmatter(engine, { dryRun: true, json: true });
    expect(result.status).toBe('dry_run');
    expect(result.examined).toBe(0);
    expect(result.updated).toBe(0);
  });

  test('dry-run with a seeded backfillable row reports examined>0 and does not crash on engine query', async () => {
    // Seed a page with frontmatter that would trigger a backfill.
    // The point of this case is NOT to assert what dry-run counts as
    // "updated" (the command reports "would update" in dry-run mode);
    // the point is to prove the engine is connected enough to scan
    // and report at all. Pre-fix this scenario crashed with "PGLite
    // not connected".
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, page_kind, frontmatter, effective_date)
       VALUES ($1, 'note', $2, $3, 'markdown', $4::jsonb, NULL)`,
      [
        'wiki/notes/test',
        'test',
        '# test\n\nbody',
        JSON.stringify({ effective_date: '2025-01-15' }),
      ],
    );
    const result = await runReindexFrontmatter(engine, { dryRun: true, json: true });
    expect(result.status).toBe('dry_run');
    expect(result.examined).toBeGreaterThanOrEqual(1);
  });

  test('reuses the CLI-owned engine instead of constructing a second PGLite connection', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, page_kind, frontmatter, effective_date)
       VALUES ($1, 'note', $2, $3, 'markdown', $4::jsonb, NULL)`,
      [
        'cli-owned-engine',
        'CLI owned engine',
        '# CLI owned engine\n\nbody',
        JSON.stringify({ effective_date: '2026-01-01' }),
      ],
    );

    const disconnect = engine.disconnect.bind(engine);
    const disconnectSpy = mock(disconnect);
    engine.disconnect = disconnectSpy;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message));

    try {
      await reindexFrontmatterCli(['--dry-run', '--json'], engine);
      const result = JSON.parse(logs.at(-1) ?? '{}') as { examined?: number };
      // A second engine would see a different/empty database; this asserts that
      // the CLI command queried the connected engine supplied by its dispatcher.
      expect(result.examined).toBeGreaterThanOrEqual(1);
      expect(disconnectSpy).not.toHaveBeenCalled();
    } finally {
      console.log = originalLog;
      engine.disconnect = disconnect;
    }
  });
});
