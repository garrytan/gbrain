/**
 * The extract_atoms state-store gate (`assertAtomStateStore`, cycle/extract-atoms.ts): an engine that keeps no
 * extract_atoms page or transcript state refuses after discovery and before the first model call, so a run that could
 * not record what it settles never spends the model. With no work the gate is not asked, and the phase reports
 * no_work. Every engine of this tree keeps the state (the Rust store from store format 17), so the gate passes on each;
 * this file pins what an engine that refuses it does.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';

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

const reply = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });

/** The engine with a store that keeps no extract_atoms state: the gate refuses as the Rust store's member does. */
function withoutStateStore(base: PGLiteEngine): { engine: PGLiteEngine; asked: () => number } {
  let asked = 0;
  const engine = new Proxy(base, {
    get(target, prop) {
      if (prop === 'assertAtomStateStore') {
        return async () => { asked++; throw capabilityMissing('raw_sql', 'assertAtomStateStore (the store keeps no extract_atoms page or transcript state)'); };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine, asked: () => asked };
}

const body = 'We met and decided many durable things. '.repeat(40);

test('with work, a store without extract_atoms state refuses by name and the model is never called', async () => {
  await engine.putPage('meetings/example', { type: 'meeting', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
  const { engine: gated, asked } = withoutStateStore(engine);
  let calls = 0;
  const run = runPhaseExtractAtoms(gated, { _transcripts: [], _chat: async () => { calls++; return reply('[]'); } });
  await expect(run).rejects.toMatchObject({ code: 'engine_capability_missing' });
  expect({ asked: asked(), calls }).toEqual({ asked: 1, calls: 0 });
});

test('a dry run with work refuses before the model too (a dry run calls the model)', async () => {
  await engine.putPage('meetings/example', { type: 'meeting', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
  const { engine: gated } = withoutStateStore(engine);
  let calls = 0;
  await expect(runPhaseExtractAtoms(gated, { dryRun: true, _transcripts: [], _chat: async () => { calls++; return reply('[]'); } }))
    .rejects.toMatchObject({ code: 'engine_capability_missing' });
  expect(calls).toBe(0);
});

test('with no work the gate is not asked and the phase reports no_work', async () => {
  const { engine: gated, asked } = withoutStateStore(engine);
  const result = await runPhaseExtractAtoms(gated, { _transcripts: [], _chat: async () => { throw new Error('no model call expected'); } });
  expect({ status: result.status, reason: (result.details as { reason?: string }).reason, asked: asked() }).toEqual({ status: 'skipped', reason: 'no_work', asked: 0 });
});

test('on an engine that keeps the state the gate passes and the model is called', async () => {
  await engine.putPage('meetings/example', { type: 'meeting', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
  await expect(engine.assertAtomStateStore()).resolves.toBeUndefined();
  let calls = 0;
  await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => { calls++; return reply('[]'); } });
  expect(calls).toBeGreaterThan(0);
});
