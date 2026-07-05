/**
 * orchestrator-execute.test.ts — the SkillExecutor logic, with a fake JobRunner
 * (no queue, no DB, no worker). Covers the happy path, failure handling, and the
 * default prompt. The real makeQueueJobRunner is validated on the local stack.
 */

import { describe, it, expect } from 'bun:test';
import {
  makeSubagentExecutor,
  extractResultText,
  type JobRunner,
  type SubagentSpec,
} from '../src/core/orchestrator/execute.ts';
import type { OrchestratorContext, SkillRecommendation } from '../src/core/orchestrator/types.ts';

const REC: SkillRecommendation = {
  skill: 'nurse-triage',
  role: 'nurse',
  reason: 'chest pain',
  confidence: 0.9,
};

function ctx(text: string, state?: Record<string, unknown>): OrchestratorContext {
  return { input: { text, state }, history: [], now: new Date('2026-07-05T00:00:00Z'), remote: false };
}

describe('makeSubagentExecutor', () => {
  it('returns the subagent text as the skill output on success', async () => {
    const runner: JobRunner = async () => ({ status: 'completed', text: 'triage: escalate to MD' });
    const exec = makeSubagentExecutor({ runner });
    const out = await exec(REC, ctx('chest pain'));
    expect(out).toEqual({ skill: 'nurse-triage', summary: 'triage: escalate to MD' });
  });

  it('records a non-throwing failure output when the job fails', async () => {
    const runner: JobRunner = async () => ({ status: 'failed', text: '', error: 'model timeout' });
    const exec = makeSubagentExecutor({ runner });
    const out = await exec(REC, ctx('chest pain'));
    expect(out.skill).toBe('nurse-triage');
    expect(out.summary).toContain('execution failed');
    expect(out.summary).toContain('model timeout');
  });

  it('builds a prompt that names the skill, its role, and the patient input', async () => {
    let seen: SubagentSpec | undefined;
    const runner: JobRunner = async (spec) => {
      seen = spec;
      return { status: 'completed', text: 'ok' };
    };
    const exec = makeSubagentExecutor({ runner, model: 'openrouter:qwen/qwen3.6-27b', maxTurns: 5 });
    await exec(REC, ctx('reports chest pain', { spo2: 91 }));
    expect(seen?.model).toBe('openrouter:qwen/qwen3.6-27b');
    expect(seen?.maxTurns).toBe(5);
    expect(seen?.prompt).toContain('nurse-triage');
    expect(seen?.prompt).toContain('role: nurse');
    expect(seen?.prompt).toContain('reports chest pain');
    expect(seen?.prompt).toContain('spo2'); // state folded in
    expect(seen?.prompt).toContain('decision support, not diagnosis');
  });

  it('honours a custom buildPrompt', async () => {
    let seen: SubagentSpec | undefined;
    const runner: JobRunner = async (spec) => {
      seen = spec;
      return { status: 'completed', text: 'ok' };
    };
    const exec = makeSubagentExecutor({ runner, buildPrompt: (r) => `RUN ${r.skill}` });
    await exec(REC, ctx('x'));
    expect(seen?.prompt).toBe('RUN nurse-triage');
  });
});

describe('extractResultText', () => {
  it('prefers known text fields, falls back to JSON', () => {
    expect(extractResultText({ text: 'a' })).toBe('a');
    expect(extractResultText({ output: 'b' })).toBe('b');
    expect(extractResultText(null)).toBe('');
    expect(extractResultText({ foo: 1 })).toBe('{"foo":1}');
  });
});
