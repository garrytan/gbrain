/**
 * gbrain rules approve/retire write through a local context. It must wait for the commit like every other
 * owner CLI write (30 s default, GBRAIN_WRITE_WAIT_MS), not the 5 s agent wait, so a write that commits shortly
 * after is not printed as a pending Error.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { localRulesCtx } from '../src/core/rules/correct.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

describe('rules local write context', () => {
  test('carries the CLI write wait', async () => {
    await withEnv({ GBRAIN_WRITE_WAIT_MS: '12345' }, async () => {
      expect(localRulesCtx(engine).writeWaitMs).toBe(12345);
    });
  });
});
