/**
 * #2194 fix #2 — engine-parity for the failure-cooldown query.
 *
 * readRecentSourceFailures runs ONE SQL through engine.executeRaw (the
 * engine-agnostic path), so PGLite and Postgres must return identical
 * groupings. This pins that: it seeds the SAME dead/failed autopilot-cycle rows
 * into both engines and asserts the per-source counts + the null-source
 * exclusion (codex #6) match. PGLite always runs; Postgres runs only when
 * DATABASE_URL is set (mirrors engine-parity.test.ts's gating).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { readRecentSourceFailures } from '../../src/commands/autopilot-fanout.ts';

const SKIP_PG = !hasDatabase();

async function seed(engine: BrainEngine): Promise<void> {
  const rows: Array<[string, Record<string, unknown>, number]> = [
    ['dead', { source_id: 'repo-a' }, 5],
    ['failed', { source_id: 'repo-a' }, 2],
    ['dead', { source_id: 'repo-b' }, 10],
    ['completed', { source_id: 'repo-a' }, 1], // excluded (not a failure)
    ['dead', {}, 3],                            // excluded (null source_id, codex #6)
  ];
  for (const [status, data, minAgo] of rows) {
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data, finished_at) VALUES ('autopilot-cycle', $1, $2, $3)`,
      [status, data, new Date(Date.now() - minAgo * 60_000).toISOString()],
    );
  }
}

function summarize(map: Map<string, { count: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of map) out[k] = v.count;
  return out;
}

describe('failure-cooldown query — PGLite', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); await seed(engine); }, 30000);
  afterAll(async () => { await engine.disconnect(); });

  test('groups failures by source, excludes completed + null-source', async () => {
    const map = await readRecentSourceFailures(engine, { sinceMin: 120 });
    expect(summarize(map)).toEqual({ 'repo-a': 2, 'repo-b': 1 });
  });
});

(SKIP_PG ? describe.skip : describe)('failure-cooldown query — Postgres parity', () => {
  let engine: BrainEngine;
  beforeAll(async () => { await setupDB(); engine = await getEngine(); await seed(engine); }, 60000);
  afterAll(async () => { await teardownDB(); });

  test('Postgres returns the SAME groupings as PGLite', async () => {
    const map = await readRecentSourceFailures(engine, { sinceMin: 120 });
    expect(summarize(map)).toEqual({ 'repo-a': 2, 'repo-b': 1 });
  });
});
