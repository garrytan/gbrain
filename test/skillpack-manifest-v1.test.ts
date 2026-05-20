/**
 * Tests for src/core/skillpack/manifest-v1.ts — third-party skillpack.json
 * runtime validator.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  SKILLPACK_API_VERSION,
  SkillpackManifestError,
  validateSkillpackManifest,
  loadSkillpackManifest,
  bundleManifestFromSkillpack,
  type SkillpackManifest,
} from '../src/core/skillpack/manifest-v1.ts';

const VALID_MANIFEST: SkillpackManifest = {
  api_version: SKILLPACK_API_VERSION,
  name: 'hackathon-evaluation',
  version: '0.1.0',
  description: 'Score hackathon submissions with the YC rubric.',
  author: 'Garry Tan',
  license: 'MIT',
  homepage: 'https://github.com/garrytan/skillpack-hackathon-evaluation',
  gbrain_min_version: '0.36.0',
  skills: ['skills/judge-submission'],
};

describe('validateSkillpackManifest — required fields', () => {
  test('accepts a minimal valid manifest', () => {
    const result = validateSkillpackManifest(VALID_MANIFEST);
    expect(result.name).toBe('hackathon-evaluation');
    expect(result.api_version).toBe(SKILLPACK_API_VERSION);
  });

  test('rejects non-object top-level', () => {
    expect(() => validateSkillpackManifest('not an object')).toThrow(SkillpackManifestError);
    expect(() => validateSkillpackManifest(null)).toThrow(SkillpackManifestError);
    expect(() => validateSkillpackManifest([])).toThrow(SkillpackManifestError);
  });

  test('rejects missing api_version with structured code', () => {
    const bad = { ...VALID_MANIFEST };
    delete (bad as Partial<SkillpackManifest>).api_version;
    try {
      validateSkillpackManifest(bad);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SkillpackManifestError);
      expect((err as SkillpackManifestError).code).toBe('manifest_missing_field');
      expect((err as SkillpackManifestError).detail?.field).toBe('api_version');
    }
  });

  test('rejects unknown api_version', () => {
    const bad = { ...VALID_MANIFEST, api_version: 'gbrain-skillpack-v99' as 'gbrain-skillpack-v1' };
    try {
      validateSkillpackManifest(bad);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).code).toBe('manifest_unknown_api_version');
    }
  });

  test('rejects each required field individually', () => {
    const required = [
      'api_version',
      'name',
      'version',
      'description',
      'author',
      'license',
      'homepage',
      'gbrain_min_version',
      'skills',
    ] as const;
    for (const field of required) {
      const bad = { ...VALID_MANIFEST };
      delete (bad as Record<string, unknown>)[field];
      try {
        validateSkillpackManifest(bad);
        throw new Error(`should have thrown for missing ${field}`);
      } catch (err) {
        expect((err as SkillpackManifestError).code).toBe('manifest_missing_field');
        expect((err as SkillpackManifestError).detail?.field).toBe(field);
      }
    }
  });
});

describe('validateSkillpackManifest — field shape rules', () => {
  test('rejects name that is not lowercase kebab-case', () => {
    for (const bad of ['UpperCase', 'has_underscore', 'has space', '0starts-with-digit', 'a', 'x'.repeat(65)]) {
      try {
        validateSkillpackManifest({ ...VALID_MANIFEST, name: bad });
        throw new Error(`should have thrown for ${bad}`);
      } catch (err) {
        expect((err as SkillpackManifestError).detail?.field).toBe('name');
      }
    }
  });

  test('accepts valid kebab-case names', () => {
    for (const good of ['ab', 'a-b', 'a1', 'abc-def-ghi', 'x'.repeat(64)]) {
      expect(() => validateSkillpackManifest({ ...VALID_MANIFEST, name: good })).not.toThrow();
    }
  });

  test('rejects non-semver version', () => {
    for (const bad of ['1', '1.2', 'v1.2.3', '1.2.3.4.5', 'not-a-version']) {
      try {
        validateSkillpackManifest({ ...VALID_MANIFEST, version: bad });
        throw new Error(`should have thrown for ${bad}`);
      } catch (err) {
        expect((err as SkillpackManifestError).detail?.field).toBe('version');
      }
    }
  });

  test('accepts 3-segment and 4-segment semver', () => {
    for (const good of ['0.1.0', '1.0.0', '0.36.1.0', '1.0.0-alpha']) {
      expect(() => validateSkillpackManifest({ ...VALID_MANIFEST, version: good })).not.toThrow();
    }
  });

  test('rejects empty string for description/author/license/homepage', () => {
    for (const field of ['description', 'author', 'license', 'homepage'] as const) {
      try {
        validateSkillpackManifest({ ...VALID_MANIFEST, [field]: '' });
        throw new Error(`should have thrown for empty ${field}`);
      } catch (err) {
        expect((err as SkillpackManifestError).detail?.field).toBe(field);
      }
    }
  });

  test('rejects non-http homepage', () => {
    try {
      validateSkillpackManifest({ ...VALID_MANIFEST, homepage: 'ftp://example.com' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).detail?.field).toBe('homepage');
    }
  });

  test('rejects gbrain_min_version that is not semver', () => {
    try {
      validateSkillpackManifest({ ...VALID_MANIFEST, gbrain_min_version: 'latest' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).detail?.field).toBe('gbrain_min_version');
    }
  });

  test('rejects empty skills array', () => {
    try {
      validateSkillpackManifest({ ...VALID_MANIFEST, skills: [] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).detail?.field).toBe('skills');
    }
  });

  test('rejects skill paths without skills/ prefix', () => {
    try {
      validateSkillpackManifest({ ...VALID_MANIFEST, skills: ['src/foo'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).detail?.field).toBe('skills');
    }
  });

  test('rejects skill paths with traversal', () => {
    try {
      validateSkillpackManifest({ ...VALID_MANIFEST, skills: ['skills/../etc/passwd'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).detail?.field).toBe('skills');
    }
  });
});

describe('validateSkillpackManifest — optional array fields', () => {
  test('accepts valid optional array fields', () => {
    expect(() =>
      validateSkillpackManifest({
        ...VALID_MANIFEST,
        shared_deps: ['skills/conventions/'],
        unit_tests: ['test/**/*.test.ts'],
        e2e_tests: ['e2e/**/*.test.ts'],
        llm_evals: ['evals/*.judge.json'],
        routing_evals: ['skills/*/routing-eval.jsonl'],
      }),
    ).not.toThrow();
  });

  test('rejects non-array shared_deps', () => {
    try {
      validateSkillpackManifest({ ...VALID_MANIFEST, shared_deps: 'not-an-array' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).detail?.field).toBe('shared_deps');
    }
  });

  test('rejects array with non-string entries', () => {
    try {
      validateSkillpackManifest({
        ...VALID_MANIFEST,
        unit_tests: ['test/foo.test.ts', 42] as unknown as string[],
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).detail?.field).toBe('unit_tests');
    }
  });
});

