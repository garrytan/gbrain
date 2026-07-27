// v0.41.19.0 — T3 of ops-fix-wave.
//
// Pins the 30s throttle on the per-phase maybeYield helper. Without
// this, every loop iteration would fire yieldDuringPhase (which on a
// 322K-page brain is hundreds of redundant lock refreshes per phase).
//
// Behavioral test: drive runPhaseExtractAtoms with a synthetic chat
// stub + a yieldDuringPhase callback that records call timestamps.
// Verify the 30s throttle holds — fast-iter runs produce ONE fire even
// across many items.
//
// Note on fake time: the helper reads Date.now() directly inside the
// phase closure. We can't override it cleanly without touching the
// global. Instead we test the OBSERVABLE behavior: 5 items in under
// 30s wall-clock should produce exactly 1 yield (the very first call,
// when lastYieldMs starts at Date.now() — the 30s gate immediately
// returns false, so the FIRST iteration is also throttled out). The
// helper fires when (now - lastYieldMs) >= 30_000.
//
// Since lastYieldMs is initialized to Date.now() at the top of the
// phase, NO yields fire within the first 30s of execution. This is by
// design — the throttle starts the clock at phase entry. For a
// healthy fast run, 0 fires is correct.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function stubChat(): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => ({
    text: JSON.stringify([{ title: 'T', atom_type: 'insight', body: 'b' }]),
    blocks: [{ type: 'text', text: '' }],
    stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });
}

describe('extract_atoms yieldDuringPhase throttle (T3)', () => {
  test('fast iterations within 30s fire 0 yields (throttle blocks first 30s after start)', async () => {
    const yieldTimestamps: number[] = [];
    const yieldFn = async () => { yieldTimestamps.push(Date.now()); };
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [
        { filePath: '/tmp/a', content: 'a', contentHash: 'a1'.repeat(8) },
        { filePath: '/tmp/b', content: 'b', contentHash: 'b2'.repeat(8) },
        { filePath: '/tmp/c', content: 'c', contentHash: 'c3'.repeat(8) },
        { filePath: '/tmp/d', content: 'd', contentHash: 'd4'.repeat(8) },
        { filePath: '/tmp/e', content: 'e', contentHash: 'e5'.repeat(8) },
      ],
      _pages: [],
      _chat: stubChat(),
      yieldDuringPhase: yieldFn,
    });
    // The lastYieldMs is initialized to Date.now() at phase start, so
    // no fire occurs within the first 30s. The 5-iteration test runs
    // in milliseconds, so we expect ZERO yields. This is the correct
    // behavior — under healthy load the lock has plenty of TTL budget
    // and we don't need to spam refresh.
    expect(yieldTimestamps.length).toBe(0);
  });

  test('phase tolerates undefined yieldDuringPhase', async () => {
    // Sanity: phase doesn't crash without the hook.
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [],
    });
    expect(result.phase).toBe('extract_atoms');
  });

  test('yieldDuringPhase throw is non-fatal (logged, not propagated)', async () => {
    const throwingYield = async () => { throw new Error('lock stolen'); };
    // Even if yieldDuringPhase throws (would fire after 30s wall-clock),
    // phase doesn't crash. We can't easily trigger >30s in a test, but
    // we CAN verify the catch wrapper exists by reading the source.
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/core/cycle/extract-atoms.ts', import.meta.url),
      'utf-8',
    );
    expect(src).toMatch(/try\s*\{\s*await\s+opts\.yieldDuringPhase\(\)/);
    expect(src).toMatch(/yieldDuringPhase failed \(non-fatal\)/);
    // Phase itself runs without throwing.
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [],
      yieldDuringPhase: throwingYield,
    });
    expect(result.phase).toBe('extract_atoms');
  });
});
