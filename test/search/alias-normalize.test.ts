/**
 * T3 — alias normalization unit tests. The write path (ingest) and read path
 * (search) MUST normalize identically or stored aliases silently never match.
 */

import { describe, test, expect } from 'bun:test';
import { normalizeAlias, normalizeAliasList } from '../../src/core/search/alias-normalize.ts';

describe('normalizeAlias', () => {
  test('lowercases + trims + collapses whitespace', () => {
    expect(normalizeAlias('  Hall   of   Light ')).toBe('hall of light');
  });
  test('write and read of the same name converge', () => {
    expect(normalizeAlias('The Hall Of Light')).toBe(normalizeAlias('the hall of light'));
  });
  test('NFKC folds width variants', () => {
    expect(normalizeAlias('Ｍｉｎｇｔａｎｇ')).toBe('mingtang'); // fullwidth → ascii
  });
  test('keeps CJK', () => {
    expect(normalizeAlias(' 明堂 ')).toBe('明堂');
  });
  test('strips a layer of wrapping quotes/brackets from loose YAML', () => {
    expect(normalizeAlias('"Hall of Light"')).toBe('hall of light');
    expect(normalizeAlias('[Mingtang]')).toBe('mingtang');
  });
  test('empty / non-string → empty', () => {
    expect(normalizeAlias('')).toBe('');
    expect(normalizeAlias('   ')).toBe('');
    expect(normalizeAlias(undefined as unknown as string)).toBe('');
  });
});

describe('normalizeAliasList', () => {
  test('array → normalized + deduped, empties dropped', () => {
    expect(normalizeAliasList(['Hall of Light', 'hall of light', '', '  ', 'Mingtang']))
      .toEqual(['hall of light', 'mingtang']);
  });
  test('scalar string → single-element list', () => {
    expect(normalizeAliasList('Hall of Light')).toEqual(['hall of light']);
  });
  test('comma-separated scalar → split list', () => {
    expect(normalizeAliasList('Hall of Light, Mingtang, 明堂'))
      .toEqual(['hall of light', 'mingtang', '明堂']);
  });
  test('absent / non-string → empty list', () => {
    expect(normalizeAliasList(undefined)).toEqual([]);
    expect(normalizeAliasList(null)).toEqual([]);
    expect(normalizeAliasList(42)).toEqual([]);
  });
});
