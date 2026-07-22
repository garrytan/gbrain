// v0.42 — ExtractableSpec widening parity tests.
//
// Pins:
//   1. Back-compat: existing `extractable: true` shape parses unchanged.
//   2. Forward shape: `extractable: { prompt_template, fixture_corpus,
//      eval_dimensions, verifier_path }` parses cleanly.
//   3. Helper parity: extractableTypesFromPack returns same Set across both
//      shapes when each declares the type extractable.
//   4. New helper extractableSpecsFromPack returns the struct shape (or
//      empty default for boolean true).
//   5. D-EXTRACT-37: verifier_path reserved at parse time but REFUSES at
//      runtime in v0.42.

import { describe, expect, test } from 'bun:test';
import {
  parseSchemaPackManifest,
  SCHEMA_PACK_API_VERSION,
  extractableTypesFromPack,
  extractableSpecsFromPack,
  getExtractableSpec,
  isExtractableType,
  refuseVerifierPathInV042,
} from '../src/core/schema-pack/index.ts';

const BASE_PACK = {
  api_version: SCHEMA_PACK_API_VERSION,
  name: 'test-pack',
  version: '1.0.0',
};

describe('ExtractableSpec widening — back-compat (boolean shape)', () => {
  test('extractable: true parses unchanged from v0.38 shape', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [
        { name: 'note', primitive: 'temporal', extractable: true },
        { name: 'meeting', primitive: 'temporal', extractable: true },
        { name: 'person', primitive: 'entity', extractable: false },
      ],
    });
    expect(manifest.page_types[0].extractable).toBe(true);
    expect(manifest.page_types[1].extractable).toBe(true);
    expect(manifest.page_types[2].extractable).toBe(false);
  });

  test('extractable defaults to false when omitted', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [{ name: 'note', primitive: 'temporal' }],
    });
    expect(manifest.page_types[0].extractable).toBe(false);
  });

  test('extractableTypesFromPack returns correct Set for boolean shape', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [
        { name: 'note', primitive: 'temporal', extractable: true },
        { name: 'meeting', primitive: 'temporal', extractable: true },
        { name: 'person', primitive: 'entity', extractable: false },
      ],
    });
    const set = extractableTypesFromPack(manifest);
    expect(set.size).toBe(2);
    expect(set.has('note')).toBe(true);
    expect(set.has('meeting')).toBe(true);
    expect(set.has('person')).toBe(false);
  });
});

describe('ExtractableSpec widening — struct shape (v0.42)', () => {
  test('struct shape with prompt_template + fixtures + dims parses', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [
        {
          name: 'claim',
          primitive: 'annotation',
          extractable: {
            prompt_template: 'Extract claims from this page.',
            fixture_corpus: 'fixtures/extract/claim.jsonl',
            eval_dimensions: ['faithfulness', 'completeness'],
          },
        },
      ],
    });
    const ext = manifest.page_types[0].extractable;
    expect(typeof ext).toBe('object');
    if (typeof ext !== 'object') throw new Error('type guard failed');
    expect(ext.prompt_template).toBe('Extract claims from this page.');
    expect(ext.fixture_corpus).toBe('fixtures/extract/claim.jsonl');
    expect(ext.eval_dimensions).toEqual(['faithfulness', 'completeness']);
  });

  test('struct with empty fields parses (minimal struct)', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [
        {
          name: 'finding',
          primitive: 'annotation',
          extractable: {},
        },
      ],
    });
    const ext = manifest.page_types[0].extractable;
    expect(typeof ext).toBe('object');
    if (typeof ext !== 'object') throw new Error('type guard failed');
    expect(ext.eval_dimensions).toEqual([]);
  });

  test('isExtractableType returns true for struct shape', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [
        {
          name: 'claim',
          primitive: 'annotation',
          extractable: { prompt_template: 'hi' },
        },
        { name: 'note', primitive: 'temporal', extractable: false },
      ],
    });
    expect(isExtractableType(manifest, 'claim')).toBe(true);
    expect(isExtractableType(manifest, 'note')).toBe(false);
    expect(isExtractableType(manifest, 'nonexistent')).toBe(false);
  });

  test('extractableTypesFromPack returns Set for mixed shapes', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [
        { name: 'note', primitive: 'temporal', extractable: true },
        {
          name: 'claim',
          primitive: 'annotation',
          extractable: { prompt_template: 'extract claims' },
        },
        { name: 'person', primitive: 'entity', extractable: false },
      ],
    });
    const set = extractableTypesFromPack(manifest);
    expect(set.size).toBe(2);
    expect(set.has('note')).toBe(true);
    expect(set.has('claim')).toBe(true);
    expect(set.has('person')).toBe(false);
  });

  test('extractable: { benchmark_min_recall } parses with float in [0,1]', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [
        {
          name: 'claim',
          primitive: 'annotation',
          extractable: { benchmark_min_recall: 0.85 },
        },
      ],
    });
    const ext = manifest.page_types[0].extractable;
    if (typeof ext !== 'object') throw new Error('type guard failed');
    expect(ext.benchmark_min_recall).toBe(0.85);
  });

  test('extractable: { benchmark_min_recall: 1.5 } REJECTS (out of range)', () => {
    expect(() =>
      parseSchemaPackManifest({
        ...BASE_PACK,
        page_types: [
          {
            name: 'claim',
            primitive: 'annotation',
            extractable: { benchmark_min_recall: 1.5 },
          },
        ],
      }),
    ).toThrow();
  });
});

