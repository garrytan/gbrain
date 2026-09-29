/**
 * #5092: a long single-process LongMemEval run stalled at 100% CPU after
 * ~90-120 questions. TRUNCATE between questions never returns PGLite's WASM
 * memory, which grows with each question's vectors (≈30 MB per 500-chunk
 * question). A harness-owned brain is now replaced on a fixed cadence, with
 * the run's config pins re-applied to each fresh brain.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runEvalLongMemEval, LME_BRAIN_RECYCLE_EVERY } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');
const ARGS = (out: string) => [FIXTURE_PATH, '--keyword-only', '--retrieval-only', '--no-trajectory', '--output', out, '--mode', 'tokenmax'];

function rows(path: string) {
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => typeof r.question_id === 'string');
}

describe('LongMemEval benchmark brain recycling (#5092)', () => {
  test('a harness-owned brain is replaced every N questions, config re-applied, results unchanged', async () => {
    expect(LME_BRAIN_RECYCLE_EVERY).toBeGreaterThan(0);
    const tmp = mkdtempSync(join(tmpdir(), 'lme-recycle-'));
    const brains: PGLiteEngine[] = [];
    const modes: Array<string | null> = [];
    try {
      await runEvalLongMemEval(ARGS(join(tmp, 'recycled.jsonl')), {
        exitOnError: false,
        brainRecycleEvery: 2,
        createBrain: async () => {
          const b = await createBenchmarkBrain();
          const setConfig = b.setConfig.bind(b);
          b.setConfig = async (k: string, v: string) => { if (k === 'search.mode') modes.push(v); return setConfig(k, v); };
          brains.push(b);
          return b;
        },
      });
      const shared = await createBenchmarkBrain();
      try {
        await runEvalLongMemEval(ARGS(join(tmp, 'single.jsonl')), { exitOnError: false, engine: shared });
      } finally {
        await shared.disconnect();
      }
      const recycled = rows(join(tmp, 'recycled.jsonl'));
      const single = rows(join(tmp, 'single.jsonl'));
      expect(recycled.length).toBe(single.length);
      expect(brains.length).toBe(Math.ceil(recycled.length / 2));
      expect(modes).toEqual(brains.map(() => 'tokenmax'));
      expect(recycled.map((r) => [r.question_id, r.recall_all_hit, r.error ?? null]))
        .toEqual(single.map((r) => [r.question_id, r.recall_all_hit, r.error ?? null]));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
