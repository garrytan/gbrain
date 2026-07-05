/**
 * Distiller decision-eval (Task 1 guardrail).
 *
 * Runs the committed decision-eval fixtures through the v0 decider against the
 * REAL merged seed skills (loaded from the repo's skills/ dir). Proves the
 * distiller makes the expected create/update/exact_match/split decision for
 * representative clinical topics — a regression guard on both the decider and
 * the seed skills' shape.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadExistingSkills } from '../src/core/distiller/load-skills.ts';
import { decideDistillation } from '../src/core/distiller/decide.ts';
import type { CandidateTopic } from '../src/core/distiller/types.ts';

interface EvalCase {
  role: CandidateTopic['role'];
  title: string;
  summary: string;
  triggers?: string[];
  expect: { decision: string; matched: string | null };
}

const REPO_SKILLS = join(import.meta.dir, '..', 'skills');

function loadFixtures(): EvalCase[] {
  const path = join(import.meta.dir, 'fixtures', 'distiller', 'decision-eval.jsonl');
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .map((l) => JSON.parse(l) as EvalCase);
}

describe('distiller decision-eval vs real seed skills', () => {
  const all = loadExistingSkills(REPO_SKILLS);
  const fixtures = loadFixtures();

  test('the seed clinical skills are present (guard the guard)', () => {
    const clinical = all.filter((s) => s.role).map((s) => s.name);
    expect(clinical).toContain('nurse-triage');
    expect(clinical).toContain('psych-risk-screen');
    expect(clinical).toContain('patient-history-review');
  });

  for (const c of fixtures) {
    test(`${c.role}: "${c.title}" → ${c.expect.decision}`, () => {
      const lane = all.filter((s) => s.role === c.role);
      const result = decideDistillation(
        { role: c.role, title: c.title, summary: c.summary, triggers: c.triggers },
        lane,
      );
      expect(result.decision as string).toBe(c.expect.decision);
      expect(result.matchedSkill ?? null).toBe(c.expect.matched);
    });
  }
});
