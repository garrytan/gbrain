/**
 * #550 — doctor check for the pages(source_id, slug) unique index.
 *
 * putPage upserts via ON CONFLICT (source_id, slug); a brain whose
 * pages_source_slug_key constraint was dropped/renamed by an external
 * migration has silently broken writes the version counter can't see.
 * The check must match by COLUMNS, not by constraint name.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkPagesSlugUniqueIndex } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('checkPagesSlugUniqueIndex (#550)', () => {
  test('fresh schema → ok', async () => {
    const check = await checkPagesSlugUniqueIndex(engine);
    expect(check.status).toBe('ok');
  });

  test('constraint dropped → fail with apply-migrations hint, and putPage really breaks', async () => {
    await engine.executeRaw('ALTER TABLE pages DROP CONSTRAINT pages_source_slug_key');
    const check = await checkPagesSlugUniqueIndex(engine);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('apply-migrations');
    // The condition doctor now detects is a real write outage:
    await expect(
      engine.putPage('people/x', { type: 'person', title: 'X', compiled_truth: 'x' }),
    ).rejects.toThrow(/unique or exclusion constraint/);
  });

  test('conforming unique index under a DIFFERENT name/order → ok (columns, not name)', async () => {
    await engine.executeRaw(
      'CREATE UNIQUE INDEX pages_custom_uniq ON pages (slug, source_id)',
    );
    const check = await checkPagesSlugUniqueIndex(engine);
    expect(check.status).toBe('ok');
    await engine.executeRaw('DROP INDEX pages_custom_uniq');
  });

  test('partial unique index does NOT satisfy the arbiter → still fail', async () => {
    await engine.executeRaw(
      "CREATE UNIQUE INDEX pages_partial_uniq ON pages (source_id, slug) WHERE type = 'person'",
    );
    const check = await checkPagesSlugUniqueIndex(engine);
    expect(check.status).toBe('fail');
    await engine.executeRaw('DROP INDEX pages_partial_uniq');
    // Restore the canonical constraint so later suites sharing this DB stay valid.
    await engine.executeRaw(
      'ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug)',
    );
    const check2 = await checkPagesSlugUniqueIndex(engine);
    expect(check2.status).toBe('ok');
  });
});
