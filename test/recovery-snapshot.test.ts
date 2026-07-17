import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { parseRecoveryArgs, runRecovery } from '../src/commands/recovery.ts';
import type { BrainRegistry } from '../src/core/brain-registry.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildRecoverySnapshot, RecoverySnapshotError } from '../src/core/recovery-snapshot.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const FIXED_NOW = new Date('2026-07-17T12:00:00.000Z');
const PGLITE_CONFIG: GBrainConfig = {
  engine: 'pglite',
  database_path: resolve(import.meta.dir, '.recovery-snapshot-test'),
};

let engine: PGLiteEngine;

async function seedFixture(target: PGLiteEngine): Promise<void> {
  // resetPgliteState intentionally truncates the config table while preserving
  // the physical schema. Re-establish the real post-init migration identity so
  // the strict recovery contract is exercised against a current brain; a
  // missing or stale production identity must continue to fail closed.
  await target.setConfig('version', String(LATEST_VERSION));
  await target.executeRaw(
    `UPDATE sources
        SET name = 'Recovery fixture', local_path = $1, last_commit = '0123456789abcdef',
            last_sync_at = '2026-07-17T10:00:00Z', newest_content_at = '2026-07-16T09:00:00Z',
            chunker_version = 'markdown-v2'
      WHERE id = 'default'`,
    [resolve(import.meta.dir, 'fixtures', 'recovery-source')],
  );
  await target.putPage('notes/alpha', {
    type: 'note',
    title: 'Alpha',
    compiled_truth: 'Private fixture prose must never appear in the snapshot.',
    timeline: '2026-07-16: source-backed fixture event',
    content_hash: 'a'.repeat(64),
    source_path: 'notes/alpha.md',
    chunker_version: 2,
  }, { sourceId: 'default' });
  await target.putPage('notes/deleted', {
    type: 'note',
    title: 'Deleted',
    compiled_truth: 'Soft-deleted fixture prose.',
    content_hash: 'b'.repeat(64),
    source_path: 'notes/deleted.md',
    chunker_version: 2,
  }, { sourceId: 'default' });
  await target.upsertChunks('notes/alpha', [{
    chunk_index: 0,
    chunk_text: 'Private fixture chunk.',
    chunk_source: 'compiled_truth',
    model: 'fixture-embedding-v1',
    token_count: 4,
  }], { sourceId: 'default' });
  await target.addTag('notes/alpha', 'recovery-fixture', { sourceId: 'default' });
  await target.addLink(
    'notes/alpha', 'notes/deleted', 'fixture edge', 'related', 'manual',
    undefined, undefined,
    { fromSourceId: 'default', toSourceId: 'default' },
  );
  await target.addTimelineEntry('notes/alpha', {
    date: '2026-07-16',
    source: 'fixture',
    summary: 'Source-backed fixture event',
  }, { sourceId: 'default' });
  await target.softDeletePage('notes/deleted', { sourceId: 'default' });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await seedFixture(engine);
});

describe('recovery snapshot command boundary', () => {
  test('requires explicit brain, source, and JSON output', () => {
    expect(parseRecoveryArgs(['snapshot', '--brain', 'host', '--source', 'default', '--json']))
      .toEqual({ brainId: 'host', sourceId: 'default' });
    expect(() => parseRecoveryArgs(['snapshot', '--brain', 'host', '--source', 'default']))
      .toThrow('--json is required');
    expect(() => parseRecoveryArgs(['snapshot', '--brain', 'host', '--source', '../escape', '--json']))
      .toThrow('Invalid source_id');
    expect(() => parseRecoveryArgs(['snapshot', '--brain', 'bad/id', '--source', 'default', '--json']))
      .toThrow('brain id');
  });

  test('emits no partial envelope when a required section fails', async () => {
    let disconnected = false;
    const registry = {
      getBrain: async () => ({ id: 'host', engine, config: PGLITE_CONFIG, path: null }),
      disconnectAll: async () => { disconnected = true; },
    } as unknown as BrainRegistry;
    let stdout = '';
    let stderr = '';
    const exitCode = await runRecovery(
      ['snapshot', '--brain', 'host', '--source', 'missing', '--json'],
      {
        registry,
        now: () => FIXED_NOW,
        writeStdout: (value) => { stdout += value; },
        writeStderr: (value) => { stderr += value; },
      },
    );
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Recovery snapshot refused');
    expect(disconnected).toBe(true);
  });
});

