// `gbrain dream --drain --window` checked the window only BETWEEN batches.
// One batch is up to the page-discovery budget (50 by default) plus every
// live transcript, each an LLM call, so a 120s window could run for many
// minutes — past a Minion job timeout, which kills the job before the drain
// returns its structured result. The window is now a cooperative checkpoint
// before each work item: completed items keep their atoms, unstarted items
// are deferred (left untouched, still due) and reported separately.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from '../helpers/extract-atoms-page-fixtures.ts';
import { countExtractAtomsBacklog } from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { assertTransientCutScenario, assertTranscriptDeferralScenario, assertWindowCheckpointScenario } from '../helpers/extract-atoms-window-scenario.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';

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

function zeroYieldChat(counter: { calls: number }) {
  return async (): Promise<ChatResult> => {
    counter.calls++;
    return {
      text: '[]',
      blocks: [{ type: 'text', text: '[]' }],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5',
      providerId: 'anthropic',
    };
  };
}

const page = (n: number) => ({
  slug: `meetings/checkpoint-example-${n}`,
  content: `Synthetic checkpoint evidence ${n}. `.repeat(40),
  contentHash: `${n}`.repeat(64).slice(0, 64),
});

describe('extract_atoms stop checkpoint (phase level)', () => {
  test('shouldStop defers every unstarted item and leaves it due', async () => {
    const counter = { calls: 0 };
    const r = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [
        { filePath: '/tmp/checkpoint-t1.txt', content: 'Synthetic transcript. '.repeat(40), contentHash: 'c1'.repeat(32) },
      ],
      _pages: [page(1), page(2), page(3)],
      _chat: zeroYieldChat(counter),
      // Stop once one item has been attempted.
      shouldStop: () => counter.calls >= 1,
    });
    const d = r.details as Record<string, unknown>;
    expect(counter.calls).toBe(1);
    expect(d.pages_processed).toBe(1);
    // Work order is page-first interleave: p1, t1, p2, p3 → t1 + p2 + p3 deferred.
    expect(d.pages_deferred).toBe(2);
    expect(d.transcripts_deferred).toBe(1);
    // Deferred is not budget-skipped and not a failure.
    expect(d.pages_skipped_budget).toBe(0);
    expect(d.failures).toEqual([]);
    expect(r.status).toBe('ok');
    expect(r.summary).toContain('3 deferred at stop checkpoint');
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(2);
  });

  test('no shouldStop keeps the pre-existing run-to-completion behavior', async () => {
    const counter = { calls: 0 };
    const r = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [page(4), page(5)],
      _chat: zeroYieldChat(counter),
    });
    const d = r.details as Record<string, unknown>;
    expect(counter.calls).toBe(2);
    expect(d.pages_processed).toBe(2);
    expect(d.pages_deferred).toBe(0);
    expect(d.transcripts_deferred).toBe(0);
  });
});

describe('dream --drain --window enforced inside a batch (PGLite)', () => {
  test('stops between items, keeps persisted atoms, defers the rest', async () => {
    await assertWindowCheckpointScenario(engine);
  });

  test('deferred transcripts stay due and the follow-up drain processes them', async () => {
    await assertTranscriptDeferralScenario(engine);
  });

  test('a window cut after one transient failure is deferral; an uncut all-failed batch is an outage', async () => {
    await assertTransientCutScenario(engine);
  });
});