describe('extractableSpecsFromPack — v0.42 new helper', () => {
  test('returns struct spec for struct-shape types', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [
        {
          name: 'claim',
          primitive: 'annotation',
          extractable: {
            prompt_template: 'Extract claims',
            eval_dimensions: ['faithfulness'],
          },
        },
      ],
    });
    const map = extractableSpecsFromPack(manifest);
    expect(map.size).toBe(1);
    const spec = map.get('claim');
    expect(spec?.prompt_template).toBe('Extract claims');
    expect(spec?.eval_dimensions).toEqual(['faithfulness']);
  });

  test('returns empty default spec for boolean-true types', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [{ name: 'note', primitive: 'temporal', extractable: true }],
    });
    const map = extractableSpecsFromPack(manifest);
    expect(map.size).toBe(1);
    const spec = map.get('note');
    expect(spec).toBeDefined();
    expect(spec?.eval_dimensions).toEqual([]);
    expect(spec?.prompt_template).toBeUndefined();
  });

  test('excludes non-extractable types', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [
        { name: 'note', primitive: 'temporal', extractable: true },
        { name: 'person', primitive: 'entity', extractable: false },
      ],
    });
    const map = extractableSpecsFromPack(manifest);
    expect(map.size).toBe(1);
    expect(map.has('note')).toBe(true);
    expect(map.has('person')).toBe(false);
  });

  test('getExtractableSpec returns null for non-extractable / missing', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [
        { name: 'note', primitive: 'temporal', extractable: true },
        { name: 'person', primitive: 'entity', extractable: false },
      ],
    });
    expect(getExtractableSpec(manifest, 'note')).not.toBeNull();
    expect(getExtractableSpec(manifest, 'person')).toBeNull();
    expect(getExtractableSpec(manifest, 'nonexistent')).toBeNull();
  });
});

describe('D-EXTRACT-37 — verifier_path reserved + REFUSE at runtime in v0.42', () => {
  test('verifier_path parses at schema level (forward-compat)', () => {
    const manifest = parseSchemaPackManifest({
      ...BASE_PACK,
      page_types: [
        {
          name: 'claim',
          primitive: 'annotation',
          extractable: { verifier_path: 'verifiers/claim.js' },
        },
      ],
    });
    const ext = manifest.page_types[0].extractable;
    if (typeof ext !== 'object') throw new Error('type guard failed');
    expect(ext.verifier_path).toBe('verifiers/claim.js');
  });

  test('refuseVerifierPathInV042 throws with paste-ready hint when set', () => {
    expect(() => refuseVerifierPathInV042({ verifier_path: 'verifiers/claim.js' }, 'claim'))
      .toThrow(/not supported in v0\.42/);
    expect(() => refuseVerifierPathInV042({ verifier_path: 'verifiers/claim.js' }, 'claim'))
      .toThrow(/claim/);
    expect(() => refuseVerifierPathInV042({ verifier_path: 'verifiers/claim.js' }, 'claim'))
      .toThrow(/v0\.43/);
  });

  test('refuseVerifierPathInV042 no-op when not set', () => {
    expect(() => refuseVerifierPathInV042({}, 'claim')).not.toThrow();
    expect(() => refuseVerifierPathInV042({ verifier_path: undefined }, 'claim')).not.toThrow();
  });
});
