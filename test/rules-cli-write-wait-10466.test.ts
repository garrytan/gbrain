/**
 * #10466: `gbrain rules approve` and `gbrain rules retire` save through a local context. Like every other owner CLI
 * write they wait for the commit for the CLI write wait (30 s default, GBRAIN_WRITE_WAIT_MS, --wait), not the 5 s agent
 * default, so a retire that commits a few seconds later prints its success line instead of Error [write_pending].
 * The shared local context that the MCP `correct` resume path also uses keeps the context default.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import * as correct from '../src/core/rules/correct.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine?.disconnect(); });

const SOURCE = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'rules', 'correct.ts'), 'utf8');
const body = (start: string) => {
  const at = SOURCE.indexOf(start);
  expect(at).toBeGreaterThan(-1);
  const next = SOURCE.indexOf('\nexport ', at + start.length);
  const nextLocal = SOURCE.indexOf('\nasync function ', at + start.length);
  return SOURCE.slice(at, Math.min(...[next, nextLocal].filter(i => i > -1)));
};

describe('rules approve/retire write wait (#10466)', () => {
  test('the owner CLI rules context carries the CLI write wait', async () => {
    const ownerCliRulesCtx = (correct as Record<string, unknown>).ownerCliRulesCtx as typeof correct.localRulesCtx | undefined;
    expect(typeof ownerCliRulesCtx).toBe('function');
    await withEnv({ GBRAIN_WRITE_WAIT_MS: '12345' }, async () => {
      expect(ownerCliRulesCtx!(engine, 'source-a')).toMatchObject({ writeWaitMs: 12345, sourceId: 'source-a', remote: false });
      expect(correct.localRulesCtx(engine).writeWaitMs).toBeUndefined();
    });
  });

  test('approve and retire save through it', () => {
    expect(body('export async function approveRule(')).toContain('ownerCliRulesCtx(engine, sourceId)');
    expect(body('async function retireHeld(')).toContain('ownerCliRulesCtx(engine, sourceId)');
  });
});
