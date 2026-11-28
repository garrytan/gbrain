/**
 * GST-4069 (RT3, OV3): which source `gbrain access serves several` labels when --source is empty or GBRAIN_SOURCE spans
 * every source.
 *
 * 1. Protects: an explicit empty --source is refused, never read as "no --source" (which labels GBRAIN_SOURCE, then
 *    sources.default); GBRAIN_SOURCE=__all__ without --source is refused with a message that names --source.
 * 2. Fails when: an empty --source labels a source, or the __all__ refusal does not say how to name one.
 * 3. Existing coverage: setup-serves-gst4043.test.ts (GBRAIN_SOURCE and sources.default).
 * 4. No production seam: runAccessServes on an in-memory PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runAccessServes } from '../src/commands/access-serves.ts';
import { withEnv } from './helpers/with-env.ts';
import { memoryBrain } from './helpers/setup-serves-box.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = await memoryBrain(); });
afterAll(async () => { await engine.disconnect(); });

const flagValue = (args: string[], name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const serves = (args: string[]) => runAccessServes(engine, 'several', ['several', '--members', 'alice-example', ...args], true, flagValue);

describe('access serves several: an empty --source and GBRAIN_SOURCE=__all__', () => {
  test('an explicit empty --source is refused instead of read as absent', async () => {
    await expect(withEnv({ GBRAIN_SOURCE: undefined }, () => serves(['--source', '']))).rejects.toThrow('--source is empty');
  });

  test('GBRAIN_SOURCE=__all__ without --source is refused, naming --source', async () => {
    await expect(withEnv({ GBRAIN_SOURCE: '__all__' }, () => serves([]))).rejects.toThrow(/__all__ spans every source/);
    await expect(withEnv({ GBRAIN_SOURCE: '__all__' }, () => serves([]))).rejects.toMatchObject({ suggestion: expect.stringContaining('--source <id>') });
  });
});
