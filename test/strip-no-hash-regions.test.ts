import { describe, test, expect } from 'bun:test';
import { stripNoHashRegions } from '../src/core/markdown.ts';

describe('stripNoHashRegions', () => {
  test('strips a single sentinel-wrapped region', () => {
    const text = 'before <!-- gbrain:no-hash-start -->presentation<!-- gbrain:no-hash-end --> after';
    expect(stripNoHashRegions(text)).toBe('before  after');
  });

  test('strips multiple sentinel-wrapped regions', () => {
    const text = 'A <!-- gbrain:no-hash-start -->X<!-- gbrain:no-hash-end --> B <!-- gbrain:no-hash-start -->Y<!-- gbrain:no-hash-end --> C';
    expect(stripNoHashRegions(text)).toBe('A  B  C');
  });

  test('strips multi-line content inside sentinel', () => {
    const text = 'before\n<!-- gbrain:no-hash-start -->\nline 1\nline 2\n<!-- gbrain:no-hash-end -->\nafter';
    expect(stripNoHashRegions(text)).toBe('before\n\nafter');
  });

  test('tolerates whitespace inside the comment tags', () => {
    const text = '<!--   gbrain:no-hash-start   -->X<!--   gbrain:no-hash-end   -->';
    expect(stripNoHashRegions(text)).toBe('');
  });

  test('leaves text without sentinels unchanged', () => {
    const text = 'this is plain text with no sentinels';
    expect(stripNoHashRegions(text)).toBe(text);
  });

  test('leaves unmatched start sentinel alone (no closing marker = no strip)', () => {
    const text = 'before <!-- gbrain:no-hash-start --> never closes';
    expect(stripNoHashRegions(text)).toBe(text);
  });
});
