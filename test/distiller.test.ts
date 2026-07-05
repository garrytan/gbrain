/**
 * Unit suite for the Task 1 distiller (src/core/distiller/).
 *
 * Hermetic: no DB, no LLM, no network — all seams injected. Proves the decider's
 * four branches, lane isolation, the APPI role guard, and the injected-classifier
 * (LLM seam) path including `split`.
 */

import { describe, expect, test } from 'bun:test';
import {
  decideDistillation,
  EXACT_MATCH_THRESHOLD,
} from '../src/core/distiller/decide.ts';
import { runDistiller, slugify, type DistillerDeps } from '../src/core/distiller/run.ts';
import type { CandidateTopic, ExistingSkill, DistillDecisionResult } from '../src/core/distiller/types.ts';

// --- fixtures (mirror the seed skills' shape from list_skills) ---------------

const nurseTriage: ExistingSkill = {
  name: 'nurse-triage',
  description: 'Nursing intake and triage decision-support for presenting symptoms and vital signs.',
  triggers: ['chest pain', 'shortness of breath', 'triage', 'vital signs', 'fever', 'wound care'],
  role: 'nurse',
};
const psychScreen: ExistingSkill = {
  name: 'psych-risk-screen',
  description: 'Psychiatric risk screening for self-harm suicidality and mental status.',
  triggers: ['suicidal', 'self-harm', 'mental status', 'psychiatric risk', 'depression', 'anxiety'],
  role: 'psychiatrist',
};
const library = [nurseTriage, psychScreen];

function nurseTopic(over: Partial<CandidateTopic> = {}): CandidateTopic {
  return {
    title: 'Chest pain triage',
    summary: 'Assess chest pain, shortness of breath, and vital signs; recommend triage escalation.',
    role: 'nurse',
    ...over,
  };
}

// --- decideDistillation ------------------------------------------------------

describe('decideDistillation — branches', () => {
  test('empty lane → none (create)', () => {
    const r = decideDistillation(nurseTopic(), []);
    expect(r.decision).toBe('none');
  });

  test('no overlap with any same-lane skill → none (create)', () => {
    const topic = nurseTopic({
      title: 'Nutrition and hydration plan',
      summary: 'Daily fluid intake goals, meal supplementation, dietician referral cadence.',
      triggers: ['hydration', 'nutrition', 'dietician'],
    });
    const r = decideDistillation(topic, [nurseTriage]);
    expect(r.decision).toBe('none');
  });

  test('high overlap + no new info → exact_match', () => {
    // Topic built straight from the skill's own description/triggers.
    const topic = nurseTopic({
      title: 'Triage',
      summary: 'Nursing intake and triage decision-support for presenting symptoms and vital signs.',
      triggers: ['triage', 'vital signs', 'chest pain'],
    });
    const r = decideDistillation(topic, [nurseTriage]);
    expect(r.decision).toBe('exact_match');
    expect(r.matchedSkill).toBe('nurse-triage');
    expect(r.confidence).toBeGreaterThanOrEqual(EXACT_MATCH_THRESHOLD);
  });

  test('close skill + substantial new info → update', () => {
    const topic = nurseTopic({
      title: 'Triage with sepsis pathway',
      summary:
        'Triage and vital signs plus a new sepsis screening bundle: lactate draw, blood cultures, ' +
        'antibiotic timing, fluid resuscitation targets, escalation to intensive care.',
      triggers: ['triage', 'sepsis', 'lactate', 'antibiotics'],
    });
    const r = decideDistillation(topic, [nurseTriage]);
    expect(r.decision).toBe('update');
    expect(r.matchedSkill).toBe('nurse-triage');
  });
});

// --- runDistiller ------------------------------------------------------------

function deps(over: Partial<DistillerDeps> = {}): DistillerDeps {
  return { loadExistingSkills: async () => library, ...over };
}

describe('runDistiller — pipeline', () => {
  test('lane isolation: a nurse topic never matches a psychiatrist skill', async () => {
    // Only the psychiatrist skill exists; a nurse topic must NOT match it.
    const report = await runDistiller(nurseTopic(), deps({ loadExistingSkills: async () => [psychScreen] }));
    expect(report.decision).toBe('none');
    expect(report.notes.some((n) => n.includes("no existing 'nurse' skill"))).toBe(true);
  });

  test('create path yields a scaffold action with a slug', async () => {
    const report = await runDistiller(
      nurseTopic({ title: 'Falls risk assessment', summary: 'Falls history, gait, environment.', triggers: ['falls', 'gait'] }),
      deps(),
    );
    expect(report.decision).toBe('none');
    expect(report.proposedAction).toContain('skillify scaffold falls-risk-assessment');
    expect(report.proposedAction).toContain('role: nurse');
  });

  test('APPI guard: non-clinical role is refused', async () => {
    const bad = { title: 'x', summary: 'y', role: 'marketing' } as unknown as CandidateTopic;
    await expect(runDistiller(bad, deps())).rejects.toThrow(/non-clinical role/);
  });

  test('injected classifier (LLM seam) can return split, framed as a split action', async () => {
    const classify = (): DistillDecisionResult => ({
      decision: 'split',
      matchedSkill: 'nurse-triage',
      splitInto: ['nurse-triage', 'nurse-sepsis-pathway'],
      reason: 'topic carries two distinct clinical pathways',
      confidence: 0.8,
    });
    const report = await runDistiller(nurseTopic(), deps({ classify }));
    expect(report.decision).toBe('split');
    expect(report.splitInto).toEqual(['nurse-triage', 'nurse-sepsis-pathway']);
    expect(report.proposedAction).toContain('split');
    expect(report.proposedAction).toContain('nurse-sepsis-pathway');
  });

  test('retrieveBrainData enrichment is recorded and feeds the decider', async () => {
    const report = await runDistiller(
      nurseTopic({ title: 'New topic', summary: 'sparse', triggers: [] }),
      deps({ retrieveBrainData: async () => ['triage and vital signs guidance', 'chest pain protocol'] }),
    );
    expect(report.notes.some((n) => n.includes('enriched topic with 2 retrieved snippet'))).toBe(true);
  });

  test('provenance sourceIds surface in the audit notes', async () => {
    const report = await runDistiller(nurseTopic({ sourceIds: ['page:123', 'page:456'] }), deps());
    expect(report.notes.some((n) => n.includes('provenance: page:123, page:456'))).toBe(true);
  });
});

describe('slugify', () => {
  test('kebab-cases and trims', () => {
    expect(slugify('  Chest Pain / Triage!! ')).toBe('chest-pain-triage');
  });
  test('falls back for empty input', () => {
    expect(slugify('!!!')).toBe('untitled-skill');
  });
});
