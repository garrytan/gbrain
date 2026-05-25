/**
 * v0.41 IRON-RULE regression: `eval replay` MUST skip the
 * `_kind: 'baseline_metadata'` header line that `gbrain bench publish`
 * writes. Codex round-1 #3 caught that without the skip, the header
 * would be parsed as a fake captured row and pollute counts.
 *
 * This test verifies the skip works by feeding `parseNdjson` (via the
 * replayCore entrypoint's file-read path) a synthetic baseline file and
 * asserting:
 *   1. The metadata line is dropped (rows_total reflects ONLY captured rows)
 *   2. The body rows parse correctly
 *   3. parseNdjson rejects a bare captured row WITHOUT schema_version
 *      (i.e. the discriminator + schema_version validators are both live)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { replayCore } from '../src/commands/eval-replay.ts';

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

describe('eval-replay metadata-skip regression (v0.41)', () => {
  test('parseNdjson skips _kind:baseline_metadata header line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-replay-meta-skip-'));
    const baselinePath = join(dir, 'baseline.ndjson');

    // Synthetic baseline file with metadata header + 2 captured rows.
    const metadataLine = JSON.stringify({
      schema_version: 1,
      _kind: 'baseline_metadata',
      label: 'test',
      published_at: '2026-05-24T00:00:00Z',
      source_hash: 'fake-hash',
      thresholds: { jaccard: 0.85, top1: 0.8, latency_multiplier: 2.0 },
      row_count: 2,
      baseline_mean_latency_ms: 100,
    });
    const row1 = JSON.stringify({
      id: 1,
      schema_version: 1,
      tool_name: 'query',
      query: '',  // empty query → skipped, doesn't touch the engine
      retrieved_slugs: ['a'],
      latency_ms: 100,
    });
    const row2 = JSON.stringify({
      id: 2,
      schema_version: 1,
      tool_name: 'query',
      query: '',
      retrieved_slugs: ['b'],
      latency_ms: 100,
    });
    writeFileSync(baselinePath, `${metadataLine}\n${row1}\n${row2}\n`);

    try {
      const { summary } = await replayCore(engine, { against: baselinePath });
      // KEY ASSERTION: rows_total = 2 (metadata header NOT counted).
      // Without the skip, this would be 3 and parser would throw on the
      // metadata line because it has no schema_version of the type expected.
      expect(summary.rows_total).toBe(2);
      expect(summary.rows_skipped).toBe(2); // both empty-query rows skipped
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parseNdjson still rejects malformed rows (validator live, not silently dropping everything)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-replay-meta-skip-'));
    const baselinePath = join(dir, 'bad.ndjson');

    const metadataLine = JSON.stringify({
      schema_version: 1,
      _kind: 'baseline_metadata',
      label: 'test',
    });
    // Row missing schema_version entirely → should still throw.
    const badRow = JSON.stringify({ id: 1, tool_name: 'query', query: 'x' });
    writeFileSync(baselinePath, `${metadataLine}\n${badRow}\n`);

    try {
      await expect(replayCore(engine, { against: baselinePath })).rejects.toThrow(/schema_version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
