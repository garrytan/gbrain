/**
 * #3219 — `gbrain models doctor` must probe configured per-task routes, not
 * only the global chat + expansion models. A background route (e.g.
 * `models.dream.synthesize`) can point at a distinct unreachable provider
 * while chat/expansion are green.
 *
 * Pins `resolvePerTaskProbePlan`: same resolution path `buildReport` uses,
 * dedup against already-probed models, dedup identical resolved models across
 * routes, route-key attribution retained.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { resolvePerTaskProbePlan, probeModel } from '../src/commands/models.ts';
import { TIER_DEFAULTS } from '../src/core/model-config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { afterEach } from 'bun:test';

function stubEngine(config: Record<string, string>): BrainEngine {
  return { getConfig: async (k: string) => config[k] ?? null } as unknown as BrainEngine;
}

beforeEach(() => {
  delete process.env.GBRAIN_MODEL;
});

afterEach(() => {
  __setChatTransportForTests(null);
});

describe('#3219 — doctor probes per-task background routes', () => {
  test('a distinctly configured background route lands in the probe plan with route attribution', async () => {
    const plan = await resolvePerTaskProbePlan(
      stubEngine({ 'models.dream.synthesize': 'litellm:qwen-test' }),
      new Set([TIER_DEFAULTS.reasoning, TIER_DEFAULTS.utility, TIER_DEFAULTS.deep]),
    );

    const entry = plan.find(p => p.model === 'litellm:qwen-test');
    expect(entry).toBeDefined();
    expect(entry!.routes).toEqual(['models.dream.synthesize']);
  });

  test('routes resolving to already-probed chat/expansion models are excluded', async () => {
    // Nothing configured: every route resolves to its tier default. With all
    // tier defaults already probed, the plan must be empty (no double-probes).
    const plan = await resolvePerTaskProbePlan(
      stubEngine({}),
      new Set(Object.values(TIER_DEFAULTS)),
    );
    expect(plan).toEqual([]);
  });

  test('multiple routes on the same distinct model dedup into ONE probe carrying all route keys', async () => {
    const plan = await resolvePerTaskProbePlan(
      stubEngine({}),
      // Only reasoning + utility probed (the doctor default when chat +
      // expansion are unconfigured) — the deep tier default is a distinct
      // model shared by models.auto_think and models.think.
      new Set([TIER_DEFAULTS.reasoning, TIER_DEFAULTS.utility]),
    );

    const deep = plan.find(p => p.model === TIER_DEFAULTS.deep);
    expect(deep).toBeDefined();
    expect(deep!.routes).toContain('models.auto_think');
    expect(deep!.routes).toContain('models.think');
    // Exactly one plan entry per distinct model.
    expect(plan.filter(p => p.model === TIER_DEFAULTS.deep).length).toBe(1);
  });

  test('models.chat / models.expansion route keys never enter the plan (they ARE the chat/expansion probes)', async () => {
    const plan = await resolvePerTaskProbePlan(
      stubEngine({ 'models.chat': 'litellm:bare-chat', 'models.expansion': 'litellm:bare-expand' }),
      new Set(Object.values(TIER_DEFAULTS)),
    );
    const routes = plan.flatMap(p => p.routes);
    expect(routes).not.toContain('models.chat');
    expect(routes).not.toContain('models.expansion');
  });

  test('probeModel carries the route-key touchpoint through for attribution', async () => {
    __setChatTransportForTests(async () => ({
      text: 'ok',
      blocks: [{ type: 'text', text: 'ok' }],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));

    const r = await probeModel('litellm:qwen-test', 'models.dream.synthesize,models.think');
    expect(r.status).toBe('ok');
    expect(r.touchpoint).toBe('models.dream.synthesize,models.think');
  });
});
