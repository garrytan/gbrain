/**
 * The shadow fingerprint probe on a PGLite primary. PGLite is the reference the committed fixture
 * (rust/crates/gbrain-store/tests/fixtures/fact_fingerprints.json) is built from, so the probe finds no differing code
 * point and no corpus row that fingerprints differently. The Postgres twin with glibc and C-locale hosts is
 * test/e2e/shadow-fingerprint-probe.test.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: probeOnPrimary compares the primary's lower() and [[:space:]] answers for every code point, the
 *    word-final sigma rule and a sample of the corpus's fingerprints with the fixture, and records the database's
 *    ctype and locale provider.
 *  - Regression: a probe that only runs 20 claims passes on a host whose lower() or [[:space:]] differs per code point.
 *  - Why existing coverage misses it: the old corpus held no differing code point.
 *  - Seam: none. Real PGLite and the installed SQL functions.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { probeOnPrimary, probeRecord, PROBE_CORPUS } from '../src/shadow/fingerprints.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine?.disconnect(); });

test('on PGLite the probe passes with no differing code point and no corpus mismatch', async () => {
  const started = performance.now();
  const probe = await probeOnPrimary(engine);
  console.log(`[fingerprint probe] PGLite ${Math.round(performance.now() - started)} ms`);
  const { sql, ...meta } = probe;
  const record = probeRecord(sql, sql.map(([fingerprint, fingerprint_v1]) => ({ fingerprint, fingerprint_v1 })), meta, new Date(0));
  expect(record).toMatchObject({
    state: 'pass', mismatches: 0, differing_code_points: [], differing_code_points_total: 0,
    corpus_mismatches: 0, corpus_mismatch_rows: [], facts_with_differing_code_points: 0,
  });
  expect(probe.sql).toHaveLength(PROBE_CORPUS.length);
  expect(record.ctype).not.toBeNull();
  expect(record.collation).not.toBeNull();
}, 60_000);
