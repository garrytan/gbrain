// v0.41.19.0 — T4 of ops-fix-wave.
//
// Pins that extract_atoms wires its progress reporter inside the work
// loop (one tick per processed item) and emits a heartbeat before the
// batch idempotency check. Codex caught that cycle.ts must NOT pass a
// child reporter — phases receive the SAME reporter and only call tick
// / heartbeat (cycle.ts owns start / finish).

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
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
  events: Array<{ kind: 'start' | 'tick' | 'heartbeat' | 'finish' | 'child'; phase?: string; note?: string; n?: number }>;
} {
  const events: Array<{ kind: 'start' | 'tick' | 'heartbeat' | 'finish' | 'child'; phase?: string; note?: string; n?: number }> = [];
  const reporter: ProgressReporter = {
    start: (phase, _total) => { events.push({ kind: 'start', phase }); },
    tick: (n, note) => { events.push({ kind: 'tick', n, note }); },
    heartbeat: (note) => { events.push({ kind: 'heartbeat', note }); },
    finish: (note) => { events.push({ kind: 'finish', note }); },
    child: (phase) => {
      events.push({ kind: 'child', phase });
      return reporter; // return self for simplicity
    },
  };
  return { reporter, events };
}

function stubChat(text: string): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => ({
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });
}

describe('extract_atoms progress wiring (T4)', () => {
  test('phase does NOT call start or finish — cycle.ts owns those', async () => {
    const { reporter, events } = makeMockReporter();
    const validAtomJson = JSON.stringify([
      { title: 'A', atom_type: 'insight', body: 'body a' },
    ]);
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [
        { filePath: '/tmp/t1.txt', content: 'transcript 1 body', contentHash: 'h1'.repeat(8) },
      ],
      _pages: [],
      _chat: stubChat(validAtomJson),
      progress: reporter,
    });
    const startEvents = events.filter(e => e.kind === 'start');
    const finishEvents = events.filter(e => e.kind === 'finish');
    expect(startEvents.length).toBe(0);
    expect(finishEvents.length).toBe(0);
  });

  test('emits a heartbeat before the batch idempotency check', async () => {
    const { reporter, events } = makeMockReporter();
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [
        { filePath: '/tmp/t1.txt', content: 'transcript', contentHash: 'h1'.repeat(8) },
      ],
      _pages: [],
      _chat: stubChat('[]'),
      progress: reporter,
    });
    const heartbeats = events.filter(e => e.kind === 'heartbeat');
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    // Note mentions the count
    expect(heartbeats[0].note).toMatch(/checking existing atoms/);
  });

  test('one tick per processed work item with running count note', async () => {
    const { reporter, events } = makeMockReporter();
    const validAtomJson = JSON.stringify([
      { title: 'A', atom_type: 'insight', body: 'body a' },
    ]);
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [
        { filePath: '/tmp/t1.txt', content: 'a', contentHash: 'h1'.repeat(8) },
        { filePath: '/tmp/t2.txt', content: 'b', contentHash: 'h2'.repeat(8) },
        { filePath: '/tmp/t3.txt', content: 'c', contentHash: 'h3'.repeat(8) },
      ],
      _pages: [],
      _chat: stubChat(validAtomJson),
      progress: reporter,
    });
    const ticks = events.filter(e => e.kind === 'tick');
    expect(ticks.length).toBe(3);
    expect(ticks[0].note).toMatch(/atoms.*skipped/);
  });

  test('no progress wiring required — opts.progress is optional', async () => {
    // Sanity: phase works without a reporter.
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [],
    });
    expect(result.phase).toBe('extract_atoms');
  });
});