describe('validateSkillpackManifest — runbooks', () => {
  test('accepts runbooks.bootstrap', () => {
    expect(() =>
      validateSkillpackManifest({
        ...VALID_MANIFEST,
        runbooks: { bootstrap: 'runbooks/bootstrap.md' },
      }),
    ).not.toThrow();
  });

  test('rejects non-object runbooks', () => {
    try {
      validateSkillpackManifest({ ...VALID_MANIFEST, runbooks: 'string' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).detail?.field).toBe('runbooks');
    }
  });

  test('rejects non-string runbooks.bootstrap', () => {
    try {
      validateSkillpackManifest({ ...VALID_MANIFEST, runbooks: { bootstrap: 42 } });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).detail?.field).toBe('runbooks.bootstrap');
    }
  });
});

describe('validateSkillpackManifest — schema-version forward-compat', () => {
  test('accepts schema versions within the supported range', () => {
    expect(() =>
      validateSkillpackManifest({
        ...VALID_MANIFEST,
        runbook_schema_version: 1,
        eval_schema_version: 1,
      }),
    ).not.toThrow();
  });

  test('rejects runbook_schema_version newer than supported', () => {
    try {
      validateSkillpackManifest({
        ...VALID_MANIFEST,
        runbook_schema_version: 99,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).code).toBe('manifest_unsupported_schema_version');
      expect((err as SkillpackManifestError).detail?.field).toBe('runbook_schema_version');
    }
  });

  test('rejects eval_schema_version newer than supported', () => {
    try {
      validateSkillpackManifest({
        ...VALID_MANIFEST,
        eval_schema_version: 99,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).code).toBe('manifest_unsupported_schema_version');
    }
  });

  test('rejects non-integer schema version', () => {
    try {
      validateSkillpackManifest({
        ...VALID_MANIFEST,
        runbook_schema_version: 1.5,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackManifestError).code).toBe('manifest_invalid_field');
    }
  });

  test('honors caller-supplied opts to support a newer schema version', () => {
    expect(() =>
      validateSkillpackManifest(
        { ...VALID_MANIFEST, runbook_schema_version: 5 },
        { maxRunbookSchemaVersion: 5 },
      ),
    ).not.toThrow();
  });
});

