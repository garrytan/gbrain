import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const loaderSrc = readFileSync(
  new URL('../src/core/cycle/allowed-slug-prefixes.ts', import.meta.url),
  'utf8',
);
const synthesizeSrc = readFileSync(
  new URL('../src/core/cycle/synthesize.ts', import.meta.url),
  'utf8',
);
const patternsSrc = readFileSync(
  new URL('../src/core/cycle/patterns.ts', import.meta.url),
  'utf8',
);

describe('dream allow-list loader', () => {
  test('has packaged and schema-pack fallbacks beyond workspace skills files', () => {
    expect(loaderSrc).toContain("../../../skills/_brain-filing-rules.json");
    expect(loaderSrc).toContain('loadActivePack');
    expect(loaderSrc).toContain('deriveAllowedSlugPrefixesFromSchemaPack');
  });

  test('synthesize and patterns share the production loader', () => {
    expect(synthesizeSrc).toContain("import { loadAllowedSlugPrefixes } from './allowed-slug-prefixes.ts'");
    expect(patternsSrc).toContain("import { loadAllowedSlugPrefixes } from './allowed-slug-prefixes.ts'");
  });
});
