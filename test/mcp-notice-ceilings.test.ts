/**
 * C4 (cost wave): the saved-facts and other-names notice blocks have hard
 * character ceilings (1,500 and 400, header included). Items are whole: a
 * fact or alias pair is never cut, so its provenance stays intact; the first
 * item is always shown even when it alone is over the ceiling; a marker
 * counts what was left out. Under the ceilings the blocks are unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { OTHER_NAMES_NOTICE_MAX_CHARS, SAVED_FACTS_NOTICE_MAX_CHARS, retrievalNoticeBlocks } from '../src/mcp/dispatch.ts';

const FACTS_HEAD = 'Saved facts (remember): about the entity this query names (newest first), then facts those point to, then matches for its words; recall returns more:\n';
const NAMES_HEAD = 'Other names in these results (documents may use either; search the one you have not tried): ';

const fact = (text: string, i = 0) => ({ fact: text, entity_slug: `e${i}`, valid_from: '2026-09-01T00:00:00Z', source: 'user update' });
const factLine = (f: ReturnType<typeof fact>) => `- ${f.fact} [entity: ${f.entity_slug}; saved 2026-09-01; provenance: ${f.source}]`;
const factsBlock = (facts: Array<ReturnType<typeof fact>>) => retrievalNoticeBlocks([{}], { saved_facts: facts })[0];
const pair = (alias: string, i = 0) => ({ name: `Name ${i}`, alias, slug: `crm/n${i}` });
const pairText = (p: ReturnType<typeof pair>) => `${p.alias} = ${p.name} (declared in ${p.slug})`;
const namesBlock = (pairs: Array<ReturnType<typeof pair>>) => retrievalNoticeBlocks([{}], { other_names: pairs })[0];

/** A fact whose rendered line is exactly `len` characters. */
function factOfLine(len: number, i: number) {
  const base = factLine(fact('', i)).length;
  return fact('x'.repeat(len - base), i);
}

describe('saved facts notice: 1,500 characters, whole facts', () => {
  test('constants', () => {
    expect(SAVED_FACTS_NOTICE_MAX_CHARS).toBe(1500);
    expect(OTHER_NAMES_NOTICE_MAX_CHARS).toBe(400);
  });

  test('under the ceiling the block is unchanged', () => {
    const facts = [fact('The billing contact for Acme Example is a new person.', 1), fact('Renewal quotes go to billing.', 2)];
    expect(factsBlock(facts)).toBe(`${FACTS_HEAD}${facts.map(factLine).join('\n')}`);
  });

  test('a block of exactly 1,500 characters keeps every fact', () => {
    const first = factOfLine(700, 1);
    const second = factOfLine(1500 - FACTS_HEAD.length - 700 - 1, 2);
    const block = factsBlock([first, second]);
    expect(block.length).toBe(1500);
    expect(block).not.toContain('more; recall returns them');
  });

  test('one character over drops the whole last fact and counts it', () => {
    const first = factOfLine(700, 1);
    const second = factOfLine(1500 - FACTS_HEAD.length - 700, 2);
    const block = factsBlock([first, second]);
    expect(block).toBe(`${FACTS_HEAD}${factLine(first)}\n(+1 more; recall returns them)`);
  });

  test('a first fact alone over the ceiling is shown whole; the ceiling applies from the second', () => {
    const big = factOfLine(1600, 1);
    const block = factsBlock([big, fact('small', 2), fact('small too', 3)]);
    expect(block).toBe(`${FACTS_HEAD}${factLine(big)}\n(+2 more; recall returns them)`);
  });

  test('shown facts are never cut: every line is a complete rendered fact', () => {
    const facts = Array.from({ length: 5 }, (_, i) => factOfLine(400, i));
    const block = factsBlock(facts);
    expect(block.length).toBeLessThanOrEqual(1500 + '\n(+9 more; recall returns them)'.length);
    const lines = block.slice(FACTS_HEAD.length).split('\n');
    const shown = lines.filter(l => l.startsWith('- '));
    expect(shown).toEqual(facts.slice(0, shown.length).map(factLine));
    expect(lines.at(-1)).toBe(`(+${5 - shown.length} more; recall returns them)`);
  });
});

describe('other names notice: 400 characters, whole pairs', () => {
  test('under the ceiling the block is unchanged', () => {
    const pairs = [pair('NULA', 1), pair('ACME', 2)];
    expect(namesBlock(pairs)).toBe(`${NAMES_HEAD}${pairs.map(pairText).join('; ')}.`);
  });

  test('exactly 400 characters before the closing period keeps every pair', () => {
    const first = pair('A'.repeat(100), 1);
    const rest = 400 - NAMES_HEAD.length - pairText(first).length - 2 - pairText(pair('', 2)).length;
    const second = pair('B'.repeat(rest), 2);
    const block = namesBlock([first, second]);
    expect(block.length).toBe(401);
    expect(block).not.toContain('more)');
  });

  test('one character over drops the whole last pair and counts it', () => {
    const first = pair('A'.repeat(100), 1);
    const rest = 400 - NAMES_HEAD.length - pairText(first).length - 2 - pairText(pair('', 2)).length + 1;
    const block = namesBlock([first, pair('B'.repeat(rest), 2)]);
    expect(block).toBe(`${NAMES_HEAD}${pairText(first)} (+1 more).`);
  });

  test('a first pair alone over the ceiling is shown whole', () => {
    const big = pair('Z'.repeat(450), 1);
    expect(namesBlock([big, pair('Q', 2)])).toBe(`${NAMES_HEAD}${pairText(big)} (+1 more).`);
  });
});
