/**
 * Tests for src/core/skillpack/registry-schema.ts — validators for
 * registry.json + endorsements.json.
 */
import { describe, test, expect } from 'bun:test';

import {
  REGISTRY_SCHEMA_VERSION,
  ENDORSEMENTS_SCHEMA_VERSION,
  RegistrySchemaError,
  validateRegistryCatalog,
  validateRegistryEntry,
  validateEndorsementsFile,
  effectiveTier,
  type RegistryCatalog,
  type RegistryEntry,
  type EndorsementsFile,
} from '../src/core/skillpack/registry-schema.ts';

const VALID_ENTRY: RegistryEntry = {
  name: 'hackathon-evaluation',
  description: 'Score hackathon submissions',
  author: 'Garry Tan',
  author_handle: 'garrytan',
  homepage: 'https://github.com/garrytan/skillpack-hackathon-evaluation',
  source: {
    kind: 'git',
    url: 'https://github.com/garrytan/skillpack-hackathon-evaluation.git',
    pinned_commit: 'abc1234567890abcdef1234567890abcdef12345',
  },
  tarball_sha256: 'deadbeef'.repeat(8),
  gbrain_min_version: '0.36.0',
  default_tier: 'community',
  tags: ['evaluation', 'yc'],
  validated_at: '2026-05-18T20:00:00Z',
  validation_run_id: '2026-05-18T19-58-12',
  skills_count: 2,
  skills: ['skills/judge-submission', 'skills/score-rubric'],
  version: '0.1.0',
};

const VALID_CATALOG: RegistryCatalog = {
  schema_version: REGISTRY_SCHEMA_VERSION,
  updated_at: '2026-05-18T20:00:00Z',
  skillpacks: [VALID_ENTRY],
};

describe('validateRegistryCatalog', () => {
  test('accepts a minimal valid catalog', () => {
    expect(() => validateRegistryCatalog(VALID_CATALOG)).not.toThrow();
  });

  test('rejects malformed top-level', () => {
    for (const bad of ['x', null, [], 42]) {
      expect(() => validateRegistryCatalog(bad)).toThrow(RegistrySchemaError);
    }
  });

  test('rejects wrong schema_version', () => {
    try {
      validateRegistryCatalog({
        ...VALID_CATALOG,
        schema_version: 'gbrain-registry-v99',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistrySchemaError).code).toBe('unknown_schema');
    }
  });

  test('rejects non-array skillpacks', () => {
    try {
      validateRegistryCatalog({ ...VALID_CATALOG, skillpacks: {} });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistrySchemaError).code).toBe('invalid_field');
    }
  });

  test('accepts valid bundles map', () => {
    expect(() =>
      validateRegistryCatalog({
        ...VALID_CATALOG,
        bundles: { 'starter-pack': ['hackathon-evaluation'] },
      }),
    ).not.toThrow();
  });

  test('rejects bundles map with non-string-array value', () => {
    try {
      validateRegistryCatalog({
        ...VALID_CATALOG,
        bundles: { broken: [42] },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistrySchemaError).code).toBe('invalid_field');
    }
  });
});

