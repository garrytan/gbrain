import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  loadOpCheckpoint,
  recordCompleted,
  appendCompleted,
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

// #1794: append-only delta storage (op_checkpoint_paths). recordCompleted keeps
// REPLACE semantics for the 9 non-sync consumers; appendCompleted is the
// additive path sync uses to avoid O(N²) full-set rewrites.
describe('appendCompleted (delta) + union read', () => {
  async function pathRowCount(op: string, fp: string): Promise<number> {
    const rows = await engine.executeRaw<{ n: string | number }>(
      `SELECT count(*)::text AS n FROM op_checkpoint_paths WHERE op = $1 AND fingerprint = $2`,
      [op, fp],
    );
    return Number(rows[0]?.n ?? 0);
  }

  test('appendCompleted returns true and load reflects the delta', async () => {
    const key = { op: 'sync', fingerprint: 'fp-append' };
    expect(await appendCompleted(engine, key, ['a.md', 'b.md'])).toBe(true);
    expect((await loadOpCheckpoint(engine, key)).sort()).toEqual(['a.md', 'b.md']);
  });

  test('re-appending an already-banked path inserts 0 new rows (delta, not full rewrite)', async () => {
    const key = { op: 'sync', fingerprint: 'fp-delta' };
    await appendCompleted(engine, key, ['a.md', 'b.md']);
    expect(await pathRowCount('sync', 'fp-delta')).toBe(2);
    // Second flush re-sends one banked + one new path; ON CONFLICT DO NOTHING
    // means only the genuinely-new row lands.
    await appendCompleted(engine, key, ['b.md', 'c.md']);
    expect(await pathRowCount('sync', 'fp-delta')).toBe(3);
    expect((await loadOpCheckpoint(engine, key)).sort()).toEqual(['a.md', 'b.md', 'c.md']);
  });

  test('empty delta is a no-op (returns true, writes nothing)', async () => {
    const key = { op: 'sync', fingerprint: 'fp-empty' };
    expect(await appendCompleted(engine, key, [])).toBe(true);
    expect(await pathRowCount('sync', 'fp-empty')).toBe(0);
  });

  test('union read across legacy completed_keys array AND appended child rows', async () => {
    // Simulates an in-flight upgrade: a pre-existing parent row carries the
    // legacy array, then the new code appends child rows to the same key.
    const key = { op: 'sync', fingerprint: 'fp-union' };
    await engine.executeRaw(
      `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
       VALUES ('sync', 'fp-union', '["legacy-1","legacy-2"]'::jsonb, now())`,
    );
    await appendCompleted(engine, key, ['new-1']);
    expect((await loadOpCheckpoint(engine, key)).sort()).toEqual(['legacy-1', 'legacy-2', 'new-1']);
  });

  test('clearOpCheckpoint cascades to child rows', async () => {
    const key = { op: 'sync', fingerprint: 'fp-clear' };
    await appendCompleted(engine, key, ['a.md', 'b.md']);
    expect(await pathRowCount('sync', 'fp-clear')).toBe(2);
    await clearOpCheckpoint(engine, key);
    expect(await pathRowCount('sync', 'fp-clear')).toBe(0);
    expect(await loadOpCheckpoint(engine, key)).toEqual([]);
  });

  test('recordCompleted still REPLACES (sync appendCompleted does not)', async () => {
    // Guards V3: recordCompleted must remove stale keys, not append them.
    const key = { op: 'embed', fingerprint: 'fp-replace' };
    await recordCompleted(engine, key, ['x', 'y']);
    await recordCompleted(engine, key, ['x']);
    expect((await loadOpCheckpoint(engine, key)).sort()).toEqual(['x']);
  });

  test('purge of a stale parent cascades to its child rows', async () => {
    // The FK guarantees children always have a parent, so deleting the stale
    // parent cascade-drops its children. (A standalone orphan is impossible to
    // create — the FK rejects it — so there is no separate orphan sweep.)
    await engine.executeRaw(
      `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
       VALUES ('sync', 'fp-stale', '[]'::jsonb, now() - interval '10 days')`,
    );
    await engine.executeRaw(
      `INSERT INTO op_checkpoint_paths (op, fingerprint, path, created_at)
       VALUES ('sync', 'fp-stale', 'old.md', now() - interval '10 days')`,
    );
    const purged = await purgeStaleCheckpoints(engine, 7);
    expect(purged).toBe(1); // counts the parent; child cascades silently
    expect(await pathRowCount('sync', 'fp-stale')).toBe(0);
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

describe('BUG 3: completed_keys array-shape guard (v119 CHECK + defensive loader)', () => {
  const CONSTRAINT = 'op_checkpoints_completed_keys_array';

  test('CHECK rejects a scalar completed_keys write — exactly one constraint (no blob+migration dupe)', async () => {
    // Fresh PGLite install: the schema blob ships the NAMED inline CHECK and
    // migration v119's IF NOT EXISTS skips re-adding it. Exactly one constraint.
    const c = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = $1`,
      [CONSTRAINT],
    );
    expect(Number(c[0].n)).toBe(1);

    let threw = false;
    try {
      await engine.executeRaw(
        `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
         VALUES ('embed', 'fp-reject', '"not-an-array"'::jsonb, now())`,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('loader survives a scalar parent: returns child rows (not []), does not throw', async () => {
    const key = { op: 'sync', fingerprint: 'fp-scalar-survive' };
    // Bypass the CHECK to simulate pre-migration / out-of-band corruption.
    await engine.executeRaw(`ALTER TABLE op_checkpoints DROP CONSTRAINT ${CONSTRAINT}`);
    try {
      await engine.executeRaw(
        `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
         VALUES ('sync', 'fp-scalar-survive', '"corrupt-scalar"'::jsonb, now())`,
      );
      await engine.executeRaw(
        `INSERT INTO op_checkpoint_paths (op, fingerprint, path)
         VALUES ('sync', 'fp-scalar-survive', 'child-a.md')`,
      );
      // Pre-guard, jsonb_array_elements_text on the scalar threw and the catch
      // returned [] — losing child-a.md. The typeof guard skips the scalar so
      // the valid child survives.
      const loaded = await loadOpCheckpoint(engine, key);
      expect(loaded).toEqual(['child-a.md']);
    } finally {
      await engine.executeRaw(
        `UPDATE op_checkpoints SET completed_keys = '[]'::jsonb WHERE jsonb_typeof(completed_keys) <> 'array'`,
      );
      await engine.executeRaw(
        `ALTER TABLE op_checkpoints ADD CONSTRAINT ${CONSTRAINT} CHECK (jsonb_typeof(completed_keys) = 'array')`,
      );
    }
  });

  test('v119 repair converts a scalar parent to an empty array', async () => {
    await engine.executeRaw(`ALTER TABLE op_checkpoints DROP CONSTRAINT ${CONSTRAINT}`);
    try {
      await engine.executeRaw(
        `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
         VALUES ('embed', 'fp-repair', '"scalar"'::jsonb, now())`,
      );
      // Migration v119's repair statement.
      await engine.executeRaw(
        `UPDATE op_checkpoints SET completed_keys = '[]'::jsonb, updated_at = now()
         WHERE jsonb_typeof(completed_keys) <> 'array'`,
      );
      const typ = await engine.executeRaw<{ t: string }>(
        `SELECT jsonb_typeof(completed_keys) AS t FROM op_checkpoints WHERE op = 'embed' AND fingerprint = 'fp-repair'`,
      );
      expect(typ[0].t).toBe('array');
    } finally {
      await engine.executeRaw(
        `ALTER TABLE op_checkpoints ADD CONSTRAINT ${CONSTRAINT} CHECK (jsonb_typeof(completed_keys) = 'array')`,
      );
    }
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
