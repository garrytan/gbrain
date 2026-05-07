import { describe, expect, test } from 'bun:test';
import {
  addSubbrainToRegistry,
  findSubbrainBySlugPrefix,
  parseSubbrainRegistry,
  removeSubbrainFromRegistry,
  serializeSubbrainRegistry,
  stripSubbrainPrefix,
  validateSubbrainId,
  validateSubbrainPrefix,
} from '../src/core/subbrains.ts';

describe('subbrain registry helpers', () => {
  test('parses an empty registry when config is missing', () => {
    expect(parseSubbrainRegistry(null)).toEqual({ subbrains: {} });
    expect(parseSubbrainRegistry('')).toEqual({ subbrains: {} });
  });

  test('adds subbrains with default prefix and serializes deterministically', () => {
    const registry = addSubbrainToRegistry(parseSubbrainRegistry(null), {
      id: 'personal',
      path: '/brain/personal',
      default: true,
    });

    expect(registry.subbrains.personal).toEqual({
      id: 'personal',
      path: '/brain/personal',
      prefix: 'personal',
      default: true,
    });
    expect(serializeSubbrainRegistry(registry)).toBe(JSON.stringify({
      subbrains: {
        personal: {
          id: 'personal',
          path: '/brain/personal',
          prefix: 'personal',
          default: true,
        },
      },
    }));
  });

  test('adding a default subbrain clears previous defaults', () => {
    const registry = addSubbrainToRegistry(
      addSubbrainToRegistry(parseSubbrainRegistry(null), {
        id: 'personal',
        path: '/brain/personal',
        default: true,
      }),
      {
        id: 'office',
        path: '/brain/office',
        prefix: 'work',
        default: true,
      },
    );

    expect(registry.subbrains.personal.default).toBeUndefined();
    expect(registry.subbrains.office.default).toBe(true);
    expect(registry.subbrains.office.prefix).toBe('work');
  });

  test('rejects duplicate ids and prefixes', () => {
    const registry = addSubbrainToRegistry(parseSubbrainRegistry(null), {
      id: 'personal',
      path: '/brain/personal',
      prefix: 'personal',
    });

    expect(() => addSubbrainToRegistry(registry, {
      id: 'personal',
      path: '/brain/personal-2',
      prefix: 'personal-2',
    })).toThrow('Sub-brain already exists: personal');

    expect(() => addSubbrainToRegistry(registry, {
      id: 'office',
      path: '/brain/office',
      prefix: 'personal',
    })).toThrow('Sub-brain prefix already exists: personal');
  });

  test('rejects malformed persisted registries instead of trusting config blindly', () => {
    expect(() => parseSubbrainRegistry(JSON.stringify({
      subbrains: {
        personal: { id: 'personal', path: '/tmp/personal', prefix: 'shared' },
        office: { id: 'office', path: '/tmp/office', prefix: 'shared' },
      },
    }))).toThrow('Sub-brain prefix already exists');

    expect(() => parseSubbrainRegistry(JSON.stringify({
      subbrains: {
        personal: { id: 'other', path: '/tmp/personal', prefix: 'personal' },
      },
    }))).toThrow('does not match registry key');

    expect(() => parseSubbrainRegistry(JSON.stringify({
      subbrains: {
        personal: { id: 'personal', prefix: 'personal' },
      },
    }))).toThrow('path must be a non-empty string');
  });

  test('validates ids and prefixes as safe slug segments', () => {
    expect(validateSubbrainId('personal')).toBe('personal');
    expect(validateSubbrainPrefix('office-notes')).toBe('office-notes');

    expect(() => validateSubbrainId('two/segments')).toThrow('single slug segment');
    expect(() => validateSubbrainPrefix('Office Notes')).toThrow('must already be slugified');
    expect(() => validateSubbrainPrefix('ops')).toThrow('reserved');
    expect(() => validateSubbrainPrefix('.git')).toThrow('reserved');
  });

  test('finds and strips a registered slug prefix', () => {
    const registry = addSubbrainToRegistry(parseSubbrainRegistry(null), {
      id: 'personal',
      path: '/brain/personal',
      prefix: 'personal',
    });

    const subbrain = findSubbrainBySlugPrefix(registry, 'personal/people/alice');

    expect(subbrain?.id).toBe('personal');
    expect(stripSubbrainPrefix(subbrain!, 'personal/people/alice')).toBe('people/alice');
    expect(findSubbrainBySlugPrefix(registry, 'office/people/alice')).toBeNull();
    expect(() => stripSubbrainPrefix(subbrain!, 'personal')).toThrow('missing path after prefix');
  });

  test('removes subbrains from the registry without mutating the input', () => {
    const original = addSubbrainToRegistry(parseSubbrainRegistry(null), {
      id: 'personal',
      path: '/brain/personal',
    });

    const next = removeSubbrainFromRegistry(original, 'personal');

    expect(original.subbrains.personal).toBeDefined();
    expect(next.subbrains.personal).toBeUndefined();
  });
});