describe('validateRegistryEntry', () => {
  test('accepts a complete entry', () => {
    expect(() => validateRegistryEntry(VALID_ENTRY)).not.toThrow();
  });

  test('rejects each required field individually', () => {
    const required = [
      'name',
      'description',
      'author',
      'author_handle',
      'homepage',
      'source',
      'tarball_sha256',
      'gbrain_min_version',
      'default_tier',
      'tags',
      'validated_at',
      'validation_run_id',
      'skills_count',
      'skills',
      'version',
    ] as const;
    for (const field of required) {
      const bad = { ...VALID_ENTRY } as Record<string, unknown>;
      delete bad[field];
      try {
        validateRegistryEntry(bad);
        throw new Error(`should have thrown for ${field}`);
      } catch (err) {
        expect((err as RegistrySchemaError).code).toBe('missing_field');
        expect((err as RegistrySchemaError).detail?.field).toBe(field);
      }
    }
  });

  test('rejects non-kebab name', () => {
    try {
      validateRegistryEntry({ ...VALID_ENTRY, name: 'UpperCase' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistrySchemaError).detail?.field).toBe('name');
    }
  });

  test('rejects default_tier=endorsed (endorsement is in endorsements.json)', () => {
    try {
      validateRegistryEntry({ ...VALID_ENTRY, default_tier: 'endorsed' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistrySchemaError).detail?.field).toBe('default_tier');
    }
  });

  test('rejects non-https source URL', () => {
    try {
      validateRegistryEntry({
        ...VALID_ENTRY,
        source: { ...VALID_ENTRY.source, url: 'ftp://example.com' },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistrySchemaError).detail?.field).toBe('source.url');
    }
  });

  test('rejects non-hex pinned_commit', () => {
    try {
      validateRegistryEntry({
        ...VALID_ENTRY,
        source: { ...VALID_ENTRY.source, pinned_commit: 'not-a-sha' },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistrySchemaError).detail?.field).toBe('source.pinned_commit');
    }
  });

  test('rejects negative skills_count', () => {
    try {
      validateRegistryEntry({ ...VALID_ENTRY, skills_count: -1 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistrySchemaError).detail?.field).toBe('skills_count');
    }
  });
});

describe('validateEndorsementsFile', () => {
  const VALID: EndorsementsFile = {
    schema_version: ENDORSEMENTS_SCHEMA_VERSION,
    endorsements: {
      'hackathon-evaluation': { tier: 'endorsed', endorsed_at: '2026-05-18T20:00:00Z' },
    },
  };

  test('accepts a valid file', () => {
    expect(() => validateEndorsementsFile(VALID)).not.toThrow();
  });

  test('rejects wrong schema_version', () => {
    try {
      validateEndorsementsFile({ ...VALID, schema_version: 'old' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistrySchemaError).code).toBe('unknown_schema');
    }
  });

  test('rejects unknown tier', () => {
    try {
      validateEndorsementsFile({
        schema_version: ENDORSEMENTS_SCHEMA_VERSION,
        endorsements: { foo: { tier: 'bogus', endorsed_at: '2026-01-01' } as never },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistrySchemaError).code).toBe('invalid_field');
    }
  });

  test('accepts endorsements with notes', () => {
    expect(() =>
      validateEndorsementsFile({
        ...VALID,
        endorsements: {
          'foo': {
            tier: 'endorsed',
            endorsed_at: '2026-05-18',
            note: 'promoted after clean 30d',
          },
        },
      }),
    ).not.toThrow();
  });
});

describe('effectiveTier — endorsements overlay', () => {
  test('returns default_tier when no endorsements file', () => {
    expect(effectiveTier(VALID_ENTRY, null)).toBe('community');
  });

  test('returns default_tier when endorsements file has no record', () => {
    const ends: EndorsementsFile = {
      schema_version: ENDORSEMENTS_SCHEMA_VERSION,
      endorsements: {},
    };
    expect(effectiveTier(VALID_ENTRY, ends)).toBe('community');
  });

  test('endorsements override wins over default_tier', () => {
    const ends: EndorsementsFile = {
      schema_version: ENDORSEMENTS_SCHEMA_VERSION,
      endorsements: {
        'hackathon-evaluation': { tier: 'endorsed', endorsed_at: '2026-05-18' },
      },
    };
    expect(effectiveTier(VALID_ENTRY, ends)).toBe('endorsed');
  });

  test('endorsements can downgrade to dead', () => {
    const ends: EndorsementsFile = {
      schema_version: ENDORSEMENTS_SCHEMA_VERSION,
      endorsements: {
        'hackathon-evaluation': { tier: 'dead', endorsed_at: '2026-05-18' },
      },
    };
    expect(effectiveTier(VALID_ENTRY, ends)).toBe('dead');
  });
});
