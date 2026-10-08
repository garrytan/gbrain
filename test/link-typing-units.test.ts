/**
 * Typing units (src/core/link-typing-units.ts): each example's frozen type, tense, transitions and as-of result with
 * no unit, with only its own unit, and with every shipped unit (test/helpers/typing-unit-examples.ts).
 */
import { describe, expect, test } from 'bun:test';
import { TYPING_UNITS, ENABLED_TYPING_UNITS, activeTypingUnits, parseTypingUnits, withTypingUnits, type TypingUnit } from '../src/core/link-typing-units.ts';
import { EXAMPLES, expected, observe } from './helpers/typing-unit-examples.ts';

const sets: Array<[string, TypingUnit[]]> = [['none', []], ...TYPING_UNITS.map(u => [u, [u]] as [string, TypingUnit[]]), ['all', [...TYPING_UNITS]]];

describe('typing units: frozen examples', () => {
  for (const [label, units] of sets) {
    test(`unit set ${label}`, async () => {
      await withTypingUnits(units, async () => {
        for (const ex of EXAMPLES) {
          const want = expected(ex, new Set(units));
          expect({ id: ex.id, ...(await observe(ex, want)) }).toEqual({ id: ex.id, ...want });
        }
      });
    });
  }
});

describe('typing unit switch', () => {
  test('the build ships the confirmed package: U3, U4, U1', () => {
    expect([...ENABLED_TYPING_UNITS]).toEqual(['U3', 'U4', 'U1']);
    expect(activeTypingUnits()).toEqual(['U1', 'U3', 'U4']);
  });
  test('withTypingUnits restores the previous set', async () => {
    await withTypingUnits(['U3', 'U1'], () => expect(activeTypingUnits()).toEqual(['U1', 'U3']));
    await withTypingUnits([], () => expect(activeTypingUnits()).toEqual([]));
    expect(activeTypingUnits()).toEqual(['U1', 'U3', 'U4']);
  });
  test('unknown or removed unit ids are refused with the list of units', () => {
    expect(() => parseTypingUnits(['U2'])).toThrow(/Unknown typing unit "U2". The units are U1, U3, U4 and the joint U34/);
    expect(() => parseTypingUnits(['U25'])).toThrow(/Unknown typing unit "U25"/);
    expect(parseTypingUnits(['u3', ' U1 ', 'U3'])).toEqual(['U3', 'U1']);
  });
});
