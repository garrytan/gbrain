/**
 * v0.35.4 — `gbrain eval trajectory` CLI (T6) tests.
 *
 * Pins:
 *   - argv parser: positional entity-slug required; --metric / --since /
 *     --until / --limit / --json honored; unknown flags rejected.
 *   - --json output has the stable schema_version: 1 envelope (R5).
 *   - Human format includes the regression marker for points that match.
 *   - Empty result graceful shape (G1).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runEvalTrajectory } from '../src/commands/eval-trajectory.ts';

let engine: PGLiteEngine;
let embeddingDim = 1536;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // initSchema sizes vector columns from the module-global AI gateway's
  // current dims. A neighboring test file in the same shard process that
  // configured the gateway (resetGateway() lands on the 1280d default)
  // changes the width THIS file's schema gets, and shard composition —
  // which reshuffles whenever any PR adds or removes a test file — decides
  // the neighbors. A hardcoded 1536 vector then fails unrelated PRs with
  // "expected 1280 dimensions, not 1536". Ask the live column instead
  // (same idiom as embedding-signature-stale.test.ts).
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'facts'::regclass AND attname = 'embedding' AND attnum > 0`,
  );
  if (Number(rows[0]?.dim) > 0) embeddingDim = Number(rows[0]?.dim);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts WHERE entity_slug LIKE 'cli-traj-%'`);
});

function unitVec(idx = 0): string {
  const a = new Float32Array(embeddingDim);
  a[idx % embeddingDim] = 1.0;
  return '[' + Array.from(a).join(',') + ']';
}

async function insertTyped(args: {
  entity_slug: string;
  metric: string;
  value: number;
  valid_from: Date;
  unit?: string;
}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from,
                        claim_metric, claim_value, claim_unit, claim_period,
                        visibility, embedding, embedded_at)
     VALUES ('default', $1, $2, 'fact', 'test', $3::timestamptz,
             $4, $5, $6, 'monthly',
             'private', $7::vector, $3::timestamptz)`,
    [args.entity_slug, `${args.metric} ${args.value}`, args.valid_from.toISOString(),
     args.metric, args.value, args.unit ?? 'USD', unitVec()],
  );
}

/** Capture console.log output to assert on. */
async function captureRun(args: string[]): Promise<{ out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  let out = '';
  let err = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
  try {
    await runEvalTrajectory(engine, args);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out, err };
}

describe('eval-trajectory CLI — arg parsing', () => {
  test('--help prints usage and returns without DB call', async () => {
    const { out } = await captureRun(['--help']);
    expect(out).toContain('Usage: gbrain eval trajectory');
    expect(out).toContain('--metric');
  });

  test('missing positional arg surfaces an error + non-zero exit', async () => {
    // process.exit throws inside Bun test runner; capture via try/catch.
    let exitCode: number | undefined;
    const origExit = process.exit;
    (process as any).exit = (code?: number) => {
      exitCode = code;
      throw new Error('__exit_intercept__');
    };
    try {
      await captureRun([]);
    } catch (e: any) {
      if (!String(e).includes('__exit_intercept__')) throw e;
    } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });
});

describe('eval-trajectory CLI — JSON envelope (R5)', () => {
  test('--json output has schema_version: 1 and points + regressions + drift_score keys', async () => {
    await insertTyped({ entity_slug: 'cli-traj-shape', metric: 'mrr', value: 50000, valid_from: new Date('2026-01-15') });
    const { out } = await captureRun(['cli-traj-shape', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed.schema_version).toBe(1);
    expect(parsed).toHaveProperty('points');
    expect(parsed).toHaveProperty('regressions');
    expect(parsed).toHaveProperty('drift_score');
    // Engine's raw embedding is NOT in the CLI JSON output.
    expect(parsed.points[0]).not.toHaveProperty('embedding');
    expect(parsed.points[0].valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('--json empty-entity output is the same shape (G1)', async () => {
    const { out } = await captureRun(['cli-traj-nonexistent', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed.points).toEqual([]);
    expect(parsed.regressions).toEqual([]);
    expect(parsed.drift_score).toBeNull();
    expect(parsed.schema_version).toBe(1);
  });
});

describe('eval-trajectory CLI — regression annotation in human output', () => {
  test('regression line is marked with [REGRESSION ↓XX.X%] in human format', async () => {
    await insertTyped({ entity_slug: 'cli-traj-reg', metric: 'mrr', value: 200000, valid_from: new Date('2026-04-12') });
    await insertTyped({ entity_slug: 'cli-traj-reg', metric: 'mrr', value: 150000, valid_from: new Date('2026-07-08') });

    const { out } = await captureRun(['cli-traj-reg']);
    expect(out).toContain('Entity: cli-traj-reg');
    expect(out).toContain('mrr');
    expect(out).toContain('REGRESSION');
    expect(out).toContain('25.0%');
  });

  test('empty entity produces the friendly no-claims message', async () => {
    const { out } = await captureRun(['cli-traj-nothing']);
    expect(out).toContain('Entity: cli-traj-nothing');
    expect(out).toContain('(no typed claims');
  });
});

describe('eval-trajectory CLI — metric filter narrows results', () => {
  test('--metric arr returns only ARR points', async () => {
    await insertTyped({ entity_slug: 'cli-traj-flt', metric: 'mrr', value:  50000, valid_from: new Date('2026-01-15') });
    await insertTyped({ entity_slug: 'cli-traj-flt', metric: 'arr', value: 600000, valid_from: new Date('2026-01-15') });

    const { out } = await captureRun(['cli-traj-flt', '--metric', 'arr', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed.points.length).toBe(1);
    expect(parsed.points[0].metric).toBe('arr');
  });
});
