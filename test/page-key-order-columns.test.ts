/**
 * PAGE_KEY_ORDER (src/core/rust-engine/store-codec.ts) against the real `pages` schema.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every column of `pages` on a fresh schema is either in PAGE_KEY_ORDER (a page read returns it) or in
 *    NOT_IN_PAGE_READ below (no page read returns it), and the keys PGLite's putPage, getPage and listPages return
 *    are all in PAGE_KEY_ORDER, in its order.
 *  - Regression: PAGE_KEY_ORDER is a hand-kept list. A new `pages` column that a page read returns, and that the
 *    list does not name, prints after the listed keys on a Rust brain and in its table place on PGLite and Postgres.
 *  - Why existing coverage misses it: test/engine-parity/page-key-order.test.ts compares only the columns it reads.
 *  - Seam: none. A real PGLite schema, information_schema and the typed page methods.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_KEY_ORDER } from '../src/core/rust-engine/store-codec.ts';

/** `pages` columns no page read returns. A new column goes here or into PAGE_KEY_ORDER. */
const NOT_IN_PAGE_READ = [
  'page_kind', 'last_retrieved_at', 'links_extracted_at', 'database_only_reason', 'corpus_generation', 'generation',
  'search_vector', 'emotional_weight_recomputed_at', 'chunker_version', 'embedding_signature',
  'links_attendance_blocked_revision', 'links_attendance_blocked_at', 'revision_write_request_id',
  'revision_principal_kind', 'revision_principal_id', 'trust_tier', 'write_origin', 'body_storage', 'body_bytes',
  'truth_bytes', 'body_lines', 'body_generation', 'segment_count', 'segmenter_version', 'body_flags', 'truth_lead',
  'timeline_lead', 'links_extract_failure', 'page_readers', 'folder_rule_ids', 'version_history_gap_at',
];

/** Keys a page read returns that are not `pages` columns. */
const COMPUTED_KEYS = ['updated_at_iso'];

let engine: PGLiteEngine;
let columns: string[];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const rows = await engine.executeRaw<{ c: string }>(
    `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pages' ORDER BY ordinal_position`);
  columns = rows.map((r) => r.c);
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

const listed = new Set<string>(PAGE_KEY_ORDER);

describe('PAGE_KEY_ORDER and the pages schema', () => {
  test('every pages column is in PAGE_KEY_ORDER or in NOT_IN_PAGE_READ', () => {
    expect(columns.length).toBeGreaterThan(0);
    const unclassified = columns.filter((c) => !listed.has(c) && !NOT_IN_PAGE_READ.includes(c));
    expect(unclassified).toEqual([]);
  });

  test('every listed key is a pages column or a computed key, and no column is in both lists', () => {
    const known = new Set([...columns, ...COMPUTED_KEYS]);
    expect(PAGE_KEY_ORDER.filter((k) => !known.has(k))).toEqual([]);
    expect(NOT_IN_PAGE_READ.filter((c) => !columns.includes(c))).toEqual([]);
    expect(NOT_IN_PAGE_READ.filter((c) => listed.has(c))).toEqual([]);
  });

  test('PGLite putPage, getPage and listPages return only listed keys, in PAGE_KEY_ORDER order', async () => {
    const put = await engine.putPage('notes/key-order', { type: 'note', title: 'Key order', compiled_truth: 'Body.', timeline: '' });
    const got = await engine.getPage('notes/key-order');
    const [row] = await engine.listPages({});
    for (const page of [put, got, row]) {
      const keys = Object.keys(page as object);
      expect(keys.filter((k) => !listed.has(k))).toEqual([]);
      expect(keys).toEqual(PAGE_KEY_ORDER.filter((k) => keys.includes(k)));
    }
  });
});
