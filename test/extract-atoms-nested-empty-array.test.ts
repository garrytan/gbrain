/**
 * #6260: an empty array counts as the model's honest "nothing here" only at
 * top level. An atom's own `"concepts": []` inside a clipped or malformed
 * outer array must read as malformed output (a counted failure), never as a
 * zero-yield extraction that stamps the item done.
 */
import { describe, expect, test } from 'bun:test';
import { parseAtomsOutcome } from '../src/core/cycle/extract-atoms-parse.ts';

const ATOM = '{"title":"Acme founded","atom_type":"insight","body":"Acme was founded in 2020.","concepts":[]}';

describe('parseAtomsOutcome: nested empty arrays (#6260)', () => {
  test('a clipped response whose first atom has "concepts": [] is malformed, not zero-yield', () => {
    const outcome = parseAtomsOutcome(`[${ATOM},{"title":"Bob joi`);
    expect(outcome.ok).toBe(false);
  });

  test('complete JSON with a missing comma before a nested [] is malformed', () => {
    const outcome = parseAtomsOutcome('[{"title":"A","atom_type":"insight","body":"x" "concepts":[]}]');
    expect(outcome.ok).toBe(false);
  });

  test('complete JSON with a trailing comma after a nested [] is malformed', () => {
    const outcome = parseAtomsOutcome('[{"title":"A","atom_type":"insight","body":"x","concepts":[],}]');
    expect(outcome.ok).toBe(false);
  });

  test('a top-level [] after closed citation brackets is still the honest zero-yield', () => {
    expect(parseAtomsOutcome('Per [1], nothing: []')).toEqual({ ok: true, atoms: [] });
    expect(parseAtomsOutcome('[]')).toEqual({ ok: true, atoms: [] });
    expect(parseAtomsOutcome('{"atoms": []}')).toEqual({ ok: true, atoms: [] });
  });

  test('a complete atom with an empty concepts list still parses as that atom', () => {
    const outcome = parseAtomsOutcome(`[${ATOM}]`);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.atoms.map((a) => a.title)).toEqual(['Acme founded']);
  });
});
