// v0.38 T_E: enrichment pack-aware parity tests.

import { describe, expect, test } from 'bun:test';
import {
  enrichableTypesFromPack,
  rubricNameForType,
  parseSchemaPackManifest,
  loadPackFromFile,
} from '../src/core/schema-pack/index.ts';
import { join } from 'node:path';

const GBRAIN_BASE_PATH = join(import.meta.dir, '../src/core/schema-pack/base/gbrain-base.yaml');

describe('enrichableTypesFromPack (T_E) — gbrain-base parity', () => {
  test('gbrain-base declares person + company + deal as enrichable', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    const enrichable = enrichableTypesFromPack(pack);
    expect(enrichable.has('person')).toBe(true);
    expect(enrichable.has('company')).toBe(true);
    expect(enrichable.has('deal')).toBe(true);
  });

  test('rubricNameForType returns the declared slot name', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    expect(rubricNameForType(pack, 'person')).toBe('person-default');
    expect(rubricNameForType(pack, 'company')).toBe('company-default');
    expect(rubricNameForType(pack, 'deal')).toBe('deal-default');
  });

  test('rubricNameForType returns null for unknown / non-enrichable type', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    expect(rubricNameForType(pack, 'note')).toBeNull();
    expect(rubricNameForType(pack, 'random')).toBeNull();
  });

  test('custom pack overrides enrichable types', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'research',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [],
      enrichable_types: [
        { type: 'researcher', rubric: 'researcher-default' },
        { type: 'paper', rubric: 'paper-default' },
      ],
    });
    const enrichable = enrichableTypesFromPack(pack);
    expect(enrichable.has('researcher')).toBe(true);
    expect(enrichable.has('paper')).toBe(true);
    expect(enrichable.has('person')).toBe(false);
    expect(rubricNameForType(pack, 'researcher')).toBe('researcher-default');
  });
});
