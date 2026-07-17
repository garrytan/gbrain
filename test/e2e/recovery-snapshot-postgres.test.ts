import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { buildRecoverySnapshot } from '../../src/core/recovery-snapshot.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const FIXED_NOW = new Date('2026-07-17T12:00:00.000Z');
const PGLITE_CONFIG: GBrainConfig = {
  engine: 'pglite',
  database_path: resolve(import.meta.dir, '.recovery-snapshot-parity'),
};

async function seedParityFixture(target: BrainEngine): Promise<void> {
  await target.executeRaw(
    `UPDATE sources
        SET name = 'Recovery parity', last_commit = 'fedcba9876543210',
            chunker_version = 'markdown-v2', archived = false
      WHERE id = 'default'`,
  );
  await target.putPage('notes/parity-alpha', {
    type: 'note', title: 'Parity alpha', compiled_truth: 'Parity source text.',
    content_hash: 'd'.repeat(64), source_path: 'notes/parity-alpha.md', chunker_version: 2,
  }, { sourceId: 'default' });
  await target.putPage('notes/parity-deleted', {
    type: 'note', title: 'Parity deleted', compiled_truth: 'Deleted parity source text.',
    content_hash: 'e'.repeat(64), source_path: 'notes/parity-deleted.md', chunker_version: 2,
  }, { sourceId: 'default' });
  await target.upsertChunks('notes/parity-alpha', [{
    chunk_index: 0,
    chunk_text: 'Parity source text.',
    chunk_source: 'compiled_truth',
    model: 'fixture-embedding-v1',
    token_count: 4,
  }], { sourceId: 'default' });
  await target.addTag('notes/parity-alpha', 'recovery-parity', { sourceId: 'default' });
  await target.addLink(
    'notes/parity-alpha', 'notes/parity-deleted', 'parity', 'related', 'manual',
    undefined, undefined,
    { fromSourceId: 'default', toSourceId: 'default' },
  );
  await target.addTimelineEntry('notes/parity-alpha', {
    date: '2026-07-16', source: 'fixture', summary: 'Parity source event',
  }, { sourceId: 'default' });
  await target.softDeletePage('notes/parity-deleted', { sourceId: 'default' });
}

const describePostgres = hasDatabase() ? describe : describe.skip;

describePostgres('recovery snapshot real Postgres/PGLite parity', () => {
  let pglite: PGLiteEngine;

  beforeAll(async () => {
    await setupDB();
    pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    await seedParityFixture(getEngine());
    await seedParityFixture(pglite);
  }, 120_000);

  afterAll(async () => {
    await pglite?.disconnect();
    await teardownDB();
  });

  test('strict snapshot has exact cross-engine source identity and mutates neither engine', async () => {
    const postgres = getEngine();
    const credentialProbeUrl = new URL(process.env.DATABASE_URL!);
    credentialProbeUrl.password = 'recovery-snapshot-secret-sentinel';
    const postgresConfig: GBrainConfig = {
      engine: 'postgres',
      database_url: credentialProbeUrl.toString(),
    };
    const postgresBefore = await postgres.executeRaw<{ pages: number; chunks: number }>(
      `SELECT (SELECT count(*)::int FROM pages) AS pages,
              (SELECT count(*)::int FROM content_chunks) AS chunks`,
    );
    const pgliteBefore = await pglite.executeRaw<{ pages: number; chunks: number }>(
      `SELECT (SELECT count(*)::int FROM pages) AS pages,
              (SELECT count(*)::int FROM content_chunks) AS chunks`,
    );

    const postgresSnapshot = await buildRecoverySnapshot(postgres, {
      brainId: 'fixture-postgres', sourceId: 'default', config: postgresConfig, now: () => FIXED_NOW,
    });
    const pgliteSnapshot = await buildRecoverySnapshot(pglite, {
      brainId: 'fixture-pglite', sourceId: 'default', config: PGLITE_CONFIG, now: () => FIXED_NOW,
    });

    expect(postgresSnapshot.content_digest).toEqual(pgliteSnapshot.content_digest);
    expect(postgresSnapshot.counts).toEqual(pgliteSnapshot.counts);
    expect(postgresSnapshot.pages.map((page) => ({
      slug: page.slug,
      state: page.state,
      content_hash: page.content_hash,
      source_anchor: page.source_anchor,
      normalized_sha256: page.normalized_sha256,
      chunk_content_sha256: page.chunk_content_sha256,
    }))).toEqual(pgliteSnapshot.pages.map((page) => ({
      slug: page.slug,
      state: page.state,
      content_hash: page.content_hash,
      source_anchor: page.source_anchor,
      normalized_sha256: page.normalized_sha256,
      chunk_content_sha256: page.chunk_content_sha256,
    })));
    const serializedPostgres = JSON.stringify(postgresSnapshot);
    expect(serializedPostgres).not.toContain(credentialProbeUrl.toString());
    expect(serializedPostgres).not.toContain(credentialProbeUrl.password);

    expect(await postgres.executeRaw(
      `SELECT (SELECT count(*)::int FROM pages) AS pages,
              (SELECT count(*)::int FROM content_chunks) AS chunks`,
    )).toEqual(postgresBefore);
    expect(await pglite.executeRaw(
      `SELECT (SELECT count(*)::int FROM pages) AS pages,
              (SELECT count(*)::int FROM content_chunks) AS chunks`,
    )).toEqual(pgliteBefore);
  }, 60_000);
});