describe('loadSkillpackManifest — filesystem path', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'manifest-test-'));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns parsed manifest when file is valid and skill dirs exist', () => {
    mkdirSync(join(tmp, 'skills/judge-submission'), { recursive: true });
    writeFileSync(join(tmp, 'skills/judge-submission/SKILL.md'), '---\nname: judge\n---\n');
    writeFileSync(join(tmp, 'skillpack.json'), JSON.stringify(VALID_MANIFEST, null, 2));
    const m = loadSkillpackManifest(tmp);
    expect(m.name).toBe('hackathon-evaluation');
  });

  test('throws manifest_not_found for missing skillpack.json', () => {
    const empty = mkdtempSync(join(tmpdir(), 'manifest-test-empty-'));
    try {
      try {
        loadSkillpackManifest(empty);
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as SkillpackManifestError).code).toBe('manifest_not_found');
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('throws manifest_malformed_json for invalid JSON', () => {
    const badJsonDir = mkdtempSync(join(tmpdir(), 'manifest-test-bad-'));
    try {
      writeFileSync(join(badJsonDir, 'skillpack.json'), '{ not valid json');
      try {
        loadSkillpackManifest(badJsonDir);
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as SkillpackManifestError).code).toBe('manifest_malformed_json');
      }
    } finally {
      rmSync(badJsonDir, { recursive: true, force: true });
    }
  });

  test('throws manifest_skill_not_found when declared skill dir does not exist', () => {
    const noSkillDir = mkdtempSync(join(tmpdir(), 'manifest-test-noskill-'));
    try {
      writeFileSync(
        join(noSkillDir, 'skillpack.json'),
        JSON.stringify(VALID_MANIFEST, null, 2),
      );
      try {
        loadSkillpackManifest(noSkillDir);
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as SkillpackManifestError).code).toBe('manifest_skill_not_found');
      }
    } finally {
      rmSync(noSkillDir, { recursive: true, force: true });
    }
  });
});

describe('bundleManifestFromSkillpack — adapter', () => {
  test('projects SkillpackManifest fields onto BundleManifest shape', () => {
    const bundle = bundleManifestFromSkillpack({
      ...VALID_MANIFEST,
      shared_deps: ['skills/conventions/'],
      excluded_from_install: ['skills/internal'],
    });
    expect(bundle.name).toBe(VALID_MANIFEST.name);
    expect(bundle.version).toBe(VALID_MANIFEST.version);
    expect(bundle.skills).toEqual(VALID_MANIFEST.skills);
    expect(bundle.shared_deps).toEqual(['skills/conventions/']);
    expect(bundle.excluded_from_install).toEqual(['skills/internal']);
  });

  test('defaults shared_deps to empty array when not declared', () => {
    const bundle = bundleManifestFromSkillpack(VALID_MANIFEST);
    expect(bundle.shared_deps).toEqual([]);
  });
});
