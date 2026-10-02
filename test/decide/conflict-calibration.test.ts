/**
 * S9 calibration: the duplicate value is reducer-consistent (P(chosen) only
 * when duplicate is chosen), the proposal floor is calibrated on supersede
 * labels over the pairs the duplicate rule does not take, and the sweep's
 * floor precedence is operator override > calibration > default.
 */
import { describe, expect, test } from 'bun:test';
import { calibrateProposalFloor, duplicateValue, MIN_SUPERSEDE_LABELS, parseConflictPairs } from '../../src/core/ai/decide/datasets-conflict.ts';
import { DEFAULT_PROPOSAL_FLOOR } from '../../src/core/ai/decide/conflict.ts';
import { notesProposalFloor } from '../../src/core/ai/decide/policy.ts';
import { proposalFloor } from '../../src/core/ai/decide/sweep.ts';
import type { ChoiceAnswer } from '../../src/core/ai/decide/types.ts';

const ans = (choice: string, probabilities: Record<string, number>): ChoiceAnswer => ({ kind: 'choice', choice, confidence: probabilities[choice] ?? 0, probabilities });

describe('S9 duplicate value', () => {
  test('counts only a chosen duplicate', () => {
    expect(duplicateValue(ans('duplicate', { duplicate: 0.8, supersede: 0.1, independent: 0.1 }))).toBe(0.8);
    expect(duplicateValue(ans('independent', { duplicate: 0.05, supersede: 0.05, independent: 0.9 }))).toBe(0);
    expect(duplicateValue({ kind: 'noul', p: 0.9 })).toBe(0);
  });
});

describe('S9 proposal floor calibration', () => {
  const lines: string[] = [];
  const answers: Record<string, ChoiceAnswer> = {};
  for (let i = 0; i < 12; i++) {
    lines.push(JSON.stringify({ id: `s${i}`, fact: 'f', candidate: 'c', label: 'supersede' }));
    answers[`s${i}`] = ans('supersede', { duplicate: 0.1, supersede: 0.6 + i * 0.01, independent: 0.3 - i * 0.01 });
    lines.push(JSON.stringify({ id: `i${i}`, fact: 'f', candidate: 'c', label: 'independent' }));
    answers[`i${i}`] = ans('independent', { duplicate: 0.1, supersede: 0.2, independent: 0.7 });
  }
  lines.push(JSON.stringify({ id: 'd0', fact: 'f', candidate: 'c', label: 'duplicate' }));
  answers.d0 = ans('duplicate', { duplicate: 0.9, supersede: 0.9, independent: 0 });
  const items = parseConflictPairs(lines.join('\n'));

  test('picks a floor separating supersede labels, excluding pairs the duplicate rule takes', () => {
    const extra = calibrateProposalFloor(items, answers, 0.5)!;
    expect(extra.proposal_floor).toBeGreaterThan(0.2);
    expect(extra.proposal_floor).toBeLessThanOrEqual(0.6);
    expect(extra.proposal_floor_precision).toBe(1);
    expect(extra.proposal_floor_recall).toBe(1);
    expect(extra.proposal_floor_n).toBe(24);
    expect(extra.proposal_floor_supersedes).toBe(12);
  });

  test('refuses with too few supersede labels', () => {
    const few = items.filter((it) => !it.id.startsWith('s') || Number(it.id.slice(1)) < MIN_SUPERSEDE_LABELS - 1);
    expect(calibrateProposalFloor(few, answers, 0.5)).toBeNull();
  });
});

describe('S9 floor precedence', () => {
  test('override > calibration > default', () => {
    expect(proposalFloor({ 'decide.slots.conflict.proposal_floor': '0.7' }, 0.4)).toBe(0.7);
    expect(proposalFloor({}, 0.4)).toBe(0.4);
    expect(proposalFloor({})).toBe(DEFAULT_PROPOSAL_FLOOR);
  });
  test('notes JSON parsing is strict', () => {
    expect(notesProposalFloor('{"proposal_floor":0.43}')).toBe(0.43);
    expect(notesProposalFloor('{"proposal_floor":3}')).toBeUndefined();
    expect(notesProposalFloor('not json')).toBeUndefined();
    expect(notesProposalFloor(null)).toBeUndefined();
  });
});
