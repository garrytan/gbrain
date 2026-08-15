// v0.41.19.0 — T4 of ops-fix-wave.
//
// Pins that synthesize_concepts wires its progress reporter inside the
// concept-group loop (one tick per concept written). Cycle.ts owns
// start/finish; phase only ticks.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ProgressReporter } from '../../src/core/progress.ts';
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

function makeMockReporter(): {
  reporter: ProgressReporter;
  events: Array<{ kind: 'tick' | 'heartbeat' | 'start' | 'finish'; note?: string }>;
} {
  const events: Array<{ kind: 'tick' | 'heartbeat' | 'start' | 'finish'; note?: string }> = [];
  const reporter: ProgressReporter = {
    start: () => { events.push({ kind: 'start' }); },
    tick: (_n, note) => { events.push({ kind: 'tick', note }); },
    heartbeat: (note) => { events.push({ kind: 'heartbeat', note }); },
    finish: (note) => { events.push({ kind: 'finish', note }); },
    child: () => reporter,
  };
  return { reporter, events };
}

function stubChat(text: string): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => ({
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  });
}

describe('synthesize_concepts progress wiring (T4)', () => {
  test('phase does NOT call start or finish', async () => {
    const { reporter, events } = makeMockReporter();
    await runPhaseSynthesizeConcepts(engine, {
      _atoms: [
        // T3 tier (2 atoms): no LLM, deterministic narrative
        { slug: 'atoms/a1', concept_refs: ['concepts/x'], body: 'b1', title: 'A1' },
        { slug: 'atoms/a2', concept_refs: ['concepts/x'], body: 'b2', title: 'A2' },
      ],
      _chat: stubChat('narrative text'),
      progress: reporter,
    });
    expect(events.filter(e => e.kind === 'start').length).toBe(0);
    expect(events.filter(e => e.kind === 'finish').length).toBe(0);
  });

  test('one tick per concept group written', async () => {
    const { reporter, events } = makeMockReporter();
    await runPhaseSynthesizeConcepts(engine, {
      _atoms: [
        { slug: 'atoms/a1', concept_refs: ['concepts/x'], body: 'b1', title: 'A1' },
        { slug: 'atoms/a2', concept_refs: ['concepts/x'], body: 'b2', title: 'A2' },
        { slug: 'atoms/a3', concept_refs: ['concepts/y'], body: 'b3', title: 'A3' },
        { slug: 'atoms/a4', concept_refs: ['concepts/y'], body: 'b4', title: 'A4' },
      ],
      _chat: stubChat('narrative text'),
      progress: reporter,
    });
    const ticks = events.filter(e => e.kind === 'tick');
    // Two concept groups, each ≥2 atoms → both qualify for synthesis
    expect(ticks.length).toBe(2);
    expect(ticks[0].note).toMatch(/concepts/);
  });

  test('no progress wiring required — opts.progress is optional', async () => {
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: [],
    });
    expect(result.phase).toBe('synthesize_concepts');
  });
});
