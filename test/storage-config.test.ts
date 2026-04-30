import { test, expect, describe, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  validateStorageConfig,
  isGitTracked,
  isSupabaseOnly,
  getStorageTier,
  loadStorageConfig,
  normalizeAndValidateStorageConfig,
  StorageConfigError,
  __resetMissingStorageWarning,
} from '../src/core/storage-config.ts';
import type { StorageConfig } from '../src/core/storage-config.ts';

describe('Storage Configuration', () => {
  const testConfig: StorageConfig = {
    db_tracked: ['people/', 'companies/', 'deals/'],
    db_only: ['media/x/', 'media/articles/', 'meetings/transcripts/'],
  };

  describe('validateStorageConfig', () => {
    test('should return no warnings for valid config', () => {
      const warnings = validateStorageConfig(testConfig);
      expect(warnings).toEqual([]);
    });

    test('should warn about overlap between db_tracked and db_only', () => {
      const invalidConfig: StorageConfig = {
        db_tracked: ['people/', 'media/'],
        db_only: ['media/', 'articles/'],
      };
      const warnings = validateStorageConfig(invalidConfig);
      expect(warnings).toContain('Directory "media/" appears in both db_tracked and db_only');
    });

    test('should warn about paths not ending with /', () => {
      const invalidConfig: StorageConfig = {
        db_tracked: ['people', 'companies/'],
        db_only: ['media/x/', 'articles'],
      };
      const warnings = validateStorageConfig(invalidConfig);
      expect(warnings).toContain('Directory path "people" should end with "/" for consistency');
      expect(warnings).toContain('Directory path "articles" should end with "/" for consistency');
    });
  });

  describe('Storage tier detection', () => {
    test('identifies db-tracked pages', () => {
      expect(isGitTracked('people/john-doe', testConfig)).toBe(true);
      expect(isGitTracked('companies/acme-corp', testConfig)).toBe(true);
      expect(isGitTracked('deals/series-a', testConfig)).toBe(true);
    });

    test('identifies db-only pages', () => {
      expect(isSupabaseOnly('media/x/tweet-123', testConfig)).toBe(true);
      expect(isSupabaseOnly('media/articles/blog-post', testConfig)).toBe(true);
      expect(isSupabaseOnly('meetings/transcripts/standup', testConfig)).toBe(true);
    });

    test('returns false for non-matching paths', () => {
      expect(isGitTracked('media/x/tweet-123', testConfig)).toBe(false);
      expect(isSupabaseOnly('people/john-doe', testConfig)).toBe(false);
    });

    test('correctly determines storage tier (canonical names)', () => {
      expect(getStorageTier('people/john-doe', testConfig)).toBe('db_tracked');
      expect(getStorageTier('media/x/tweet-123', testConfig)).toBe('db_only');
      expect(getStorageTier('projects/random-thing', testConfig)).toBe('unspecified');
    });

    test('handles prefix edge cases', () => {
      expect(isGitTracked('people', testConfig)).toBe(false);
      expect(isGitTracked('people/', testConfig)).toBe(true);
      expect(isGitTracked('peoplex/test', testConfig)).toBe(false);
      expect(isSupabaseOnly('mediax/test', testConfig)).toBe(false);
    });

    test('normalizeAndValidateStorageConfig auto-adds trailing slash silently with info note', () => {
      __resetMissingStorageWarning();
      const warnings: string[] = [];
      const orig = console.warn;
      console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
      try {
        const out = normalizeAndValidateStorageConfig({
          db_tracked: ['people', 'companies/'],
          db_only: ['media/x'],
        });
        expect(out.db_tracked).toEqual(['people/', 'companies/']);
        expect(out.db_only).toEqual(['media/x/']);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toMatch(/normalized.*"people".*"people\/".*"media\/x".*"media\/x\/"/);
      } finally {
        console.warn = orig;
      }
    });

    test('normalizeAndValidateStorageConfig throws on tier overlap', () => {
      __resetMissingStorageWarning();
      expect(() =>
        normalizeAndValidateStorageConfig({
          db_tracked: ['media/'],
          db_only: ['media/'],
        }),
      ).toThrow(StorageConfigError);
    });

    test('regression — media/xerox does NOT match media/x (path-segment matcher)', () => {
      // Without path-segment matching, slug.startsWith('media/x') would falsely
      // match 'media/xerox/foo'. The new matcher requires trailing '/'; if the
      // user's config has 'media/x' (no slash), the matcher refuses to match —
      // the validator's auto-normalize (step 7) ensures canonical input.
      const collisionConfig: StorageConfig = {
        db_tracked: [],
        db_only: ['media/x/'], // canonical, with trailing slash
      };
      expect(isSupabaseOnly('media/xerox/something', collisionConfig)).toBe(false);
      expect(isSupabaseOnly('media/x/tweet-1', collisionConfig)).toBe(true);

      // Non-canonical input (no trailing slash) is refused by the matcher.
      const noSlashConfig: StorageConfig = {
        db_tracked: [],
        db_only: ['media/x'],
      };
      expect(isSupabaseOnly('media/xerox/foo', noSlashConfig)).toBe(false);
      expect(isSupabaseOnly('media/x/tweet-1', noSlashConfig)).toBe(false);
    });
  });
});

