// v0.38 T7d: facts/eligibility pack-aware parity tests.
//
// Pins the contract that extractableTypesFromPack(gbrain-base) returns
// the pre-v0.38 ELIGIBLE_TYPES list from src/core/facts/eligibility.ts:
//   ['note', 'meeting', 'slack', 'email', 'calendar-event', 'source', 'writing']

import { describe, expect, test } from 'bun:test';
import {
  extractableTypesFromPack,
  isExtractableType,
  parseSchemaPackManifest,
  loadPackFromFile,
} from '../src/core/schema-pack/index.ts';
import { join } from 'node:path';

const GBRAIN_BASE_PATH = join(import.meta.dir, '../src/core/schema-pack/base/gbrain-base.yaml');

// Pre-v0.38 ELIGIBLE_TYPES from src/core/facts/eligibility.ts:51
const LEGACY_ELIGIBLE = ['note', 'meeting', 'slack', 'email', 'calendar-event', 'source', 'writing'];

describe('extractableTypesFromPack (T7d) — gbrain-base parity', () => {
  test('gbrain-base extractable set matches legacy ELIGIBLE_TYPES exactly', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    const extractable = extractableTypesFromPack(pack);
    expect(extractable.size).toBe(LEGACY_ELIGIBLE.length);
    for (const t of LEGACY_ELIGIBLE) {
      expect(extractable.has(t)).toBe(true);
    }
    // None of the entity/concept-shape types are extractable in gbrain-base.
    expect(extractable.has('person')).toBe(false);
    expect(extractable.has('company')).toBe(false);
    expect(extractable.has('deal')).toBe(false);
    expect(extractable.has('concept')).toBe(false);
    expect(extractable.has('synthesis')).toBe(false);
  });

  test('isExtractableType per-type lookups match legacy', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    for (const t of LEGACY_ELIGIBLE) {
      expect(isExtractableType(pack, t)).toBe(true);
    }
    expect(isExtractableType(pack, 'person')).toBe(false);
    expect(isExtractableType(pack, 'unknown-type')).toBe(false);
  });

  test('research-shaped pack: paper + claim + finding extractable', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'research-state',
      version: '0.1.0',
      extends: null,
      page_types: [
        { name: 'paper', primitive: 'media', path_prefixes: ['papers/'], aliases: [], extractable: true, expert_routing: false },
        { name: 'claim', primitive: 'annotation', path_prefixes: ['claims/'], aliases: [], extractable: true, expert_routing: false },
        { name: 'finding', primitive: 'annotation', path_prefixes: ['findings/'], aliases: [], extractable: true, expert_routing: false },
        { name: 'researcher', primitive: 'entity', path_prefixes: ['researchers/'], aliases: [], extractable: false, expert_routing: true },
      ],
      link_types: [],
    });
    const extractable = extractableTypesFromPack(pack);
    expect(extractable.size).toBe(3);
    expect(extractable.has('paper')).toBe(true);
    expect(extractable.has('claim')).toBe(true);
    expect(extractable.has('finding')).toBe(true);
    expect(extractable.has('researcher')).toBe(false);
  });

  test('empty page_types returns empty Set', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'empty',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [],
    });
    expect(extractableTypesFromPack(pack).size).toBe(0);
  });
});
