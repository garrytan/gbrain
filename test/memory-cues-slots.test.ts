import { expect, test } from 'bun:test';
import { CUE_ASSOCIATION_PAIRS, CUE_ASSOCIATION_SLOTS, CUE_OUTPUT_SLOTS, CUE_SYSTEM_PROMPT,
  formatCueEvidence, resolveCueEvidence } from '../src/core/memory-cues/evidence.ts';
import { buildCueWindows, validateCueOutput } from '../src/core/memory-cues/windows.ts';
import { cueSlots } from './helpers/memory-cues-wire.ts';

const window = buildCueWindows([{ id: 1, chunk_text: 'I prefer morning practice and keep evenings free for reading.' }])[0]!;
const excerpts = formatCueEvidence(window.text, false).excerpts;
const base = { evidence_ref: 1, text: 'Planning a practice session' };
const pairs = [
  ['horizon', 'explicit_constraint_applies'],
  ['horizon', 'explicit_preference_applies'],
  ['horizon', 'explicit_commitment_followup'],
  ['horizon', 'stated_goal_tradeoff'],
  ['bridge', 'explicit_constraint_applies'],
  ['bridge', 'explicit_preference_applies'],
  ['bridge', 'explicit_commitment_followup'],
  ['bridge', 'stated_goal_tradeoff'],
  ['bridge', 'category_generalization'],
] as const;

test('prompt and decoder share the finite slot and association-pair contract', () => {
  expect(CUE_OUTPUT_SLOTS).toEqual(['scene', 'association_1', 'association_2', 'association_3']);
  expect(CUE_ASSOCIATION_SLOTS).toHaveLength(3);
  expect(Object.keys(CUE_ASSOCIATION_PAIRS)).toEqual(pairs.map(([family, relation]) => `${family}:${relation}`));
  expect(CUE_SYSTEM_PROMPT).toContain(JSON.stringify(cueSlots()));
  expect(CUE_SYSTEM_PROMPT).toContain('3 optional associations total, never four associations');
  for (const [family, relation] of pairs) expect(CUE_SYSTEM_PROMPT).toContain(`${family}:${relation}`);
});

for (const includeBridge of [false, true]) {
  test(`all-null and scene-only slots have explicit semantics with bridge=${includeBridge}`, () => {
    expect(resolveCueEvidence(cueSlots(), excerpts, includeBridge)).toEqual([]);
    expect(validateCueOutput(resolveCueEvidence({ ...cueSlots(), scene: base }, excerpts, includeBridge), window, includeBridge))
      .toEqual([{ text: base.text, family: 'scene', relation: 'situation_description', quote: window.text, quoteStart: 0 }]);
  });
  for (const [family, relation] of pairs) {
    for (const slot of CUE_ASSOCIATION_SLOTS) {
      test(`${slot} admits only the valid ${family}:${relation} pair with bridge=${includeBridge}`, () => {
        const output = { ...cueSlots(), [slot]: { ...base, kind: `${family}:${relation}` } };
        if (family === 'bridge' && !includeBridge) {
          expect(() => resolveCueEvidence(output, excerpts, includeBridge)).toThrow('unsupported_relation');
        } else {
          expect(validateCueOutput(resolveCueEvidence(output, excerpts, includeBridge), window, includeBridge))
            .toEqual([{ family, relation, text: base.text, quote: window.text, quoteStart: 0 }]);
        }
      });
    }
  }
}

test('one scene and three associations fill all four slots without independent family choices', () => {
  const association = { ...base, kind: 'horizon:explicit_preference_applies' };
  const output = { scene: base, association_1: association, association_2: association, association_3: association };
  const cues = validateCueOutput(resolveCueEvidence(output, excerpts), window);
  expect(cues.map(cue => cue.family)).toEqual(['scene', 'horizon', 'horizon', 'horizon']);
  expect(cues.map(cue => cue.quote)).toEqual(Array(4).fill(window.text));
  expect(() => resolveCueEvidence({ ...output, association_4: association }, excerpts)).toThrow('invalid_output');
  expect(() => resolveCueEvidence({ ...output, scene: association }, excerpts)).toThrow('invalid_output');
  expect(() => resolveCueEvidence({ ...output, association_3: { ...base, kind: 'horizon:situation_description' } }, excerpts)).toThrow('unsupported_relation');
  expect(() => validateCueOutput(Array(4).fill(cues[1]), window)).toThrow('unsupported_relation');
  expect(() => validateCueOutput([{ ...cues[1], relation: 'situation_description' }], window)).toThrow('unsupported_relation');
});

test('unknown discriminators cannot select prototype keys or fabricate a family/relation combination', () => {
  for (const kind of ['constructor', '__proto__', 'toString', 'scene:situation_description', 'horizon:category_generalization',
    'horizon:situation_description', 'bridge:situation_description', '', null, ['horizon:stated_goal_tradeoff'], {}]) {
    expect(() => resolveCueEvidence(cueSlots({ ...base, kind }), excerpts, true)).toThrow('unsupported_relation');
  }
});

test('every malformed slot and unsupported field fails closed without dropping valid neighbors', () => {
  for (const slot of CUE_OUTPUT_SLOTS) {
    const valid = slot === 'scene' ? base : { ...base, kind: 'horizon:explicit_preference_applies' };
    for (const bad of [false, true, 0, '', [], {}, { ...valid, quote: window.text }, { ...valid, quoteStart: 0 },
      { ...valid, family: 'horizon' }, { ...valid, relation: 'explicit_preference_applies' }]) {
      expect(() => resolveCueEvidence({ ...cueSlots({ ...base, kind: 'horizon:explicit_constraint_applies' }), [slot]: bad }, excerpts))
        .toThrow('invalid_output');
    }
    for (const text of [null, 5, [], {}, '', '  ', 'x'.repeat(241)]) {
      expect(() => resolveCueEvidence({ ...cueSlots(), [slot]: { ...valid, text } }, excerpts)).toThrow('unsupported_cue');
    }
    for (const evidence_ref of [null, true, '1', -1, 0, 1.5, 2, Infinity, NaN, [], {}]) {
      expect(() => resolveCueEvidence({ ...cueSlots(), [slot]: { ...valid, evidence_ref } }, excerpts)).toThrow('unsupported_cue');
    }
    const missing = { ...cueSlots() } as Record<string, unknown>;
    delete missing[slot];
    expect(() => resolveCueEvidence(missing, excerpts)).toThrow('invalid_output');
  }
  for (const output of [undefined, null, true, '', [], [null, null, null, null], {}, { ...cueSlots(), extra: null }]) {
    expect(() => resolveCueEvidence(output, excerpts)).toThrow('invalid_output');
  }
});
