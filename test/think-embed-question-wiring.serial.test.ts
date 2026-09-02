/**
 * #3734 — embedQuestion wiring at the remaining runThink call sites.
 *
 * runThink's takes retrieval has a vector arm that only activates when the
 * caller passes `embedQuestion`. commands/think.ts, cycle/auto-think.ts, and
 * ops/takes.ts wire it; the synthesize verb (core/verbs.ts) and the CRAG
 * think escalation (core/ops/search.ts) did not, so their takes_vec arm
 * silently returned 0 rows on every call.
 *
 * Serial (*.serial.test.ts): uses mock.module, which leaks across files in a
 * shared bun process (TESTING.md R2).
 */

import { describe, expect, test, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as realThink from '../src/core/think/index.ts';
import * as realEmbedding from '../src/core/embedding.ts';

const embedQueryCalls: string[] = [];
let capturedOpts: Record<string, unknown> | null = null;

mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embedQuery: async (q: string) => {
    embedQueryCalls.push(q);
    return new Float32Array([0.1, 0.2, 0.3]);
  },
}));

mock.module('../src/core/think/index.ts', () => ({
  ...realThink,
  runThink: async (_engine: unknown, opts: Record<string, unknown>) => {
    capturedOpts = opts;
    return {
      answer: 'stub answer',
      citations: [],
      gaps: [],
      warnings: [],
      modelUsed: 'anthropic:claude-opus-4-7',
      pagesGathered: 0,
      takesGathered: 0,
      synthesis_status: 'ok',
      usage: null,
    };
  },
}));

describe('#3734 — synthesize verb wires embedQuestion into runThink', () => {
  test('runThink receives a live embedQuestion callback that routes to embedQuery', async () => {
    const { operationsByName } = await import('../src/core/operations.ts');
    const synthesize = operationsByName['synthesize'];
    expect(synthesize).toBeDefined();

    capturedOpts = null;
    embedQueryCalls.length = 0;
    const ctx = { engine: {} as never, remote: false as const };
    await synthesize.handler(ctx as never, { question: 'what changed last week?' });

    expect(capturedOpts).not.toBeNull();
    // TS control-flow narrows the module-level `capturedOpts` to null here
    // (the assignment happens inside the mocked runThink, invisible to CFA).
    const embedQuestion = (capturedOpts as unknown as Record<string, unknown>).embedQuestion;
    // Pre-fix: undefined — the takes vector arm silently never activated.
    expect(typeof embedQuestion).toBe('function');

    const vec = await (embedQuestion as (q: string) => Promise<Float32Array | null>)('probe question');
    expect(embedQueryCalls).toEqual(['probe question']);
    expect(vec).toBeInstanceOf(Float32Array);
  });
});

describe('#3734 — CRAG think escalation wires embedQuestion (source pin)', () => {
  // The query op's CRAG escalation site is unreachable without a full engine
  // + weak search result + `search.crag_escalate_think` config, so pin the
  // wiring in source text: the runThink call inside ops/search.ts must pass
  // embedQuestion (same cheap-pin pattern as the repo's other residual
  // source-text guards).
  test('ops/search.ts CRAG runThink call passes embedQuestion', () => {
    // test-reads-source-ok: the CRAG escalation runThink site is unreachable hermetically (needs a full engine, a weak search result, and search.crag_escalate_think), so the #3734 wiring pin reads the call site itself.
    const src = readFileSync(join(import.meta.dir, '../src/core/ops/search.ts'), 'utf8');
    const callSite = src.slice(src.indexOf('escalate_to_think = true'));
    const runThinkBlock = callSite.slice(callSite.indexOf('runThink(ctx.engine'), callSite.indexOf('});'));
    expect(runThinkBlock).toContain('embedQuestion');
  });
});
