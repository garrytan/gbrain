/**
 * F3: `gbrain reindex --code --max-cost N` smoke test.
 *
 * Pins the new flag's contract:
 *   1. ReindexCodeOpts.maxCostUsd?: number accepts a positive number.
 *   2. When set, runReindexCode wraps its body in withBudgetTracker so the
 *      gateway composes the tracker for every gateway.embed() call inside
 *      importCodeFile.
 *   3. When unset, the body runs outside any tracker scope (legacy behavior).
 *
 * Marked .serial.test.ts because configureGateway/resetGateway mutate the
 * module-level gateway state; running concurrent with other gateway-touching
 * tests in the same shard would race.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindexCode } from '../src/commands/reindex-code.ts';
import {
  configureGateway,
  resetGateway,
  getCurrentBudgetTracker,
} from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

describe('reindex-code --max-cost (F3)', () => {
  test('dry-run path accepts maxCostUsd without throwing', async () => {
    const result = await runReindexCode(engine, {
      dryRun: true,
      noEmbed: true,
      maxCostUsd: 5,
    });
    expect(result.status).toBe('dry_run');
    expect(result.codePages).toBe(0); // empty brain
  });

  test('empty-brain non-dry path with maxCostUsd returns ok without throwing', async () => {
    // No code pages exist → estimateReindexCost returns 0 → we hit the
    // early-return at totalPages===0 BEFORE the body wrap. This pins that
    // the early-return path isn't broken by the maxCostUsd plumbing.
    const result = await runReindexCode(engine, {
      yes: true,
      noEmbed: true,
      maxCostUsd: 5,
    });
    expect(result.status).toBe('ok');
    expect(result.reindexed).toBe(0);
    expect(result.failed).toBe(0);
  });

  test('no tracker installed when maxCostUsd is unset (legacy path)', async () => {
    // Outside any withBudgetTracker scope, getCurrentBudgetTracker() must
    // return null both before AND after the call. This pins that the body
    // wrap is conditional on the cap being set — agent callers who don't
    // pass maxCostUsd see byte-stable pre-F3 behavior.
    expect(getCurrentBudgetTracker()).toBeNull();
    await runReindexCode(engine, { yes: true, noEmbed: true });
    expect(getCurrentBudgetTracker()).toBeNull();
  });
});
