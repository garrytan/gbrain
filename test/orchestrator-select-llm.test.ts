/**
 * orchestrator-select-llm.test.ts — the LLM skill selector, with an injected fake
 * `chat` (no gateway, no network). Proves it ranks, validates against the eligible
 * set, tolerates fenced JSON, clamps confidence, and short-circuits on no candidates.
 */

import { describe, it, expect } from 'bun:test';
import { selectSkillsLLM, type ChatFn } from '../src/core/orchestrator/select-llm.ts';
import type { CandidateSkill, OrchestratorContext } from '../src/core/orchestrator/types.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';

const NURSE: CandidateSkill = {
  name: 'nurse-triage',
  path: 'skills/nurse-triage/SKILL.md',
  description: 'Triage symptoms and vitals',
  role: 'nurse',
  triggers: ['pain', 'vitals'],
};
const PSYCH: CandidateSkill = {
  name: 'psych-risk-screen',
  path: 'skills/psych-risk-screen/SKILL.md',
  description: 'Screen mood and risk',
  role: 'psychiatrist',
  triggers: ['mood', 'risk'],
};

function ctx(text: string): OrchestratorContext {
  return { input: { text }, history: [], now: new Date('2026-07-05T00:00:00Z'), remote: false };
}

/** Fake chat that returns a tool-call with the given ranked rows. */
function toolCallChat(ranked: unknown): ChatFn {
  return async () =>
    ({
      blocks: [{ type: 'tool-call', toolName: 'rank_skills', input: { ranked } }],
      text: '',
    }) as unknown as ChatResult;
}

describe('selectSkillsLLM', () => {
  it('returns recommendations from the tool-call, sorted by confidence', async () => {
    const chat = toolCallChat([
      { skill: 'psych-risk-screen', confidence: 0.9, reason: 'low mood' },
      { skill: 'nurse-triage', confidence: 0.4, reason: 'in pain' },
    ]);
    const recs = await selectSkillsLLM(ctx('feeling down and in pain'), [NURSE, PSYCH], chat);
    expect(recs.map((r) => r.skill)).toEqual(['psych-risk-screen', 'nurse-triage']);
    expect(recs[0].confidence).toBeCloseTo(0.9);
    expect(recs[0].role).toBe('psychiatrist');
  });

  it('drops skills the model invents that are not candidates', async () => {
    const chat = toolCallChat([
      { skill: 'query', confidence: 0.99, reason: 'hallucinated generic skill' },
      { skill: 'nurse-triage', confidence: 0.5, reason: 'in pain' },
    ]);
    const recs = await selectSkillsLLM(ctx('pain'), [NURSE, PSYCH], chat);
    expect(recs.map((r) => r.skill)).toEqual(['nurse-triage']);
  });

  it('parses fenced JSON text when there is no tool-call block', async () => {
    const chat: ChatFn = async () =>
      ({
        blocks: [],
        text: '```json\n{"ranked":[{"skill":"nurse-triage","confidence":0.7,"reason":"x"}]}\n```',
      }) as unknown as ChatResult;
    const recs = await selectSkillsLLM(ctx('pain'), [NURSE, PSYCH], chat);
    expect(recs.map((r) => r.skill)).toEqual(['nurse-triage']);
  });

  it('clamps out-of-range confidence into 0..1', async () => {
    const chat = toolCallChat([{ skill: 'nurse-triage', confidence: 5, reason: 'x' }]);
    const recs = await selectSkillsLLM(ctx('pain'), [NURSE], chat);
    expect(recs[0].confidence).toBe(1);
  });

  it('short-circuits (no model call) when there are no candidates', async () => {
    let called = false;
    const chat: ChatFn = async () => {
      called = true;
      return { blocks: [], text: '' } as unknown as ChatResult;
    };
    const recs = await selectSkillsLLM(ctx('pain'), [], chat);
    expect(recs).toEqual([]);
    expect(called).toBe(false);
  });
});
