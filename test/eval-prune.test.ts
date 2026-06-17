/**
 * gbrain eval prune — retention cleanup (v0.21.0).
 *
 * Verifies:
 *   - --older-than parses duration strings (30d, 1h, 90m, 3600s)
 *   - deletes only rows older than the cutoff
 *   - --dry-run reports count without deleting
 *   - missing --older-than exits with error
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runEvalPrune } from '../src/commands/eval-prune.ts';
import type { EvalCandidateInput } from '../src/core/types.ts';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.exec('DELETE FROM eval_candidates');
});

function baseInput(): EvalCandidateInput {
  return {
    tool_name: 'query',
    query: 'q',
    retrieved_slugs: [],
    retrieved_chunk_ids: [],
    source_ids: [],
    expand_enabled: true,
    detail: null,
    detail_resolved: null,
    vector_enabled: false,
    expansion_applied: false,
    latency_ms: 50,
    remote: false,
    job_id: null,
    subagent_id: null,
  };
}

/** Insert a row with an explicit created_at timestamp (for "aged" data). */
async function insertAged(daysAgo: number): Promise<void> {
  const when = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `INSERT INTO eval_candidates (
       tool_name, query, retrieved_slugs, retrieved_chunk_ids, source_ids,
       expand_enabled, detail, detail_resolved, vector_enabled, expansion_applied,
       latency_ms, remote, job_id, subagent_id, created_at
     ) VALUES ('query', 'q', '{}', '{}', '{}',
       true, null, null, false, false, 50, false, null, null, $1)`,
    [when],
  );
}

async function withSilencedStdout<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = orig;
  }
}

describe('gbrain eval prune', () => {
  test('--older-than 30d deletes rows older than 30 days, keeps recent', async () => {
    await insertAged(60); // old
    await insertAged(45); // old
    await insertAged(10); // kept
    await engine.logEvalCandidate(baseInput()); // just now, kept

    expect(await engine.listEvalCandidates()).toHaveLength(4);
    await withSilencedStdout(() => runEvalPrune(engine, ['--older-than', '30d']));

    const remaining = await engine.listEvalCandidates();
    expect(remaining).toHaveLength(2);
  });

  test('--dry-run does not delete anything', async () => {
    await insertAged(60);
    await insertAged(45);
    await withSilencedStdout(() => runEvalPrune(engine, ['--older-than', '30d', '--dry-run']));
    expect(await engine.listEvalCandidates()).toHaveLength(2);
  });

  test('accepts multiple duration units', async () => {
    // Each of these runs should succeed without error.
    for (const dur of ['1h', '90m', '3600s', '7d']) {
      await withSilencedStdout(() => runEvalPrune(engine, ['--older-than', dur]));
    }
  });

  test('missing --older-than exits 1', async () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.exit as any) = (code?: number) => {
      exitCode = code;
      throw new Error('exit');
    };
    try {
      await runEvalPrune(engine, []);
    } catch { /* expected */ }
    process.exit = originalExit;
    expect(exitCode).toBe(1);
  });

  test('invalid --older-than value exits 1', async () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.exit as any) = (code?: number) => {
      exitCode = code;
      throw new Error('exit');
    };
    try {
      await runEvalPrune(engine, ['--older-than', 'foo']);
    } catch { /* expected */ }
    process.exit = originalExit;
    expect(exitCode).toBe(1);
  });
});
