import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});

describe('v0.38 migrations v81 + v82 (smoke)', () => {
  test('v81 drops takes_kind_check; takes accepts arbitrary kind values', async () => {
    // After migration v81, INSERTing a non-default kind (e.g. 'finding') should succeed.
    await engine.executeRaw(
      "INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter) VALUES ('t/p', 'note', 't', '', '', '{}')",
      [],
    );
    const pageRows = await engine.executeRaw("SELECT id FROM pages WHERE slug = 't/p'", []);
    const pid = (pageRows[0] as Record<string, unknown>).id as number;
    // Pre-v81 this would have failed the CHECK constraint.
    await engine.executeRaw(
      "INSERT INTO takes (page_id, row_num, claim, kind, holder, weight) VALUES ($1, 1, 'test', 'finding', 'world', 0.5)",
      [pid],
    );
    const rows = await engine.executeRaw("SELECT kind FROM takes WHERE page_id = $1", [pid]);
    expect((rows[0] as Record<string, unknown>).kind).toBe('finding');
  });

  test('v82 adds eval_candidates.schema_pack_per_source column', async () => {
    const rows = await engine.executeRaw(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'eval_candidates' AND column_name = 'schema_pack_per_source'`,
      [],
    );
    expect(rows.length).toBe(1);
    expect((rows[0] as Record<string, unknown>).data_type).toBe('jsonb');
  });

  test('v82 accepts JSONB shape for per-source snapshot', async () => {
    const snapshot = {
      default: {
        pack_name: 'gbrain-base',
        pack_version: '1.0.0',
        manifest_sha8: 'abcd1234',
        alias_closure_resolved: { person: ['person'] },
      },
    };
    await engine.executeRaw(
      `INSERT INTO eval_candidates (tool_name, query, vector_enabled, expansion_applied, latency_ms, remote, schema_pack_per_source)
       VALUES ('query', 'who knows about ml', true, false, 42, false, $1::jsonb)`,
      [JSON.stringify(snapshot)],
    );
    const rows = await engine.executeRaw(
      `SELECT schema_pack_per_source FROM eval_candidates WHERE tool_name = 'query' LIMIT 1`,
      [],
    );
    const stored = (rows[0] as Record<string, unknown>).schema_pack_per_source;
    // PGLite returns JSONB as parsed object (postgres.js does too via the
    // engine layer); accept either string or object.
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    expect((parsed as Record<string, unknown>).default).toBeDefined();
  });
});
