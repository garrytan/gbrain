// Pins that synthesize_concepts resolves `models.dream.synthesize` for its
// narrative call instead of inheriting the gateway default.
//
// Regression: the chat() call passed no `model:`, so the routing advertised in
// the models table (models.dream.synthesize -> tier.reasoning) had no effect on
// this path and the phase silently ran on whatever models.chat happened to be.
//
// The failure is quiet, which is why it needs a pin rather than an assertion in
// some larger test: when the inherited model rejects the calls, each one throws,
// `narrative` falls back to deterministicNarrative(), and the phase still
// reports the same concept count. Nothing in the PhaseResult distinguishes a
// corpus of synthesized narratives from a corpus of template stubs.
//
// Hermetic: PGLite + injected `_atoms` and `_chat`. No provider credentials and
// no network.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
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

/**
 * Five atoms on one concept clears TIER_T2_MIN, which is the threshold that
 * routes a group through chat() rather than deterministicNarrative().
 */
function t2Atoms() {
  return Array.from({ length: 5 }, (_, i) => ({
    slug: `atoms/a${i}`,
    concept_refs: ['concepts/x'],
    body: `body ${i}`,
    title: `A${i}`,
  }));
}

/** Records the `model` field of every chat() call the phase makes. */
function capturingChat(seen: Array<string | undefined>): (o: ChatOpts) => Promise<ChatResult> {
  return async (o: ChatOpts) => {
    seen.push(o.model);
    const text = 'narrative text';
    return {
      text,
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: o.model ?? 'unset',
      providerId: 'test',
    };
  };
}

describe('synthesize_concepts task-model routing', () => {
  test('passes models.dream.synthesize to chat() when configured', async () => {
    await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');

    const seen: Array<string | undefined> = [];
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), _chat: capturingChat(seen) });

    expect(seen.length).toBeGreaterThan(0);
    for (const model of seen) {
      expect(model).toBe('anthropic:claude-sonnet-4-6');
    }
  });

  test('always sends an explicit model, so models.chat cannot leak in', async () => {
    // With no task key set the resolver falls through to tier/fallback. The
    // pin is that *something* explicit is sent: an absent `model` is what let
    // the gateway default silently take over.
    const seen: Array<string | undefined> = [];
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), _chat: capturingChat(seen) });

    expect(seen.length).toBeGreaterThan(0);
    for (const model of seen) {
      expect(model).toBeDefined();
      expect(model).not.toBe('');
    }
  });

  test('a task model set after the phase starts does not leak across runs', async () => {
    // Guards the resolve-once hoist above the group loop: the model is read
    // before iterating, so every group in a run shares one resolution.
    await engine.setConfig('models.dream.synthesize', 'anthropic:claude-haiku-4-5');
    const first: Array<string | undefined> = [];
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), _chat: capturingChat(first) });

    await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
    const second: Array<string | undefined> = [];
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), _chat: capturingChat(second) });

    expect(new Set(first)).toEqual(new Set(['anthropic:claude-haiku-4-5']));
    expect(new Set(second)).toEqual(new Set(['anthropic:claude-sonnet-4-6']));
  });
});
