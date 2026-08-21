/**
 * Regression: an ambient source target must never be swallowed into `default`.
 *
 * The write is deliberately driven through makeContext(), the CLI seam that
 * used to catch resolver errors, then through the resolved ctx.sourceId. This
 * proves both sides of the guard: unavailable targets stop before a write and
 * an active registered target still writes successfully.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeContext } from '../src/cli.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveSourceWithTier } from '../src/core/source-resolver.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, archived)
     VALUES ('active-target', 'active-target', false),
            ('archived-target', 'archived-target', true)`,
  );
});

describe('CLI ambient source routing fails closed', () => {
  test('RED negative: nonexistent GBRAIN_SOURCE errors and writes zero rows to default', async () => {
    await withEnv({ GBRAIN_SOURCE: 'does-not-exist' }, async () => {
      await expect(makeContext(engine, {})).rejects.toThrow(/not found|archived/i);
    });

    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE slug = 'receipts/negative-control'`,
    );
    expect(rows[0]?.n ?? 0).toBe(0);
  });

  test('RED negative: archived GBRAIN_SOURCE errors and writes zero rows to default', async () => {
    await withEnv({ GBRAIN_SOURCE: 'archived-target' }, async () => {
      await expect(makeContext(engine, {})).rejects.toThrow(/not found|archived/i);
    });

    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE slug = 'receipts/archived-control'`,
    );
    expect(rows[0]?.n ?? 0).toBe(0);
  });

  test('RED negative: entering an archived source local_path errors instead of falling to default', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-archived-target-'));
    try {
      await engine.executeRaw(
        `UPDATE sources SET local_path = $1 WHERE id = 'archived-target'`,
        [sourceDir],
      );
      await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
        await expect(resolveSourceWithTier(engine, null, sourceDir)).rejects.toThrow(/archived/i);
      });
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test('GREEN positive: active GBRAIN_SOURCE resolves and the in-scope write succeeds', async () => {
    const ctx = await withEnv({ GBRAIN_SOURCE: 'active-target' }, () => makeContext(engine, {}));
    expect(ctx.sourceId).toBe('active-target');

    await engine.putPage('receipts/positive-control', {
      type: 'note',
      title: 'Positive control',
      compiled_truth: 'An active source remains writable.',
    }, { sourceId: ctx.sourceId });

    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'receipts/positive-control'`,
    );
    expect(rows).toEqual([{ source_id: 'active-target' }]);
  });
});
