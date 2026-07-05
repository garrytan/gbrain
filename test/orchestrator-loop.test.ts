/**
 * orchestrator-loop.test.ts — the feedback-loop driver.
 *
 * Uses a fake executor whose output introduces new evidence, so a second round
 * surfaces a fresh skill; a third round finds nothing new and converges. Also
 * covers suggest-only (no executor) and the no-clinical-skill case.
 */

import { describe, it, expect } from 'bun:test';
import { orchestrateLoop } from '../src/core/orchestrator/loop.ts';
import type { OrchestratorDeps } from '../src/core/orchestrator/run.ts';
import type {
  CandidateSkill,
  OrchestratorContext,
  SkillExecutor,
  SkillOutput,
} from '../src/core/orchestrator/types.ts';

const NURSE: CandidateSkill = {
  name: 'nurse-triage',
  path: 'skills/nurse-triage/SKILL.md',
  description: 'assess pain',
  role: 'nurse',
  triggers: ['pain'],
};
const PSYCH: CandidateSkill = {
  name: 'psych-risk-screen',
  path: 'skills/psych-risk-screen/SKILL.md',
  description: 'assess mood',
  role: 'psychiatrist',
  triggers: ['mood'],
};

const deps: OrchestratorDeps = { loadCandidateSkills: async () => [NURSE, PSYCH] };

function ctx(text: string): OrchestratorContext {
  return { input: { text }, history: [], now: new Date('2026-07-05T00:00:00Z'), remote: false };
}

/** Fake executor: running nurse-triage surfaces low mood → psych becomes fresh next round. */
const executor: SkillExecutor = async (rec): Promise<SkillOutput> => {
  if (rec.skill === 'nurse-triage') return { skill: rec.skill, summary: 'patient also has low mood' };
  return { skill: rec.skill, summary: 'risk screen complete' };
};

describe('orchestrateLoop', () => {
  it('feeds outputs back so a later round surfaces a fresh skill, then converges', async () => {
    const res = await orchestrateLoop(ctx('in pain'), deps, { executor });
    expect(res.stopped).toBe('stable');
    // nurse ran round 1; its output surfaced mood → psych ran round 2; round 3 converged.
    expect(res.priorSkillOutputs.map((o) => o.skill).sort()).toEqual([
      'nurse-triage',
      'psych-risk-screen',
    ]);
    expect(res.rounds.length).toBe(3);
  });

  it('does a single suggest-only pass when no executor is wired', async () => {
    const res = await orchestrateLoop(ctx('in pain'), deps, {});
    expect(res.stopped).toBe('no_executor');
    expect(res.rounds).toHaveLength(1);
    expect(res.rounds[0].executed).toHaveLength(0);
    expect(res.finalReport.recommendations[0].skill).toBe('nurse-triage');
  });

  it('stops immediately when no clinical skill matches', async () => {
    const res = await orchestrateLoop(ctx('hello world'), deps, { executor });
    expect(res.stopped).toBe('empty');
    expect(res.rounds).toHaveLength(1);
    expect(res.priorSkillOutputs).toHaveLength(0);
  });

  it('respects maxRounds as a backstop', async () => {
    const res = await orchestrateLoop(ctx('in pain'), deps, { executor, maxRounds: 1 });
    expect(res.rounds).toHaveLength(1);
  });
});
