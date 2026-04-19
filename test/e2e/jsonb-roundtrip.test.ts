/**
 * E2E JSONB Roundtrip Tests — v0.12.1 Reliability Wave
 *
 * Guards the four JSONB write sites against double-encoding regressions:
 *   1. PostgresEngine.putPage     → pages.frontmatter
 *   2. PostgresEngine.putRawData  → raw_data.data
 *   3. PostgresEngine.logIngest   → ingest_log.pages_updated
 *   4. commands/files.ts:254      → files.metadata
 *
 * The v0.12.0 bug: `${JSON.stringify(x)}::jsonb` sends a JSON-encoded string
 * to postgres.js, which stores it as a JSONB *string literal* instead of an
 * object. `col ->> 'key'` returns NULL; GIN indexes are ineffective.
 * PGLite masks this because its driver parses the string. Real Postgres does not.
 *
 * The fix: `sql.json(x)` uses postgres.js v3's native JSONB serialization.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

describeE2E('E2E: JSONB roundtrip — v0.12.1 reliability wave', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });

  test('putPage writes frontmatter as object, not double-encoded string', async () => {
    const engine = getEngine();
    await engine.putPage('test/jsonb-putpage', {
      type: 'concept',
      title: 'JSONB putPage test',
      compiled_truth: 'body',
      timeline: '',
      frontmatter: { marker: 'putpage-value', tags: ['a', 'b'] },
    });
    const sql = getConn();
    const [row] = await sql`
      SELECT jsonb_typeof(frontmatter) AS t, frontmatter ->> 'marker' AS marker
      FROM pages WHERE slug = 'test/jsonb-putpage'
    `;
    expect(row.t).toBe('object');
    expect(row.marker).toBe('putpage-value');
  });

  test('putRawData writes raw_data.data as object, not double-encoded string', async () => {
    const engine = getEngine();
    await engine.putPage('test/jsonb-rawdata', {
      type: 'concept',
      title: 'RawData test',
      compiled_truth: 'body',
      timeline: '',
      frontmatter: {},
    });
    await engine.putRawData('test/jsonb-rawdata', 'unit-test', {
      marker: 'rawdata-value',
      nested: { k: 'v' },
    });
    const sql = getConn();
    const [row] = await sql`
      SELECT jsonb_typeof(rd.data) AS t, rd.data ->> 'marker' AS marker
      FROM raw_data rd
      JOIN pages p ON p.id = rd.page_id
      WHERE p.slug = 'test/jsonb-rawdata'
    `;
    expect(row.t).toBe('object');
    expect(row.marker).toBe('rawdata-value');
  });

  test('logIngest writes pages_updated as array, not double-encoded string', async () => {
    const engine = getEngine();
    await engine.logIngest({
      source_type: 'unit-test',
      source_ref: 'jsonb-roundtrip',
      pages_updated: ['test/a', 'test/b', 'test/c'],
      summary: 'jsonb logingest check',
    });
    const sql = getConn();
    const [row] = await sql`
      SELECT jsonb_typeof(pages_updated) AS t,
             jsonb_array_length(pages_updated) AS n,
             pages_updated ->> 0 AS first
      FROM ingest_log
      WHERE source_ref = 'jsonb-roundtrip'
      ORDER BY id DESC LIMIT 1
    `;
    expect(row.t).toBe('array');
    expect(Number(row.n)).toBe(3);
    expect(row.first).toBe('test/a');
  });

  // files.ts:254 (uploadRaw's cloud-upload branch) was changed from
  // `${JSON.stringify({...})}::jsonb` to `${sql.json({...})}` in v0.12.1.
  // The function reads config and touches cloud storage, so we exercise the
  // driver-level pattern directly against the same table/column.
  test('files.metadata writes as object via sql.json(), not double-encoded string', async () => {
    const sql = getConn();
    const payload = { type: 'pdf', upload_method: 'TUS resumable' };
    await sql`
      INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
      VALUES (NULL, 'jsonb-check.bin', 'unsorted/jsonb-check.bin', 'application/octet-stream', 1, 'sha256:deadbeef', ${sql.json(payload)})
      ON CONFLICT (storage_path) DO UPDATE SET metadata = EXCLUDED.metadata
    `;
    const [row] = await sql`
      SELECT jsonb_typeof(metadata) AS t,
             metadata ->> 'type' AS type,
             metadata ->> 'upload_method' AS method
      FROM files WHERE storage_path = 'unsorted/jsonb-check.bin'
    `;
    expect(row.t).toBe('object');
    expect(row.type).toBe('pdf');
    expect(row.method).toBe('TUS resumable');
  });

  // Source-level tripwire: if anyone re-introduces the old `${JSON.stringify(x)}::jsonb`
  // pattern for the fixed sites, fail loudly. Greps actual source files per the
  // files-test-reimplements-production tripwire (CLAUDE.md).
  test('no ${JSON.stringify(x)}::jsonb pattern remains in fixed sites', async () => {
    const files = [
      '../../src/core/postgres-engine.ts',
      '../../src/commands/files.ts',
    ];
    const bad = /\$\{[^}]*JSON\.stringify\([^}]*\)[^}]*\}::jsonb/;
    for (const rel of files) {
      const source = await Bun.file(new URL(rel, import.meta.url)).text();
      expect(source.match(bad)?.[0] ?? null).toBeNull();
    }
  });
});
