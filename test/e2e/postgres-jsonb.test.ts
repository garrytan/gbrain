/**
 * E2E JSONB round-trip tests — the test that should have caught the v0.12.0
 * silent-data-loss bug originally.
 *
 * v0.12.0-and-earlier wrote JSONB columns via `${JSON.stringify(value)}::jsonb`
 * which postgres.js v3 stringified again on the wire. Result: every JSONB
 * column stored a quoted-string literal instead of an object. Every
 * `frontmatter->>'key'` query returned NULL. PGLite was unaffected (different
 * driver path), which is why every previous unit test passed while real
 * Postgres-backed brains silently lost data.
 *
 * These tests exercise each of the four JSONB write sites and assert that:
 *   1. `jsonb_typeof(col) = 'object'` (or 'array' for array-shaped values)
 *      — proves the column is a real JSONB structure, not a string literal.
 *   2. `col->>'key'` returns the expected scalar — proves downstream queries
 *      and GIN indexes will work as intended.
 *
 * Without these E2E assertions, the CI grep guard in scripts/check-jsonb-pattern.sh
 * is the only protection — and it doesn't catch helper-wrapped or multi-line
 * variants of the buggy pattern.
 *
 * Run: DATABASE_URL=... bun test test/e2e/postgres-jsonb.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  hasDatabase, setupDB, teardownDB, getEngine, getConn,
} from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E JSONB round-trip tests (DATABASE_URL not set)');
}

describeE2E('Postgres JSONB round-trip — frontmatter / data / pages_updated / metadata', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });

  test('pages.frontmatter — putPage stores object, not string literal', async () => {
    const engine = getEngine();
    const conn = getConn();

    await engine.putPage('jsonb-test/frontmatter', {
      type: 'concept',
      title: 'JSONB roundtrip',
      compiled_truth: 'body',
      frontmatter: { author: 'garry', score: 7, tags: ['x', 'y'] },
    });

    const rows = await conn.unsafe(`
      SELECT
        jsonb_typeof(frontmatter) AS jt,
        frontmatter->>'author'    AS author,
        frontmatter->>'score'     AS score,
        frontmatter->'tags'       AS tags
      FROM pages
      WHERE slug = 'jsonb-test/frontmatter'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].jt).toBe('object');
    expect(rows[0].author).toBe('garry');
    expect(rows[0].score).toBe('7');
    expect(rows[0].tags).toEqual(['x', 'y']);
  });

  test('raw_data.data — putRawData stores object, not string literal', async () => {
    const engine = getEngine();
    const conn = getConn();

    await engine.putPage('jsonb-test/raw', { type: 'concept', title: 't', compiled_truth: '' });
    await engine.putRawData('jsonb-test/raw', 'unit-test', { kind: 'fixture', count: 42 });

    const rows = await conn.unsafe(`
      SELECT
        jsonb_typeof(rd.data) AS jt,
        rd.data->>'kind'      AS kind,
        rd.data->>'count'     AS count
      FROM raw_data rd
      JOIN pages p ON p.id = rd.page_id
      WHERE p.slug = 'jsonb-test/raw' AND rd.source = 'unit-test'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].jt).toBe('object');
    expect(rows[0].kind).toBe('fixture');
    expect(rows[0].count).toBe('42');
  });

  test('ingest_log.pages_updated — logIngest stores array, not string literal', async () => {
    const engine = getEngine();
    const conn = getConn();

    await engine.logIngest({
      source_type: 'unit-test',
      source_ref: 'jsonb-roundtrip',
      pages_updated: ['a/b', 'c/d', 'e/f'],
      summary: 'roundtrip-check',
    });

    const rows = await conn.unsafe(`
      SELECT
        jsonb_typeof(pages_updated) AS jt,
        pages_updated->>0           AS first,
        jsonb_array_length(pages_updated) AS len
      FROM ingest_log
      WHERE source_ref = 'jsonb-roundtrip'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].jt).toBe('array');
    expect(rows[0].first).toBe('a/b');
    expect(rows[0].len).toBe(3);
  });

  test('files.metadata — write site uses sql.json, not string interpolation', async () => {
    const conn = getConn();

    // Mimic the write at src/commands/files.ts:254 (the bonus fix).
    await conn`
      INSERT INTO files (filename, storage_path, mime_type, size_bytes, content_hash, metadata)
      VALUES (
        'roundtrip.bin',
        'unit-test/roundtrip.bin',
        'application/octet-stream',
        ${0},
        'sha256:test',
        ${conn.json({ type: 'archive', upload_method: 'unit-test' })}
      )
    `;

    const rows = await conn.unsafe(`
      SELECT
        jsonb_typeof(metadata) AS jt,
        metadata->>'type'      AS type,
        metadata->>'upload_method' AS method
      FROM files
      WHERE storage_path = 'unit-test/roundtrip.bin'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].jt).toBe('object');
    expect(rows[0].type).toBe('archive');
    expect(rows[0].method).toBe('unit-test');
  });

  test('page_versions.frontmatter — INSERT...SELECT propagates object shape', async () => {
    const engine = getEngine();
    const conn = getConn();

    await engine.putPage('jsonb-test/versioned', {
      type: 'concept',
      title: 'versioned',
      compiled_truth: 'v1',
      frontmatter: { mood: 'happy' },
    });
    await engine.createVersion('jsonb-test/versioned');

    const rows = await conn.unsafe(`
      SELECT
        jsonb_typeof(pv.frontmatter) AS jt,
        pv.frontmatter->>'mood'      AS mood
      FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = 'jsonb-test/versioned'
    `);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].jt).toBe('object');
    expect(rows[0].mood).toBe('happy');
  });
});
