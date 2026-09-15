// #4772 — pack-driven entity types for the READ-ONLY health/doctor/onboard
// counters. `entityTypesFromPack` unions the active pack's `primitive: entity`
// page types with the legacy literal set every counter hardcoded before, so
// no page counted today stops counting and pack-declared entity types start
// counting.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  LEGACY_ENTITY_TYPES,
  entityTypesFromPack,
  entityTypesForEngine,
  loadPackFromFile,
  parseSchemaPackManifest,
} from '../src/core/schema-pack/index.ts';
import { withEnv } from './helpers/with-env.ts';

const GBRAIN_BASE_PATH = join(import.meta.dir, '../src/core/schema-pack/base/gbrain-base.yaml');

describe('entityTypesFromPack (#4772)', () => {
  test('null pack falls back to exactly the legacy literal set', () => {
    expect(entityTypesFromPack(null)).toEqual([...LEGACY_ENTITY_TYPES]);
    expect(entityTypesFromPack(undefined)).toEqual([...LEGACY_ENTITY_TYPES]);
  });

  test('gbrain-base: every primitive:entity type counts (yc + civic were uncounted)', () => {
    const types = entityTypesFromPack(loadPackFromFile(GBRAIN_BASE_PATH));
    for (const t of ['person', 'company', 'yc', 'civic', 'entity', 'organization']) {
      expect(types).toContain(t);
    }
    // Non-entity primitives never count.
    expect(types).not.toContain('deal');
    expect(types).not.toContain('concept');
  });

  test('custom pack: pack types first (declaration order), legacy union after, deduped', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'custom-example',
      version: '0.1.0',
      extends: null,
      page_types: [
        { name: 'researcher', primitive: 'entity', path_prefixes: ['researchers/'], aliases: [], extractable: true, expert_routing: true },
        { name: 'paper', primitive: 'media', path_prefixes: ['papers/'], aliases: [], extractable: false, expert_routing: false },
        { name: 'person', primitive: 'entity', path_prefixes: ['people/'], aliases: [], extractable: true, expert_routing: false },
        { name: 'lab', primitive: 'entity', path_prefixes: ['labs/'], aliases: [], extractable: true, expert_routing: false },
      ],
      link_types: [],
    });
    const types = entityTypesFromPack(pack);
    expect(types.slice(0, 3)).toEqual(['researcher', 'person', 'lab']);
    expect(new Set(types).size).toBe(types.length);
    for (const t of LEGACY_ENTITY_TYPES) expect(types).toContain(t);
    expect(types).not.toContain('paper');
  });

  test('entityTypesForEngine resolves the active pack through the engine tier chain', async () => {
    const stub = { getConfig: async () => null };
    await withEnv({ GBRAIN_SCHEMA_PACK: 'gbrain-base' }, async () => {
      expect(await entityTypesForEngine(stub)).toContain('yc');
    });
    await withEnv({ GBRAIN_SCHEMA_PACK: 'gbrain-base-v2' }, async () => {
      const types = await entityTypesForEngine(stub);
      expect(types).not.toContain('yc');
      expect(types).toContain('organization');
    });
  });

  test('entityTypesForEngine never throws: an unresolvable pack yields the legacy set', async () => {
    const broken = { getConfig: async () => { throw new Error('db down'); } };
    await withEnv({ GBRAIN_SCHEMA_PACK: 'no-such-pack-example' }, async () => {
      expect(await entityTypesForEngine(broken)).toEqual([...LEGACY_ENTITY_TYPES]);
    });
  });
});
