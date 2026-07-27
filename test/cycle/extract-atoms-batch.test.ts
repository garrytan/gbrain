// v0.41.19.0 — T1 of ops-fix-wave.
//
// Pins the batch idempotency contract for extract_atoms. The replaced
// per-hash helper did 7K SQL round trips on a brain with 7K conversation
// transcripts; the batch helper does ONE.
//
// Coverage: empty input short-circuits without a query; mixed-existing
// returns just the existing set; SQL failure fails open with empty Set
// (preserves the prior fail-open posture so a broken check doesn't block
// extraction).

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { atomsExistingForHashes } from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedAtom(slug: string, sourceHash: string, sourceId = 'default'): Promise<void> {
  await engine.putPage(slug, {
    title: slug.split('/').pop() ?? slug,
    type: 'atom',
    compiled_truth: 'test atom body',
    frontmatter: {
      type: 'atom',
      source_hash: sourceHash,
    },
    timeline: '',
  }, { sourceId });
}

describe('atomsExistingForHashes (T1 batch idempotency)', () => {
  test('empty input short-circuits without a query', async () => {
    const result = await atomsExistingForHashes(engine, 'default', []);
    expect(result.size).toBe(0);
  });

  test('returns just the hashes that have matching atom rows', async () => {
    // Seed 3 atoms with known hashes
    await seedAtom('atoms/2026-05-26/a', 'aaaaaaaaaaaaaaaa');
    await seedAtom('atoms/2026-05-26/b', 'bbbbbbbbbbbbbbbb');
    await seedAtom('atoms/2026-05-26/c', 'cccccccccccccccc');

    // Query with a mixed list: 2 existing + 2 new
    const result = await atomsExistingForHashes(engine, 'default', [
      'aaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbb',
      'dddddddddddddddd', // not seeded
      'eeeeeeeeeeeeeeee', // not seeded
    ]);
    expect(result.size).toBe(2);
    expect(result.has('aaaaaaaaaaaaaaaa')).toBe(true);
    expect(result.has('bbbbbbbbbbbbbbbb')).toBe(true);
    expect(result.has('dddddddddddddddd')).toBe(false);
  });

  test('scoped by source_id — atom in source A invisible to source B query', async () => {
    // Register non-default sources first (pages.source_id FK).
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('source-a', 'source-a'), ('source-b', 'source-b')
        ON CONFLICT DO NOTHING`,
    );
    // Pre-fix the per-hash helper had the same scope; this regression-
    // guards that the batch helper preserves it.
    await seedAtom('atoms/2026-05-26/x', 'xxxxxxxxxxxxxxxx', 'source-a');
    const fromA = await atomsExistingForHashes(engine, 'source-a', ['xxxxxxxxxxxxxxxx']);
    const fromB = await atomsExistingForHashes(engine, 'source-b', ['xxxxxxxxxxxxxxxx']);
    expect(fromA.size).toBe(1);
    expect(fromB.size).toBe(0);
  });

  test('soft-deleted atoms are not visible', async () => {
    await seedAtom('atoms/2026-05-26/deleted', 'ffffffffffffffff');
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = NOW() WHERE slug = $1 AND source_id = 'default'`,
      ['atoms/2026-05-26/deleted'],
    );
    const result = await atomsExistingForHashes(engine, 'default', ['ffffffffffffffff']);
    expect(result.size).toBe(0);
  });

  test('fails open when query throws (returns empty Set, logs to stderr)', async () => {
    // Construct an engine with a broken executeRaw via duck-typing.
    const brokenEngine = {
      executeRaw: async () => { throw new Error('connection refused'); },
    } as unknown as PGLiteEngine;
    const result = await atomsExistingForHashes(brokenEngine, 'default', ['aaaa']);
    // Fail-open: empty Set means caller treats all as not-extracted and
    // proceeds. Re-extraction cost is bounded by daily budget cap.
    expect(result.size).toBe(0);
  });
});
