/**
 * v0.26.5 — destructive-guard unit tests.
 *
 * Source-level guard against accidental data loss. Three layers:
 *  1. Impact assessment (counts pages/chunks/embeddings/files for a source)
 *  2. Confirmation gate (`--confirm-destructive` required when data exists;
 *     `--yes` alone rejected)
 *  3. Soft-delete with 72h TTL (column-based as of v0.26.5; JSONB shape was
 *     migrated in v33)
 *
 * Run against PGLite — the contract logic is identical on Postgres but
 * PGLite is fast + DATABASE_URL-free. Postgres-specific paths (CONCURRENTLY,
 * RLS) are covered separately by E2E tests.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  assessDestructiveImpact,
  checkDestructiveConfirmation,
  softDeleteSource,
  restoreSource,
  listArchivedSources,
  purgeExpiredSources,
  formatImpact,
  formatSoftDelete,
  SOFT_DELETE_TTL_HOURS,
  type DestructiveImpact,
} from '../src/core/destructive-guard.ts';

// Tier 3 opt-out — these tests need the cold-init schema path so the v33
// migration columns exist on the brain under test.
delete process.env.GBRAIN_PGLITE_SNAPSHOT;

async function setupBrain(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}

async function seedSource(engine: PGLiteEngine, id: string, opts?: { withPages?: number }): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [id, id],
  );
  const count = opts?.withPages ?? 0;
  for (let i = 0; i < count; i++) {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title) VALUES ($1, $2, 'note', $3)`,
      [id, `${id}/page-${i}`, `Page ${i}`],
    );
  }
}

describe('assessDestructiveImpact', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = await setupBrain();
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('returns null for a non-existent source', async () => {
    const impact = await assessDestructiveImpact(engine, 'aim-does-not-exist');
    expect(impact).toBeNull();
  });

  test('counts zero across the board for an empty source', async () => {
    await seedSource(engine, 'aim-empty', { withPages: 0 });
    const impact = await assessDestructiveImpact(engine, 'aim-empty');
    expect(impact).not.toBeNull();
    expect(impact!.pageCount).toBe(0);
    expect(impact!.chunkCount).toBe(0);
    expect(impact!.embeddingCount).toBe(0);
    expect(impact!.fileCount).toBe(0);
    // Empty-source summary is the safe message, not the "permanently delete" warning.
    expect(impact!.summary).toContain('safe to remove');
  });

  test('counts pages correctly for a populated source', async () => {
    await seedSource(engine, 'aim-populated', { withPages: 3 });
    const impact = await assessDestructiveImpact(engine, 'aim-populated');
    expect(impact!.pageCount).toBe(3);
    expect(impact!.summary).toContain('3 pages');
    expect(impact!.summary).toContain('permanently delete');
  });

  test('source-scopes pages — multi-source isolation', async () => {
    await seedSource(engine, 'aim-src-a', { withPages: 2 });
    await seedSource(engine, 'aim-src-b', { withPages: 5 });
    const a = await assessDestructiveImpact(engine, 'aim-src-a');
    const b = await assessDestructiveImpact(engine, 'aim-src-b');
    expect(a!.pageCount).toBe(2);
    expect(b!.pageCount).toBe(5);
  });
});

describe('checkDestructiveConfirmation (gate truth table)', () => {
  const populated: DestructiveImpact = {
    sourceId: 'has-data',
    sourceName: 'has-data',
    pageCount: 100,
    chunkCount: 500,
    embeddingCount: 500,
    fileCount: 0,
    summary: '⚠️  This will permanently delete: 100 pages, 500 chunks, 500 embeddings',
  };

  const empty: DestructiveImpact = {
    sourceId: 'no-data',
    sourceName: 'no-data',
    pageCount: 0,
    chunkCount: 0,
    embeddingCount: 0,
    fileCount: 0,
    summary: 'Source "no-data" has no data (safe to remove).',
  };

  test('dry-run always passes regardless of flags', () => {
    expect(checkDestructiveConfirmation(populated, { dryRun: true })).toBeNull();
    expect(checkDestructiveConfirmation(populated, { yes: true, dryRun: true })).toBeNull();
  });

  test('empty source passes without --confirm-destructive', () => {
    expect(checkDestructiveConfirmation(empty, {})).toBeNull();
    expect(checkDestructiveConfirmation(empty, { yes: true })).toBeNull();
  });

  test('--confirm-destructive passes regardless of --yes', () => {
    expect(checkDestructiveConfirmation(populated, { confirmDestructive: true })).toBeNull();
    expect(checkDestructiveConfirmation(populated, { yes: true, confirmDestructive: true })).toBeNull();
  });

  test('--yes alone with data is REJECTED with guidance message', () => {
    const msg = checkDestructiveConfirmation(populated, { yes: true });
    expect(msg).not.toBeNull();
    expect(msg).toContain('--confirm-destructive');
    expect(msg).toContain('archive');
  });

  test('no flags + populated source rejects', () => {
    const msg = checkDestructiveConfirmation(populated, {});
    expect(msg).not.toBeNull();
    expect(msg).toContain('--confirm-destructive');
  });
});

describe('soft-delete + restore lifecycle (column-based v0.26.5)', () => {
  // ONE engine for the whole describe — cold init runs ~29 migrations, ~3s.
  // Each test uses a unique source id so they don't cross-pollute.
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = await setupBrain();
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('softDeleteSource flips column shape + sets TTL', async () => {
    const id = 'sd-flips';
    await seedSource(engine, id, { withPages: 2 });
    const before = Date.now();
    const result = await softDeleteSource(engine, id);
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id);
    expect(result!.pageCount).toBe(2);
    const ttlMs = SOFT_DELETE_TTL_HOURS * 60 * 60 * 1000;
    expect(result!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttlMs - 1000);
    expect(result!.expiresAt.getTime()).toBeLessThanOrEqual(after + ttlMs + 1000);
    const rows = await engine.executeRaw<{ archived: boolean; archived_at: string }>(
      `SELECT archived, archived_at FROM sources WHERE id = $1`,
      [id],
    );
    expect(rows[0].archived).toBe(true);
    expect(rows[0].archived_at).not.toBeNull();
  });

  test('softDeleteSource is idempotent-as-null on already-archived', async () => {
    const id = 'sd-idem';
    await seedSource(engine, id, { withPages: 1 });
    await softDeleteSource(engine, id);
    expect(await softDeleteSource(engine, id)).toBeNull();
  });

  test('softDeleteSource returns null for unknown source', async () => {
    expect(await softDeleteSource(engine, 'sd-unknown-xyz')).toBeNull();
  });

  test('softDeleteSource flips federated:false in JSONB but archived state is column-based', async () => {
    const id = 'sd-jsonb';
    await seedSource(engine, id, { withPages: 1 });
    await softDeleteSource(engine, id);
    const rows = await engine.executeRaw<{ config: any; archived: boolean }>(
      `SELECT config, archived FROM sources WHERE id = $1`,
      [id],
    );
    const config = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
    expect(config.federated).toBe(false);
    expect(rows[0].archived).toBe(true);
    // Issue 5 contract: archived must NOT live in config any more.
    expect(config.archived).toBeUndefined();
    expect(config.archived_at).toBeUndefined();
  });

  test('restoreSource clears the column state and re-federates by default', async () => {
    const id = 'sd-restore-fed';
    await seedSource(engine, id, { withPages: 1 });
    await softDeleteSource(engine, id);
    expect(await restoreSource(engine, id)).toBe(true);
    const rows = await engine.executeRaw<{ archived: boolean; archived_at: string | null; config: any }>(
      `SELECT archived, archived_at, config FROM sources WHERE id = $1`,
      [id],
    );
    expect(rows[0].archived).toBe(false);
    expect(rows[0].archived_at).toBeNull();
    const config = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
    expect(config.federated).toBe(true);
  });

  test('restoreSource respects --no-federate (refederate=false)', async () => {
    const id = 'sd-no-fed';
    await seedSource(engine, id, { withPages: 1 });
    await softDeleteSource(engine, id);
    await restoreSource(engine, id, false);
    const rows = await engine.executeRaw<{ config: any }>(
      `SELECT config FROM sources WHERE id = $1`,
      [id],
    );
    const config = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
    expect(config.federated).toBe(false);
  });

  test('restoreSource is idempotent-as-false on already-active', async () => {
    const id = 'sd-active';
    await seedSource(engine, id);
    expect(await restoreSource(engine, id)).toBe(false);
  });

  test('listArchivedSources filters via the archived column, not JSONB', async () => {
    const archivedId = 'la-archived';
    const liveId = 'la-live';
    await seedSource(engine, archivedId, { withPages: 3 });
    await seedSource(engine, liveId, { withPages: 1 });
    await softDeleteSource(engine, archivedId);
    const archived = await listArchivedSources(engine);
    const ids = archived.map((a) => a.id);
    expect(ids).toContain(archivedId);
    expect(ids).not.toContain(liveId);
    const archivedRow = archived.find((a) => a.id === archivedId)!;
    expect(archivedRow.pageCount).toBe(3);
  });

  test('purgeExpiredSources only deletes rows with archive_expires_at <= now()', async () => {
    const expiredId = 'pe-expired';
    const recoverableId = 'pe-recoverable';
    await seedSource(engine, expiredId, { withPages: 2 });
    await seedSource(engine, recoverableId, { withPages: 1 });
    await softDeleteSource(engine, expiredId);
    await softDeleteSource(engine, recoverableId);
    await engine.executeRaw(
      `UPDATE sources SET archive_expires_at = now() - INTERVAL '1 hour' WHERE id = $1`,
      [expiredId],
    );
    const purged = await purgeExpiredSources(engine);
    expect(purged).toContain(expiredId);
    expect(purged).not.toContain(recoverableId);
    const remainingPages = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
      [expiredId],
    );
    expect(remainingPages[0].n).toBe(0);
  });

  test('purgeExpiredSources is no-op when nothing is past TTL', async () => {
    // After all earlier tests, there may still be archived rows whose
    // archive_expires_at is in the future. Force-update any leftover-past
    // rows OUT of expiration before this assertion (we only want to test
    // the no-op return here, not interfere with prior test state).
    await engine.executeRaw(
      `UPDATE sources SET archive_expires_at = now() + INTERVAL '72 hours' WHERE archived = true`,
    );
    const purged = await purgeExpiredSources(engine);
    expect(purged).toEqual([]);
  });
});

describe('formatters (display helpers)', () => {
  test('formatImpact renders the boxed preview with the source id and counts', () => {
    const impact: DestructiveImpact = {
      sourceId: 'media-corpus',
      sourceName: 'Media Corpus',
      pageCount: 5033,
      chunkCount: 22000,
      embeddingCount: 22000,
      fileCount: 0,
      summary: '⚠️  This will permanently delete: 5,033 pages, 22,000 chunks, 22,000 embeddings',
    };
    const out = formatImpact(impact);
    expect(out).toContain('Media Corpus');
    expect(out).toContain('media-corpus');
    expect(out).toContain('5,033');
    expect(out).toContain('22,000');
    expect(out).toContain('DESTRUCTIVE OPERATION');
  });

  test('formatSoftDelete renders the post-archive guidance with restore command', () => {
    const out = formatSoftDelete({
      id: 'src-a',
      name: 'src-a',
      deletedAt: new Date(),
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      pageCount: 100,
    });
    expect(out).toContain('archived');
    expect(out).toContain('restore src-a');
    expect(out).toContain('72');
  });
});
