/**
 * Read-path audit #20: the per-candidate 5 s findTrajectory deadline in
 * think and in the LongMemEval trajectory route was a bare setTimeout that
 * was never cleared, so every lookup left a live timer that could hold the
 * process open for up to 5 s after the answer was done.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runThink, type ThinkLLMClient } from '../src/core/think/index.ts';
import { routeTrajectory } from '../src/eval/longmemeval/trajectory-route.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  await engine.putPage('people/marco-example', { title: 'Marco Example', type: 'person', compiled_truth: 'Marco is a founder.' });
  await engine.executeRaw(`
    INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, source, source_session, claim_metric, claim_value)
    VALUES ('default', 'people/marco-example', 'role: engineer', 'fact', 'private', '2026-01-01T00:00:00Z', 'test', 's1', 'role', 1),
           ('default', 'people/marco-example', 'role: VP eng', 'fact', 'private', '2026-04-01T00:00:00Z', 'test', 's2', 'role', 2)
  `);
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

/** Run `fn` while tracking 5000 ms timers; returns how many were left uncleared. */
async function uncleared5sTimers(fn: () => Promise<unknown>): Promise<{ created: number; live: number }> {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set<unknown>();
  let created = 0;
  globalThis.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const h = realSet(cb, ms, ...rest);
    if (ms === 5000) { created++; live.add(h); }
    return h;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((h: Parameters<typeof clearTimeout>[0]) => {
    live.delete(h);
    return realClear(h);
  }) as typeof clearTimeout;
  try {
    await fn();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  for (const h of live) realClear(h as Parameters<typeof clearTimeout>[0]);
  return { created, live: live.size };
}

const stubClient: ThinkLLMClient = {
  create: async () => ({
    id: 'stub', type: 'message', role: 'assistant', model: 'stub', stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
    content: [{ type: 'text', text: JSON.stringify({ answer: 'ok', citations: [], gaps: [] }) }],
  } as never),
};

describe('trajectory lookup deadlines are cleared once the lookup settles', () => {
  test('think', async () => {
    const r = await uncleared5sTimers(() => runThink(engine, { remote: false, question: 'When did Marco last switch jobs?', client: stubClient }));
    expect(r.created).toBeGreaterThan(0);
    expect(r.live).toBe(0);
  });

  test('LongMemEval trajectory route', async () => {
    let block = '';
    const r = await uncleared5sTimers(async () => {
      block = (await routeTrajectory(engine, 'When did Marco Example change roles?', ['people/marco-example'], 'knowledge_update' as any)).block;
    });
    expect(block).toContain('people/marco-example');
    expect(r.created).toBeGreaterThan(0);
    expect(r.live).toBe(0);
  });
});