describe('strict PGLite recovery snapshot', () => {
  test('is deterministic, credential-free, source-scoped, and read-only', async () => {
    const before = await engine.executeRaw<{ pages: number; chunks: number }>(
      `SELECT (SELECT count(*)::int FROM pages) AS pages,
              (SELECT count(*)::int FROM content_chunks) AS chunks`,
    );
    const first = await buildRecoverySnapshot(engine, {
      brainId: 'host', sourceId: 'default', config: PGLITE_CONFIG, now: () => FIXED_NOW,
    });
    const second = await buildRecoverySnapshot(engine, {
      brainId: 'host', sourceId: 'default', config: PGLITE_CONFIG, now: () => FIXED_NOW,
    });
    const after = await engine.executeRaw<{ pages: number; chunks: number }>(
      `SELECT (SELECT count(*)::int FROM pages) AS pages,
              (SELECT count(*)::int FROM content_chunks) AS chunks`,
    );

    expect(first).toEqual(second);
    expect(after).toEqual(before);
    expect(first.database.schema_version).toBe(LATEST_VERSION);
    expect(first.counts.pages).toEqual({ active: 1, soft_deleted: 1, total: 2 });
    expect(first.counts.chunks).toEqual({ total: 1, embedded: 0, missing: 1 });
    expect(first.counts.links.total).toBe(1);
    expect(first.counts.timeline.total).toBe(1);
    expect(first.counts.tags.total).toBe(1);
    expect(first.pages.map((page) => page.slug)).toEqual(['notes/alpha', 'notes/deleted']);
    expect(first.pages[0].source_anchor).toEqual({ kind: 'path', value: 'notes/alpha.md' });
    expect(first.database_only.parity_required).toBe(false);
    expect(first.content_digest.value).toMatch(/^[a-f0-9]{64}$/);
    expect(first.snapshot_digest.value).toMatch(/^[a-f0-9]{64}$/);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain('Private fixture prose');
    expect(serialized).not.toContain('Private fixture chunk');
    expect(serialized).not.toContain(resolve(import.meta.dir, 'fixtures', 'recovery-source'));
    expect(serialized).not.toContain('password');
  });

  test('fails closed when schema identity is missing or stale', async () => {
    try {
      await engine.unsetConfig('version');
      await expect(buildRecoverySnapshot(engine, {
        brainId: 'host', sourceId: 'default', config: PGLITE_CONFIG, now: () => FIXED_NOW,
      })).rejects.toBeInstanceOf(RecoverySnapshotError);

      await engine.setConfig('version', String(LATEST_VERSION - 1));
      await expect(buildRecoverySnapshot(engine, {
        brainId: 'host', sourceId: 'default', config: PGLITE_CONFIG, now: () => FIXED_NOW,
      })).rejects.toBeInstanceOf(RecoverySnapshotError);
    } finally {
      await engine.setConfig('version', String(LATEST_VERSION));
    }
  });

  test('changes the content digest when source-backed page identity changes', async () => {
    const before = await buildRecoverySnapshot(engine, {
      brainId: 'host', sourceId: 'default', config: PGLITE_CONFIG, now: () => FIXED_NOW,
    });
    await engine.putPage('notes/alpha', {
      type: 'note', title: 'Alpha revised', compiled_truth: 'Revised source-backed fixture.',
      content_hash: 'c'.repeat(64), source_path: 'notes/alpha.md', chunker_version: 2,
    }, { sourceId: 'default' });
    const after = await buildRecoverySnapshot(engine, {
      brainId: 'host', sourceId: 'default', config: PGLITE_CONFIG, now: () => FIXED_NOW,
    });
    expect(after.content_digest.value).not.toBe(before.content_digest.value);
  });
});
