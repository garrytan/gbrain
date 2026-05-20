import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  loadOpCheckpoint,
  recordCompleted,
  clearOpCheckpoint,
  resumeFilter,
  purgeStaleCheckpoints,
  fingerprint,
  embedFingerprint,
  extractFingerprint,
  reindexFingerprint,
} from '../src/core/op-checkpoint.ts';

/**
 * D12 pinning tests for src/core/op-checkpoint.ts.
 *
 * Closes codex #10–#16:
 *   - per-param fingerprint scoping (no cross-mode collisions)
 *   - DB-backed CRUD works on PGLite (single-host fallback path)
 *   - resumeFilter is pure
 *   - purgeStaleCheckpoints respects TTL
 */

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
  await resetPgliteState(engine);
});

describe('fingerprint helpers', () => {
  test('fingerprint: stable across runs', () => {
    const params = { stale: true, source: 'default' };
    expect(fingerprint(params)).toBe(fingerprint(params));
  });

  test('fingerprint: key order does not matter (canonical-JSON)', () => {
    const a = fingerprint({ a: 1, b: 2 });
    const b = fingerprint({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  test('fingerprint: different values produce different hashes', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  test('fingerprint returns 8 hex chars', () => {
    expect(fingerprint({ x: 1 })).toMatch(/^[a-f0-9]{8}$/);
  });

  test('codex #11: extract links vs timeline get different fingerprints', () => {
    const linksFp = extractFingerprint({ mode: 'links', source: 'default' });
    const timelineFp = extractFingerprint({ mode: 'timeline', source: 'default' });
    expect(linksFp).not.toBe(timelineFp);
  });

  test('codex #12: reindex markdown vs code get different fingerprints', () => {
    const md = reindexFingerprint({ markdown: true, chunker_version: 2 });
    const code = reindexFingerprint({ code: true, chunker_version: 2 });
    expect(md).not.toBe(code);
  });

  test('codex #15: embed model+dim variation produces different fingerprints', () => {
    const a = embedFingerprint({
      stale: true,
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 3072,
    });
    const b = embedFingerprint({
      stale: true,
      embedding_model: 'voyage:voyage-3',
      embedding_dimensions: 1024,
    });
    expect(a).not.toBe(b);
  });

  test('reindex chunker_version bump invalidates checkpoint', () => {
    const v1 = reindexFingerprint({ markdown: true, chunker_version: 1 });
    const v2 = reindexFingerprint({ markdown: true, chunker_version: 2 });
    expect(v1).not.toBe(v2);
  });
});

describe('loadOpCheckpoint / recordCompleted / clearOpCheckpoint', () => {
  test('empty checkpoint returns []', async () => {
    const result = await loadOpCheckpoint(engine, { op: 'embed', fingerprint: 'abc12345' });
    expect(result).toEqual([]);
  });

  test('round-trip: write then read', async () => {
    const key = { op: 'embed', fingerprint: 'abc12345' };
    await recordCompleted(engine, key, ['chunk-1', 'chunk-2', 'chunk-3']);
    const result = await loadOpCheckpoint(engine, key);
    expect(result.sort()).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
  });

  test('write overwrites prior state', async () => {
    const key = { op: 'embed', fingerprint: 'abc12345' };
    await recordCompleted(engine, key, ['chunk-1']);
    await recordCompleted(engine, key, ['chunk-1', 'chunk-2']);
    const result = await loadOpCheckpoint(engine, key);
    expect(result.sort()).toEqual(['chunk-1', 'chunk-2']);
  });

  test('different fingerprints stay isolated', async () => {
    const linksKey = { op: 'extract', fingerprint: 'fp-links' };
    const timelineKey = { op: 'extract', fingerprint: 'fp-timeline' };
    await recordCompleted(engine, linksKey, ['file-a.md']);
    await recordCompleted(engine, timelineKey, ['file-b.md']);

    const links = await loadOpCheckpoint(engine, linksKey);
    const timeline = await loadOpCheckpoint(engine, timelineKey);

    expect(links).toEqual(['file-a.md']);
    expect(timeline).toEqual(['file-b.md']);
  });

  test('clearOpCheckpoint drops the row', async () => {
    const key = { op: 'embed', fingerprint: 'to-clear' };
    await recordCompleted(engine, key, ['x']);
    expect(await loadOpCheckpoint(engine, key)).toEqual(['x']);
    await clearOpCheckpoint(engine, key);
    expect(await loadOpCheckpoint(engine, key)).toEqual([]);
  });

  test('clearOpCheckpoint on missing row is no-op (idempotent)', async () => {
    // Should not throw and load should still return [] afterwards
    await clearOpCheckpoint(engine, { op: 'never-written', fingerprint: 'nope' });
    const after = await loadOpCheckpoint(engine, { op: 'never-written', fingerprint: 'nope' });
    expect(after).toEqual([]);
  });
});

describe('resumeFilter (pure)', () => {
  test('empty completed returns all', () => {
    expect(resumeFilter(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  test('filters out completed keys', () => {
    expect(resumeFilter(['a', 'b', 'c', 'd'], ['b', 'd'])).toEqual(['a', 'c']);
  });

  test('no completed keys present in all: identity', () => {
    expect(resumeFilter(['a'], ['z'])).toEqual(['a']);
  });

  test('all completed: returns empty', () => {
    expect(resumeFilter(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
});

describe('purgeStaleCheckpoints', () => {
  test('no stale rows: returns 0', async () => {
    await recordCompleted(engine, { op: 'embed', fingerprint: 'fresh' }, ['x']);
    const purged = await purgeStaleCheckpoints(engine, 7);
    expect(purged).toBe(0);
  });

  test('purges rows older than TTL', async () => {
    // Insert a fake old row directly
    await engine.executeRaw(
      `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
       VALUES ('embed', 'old', '["x"]'::jsonb, now() - interval '10 days')`,
    );
    const purged = await purgeStaleCheckpoints(engine, 7);
    expect(purged).toBe(1);
    expect(await loadOpCheckpoint(engine, { op: 'embed', fingerprint: 'old' })).toEqual([]);
  });
});
