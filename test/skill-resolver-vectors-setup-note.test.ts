/**
 * Value: protects=setup prints the vectors note after status and before the router offer, only when set; 'vector' ranks between description and body;
 * fails_when=describeResolverSetup drops or reorders vectors_note, or MATCH_STRENGTHS moves 'vector' (min_match_strength gating shifts);
 * why_new=skill-resolver-vectors.test.ts checks match_strength 'vector' on a turn, not the setup text or the ordering; seam=none;
 * no_claim=syncSkillResolverSetup's receipt read that sets vectors_note (pure formatter and constant only)
 */
import { describe, expect, test } from 'bun:test';
import { describeResolverSetup, type ResolverSetupResult } from '../src/core/setup/skill-resolver-setup.ts';
import { MATCH_STRENGTHS } from '../src/core/skills/resolver/limits.ts';

const base = { steps: [], status: { line: 'skill resolver: on; 3 skills; fresh' } } as unknown as ResolverSetupResult;

describe('skill vectors in setup output', () => {
  test('vectors_note follows the status line and precedes the router offer', () => {
    const lines = describeResolverSetup({ ...base, vectors_note: 'skill vectors: on (openai:x).', router_offer: 'model picker: off.' } as ResolverSetupResult, false);
    expect(lines).toEqual(['skill resolver: on; 3 skills; fresh', 'skill vectors: on (openai:x).', 'model picker: off.']);
  });

  test('no vectors_note, no vectors line', () => {
    expect(describeResolverSetup(base, false).some((l) => l.startsWith('skill vectors'))).toBe(false);
  });

  test("'vector' sits between description and body", () => {
    expect(MATCH_STRENGTHS.indexOf('vector')).toBe(MATCH_STRENGTHS.indexOf('description') + 1);
    expect(MATCH_STRENGTHS.at(-1)).toBe('body');
  });
});
