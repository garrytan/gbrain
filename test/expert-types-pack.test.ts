// v0.38 T_W: pack-driven expert types parity tests.
//
// Pins the contract that expertTypesFromPack(gbrain-base) returns the
// pre-v0.38 hardcoded DEFAULT_TYPES = ['person', 'company']. User packs
// override by setting expert_routing: true on different types.

import { describe, expect, test } from 'bun:test';
import {
  expertTypesFromPack,
  expertTypesFromPackOrThrow,
  parseSchemaPackManifest,
  loadPackFromFile,
} from '../src/core/schema-pack/index.ts';
import { join } from 'node:path';

const GBRAIN_BASE_PATH = join(import.meta.dir, '../src/core/schema-pack/base/gbrain-base.yaml');

describe('expertTypesFromPack (T_W) — gbrain-base parity', () => {
  test('gbrain-base returns [person, company]', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    const types = expertTypesFromPack(pack);
    expect(types.sort()).toEqual(['company', 'person']);
  });

  test('research-shaped pack returns researcher + principal-investigator', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'research-state',
      version: '0.1.0',
      extends: null,
      page_types: [
        { name: 'researcher', primitive: 'entity', path_prefixes: ['researchers/'], aliases: [], extractable: true, expert_routing: true },
        { name: 'principal-investigator', primitive: 'entity', path_prefixes: ['pis/'], aliases: ['researcher'], extractable: true, expert_routing: true },
        { name: 'paper', primitive: 'media', path_prefixes: ['papers/'], aliases: [], extractable: false, expert_routing: false },
        { name: 'method', primitive: 'concept', path_prefixes: ['methods/'], aliases: [], extractable: false, expert_routing: false },
      ],
      link_types: [],
    });
    const types = expertTypesFromPack(pack);
    expect(types).toEqual(['researcher', 'principal-investigator']);
  });

  test('preserves declaration order from manifest', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'test',
      version: '0.1.0',
      extends: null,
      page_types: [
        { name: 'zebra', primitive: 'entity', path_prefixes: [], aliases: [], extractable: false, expert_routing: true },
        { name: 'apple', primitive: 'entity', path_prefixes: [], aliases: [], extractable: false, expert_routing: false },
        { name: 'mango', primitive: 'entity', path_prefixes: [], aliases: [], extractable: false, expert_routing: true },
      ],
      link_types: [],
    });
    // NOT sorted: declaration order is preserved (zebra before mango).
    expect(expertTypesFromPack(pack)).toEqual(['zebra', 'mango']);
  });

  test('pack with no expert_routing types returns empty array', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'media-only',
      version: '0.1.0',
      extends: null,
      page_types: [
        { name: 'article', primitive: 'media', path_prefixes: [], aliases: [], extractable: false, expert_routing: false },
        { name: 'book', primitive: 'media', path_prefixes: [], aliases: [], extractable: false, expert_routing: false },
      ],
      link_types: [],
    });
    expect(expertTypesFromPack(pack)).toEqual([]);
  });

  test('expertTypesFromPackOrThrow throws on empty', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'media-only',
      version: '0.1.0',
      extends: null,
      page_types: [
        { name: 'article', primitive: 'media', path_prefixes: [], aliases: [], extractable: false, expert_routing: false },
      ],
      link_types: [],
    });
    expect(() => expertTypesFromPackOrThrow(pack)).toThrow(/declares no types with expert_routing/);
  });

  test('expertTypesFromPackOrThrow passes when types exist', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    expect(() => expertTypesFromPackOrThrow(pack)).not.toThrow();
  });
});
