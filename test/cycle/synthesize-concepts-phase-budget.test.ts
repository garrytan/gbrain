// Pins the wall-clock bound on synthesize_concepts.
//
// The bug this guards: the phase's only bound was a dollar budget, which does
// not bound a locally-served model by wall clock. The per-group loop ran past
// the minion job timeout; the worker evicts the job but cannot kill the
// handler, so it kept running orphaned while the cycle never recorded
// completion. These tests assert the bound that holds regardless of pricing.

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

/** A locally-served model: answers fine, has NO canonical price. */
function localChat(delayMs = 0): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return {
      text: 'narrative text',
      blocks: [{ type: 'text', text: 'narrative text' }],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'llama-server:local-model',
      providerId: 'llama-server',
    };
  };
}

/** N T1-tier groups (10 atoms each) → every one takes the LLM path. */
function atomsForGroups(n: number) {
  const atoms = [];
  for (let g = 0; g < n; g++) {
    for (let i = 0; i < 10; i++) {
      atoms.push({
        slug: `atoms/g${g}-a${i}`,
        concept_refs: [`concepts/c${g}`],
        body: `body ${g}-${i}`,
        title: `A${g}-${i}`,
      });
    }
  }
  return atoms;
}

describe('synthesize_concepts wall-clock bound', () => {
  test('a free local model does NOT make the loop unbounded', async () => {
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(20),
      _chat: localChat(20),      // 20 groups x 20ms = 400ms of work available
      phaseBudgetMs: 100,        // ...against a 100ms budget
    });

    const d = result.details as Record<string, unknown>;
    expect(d.partial).toBe(true);
    expect(d.phase_budget_ms).toBe(100);
    expect(d.groups_skipped as number).toBeGreaterThan(0);
    expect(d.concepts_written as number).toBeLessThan(20);
    expect((d.concepts_written as number) + (d.groups_skipped as number)).toBe(20);
    expect(result.summary).toMatch(/PARTIAL/);
  }, 30000);

  test('returns cleanly instead of running past the deadline', async () => {
    const started = Date.now();
    await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(40),
      _chat: localChat(25),      // 1000ms of work
      phaseBudgetMs: 150,
    });
    // Generous ceiling: what matters is that it bounded at all, not the slack.
    expect(Date.now() - started).toBeLessThan(700);
  }, 30000);

  test('an aborted job stops the loop — the orphaned-handler case', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(10),
      _chat: async (o) => { calls++; return localChat()(o); },
      signal: ac.signal,
    });
    const d = result.details as Record<string, unknown>;
    expect(calls).toBe(0);
    expect(d.concepts_written).toBe(0);
    expect(d.groups_skipped).toBe(10);
  }, 30000);

  test('abort during chat reaches the provider and publishes no concept', async () => {
    const ac = new AbortController();
    let received: AbortSignal | undefined;
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(1), signal: ac.signal,
      _chat: async (o) => {
        received = o.abortSignal;
        await new Promise((r) => setTimeout(r, 20));
        ac.abort();
        return localChat()(o);
      },
    });
    const d = result.details as Record<string, unknown>;
    expect(received?.aborted).toBe(true);
    expect(d.concepts_written).toBe(0);
    expect(d.groups_skipped).toBe(1);
    expect((await engine.getPage('concepts/c0'))).toBeNull();
  }, 30000);

  test('deadline during delayed chat aborts the call and publishes no concept', async () => {
    let received: AbortSignal | undefined;
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(1), phaseBudgetMs: 30,
      _chat: async (o) => {
        received = o.abortSignal;
        await new Promise((r) => setTimeout(r, 80));
        return localChat()(o);
      },
    });
    expect(received?.aborted).toBe(true);
    expect((result.details as Record<string, unknown>).concepts_written).toBe(0);
    expect((await engine.getPage('concepts/c0'))).toBeNull();
  }, 30000);

  test('a provider that throws on cancellation records no LLM failure', async () => {
    const ac = new AbortController();
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(1), signal: ac.signal,
      _chat: async () => { ac.abort(); throw new Error('The operation was aborted.'); },
    });
    const d = result.details as Record<string, unknown>;
    expect(d.failures).toEqual([]);
    expect(d.concepts_written).toBe(0);
    expect(d.groups_skipped).toBe(1);
    expect((await engine.getPage('concepts/c0'))).toBeNull();
  }, 30000);

  test('abort during the pre-publication lookup publishes no concept', async () => {
    const ac = new AbortController();
    const originalGetPage = engine.getPage.bind(engine);
    let lookupReached = false;
    engine.getPage = (async (...args: Parameters<typeof engine.getPage>) => {
      if (args[0] === 'concepts/c0' && !lookupReached) {
        lookupReached = true;
        ac.abort();
        return null;
      }
      return originalGetPage(...args);
    }) as typeof engine.getPage;
    try {
      const result = await runPhaseSynthesizeConcepts(engine, {
        _atoms: atomsForGroups(1), signal: ac.signal, _chat: localChat(),
      });
      expect(lookupReached).toBe(true);
      expect((result.details as Record<string, unknown>).concepts_written).toBe(0);
      expect((result.details as Record<string, unknown>).partial).toBe(true);
      expect((result.details as Record<string, unknown>).groups_skipped).toBe(1);
    } finally {
      delete (engine as any).getPage;
    }
    expect(await engine.getPage('concepts/c0')).toBeNull();
  }, 30000);

  test('deadline expiring during the pre-publication lookup publishes no concept', async () => {
    const originalGetPage = engine.getPage.bind(engine);
    let lookupReached = false;
    engine.getPage = (async (...args: Parameters<typeof engine.getPage>) => {
      if (args[0] === 'concepts/c0' && !lookupReached) {
        lookupReached = true;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return null;
      }
      return originalGetPage(...args);
    }) as typeof engine.getPage;
    try {
      const result = await runPhaseSynthesizeConcepts(engine, {
        _atoms: atomsForGroups(1), phaseBudgetMs: 200, _chat: localChat(),
      });
      expect(lookupReached).toBe(true);
      expect((result.details as Record<string, unknown>).concepts_written).toBe(0);
      expect((result.details as Record<string, unknown>).partial).toBe(true);
      expect((result.details as Record<string, unknown>).groups_skipped).toBe(1);
    } finally {
      delete (engine as any).getPage;
    }
    expect(await engine.getPage('concepts/c0')).toBeNull();
  }, 30000);

  test('within budget, nothing is skipped and it is not marked partial', async () => {
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(3),
      _chat: localChat(),
      phaseBudgetMs: 60_000,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.concepts_written).toBe(3);
    expect(d.groups_skipped).toBe(0);
    expect(d.partial).toBe(false);
    expect(result.summary).not.toMatch(/PARTIAL/);
  }, 30000);

  test('densest groups win the budget, not Map insertion order', async () => {
    // sparse = 2 atoms (T3, cheap), dense = 10 atoms (T1, the valuable one).
    const atoms = [
      { slug: 'atoms/s0', concept_refs: ['concepts/sparse'], body: 'b', title: 'S0' },
      { slug: 'atoms/s1', concept_refs: ['concepts/sparse'], body: 'b', title: 'S1' },
      ...Array.from({ length: 10 }, (_, i) => ({
        slug: `atoms/d${i}`,
        concept_refs: ['concepts/dense'],
        body: 'b',
        title: `D${i}`,
      })),
    ];
    // A budget that admits exactly one group: the dense one must be it.
    let firstChatSlug = '';
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: async (o) => {
        firstChatSlug ||= String(o.messages?.[0]?.content ?? '');
        await new Promise((r) => setTimeout(r, 60));
        return localChat()(o);
      },
      phaseBudgetMs: 30,
    });
    const d = result.details as Record<string, unknown>;
    expect(firstChatSlug).toContain('Concept slug: dense');
    expect((d.tier_counts as Record<string, number>).T1).toBe(1);
    expect((d.tier_counts as Record<string, number>).T3).toBe(0); // sparse never started
  }, 30000);
});
