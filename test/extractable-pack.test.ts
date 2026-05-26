// v0.38 T7d: facts/eligibility pack-aware parity tests.
//
// Pins the contract that extractableTypesFromPack(gbrain-base) returns
// the configured eligible set declared by gbrain-base.yaml. The pre-v0.38
// `ELIGIBLE_TYPES` constant from src/core/facts/eligibility.ts was the
// seed (note/meeting/slack/email/calendar-event/source/writing); v0.41.11
// promotes concept + conversation into the same set as part of the
// conversation retrieval upgrade. `atom` is explicitly pinned
// non-extractable so a future drift fails loudly.

import { describe, expect, test } from 'bun:test';
import {
  extractableTypesFromPack,
  isExtractableType,
  parseSchemaPackManifest,
  loadPackFromFile,
} from '../src/core/schema-pack/index.ts';
import { join } from 'node:path';

const GBRAIN_BASE_PATH = join(import.meta.dir, '../src/core/schema-pack/base/gbrain-base.yaml');

// Pre-v0.38 seed ELIGIBLE_TYPES from src/core/facts/eligibility.ts:51.
const LEGACY_ELIGIBLE = ['note', 'meeting', 'slack', 'email', 'calendar-event', 'source', 'writing'];

// v0.41.11+ additions: concept page bodies define concepts and routinely
// contain claim-shaped statements; conversation pages carry the imported
// chat history the batch facts extractor walks. Both flipped to
// `extractable: true` in gbrain-base.yaml.
const V0_41_11_ADDED_ELIGIBLE = ['concept', 'conversation'];
const CURRENT_ELIGIBLE = [...LEGACY_ELIGIBLE, ...V0_41_11_ADDED_ELIGIBLE];

describe('extractableTypesFromPack (T7d) — gbrain-base parity', () => {
  test('gbrain-base extractable set matches the configured eligible list', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    const extractable = extractableTypesFromPack(pack);
    expect(extractable.size).toBe(CURRENT_ELIGIBLE.length);
    for (const t of CURRENT_ELIGIBLE) {
      expect(extractable.has(t)).toBe(true);
    }
    // Entity-shape + annotation-shape types stay non-extractable in gbrain-base.
    // `atom` is annotation (and IS the extracted unit), so it must not
    // be extractable itself — running the extractor on it would loop.
    expect(extractable.has('person')).toBe(false);
    expect(extractable.has('company')).toBe(false);
    expect(extractable.has('deal')).toBe(false);
    expect(extractable.has('synthesis')).toBe(false);
    expect(extractable.has('atom')).toBe(false);
  });

  test('legacy seed types remain extractable (back-compat)', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    const extractable = extractableTypesFromPack(pack);
    for (const t of LEGACY_ELIGIBLE) {
      expect(extractable.has(t)).toBe(true);
    }
  });

  test('v0.41.11 additions (concept + conversation) are extractable', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    for (const t of V0_41_11_ADDED_ELIGIBLE) {
      expect(isExtractableType(pack, t)).toBe(true);
    }
  });

  test('isExtractableType per-type lookups match the configured set', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    for (const t of CURRENT_ELIGIBLE) {
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