describe('loadStorageConfig — real-disk loader', () => {
  let tmp: string;
  let originalWarn: typeof console.warn;
  let warnings: string[];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gbrain-storage-test-'));
    __resetMissingStorageWarning();
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
  });

  function cleanup(): void {
    console.warn = originalWarn;
    rmSync(tmp, { recursive: true, force: true });
  }

  test('returns null when repoPath is missing', () => {
    try {
      expect(loadStorageConfig(undefined)).toBeNull();
      expect(loadStorageConfig(null)).toBeNull();
      expect(loadStorageConfig('')).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('returns null when gbrain.yml does not exist', () => {
    try {
      expect(loadStorageConfig(tmp)).toBeNull();
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('loads canonical gbrain.yml — the test that would have caught the original gray-matter P0', () => {
    try {
      const yaml = `# Brain storage tiering config
storage:
  db_tracked:
    - people/
    - companies/
    - deals/
  db_only:
    - media/x/
    - media/articles/
`;
      writeFileSync(join(tmp, 'gbrain.yml'), yaml);
      const config = loadStorageConfig(tmp);
      expect(config).not.toBeNull();
      expect(config!.db_tracked).toEqual(['people/', 'companies/', 'deals/']);
      expect(config!.db_only).toEqual(['media/x/', 'media/articles/']);
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('handles inline comments and blank lines', () => {
    try {
      const yaml = `
storage:
  db_tracked:
    - people/  # human-curated
    - companies/

  db_only:
    - media/x/    # bulk tweets
`;
      writeFileSync(join(tmp, 'gbrain.yml'), yaml);
      const config = loadStorageConfig(tmp);
      expect(config!.db_tracked).toEqual(['people/', 'companies/']);
      expect(config!.db_only).toEqual(['media/x/']);
    } finally {
      cleanup();
    }
  });

  test('strips quoted values', () => {
    try {
      const yaml = `storage:
  db_tracked:
    - "people/"
    - 'companies/'
  db_only: []
`;
      writeFileSync(join(tmp, 'gbrain.yml'), yaml);
      const config = loadStorageConfig(tmp);
      expect(config!.db_tracked).toEqual(['people/', 'companies/']);
    } finally {
      cleanup();
    }
  });

  test('reads deprecated keys (git_tracked / supabase_only) with once-per-process warning', () => {
    try {
      const yaml = `storage:
  git_tracked:
    - people/
  supabase_only:
    - media/x/
`;
      writeFileSync(join(tmp, 'gbrain.yml'), yaml);
      const config = loadStorageConfig(tmp);
      expect(config!.db_tracked).toEqual(['people/']);
      expect(config!.db_only).toEqual(['media/x/']);
      expect(warnings.some((w) => /deprecated/.test(w))).toBe(true);

      // Second call: no second deprecation warning (once-per-process).
      const before = warnings.length;
      loadStorageConfig(tmp);
      const newWarnings = warnings.slice(before);
      expect(newWarnings.filter((w) => /deprecated/.test(w))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('canonical keys win over deprecated keys when both present', () => {
    try {
      const yaml = `storage:
  db_tracked:
    - new-people/
  git_tracked:
    - old-people/
  db_only:
    - new-media/
  supabase_only:
    - old-media/
`;
      writeFileSync(join(tmp, 'gbrain.yml'), yaml);
      const config = loadStorageConfig(tmp);
      expect(config!.db_tracked).toEqual(['new-people/']);
      expect(config!.db_only).toEqual(['new-media/']);
      // Stronger deprecation warning when both shapes coexist.
      expect(warnings.some((w) => /deprecated.*ignored/.test(w))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('warns once when gbrain.yml exists but storage section is missing', () => {
    try {
      writeFileSync(join(tmp, 'gbrain.yml'), 'something_else: foo\n');
      const config = loadStorageConfig(tmp);
      expect(config).toBeNull();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/no storage configuration/);

      // Second call: no additional warning (once-per-process).
      loadStorageConfig(tmp);
      expect(warnings.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('warns when storage section is empty', () => {
    try {
      const yaml = `storage:
  db_tracked: []
  db_only: []
`;
      writeFileSync(join(tmp, 'gbrain.yml'), yaml);
      const config = loadStorageConfig(tmp);
      // Empty config is returned (not null) but warning fires.
      expect(config).not.toBeNull();
      expect(config!.db_tracked).toEqual([]);
      expect(config!.db_only).toEqual([]);
      const noConfigWarnings = warnings.filter((w) => /no storage configuration/.test(w));
      expect(noConfigWarnings.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('throws on unreadable gbrain.yml (permission denied) — does not silently disable feature', () => {
    try {
      const yamlPath = join(tmp, 'gbrain.yml');
      writeFileSync(yamlPath, 'storage:\n  db_tracked:\n    - x/\n');
      // Simulate unreadable: chmod 000. May not work on all CI; skip if not supported.
      const fs = require('fs');
      fs.chmodSync(yamlPath, 0o000);
      try {
        // On systems where chmod 000 actually denies read, this throws.
        // On systems where root can still read (CI containers), the read succeeds
        // and the test is a no-op assertion.
        try {
          fs.readFileSync(yamlPath, 'utf-8');
          // Read succeeded — skip strict assertion.
        } catch {
          expect(() => loadStorageConfig(tmp)).toThrow();
        }
      } finally {
        fs.chmodSync(yamlPath, 0o644);
      }
    } finally {
      cleanup();
    }
  });
});
