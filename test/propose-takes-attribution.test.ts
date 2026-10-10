// #5425 [UC4] (wave 14 PR3 row P3.9): the mechanical holder check for
// propose_takes, `downgradeAssistantOnlyHolders`, unit-tested standalone
// because its one call site in `propose-takes.ts` (wave 13 hot file) is a
// stack hunk (`~/.capy/work/w14/pr3/stack-hunks/propose-takes.ts.p3.9.patch`).
//
// Protects: a `people/<slug>` proposal whose numbers, dates and quoted
// phrases only assistant turns state is held by `brain`; a token the user
// stated, or explicitly accepted in the next turn ("yes, do that"), keeps the
// person; claims with no content tokens, pages with no speaker turns, and
// tokens no turn states are left alone; non-person holders are never touched;
// the input is not mutated. Fails when: the check downgrades on shared or
// accepted tokens, or fires without turn evidence. Why not existing coverage:
// attribution-rules-opt-in.test.ts pins the prompt rules, not a mechanical
// check. No production seam.

import { describe, expect, test } from 'bun:test';
import { claimContentTokens, downgradeAssistantOnlyHolders } from '../src/core/cycle/propose-takes-attribution.ts';

const page = [
  '[user]',
  'How should we price the pro tier?',
  '[assistant]',
  'Price the pro tier at $49 per seat and expect 12% monthly churn at first. "Annual prepay is the lever that matters most."',
  '[user]',
  'The churn number I trust is 8%, from our own 2025 cohort.',
  '[assistant]',
  'Then I would still cap discounts at 20% for annual prepay.',
  '[user]',
  'Yes, do that.',
].join('\n');

const take = (claim_text: string, holder: string) => ({ claim_text, kind: 'take' as const, holder, weight: 0.6 });

describe('downgradeAssistantOnlyHolders (#5425 [UC4])', () => {
  test('a person-holder proposal whose numbers only the assistant stated is held by brain', () => {
    const out = downgradeAssistantOnlyHolders([take('Pro tier should be priced at $49 per seat.', 'people/alice-example')], page);
    expect(out.map(p => p.holder)).toEqual(['brain']);
  });

  test('a quoted phrase only the assistant said is assistant evidence too', () => {
    const out = downgradeAssistantOnlyHolders([take('"Annual prepay is the lever that matters most."', 'people/alice-example')], page);
    expect(out.map(p => p.holder)).toEqual(['brain']);
  });

  test('a number the user stated keeps the person; mixed tokens keep the person', () => {
    const out = downgradeAssistantOnlyHolders([
      take('Churn for the pro tier runs at 8%.', 'people/alice-example'),
      take('Pro tier at $49 per seat with 8% churn is viable.', 'people/alice-example'),
    ], page);
    expect(out.map(p => p.holder)).toEqual(['people/alice-example', 'people/alice-example']);
  });

  test('a proposal the user explicitly accepted ("Yes, do that.") stays the person\'s', () => {
    const out = downgradeAssistantOnlyHolders([take('Annual prepay discounts are capped at 20%.', 'people/alice-example')], page);
    expect(out.map(p => p.holder)).toEqual(['people/alice-example']);
  });

  test('no content tokens, a number no turn states, or a bare year: nothing to decide', () => {
    const input = [
      take('The pro tier is under-priced.', 'people/alice-example'),
      take('We should target $99 per seat eventually.', 'people/alice-example'),
      take('The 2025 cohort is the one to study.', 'people/alice-example'),
    ];
    expect(downgradeAssistantOnlyHolders(input, page)).toBe(input);
  });

  test('a page without speaker turns is never checked', () => {
    const input = [take('Pro tier should be priced at $49 per seat.', 'people/alice-example')];
    expect(downgradeAssistantOnlyHolders(input, 'Pricing memo: the pro tier goes to $49 per seat; 12% churn expected.')).toBe(input);
  });

  test('non-person holders are never touched and the input is not mutated', () => {
    const input = [take('Pro tier should be priced at $49 per seat.', 'brain'), take('Churn will be 12%.', 'companies/acme-example'),
      take('Churn will be 12%.', 'people/bob-example')];
    const before = JSON.stringify(input);
    const out = downgradeAssistantOnlyHolders(input, page);
    expect(out.map(p => p.holder)).toEqual(['brain', 'companies/acme-example', 'brain']);
    expect(JSON.stringify(input)).toBe(before);
    expect(out).not.toBe(input);
  });

  test('claimContentTokens: numbers and dates in canonical form, quoted phrases normalized, bare years dropped', () => {
    expect(claimContentTokens('Ship by 2026-03-14 with $250K, 5% churn and "a quoted phrase here" in 2026')).toEqual([
      '250000', '5%', 'date:2026-03-14', 'md:3-14', 'q:a quoted phrase here',
    ]);
    expect(claimContentTokens('Nothing numeric here, "short"')).toEqual([]);
  });
});
