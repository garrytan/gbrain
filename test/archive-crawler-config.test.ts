/**
 * Tests for src/core/archive-crawler-config.ts (D12 + codex HIGH-4 fix).
 *
 * The canonical safety contract: archive-crawler refuses to run unless
 * `archive-crawler.scan_paths:` is explicitly set in gbrain.yml.
 * These tests pin every gate in that contract:
 *   - missing gbrain.yml -> missing_section
 *   - gbrain.yml without the section -> missing_section
 *   - empty scan_paths -> empty_scan_paths
 *   - relative path -> invalid_path
 *   - path traversal (..) -> invalid_path
 *   - valid config -> normalized absolute trailing-slashed paths
 *   - ~ expansion
 *   - deny_paths optional
 *   - isPathAllowed: prefix match + deny override + prefix boundary
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  loadArchiveCrawlerConfig,
  normalizeAndValidateArchiveCrawlerConfig,
  isPathAllowed,
  ArchiveCrawlerConfigError,
} from '../src/core/archive-crawler-config.ts';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'archive-crawler-config-'));
});

afterEach(() => {
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function writeYaml(content: string): string {
  const path = join(workdir, 'gbrain.yml');
  writeFileSync(path, content);
  return path;
}

describe('loadArchiveCrawlerConfig — D12 missing_section', () => {
  it('throws missing_section when repoPath is null', () => {
    expect(() => loadArchiveCrawlerConfig(null)).toThrow(ArchiveCrawlerConfigError);
    try {
      loadArchiveCrawlerConfig(null);
    } catch (e) {
      expect(e).toBeInstanceOf(ArchiveCrawlerConfigError);
      expect((e as ArchiveCrawlerConfigError).code).toBe('missing_section');
    }
  });

  it('throws missing_section when gbrain.yml does not exist', () => {
    expect(() => loadArchiveCrawlerConfig(workdir)).toThrow(ArchiveCrawlerConfigError);
    try {
      loadArchiveCrawlerConfig(workdir);
    } catch (e) {
      expect((e as ArchiveCrawlerConfigError).code).toBe('missing_section');
    }
  });

  it('throws missing_section when gbrain.yml exists but has no archive-crawler section', () => {
    writeYaml('storage:\n  db_tracked:\n    - originals/\n');
    expect(() => loadArchiveCrawlerConfig(workdir)).toThrow(ArchiveCrawlerConfigError);
    try {
      loadArchiveCrawlerConfig(workdir);
    } catch (e) {
      expect((e as ArchiveCrawlerConfigError).code).toBe('missing_section');
    }
  });
});

describe('loadArchiveCrawlerConfig — D12 empty_scan_paths', () => {
  it('throws empty_scan_paths when scan_paths is omitted', () => {
    writeYaml('archive-crawler:\n  deny_paths:\n    - /tmp/forbidden/\n');
    expect(() => loadArchiveCrawlerConfig(workdir)).toThrow(ArchiveCrawlerConfigError);
    try {
      loadArchiveCrawlerConfig(workdir);
    } catch (e) {
      expect((e as ArchiveCrawlerConfigError).code).toBe('empty_scan_paths');
    }
  });

  it('throws empty_scan_paths when scan_paths is []', () => {
    writeYaml('archive-crawler:\n  scan_paths: []\n');
    expect(() => loadArchiveCrawlerConfig(workdir)).toThrow(ArchiveCrawlerConfigError);
  });
});

describe('loadArchiveCrawlerConfig — D12 invalid_path', () => {
  it('throws invalid_path on a relative path in scan_paths', () => {
    writeYaml('archive-crawler:\n  scan_paths:\n    - ./relative/path\n');
    try {
      loadArchiveCrawlerConfig(workdir);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ArchiveCrawlerConfigError).code).toBe('invalid_path');
    }
  });

  it('throws invalid_path on path traversal (..)', () => {
    writeYaml('archive-crawler:\n  scan_paths:\n    - /home/user/Documents/../../etc/passwd\n');
    try {
      loadArchiveCrawlerConfig(workdir);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ArchiveCrawlerConfigError).code).toBe('invalid_path');
    }
  });

  it('rejects ".." in deny_paths too', () => {
    writeYaml(`archive-crawler:
  scan_paths:
    - /home/user/Documents/
  deny_paths:
    - /home/user/Documents/../etc
`);
    try {
      loadArchiveCrawlerConfig(workdir);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ArchiveCrawlerConfigError).code).toBe('invalid_path');
    }
  });
});

describe('loadArchiveCrawlerConfig — happy path', () => {
  it('returns normalized absolute paths with trailing slash', () => {
    writeYaml(`archive-crawler:
  scan_paths:
    - /home/user/writing
    - /mnt/backup/old-letters/
`);
    const config = loadArchiveCrawlerConfig(workdir);
    expect(config.scan_paths).toEqual([
      '/home/user/writing/',
      '/mnt/backup/old-letters/',
    ]);
    expect(config.deny_paths).toEqual([]);
  });

  it('expands ~/ to homedir', () => {
    const home = homedir();
    writeYaml('archive-crawler:\n  scan_paths:\n    - ~/Documents/writing\n');
    const config = loadArchiveCrawlerConfig(workdir);
    expect(config.scan_paths[0]).toBe(`${home}/Documents/writing/`);
  });

  it('accepts deny_paths alongside scan_paths', () => {
    writeYaml(`archive-crawler:
  scan_paths:
    - /home/user/Documents/
  deny_paths:
    - /home/user/Documents/finances/
    - /home/user/Documents/medical/
`);
    const config = loadArchiveCrawlerConfig(workdir);
    expect(config.deny_paths).toEqual([
      '/home/user/Documents/finances/',
      '/home/user/Documents/medical/',
    ]);
  });

  it('accepts both archive-crawler and archive_crawler key spellings', () => {
    writeYaml('archive_crawler:\n  scan_paths:\n    - /home/user/notes\n');
    const config = loadArchiveCrawlerConfig(workdir);
    expect(config.scan_paths[0]).toBe('/home/user/notes/');
  });
});

describe('normalizeAndValidateArchiveCrawlerConfig — direct API', () => {
  it('throws empty_scan_paths even when called directly', () => {
    expect(() => normalizeAndValidateArchiveCrawlerConfig({ scan_paths: [] })).toThrow(
      ArchiveCrawlerConfigError,
    );
  });

  it('returns trailing-slashed normalized paths', () => {
    const out = normalizeAndValidateArchiveCrawlerConfig({
      scan_paths: ['/a/b', '/c/d/'],
    });
    expect(out.scan_paths).toEqual(['/a/b/', '/c/d/']);
  });
});

describe('isPathAllowed', () => {
  const config = {
    scan_paths: ['/home/user/writing/', '/home/user/Dropbox/'],
    deny_paths: ['/home/user/Dropbox/finances/'],
  };

  it('returns true for a path inside a scan_path', () => {
    expect(isPathAllowed('/home/user/writing/essay.md', config)).toBe(true);
    expect(isPathAllowed('/home/user/Dropbox/letters/a.txt', config)).toBe(true);
  });

  it('returns false for a path outside any scan_path', () => {
    expect(isPathAllowed('/etc/passwd', config)).toBe(false);
    expect(isPathAllowed('/home/user/Other/thing.md', config)).toBe(false);
  });

  it('returns false for a path inside a deny_path even if it is also in a scan_path', () => {
    expect(isPathAllowed('/home/user/Dropbox/finances/2024.pdf', config)).toBe(false);
  });

  it('respects directory boundaries — /writing/ does not match /writing-stuff/', () => {
    // Exact-prefix-with-trailing-slash means /home/user/writing/ does NOT
    // match /home/user/writing-stuff/. This is the codex T7 / storage-config
    // pattern: prefix matching at directory boundaries, not arbitrary string
    // prefixes.
    expect(isPathAllowed('/home/user/writing-stuff/file.md', config)).toBe(false);
  });

  it('rejects relative paths', () => {
    expect(isPathAllowed('./relative.md', config)).toBe(false);
  });
});
