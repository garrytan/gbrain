/**
 * A sub-day `ttl` must not write a fact that is already expired.
 *
 * The fence writers rendered `valid_until` with `.toISOString().slice(0, 10)`.
 * For a ttl carrying a time of day that does not round the expiry, it moves it
 * BACKWARDS to 00:00 of the same day. A fact remembered at 07:55 with ttl '1h'
 * landed with `valid_until` = 00:00 that morning: read-time TTL validity
 * (v0.47.10.0) filters on `valid_until > now()`, so it answered no recall arm
 * except `include_expired`, while `expired_at` stayed null so it did not even
 * look expired. `remember` returned the correct un-truncated timestamp, so the
 * loss was invisible at the call site.
 *
 * `parseValidDate` always accepted a full ISO instant, so the fix is write-side
 * only: emit the bare date at exactly UTC midnight, the full instant otherwise.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import type { FenceInputFact } from '../src/core/facts/fence-write.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'fence-subday-ttl-'));
  _resetWriteThroughCacheForTest();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (engine as any).db;
  await db.query(`DELETE FROM config WHERE key = 'sync.write_through'`);
  await db.query('DELETE FROM facts');
  await db.query(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
});

const input = (validUntil: Date): FenceInputFact => ({
  fact: 'A claim that expires within the day',
  kind: 'fact',
  notability: 'medium',
  source: 'test',
  visibility: 'world',
  confidence: 1.0,
  validUntil,
  embedding: null,
  sessionId: null,
});

async function validUntilOf(id: number): Promise<Date> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (engine as any).db.query(
    'SELECT valid_until FROM facts WHERE id = $1', [id],
  );
  return new Date(rows.rows[0].valid_until);
}

describe('a sub-day ttl survives the fence write', () => {
  test('a 1h ttl stays in the future instead of collapsing to midnight', async () => {
    const before = new Date();
    const expiry = new Date(before.getTime() + 3_600_000);

    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/alice', resolutionSource: 'exact_page' },
      [input(expiry)],
    );
    expect(result.inserted).toBe(1);

    // The defect: this landed at 00:00 today, i.e. behind `before`.
    expect((await validUntilOf(result.ids[0])).getTime()).toBeGreaterThan(before.getTime());
  });

  test('the stored expiry is the instant asked for, to the millisecond', async () => {
    const expiry = new Date(Date.now() + 45 * 60_000);

    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/bob', resolutionSource: 'exact_page' },
      [input(expiry)],
    );

    expect((await validUntilOf(result.ids[0])).toISOString()).toBe(expiry.toISOString());
  });

  test('the fact is readable, not filtered out as lapsed', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/carol', resolutionSource: 'exact_page' },
      [input(new Date(Date.now() + 3_600_000))],
    );

    // The read-time TTL predicate every recall arm applies.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT id FROM facts
        WHERE id = $1 AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())`,
      [result.ids[0]],
    );
    expect(rows.rows).toHaveLength(1);
  });

  test('a midnight expiry still renders as a bare date in the fence', async () => {
    // The cell shape existing rows use must not churn.
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/dave', resolutionSource: 'exact_page' },
      [input(new Date('2027-03-04T00:00:00.000Z'))],
    );
    expect(result.inserted).toBe(1);

    const body = readFileSync(join(brainDir, 'people/dave.md'), 'utf-8');
    expect(body).toContain('| 2027-03-04 |');
    expect(body).not.toContain('2027-03-04T00:00:00.000Z');
  });
});
