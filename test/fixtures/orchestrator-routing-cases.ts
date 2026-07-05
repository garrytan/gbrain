/**
 * orchestrator-routing-cases.ts — the shared "input → expected skills" acceptance
 * fixtures for the Task 2 orchestrator (the routing-eval gate from the plan).
 *
 * The CATALOG mirrors the three seed clinical skills plus one generic GBrain skill
 * (which must never be routed patient data). Cases are phrased like real patient
 * inputs. `expect_top` is the skill that must rank first for the deterministic v0
 * selector; the same cases can later be replayed through the LLM selector.
 */

import type { CandidateSkill } from '../../src/core/orchestrator/types.ts';

export const CATALOG: CandidateSkill[] = [
  {
    name: 'nurse-triage',
    path: 'skills/nurse-triage/SKILL.md',
    description: 'Triage patient symptoms and vitals; flag escalation',
    role: 'nurse',
    triggers: ['chest pain', 'shortness of breath', 'triage', 'vital signs', 'fever', 'wound care'],
  },
  {
    name: 'psych-risk-screen',
    path: 'skills/psych-risk-screen/SKILL.md',
    description: 'Screen for mood and psychiatric risk indicators',
    role: 'psychiatrist',
    triggers: ['suicidal', 'self-harm', 'mental status', 'psychiatric risk', 'depression', 'anxiety'],
  },
  {
    name: 'patient-history-review',
    path: 'skills/patient-history-review/SKILL.md',
    description: 'Review medication list, allergies and past medical history',
    role: 'general-medicine',
    triggers: ['medication list', 'allergies', 'past medical history', 'medical record'],
  },
  {
    // generic GBrain skill — no clinical role → never eligible for patient data.
    name: 'query',
    path: 'skills/query/SKILL.md',
    description: 'Generic brain search and retrieval',
    triggers: ['search', 'query', 'lookup'],
  },
];

export interface RoutingCase {
  name: string;
  input: string;
  /** Skill that must rank first. null → expect no clinical recommendation. */
  expect_top: string | null;
}

export const ROUTING_CASES: RoutingCase[] = [
  {
    name: 'cardiac symptoms → nurse triage',
    input: 'reports chest pain and shortness of breath, needs vital signs',
    expect_top: 'nurse-triage',
  },
  {
    name: 'mental-health risk → psych screen',
    input: 'expressing suicidal thoughts, self-harm and depression',
    expect_top: 'psych-risk-screen',
  },
  {
    name: 'records review → general medicine',
    input: 'needs a medication list and allergies check against past medical history',
    expect_top: 'patient-history-review',
  },
  {
    name: 'purely generic input → nothing clinical routes',
    input: 'please run a keyword search in the system',
    expect_top: null,
  },
];
