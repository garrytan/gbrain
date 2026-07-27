/**
 * Unit tests for the Retrieval Reflex pure extractor (#1981, T1).
 * No DB, no SDK — just the deterministic candidate extraction + precision filters.
 */
import { describe, test, expect } from 'bun:test';
import { extractCandidates, MAX_CANDIDATES } from '../../src/core/context/entity-salience.ts';

function queries(text: string): string[] {
  return extractCandidates(text).map((c) => c.query);
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

  test('documented v1 limit: lowercase names are NOT detected', () => {
    expect(queries('what about garry tan')).toEqual([]);
  });
});
