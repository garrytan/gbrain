import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DREAM_VERDICT_TTL_SECONDS } from '../src/core/engine.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM dream_verdicts');
});

afterAll(async () => {
  await engine.disconnect();
});

describe('dream_verdicts TTL', () => {
  test('migration v127 adds a 30-day expiry and index', async () => {
    const migration = MIGRATIONS.find(item => item.version === 127);
    expect(migration?.name).toBe('dream_verdicts_ttl');
    expect(migration?.idempotent).toBe(true);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(127);

    const columns = await engine.executeRaw<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(`SELECT column_name, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_name = 'dream_verdicts' AND column_name = 'expires_at'`);
    expect(columns).toHaveLength(1);
    expect(columns[0].is_nullable).toBe('NO');
    expect(columns[0].column_default).toContain('30 days');

    const indexes = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'dream_verdicts'
          AND indexname = 'dream_verdicts_expires_idx'`,
    );
    expect(indexes).toHaveLength(1);
  });

  test('put assigns the default TTL and get returns a fresh verdict', async () => {
    const before = Date.now();
    await engine.putDreamVerdict('/tmp/fresh.md', 'fresh-hash', {
      worth_processing: true,
      reasons: ['fresh'],
    });

    const hit = await engine.getDreamVerdict('/tmp/fresh.md', 'fresh-hash');
    expect(hit?.worth_processing).toBe(true);
    const rows = await engine.executeRaw<{ expires_at: string }>(
      `SELECT expires_at FROM dream_verdicts WHERE content_hash = 'fresh-hash'`,
    );
    const ttlMs = new Date(rows[0].expires_at).getTime() - before;
    expect(ttlMs).toBeGreaterThan((DREAM_VERDICT_TTL_SECONDS - 5) * 1000);
    expect(ttlMs).toBeLessThanOrEqual((DREAM_VERDICT_TTL_SECONDS + 5) * 1000);
  });

  test('expired rows miss on read and sweep deletes only expired rows', async () => {
    await engine.putDreamVerdict('/tmp/expired.md', 'expired-hash', {
      worth_processing: false,
      reasons: ['legacy poison'],
    });
    await engine.putDreamVerdict('/tmp/fresh.md', 'fresh-hash', {
      worth_processing: true,
      reasons: ['fresh'],
    });
    await engine.executeRaw(
      `UPDATE dream_verdicts SET expires_at = now() - interval '1 second'
        WHERE content_hash = 'expired-hash'`,
    );

    expect(await engine.getDreamVerdict('/tmp/expired.md', 'expired-hash')).toBeNull();
    expect(await engine.getDreamVerdict('/tmp/fresh.md', 'fresh-hash')).not.toBeNull();
    expect(await engine.sweepDreamVerdicts()).toBe(1);

    const rows = await engine.executeRaw<{ content_hash: string }>(
      'SELECT content_hash FROM dream_verdicts ORDER BY content_hash',
    );
    expect(rows.map(row => row.content_hash)).toEqual(['fresh-hash']);
  });

  test('upgrade backfill derives expiry from judged_at and is idempotent', async () => {
    await engine.executeRaw('ALTER TABLE dream_verdicts DROP COLUMN expires_at');
    await engine.executeRaw(`
      INSERT INTO dream_verdicts (file_path, content_hash, worth_processing, reasons, judged_at)
      VALUES ('/tmp/legacy.md', 'legacy-hash', false, '[]'::jsonb, now() - interval '45 days')
    `);
    await engine.setConfig('version', '126');

    const applied = await runMigrations(engine);
    expect(applied.applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getDreamVerdict('/tmp/legacy.md', 'legacy-hash')).toBeNull();
    expect(await engine.sweepDreamVerdicts()).toBe(1);
    expect((await runMigrations(engine)).applied).toBe(0);
  }, 30_000);
});
