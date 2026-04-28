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
  __resetMissingStorageWarning,
} from '../src/core/storage-config.ts';
import type { StorageConfig } from '../src/core/storage-config.ts';

describe('Storage Configuration', () => {
  const testConfig: StorageConfig = {
    git_tracked: ['people/', 'companies/', 'deals/'],
    supabase_only: ['media/x/', 'media/articles/', 'meetings/transcripts/']
  };

  describe('validateStorageConfig', () => {
    test('should return no warnings for valid config', () => {
      const warnings = validateStorageConfig(testConfig);
      expect(warnings).toEqual([]);
    });

    test('should warn about overlap between git_tracked and supabase_only', () => {
      const invalidConfig: StorageConfig = {
        git_tracked: ['people/', 'media/'],
        supabase_only: ['media/', 'articles/']
      };
      const warnings = validateStorageConfig(invalidConfig);
      expect(warnings).toContain('Directory "media/" appears in both git_tracked and supabase_only');
    });

    test('should warn about paths not ending with /', () => {
      const invalidConfig: StorageConfig = {
        git_tracked: ['people', 'companies/'],
        supabase_only: ['media/x/', 'articles']
      };
      const warnings = validateStorageConfig(invalidConfig);
      expect(warnings).toContain('Directory path "people" should end with "/" for consistency');
      expect(warnings).toContain('Directory path "articles" should end with "/" for consistency');
    });
  });

  describe('Storage tier detection', () => {
    test('should identify git-tracked pages', () => {
      expect(isGitTracked('people/john-doe', testConfig)).toBe(true);
      expect(isGitTracked('companies/acme-corp', testConfig)).toBe(true);
      expect(isGitTracked('deals/series-a', testConfig)).toBe(true);
    });

    test('should identify supabase-only pages', () => {
      expect(isSupabaseOnly('media/x/tweet-123', testConfig)).toBe(true);
      expect(isSupabaseOnly('media/articles/blog-post', testConfig)).toBe(true);
      expect(isSupabaseOnly('meetings/transcripts/standup', testConfig)).toBe(true);
    });

    test('should return false for non-matching paths', () => {
      expect(isGitTracked('media/x/tweet-123', testConfig)).toBe(false);
      expect(isSupabaseOnly('people/john-doe', testConfig)).toBe(false);
    });

    test('should correctly determine storage tier', () => {
      expect(getStorageTier('people/john-doe', testConfig)).toBe('git_tracked');
      expect(getStorageTier('media/x/tweet-123', testConfig)).toBe('supabase_only');
      expect(getStorageTier('projects/random-thing', testConfig)).toBe('unspecified');
    });

    test('should handle edge cases', () => {
      // Exact match shouldn't match (needs prefix)
      expect(isGitTracked('people', testConfig)).toBe(false);
      expect(isGitTracked('people/', testConfig)).toBe(true);

      // Partial match shouldn't match
      expect(isGitTracked('peoplex/test', testConfig)).toBe(false);
      expect(isSupabaseOnly('mediax/test', testConfig)).toBe(false);
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
  git_tracked:
    - people/
    - companies/
    - deals/
  supabase_only:
    - media/x/
    - media/articles/
`;
      writeFileSync(join(tmp, 'gbrain.yml'), yaml);
      const config = loadStorageConfig(tmp);
      expect(config).not.toBeNull();
      expect(config!.git_tracked).toEqual(['people/', 'companies/', 'deals/']);
      expect(config!.supabase_only).toEqual(['media/x/', 'media/articles/']);
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('handles inline comments and blank lines', () => {
    try {
      const yaml = `
storage:
  git_tracked:
    - people/  # human-curated
    - companies/

  supabase_only:
    - media/x/    # bulk tweets
`;
      writeFileSync(join(tmp, 'gbrain.yml'), yaml);
      const config = loadStorageConfig(tmp);
      expect(config!.git_tracked).toEqual(['people/', 'companies/']);
      expect(config!.supabase_only).toEqual(['media/x/']);
    } finally {
      cleanup();
    }
  });

  test('strips quoted values', () => {
    try {
      const yaml = `storage:
  git_tracked:
    - "people/"
    - 'companies/'
  supabase_only: []
`;
      writeFileSync(join(tmp, 'gbrain.yml'), yaml);
      const config = loadStorageConfig(tmp);
      expect(config!.git_tracked).toEqual(['people/', 'companies/']);
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
  git_tracked: []
  supabase_only: []
`;
      writeFileSync(join(tmp, 'gbrain.yml'), yaml);
      const config = loadStorageConfig(tmp);
      // Empty config is returned (not null) but warning fires.
      expect(config).not.toBeNull();
      expect(config!.git_tracked).toEqual([]);
      expect(config!.supabase_only).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/no storage configuration/);
    } finally {
      cleanup();
    }
  });

  test('throws on unreadable gbrain.yml (permission denied) — does not silently disable feature', () => {
    try {
      const yamlPath = join(tmp, 'gbrain.yml');
      writeFileSync(yamlPath, 'storage:\n  git_tracked:\n    - x/\n');
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