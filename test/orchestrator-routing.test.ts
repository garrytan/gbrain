/**
 * orchestrator-routing.test.ts — the routing-eval acceptance gate.
 *
 * Replays the shared input→expected-skills fixtures through the orchestrator with
 * the deterministic v0 selector. Asserts the right clinical skill ranks first and
 * that the generic GBrain skill is never routed patient data.
 */

import { describe, it, expect } from 'bun:test';
import { runOrchestrator, type OrchestratorDeps } from '../src/core/orchestrator/run.ts';
import type { OrchestratorContext } from '../src/core/orchestrator/types.ts';
import { CATALOG, ROUTING_CASES } from './fixtures/orchestrator-routing-cases.ts';

const deps: OrchestratorDeps = { loadCandidateSkills: async () => CATALOG };

function ctx(text: string): OrchestratorContext {
  return { input: { text }, history: [], now: new Date('2026-07-05T00:00:00Z'), remote: false };
}

describe('orchestrator routing-eval', () => {
  for (const c of ROUTING_CASES) {
    it(c.name, async () => {
      const report = await runOrchestrator(ctx(c.input), deps);
      const names = report.recommendations.map((r) => r.skill);

      // Generic GBrain skill is never routed patient data, always audited.
      expect(names).not.toContain('query');
      expect(report.excluded_generic).toContain('query');

      if (c.expect_top === null) {
        expect(report.recommendations).toHaveLength(0);
      } else {
        expect(names[0]).toBe(c.expect_top);
      }
    });
  }
});
