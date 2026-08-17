/**
 * Unit tests for the Retrieval Reflex pure extractor (#1981, T1).
 * No DB, no SDK — just the deterministic candidate extraction + precision filters.
 */
import { describe, test, expect } from 'bun:test';
import {
  extractCandidates,
  extractCandidatesFromWindow,
  MAX_CANDIDATES,
  MAX_WEAK_CANDIDATES,
} from '../../src/core/context/entity-salience.ts';

/** STRONG candidate queries only (the v1 contract most tests pin). */
function queries(text: string): string[] {
  return extractCandidates(text)
    .filter((c) => !c.weak)
    .map((c) => c.query);
}

function weakQueries(text: string): string[] {
  return extractCandidates(text)
    .filter((c) => c.weak)
    .map((c) => c.query);
}

describe('extractCandidates', () => {
  test('multi-word capitalized run', () => {
    expect(queries('what do you think about Garry Tan?')).toContain('Garry Tan');
  });

  test('@handles are captured without the @ in the query, with @ in display', () => {
    const c = extractCandidates('ping @garry about it');
    const handle = c.find((x) => x.display === '@garry');
    expect(handle).toBeDefined();
    expect(handle!.query).toBe('garry');
  });

  test('drops hard stopwords even capitalized', () => {
    const q = queries('What should We do? The plan is set.');
    expect(q).not.toContain('What');
    expect(q).not.toContain('We');
    expect(q).not.toContain('The');
  });

  test('drops weekday/common words seen only at sentence start', () => {
    // Re-pinned for the v0.46.15 identity wave: STRONG extraction still drops
    // these; the lowercase pass may emit weak candidates ("ship", "busy"),
    // which are alias-arm-restricted and cannot fabricate pointers.
    expect(queries('Monday we ship. Today is busy.')).toEqual([]);
  });

  test('keeps a real name even at sentence start', () => {
    expect(queries('Sarah went home early.')).toContain('Sarah');
  });

  test('keeps a common-looking word if also seen capitalized mid-sentence', () => {
    // "Apple" appears mid-sentence → strong entity signal, kept despite being common-ish.
    expect(queries('I love Apple. Apple makes phones.')).toContain('Apple');
  });

  test('rejects single chars and pure numbers', () => {
    const q = queries('A 2026 plan');
    expect(q).not.toContain('A');
    expect(q).not.toContain('2026');
  });

  test('strips possessive', () => {
    expect(queries("Garry's idea")).toContain('Garry');
  });

  test('dedups on normalized form', () => {
    const q = queries('Garry and Garry again');
    expect(q.filter((x) => x.toLowerCase() === 'garry')).toHaveLength(1);
  });

  test('caps at MAX_CANDIDATES', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Person${String.fromCharCode(65 + (i % 26))}x${i}`).join(' ');
    expect(extractCandidates(many).length).toBeLessThanOrEqual(MAX_CANDIDATES);
  });

  test('empty / non-string input → []', () => {
    expect(extractCandidates('')).toEqual([]);
    // @ts-expect-error intentional bad input
    expect(extractCandidates(null)).toEqual([]);
  });

  test('lowercase names are now detected as WEAK candidates (v1 limit lifted at extraction)', () => {
    // Re-pinned for the v0.46.15 identity wave (was: "lowercase names are NOT
    // detected"). The lowercase pass emits weak, alias-arm-restricted
    // candidates; strong extraction stays capitalization-biased.
    expect(queries('what about garry tan')).toEqual([]);
    const weak = weakQueries('what about garry tan');
    expect(weak).toContain('garry');
    expect(weak).toContain('tan');
  });

  test('leading-stopword trim: surname escapes a glued auxiliary', () => {
    // "Did Galewright" is the raw run; the trimmed remainder must ALSO be a
    // strong candidate (kta-pos variant 4, the documented surname-only limit).
    const q = queries('Did Galewright ever follow up on that intro?');
    expect(q).toContain('Galewright');
    expect(q).toContain('Did Galewright'); // original run preserved
  });

  test('trim keeps multi-token remainders whole', () => {
    expect(queries('Did Garry Tan reply?')).toContain('Garry Tan');
  });

  test('weak candidates: possessives stripped, stopwords/common excluded, deduped vs strong', () => {
    const weak = weakQueries("remind me what saoirse's take on the round was");
    expect(weak).toContain('saoirse');
    expect(weak).not.toContain('the'); // stopword
    expect(weak).not.toContain('me');  // stopword (and <3 chars)
    const both = extractCandidates('Apple and apple again');
    // lowercase "apple" is covered by the strong "Apple" candidate — no weak dup
    expect(both.filter((c) => c.weak).map((c) => c.query)).not.toContain('apple');
  });

  test('weak candidates ride a separate budget and never evict strong ones', () => {
    const strongPart = Array.from({ length: 20 }, (_, i) => `Personx${i}q`).join('. ');
    const weakPart = Array.from({ length: 50 }, (_, i) => `wkword${i}xy`).join(' ');
    const out = extractCandidates(`${strongPart}. ${weakPart}`);
    const strong = out.filter((c) => !c.weak);
    const weak = out.filter((c) => c.weak);
    expect(strong.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(strong.length).toBe(MAX_CANDIDATES); // weak never displaces strong
    expect(weak.length).toBeLessThanOrEqual(MAX_WEAK_CANDIDATES);
    // strong candidates come first in the output
    expect(out.findIndex((c) => c.weak)).toBeGreaterThanOrEqual(strong.length);
  });
});

describe('extractCandidatesFromWindow — weak threading (v0.46.15)', () => {
  test('weak flag survives the window merge', () => {
    const out = extractCandidatesFromWindow([
      { role: 'user', text: 'remind me what saoirse said' },
    ]);
    const saoirse = out.find((c) => c.query === 'saoirse');
    expect(saoirse).toBeDefined();
    expect(saoirse!.weak).toBe(true);
  });

  test('a strong sighting upgrades a weak-born candidate and takes its surface', () => {
    const out = extractCandidatesFromWindow([
      { role: 'user', text: 'remind me what saoirse said' },
      { role: 'user', text: 'I met Saoirse yesterday' },
    ]);
    const c = out.find((x) => x.query.toLowerCase() === 'saoirse');
    expect(c).toBeDefined();
    expect(c!.weak).toBeUndefined();
    expect(c!.display).toBe('Saoirse');
  });

  test('strong candidates rank strictly above weak, with separate budgets', () => {
    const weakTurn = Array.from({ length: 40 }, (_, i) => `wkword${i}xy`).join(' ');
    const out = extractCandidatesFromWindow([
      { role: 'assistant', text: 'Galewright shipped the memo' }, // old strong
      { role: 'user', text: weakTurn },                            // fresh weak noise
    ]);
    const strongIdx = out.findIndex((c) => c.query === 'Galewright');
    expect(strongIdx).toBe(0); // recent weak noise never outranks an older strong candidate
    expect(out.filter((c) => !c.weak).length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(out.filter((c) => c.weak).length).toBeLessThanOrEqual(MAX_WEAK_CANDIDATES);
  });
});

describe('v0.46.15 ship-review F10 — rejected strong candidates do not shadow weak probes', () => {
  test('a name pushed past MAX_CANDIDATES still gets its lowercase weak probe', () => {
    // 12 strong names consume the strong cap; the 13th name appears ONLY
    // beyond the cap plus once lowercase. strongNorms built from the raw
    // accumulator would suppress the weak probe for a name that was never
    // actually emitted as strong.
    const names = Array.from({ length: 13 }, (_, i) => `Zed Persona${i}`);
    const text = names.map((n) => `${n} joined.`).join(' ') + ' later persona12 pinged me again';
    const out = extractCandidates(text);
    const strong = out.filter((c) => !c.weak);
    expect(strong.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    const weak = out.filter((c) => c.weak);
    expect(weak.some((c) => c.query === 'persona12')).toBe(true);
  });
});
