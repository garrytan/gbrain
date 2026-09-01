/**
 * #4561 — think's evidence gather must pin `autocut: false` on BOTH
 * hybridSearch legs (plain + temporal-window), the same way it pins
 * `expansion: false`. Autocut is default-ON in balanced/tokenmax and cuts
 * BEFORE the limit slice, so a breadth-sized gather (default 40) could
 * collapse to minKeep=1 and starve synthesis. Same breadth rationale as the
 * CRAG escalation re-run in src/core/ops/search.ts.
 *
 * Serial: mock.module (isolation guard R2).
 */

import { describe, expect, mock, test } from 'bun:test';
import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const captured: Array<Record<string, unknown>> = [];

// Mock BEFORE importing gather (gather.ts binds hybridSearch at import time;
// the spread keeps every other export live).
mock.module('../src/core/search/hybrid.ts', () => ({
  ...realHybrid,
  hybridSearch: async (
    _engine: unknown,
    _query: string,
    opts: Record<string, unknown>,
  ) => {
    captured.push(opts);
    return [];
  },
}));

const { runGather } = await import('../src/core/think/gather.ts');

const engineStub = {
  searchTakes: async () => [],
  listPages: async () => [],
} as unknown as BrainEngine;

describe('think gather pins per-call search knobs (#4561)', () => {
  test('plain leg passes autocut:false alongside expansion:false', async () => {
    captured.length = 0;
    await runGather(engineStub, { question: 'what changed in the payments migration' });
    expect(captured.length).toBe(1);
    expect(captured[0].expansion).toBe(false);
    // Pre-fix: autocut was absent → resolved from the search mode
    // (default-ON in balanced/tokenmax) and could trim 40 gathered pages
    // down to minKeep before the synth prompt ever saw them.
    expect(captured[0].autocut).toBe(false);
  });

  test('temporal-window leg passes autocut:false alongside expansion:false', async () => {
    captured.length = 0;
    await runGather(engineStub, {
      question: 'what changed last week',
      window: { startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2026, 0, 8) },
    });
    expect(captured.length).toBe(1);
    expect(captured[0].expansion).toBe(false);
    expect(captured[0].autocut).toBe(false);
  });
});
