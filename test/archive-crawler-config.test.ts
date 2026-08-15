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
 *   - valid config -> normalized absolute trailing-separator paths
 *   - ~ expansion
 *   - deny_paths optional
 *   - isPathAllowed: prefix match + deny override + prefix boundary
 *
 * PLATFORM NOTE: these tests must run on both POSIX (gbrain CI is
 * 100% ubuntu-latest) and Windows. POSIX path literals cannot be
 * shared across both, because `/home/user` is NOT a drive-qualified
 * absolute path on Windows — `path.resolve('/home/user')` returns
 * `C:\home\user` (the cwd's drive). That is correct Win32 semantics,
 * not a product bug, so the FIXTURES are platform-selected via ROOT
 * rather than the product being forced to emit POSIX paths.
 *
 * Only the separator character is taken from `path`; the directory
 * structure in every expectation is still hand-written, so these stay
 * real assertions rather than a tautological re-run of the impl.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { homedir, tmpdir } from 'os';
import {
  loadArchiveCrawlerConfig,
  normalizeAndValidateArchiveCrawlerConfig,
  isPathAllowed,
  ArchiveCrawlerConfigError,
} from '../src/core/archive-crawler-config.ts';

const WIN = process.platform === 'win32';

/** Absolute-path fixture root for the current platform. */
const ROOT = WIN ? 'C:\\gbtest' : '/home/user';

/** Shorthand for the platform separator used in expectations. */
const S = sep;

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
    writeYaml(`archive-crawler:\n  deny_paths:\n    - ${join(ROOT, 'forbidden')}\n`);
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
    writeYaml(
      `archive-crawler:\n  scan_paths:\n    - ${join(ROOT, 'Documents')}${S}..${S}..${S}etc${S}passwd\n`,
    );
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
    - ${join(ROOT, 'Documents')}
  deny_paths:
    - ${join(ROOT, 'Documents')}${S}..${S}etc
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
  it('returns normalized absolute paths with trailing separator', () => {
    writeYaml(`archive-crawler:
  scan_paths:
    - ${join(ROOT, 'writing')}
    - ${join(ROOT, 'backup', 'old-letters')}${S}
`);
    const config = loadArchiveCrawlerConfig(workdir);
    expect(config.scan_paths).toEqual([
      `${ROOT}${S}writing${S}`,
      `${ROOT}${S}backup${S}old-letters${S}`,
    ]);
    expect(config.deny_paths).toEqual([]);
  });

  it('expands ~/ to homedir', () => {
    const home = homedir();
    writeYaml('archive-crawler:\n  scan_paths:\n    - ~/Documents/writing\n');
    const config = loadArchiveCrawlerConfig(workdir);
    expect(config.scan_paths[0]).toBe(`${home}${S}Documents${S}writing${S}`);
  });

  it('accepts deny_paths alongside scan_paths', () => {
    writeYaml(`archive-crawler:
  scan_paths:
    - ${join(ROOT, 'Documents')}${S}
  deny_paths:
    - ${join(ROOT, 'Documents', 'finances')}${S}
    - ${join(ROOT, 'Documents', 'medical')}${S}
`);
    const config = loadArchiveCrawlerConfig(workdir);
    expect(config.deny_paths).toEqual([
      `${ROOT}${S}Documents${S}finances${S}`,
      `${ROOT}${S}Documents${S}medical${S}`,
    ]);
  });

  it('accepts both archive-crawler and archive_crawler key spellings', () => {
    writeYaml(`archive_crawler:\n  scan_paths:\n    - ${join(ROOT, 'notes')}\n`);
    const config = loadArchiveCrawlerConfig(workdir);
    expect(config.scan_paths[0]).toBe(`${ROOT}${S}notes${S}`);
  });
});

describe('normalizeAndValidateArchiveCrawlerConfig — direct API', () => {
  it('throws empty_scan_paths even when called directly', () => {
    expect(() => normalizeAndValidateArchiveCrawlerConfig({ scan_paths: [] })).toThrow(
      ArchiveCrawlerConfigError,
    );
  });

  it('returns trailing-separator normalized paths', () => {
    const out = normalizeAndValidateArchiveCrawlerConfig({
      scan_paths: [join(ROOT, 'a', 'b'), `${join(ROOT, 'c', 'd')}${S}`],
    });
    expect(out.scan_paths).toEqual([
      `${ROOT}${S}a${S}b${S}`,
      `${ROOT}${S}c${S}d${S}`,
    ]);
  });

  it('terminates every normalized path with the PLATFORM separator, not a foreign one', () => {
    // Regression pin for the mixed-separator bug: resolve() emits '\' on
    // Windows but the old code appended a hardcoded '/', producing
    // 'C:\Users\...\writing/'. isPathAllowed then compared a '\'-joined
    // candidate against that '/'-terminated prefix and never matched.
    const out = normalizeAndValidateArchiveCrawlerConfig({
      scan_paths: [join(ROOT, 'writing')],
      deny_paths: [join(ROOT, 'writing', 'private')],
    });
    for (const p of [...out.scan_paths, ...out.deny_paths]) {
      expect(p.endsWith(S)).toBe(true);
      if (WIN) {
        // No stray forward slash anywhere: the whole path is native-separator.
        expect(p.includes('/')).toBe(false);
      }
    }
  });
});

describe('isPathAllowed — round-trip against the real normalizer', () => {
  // This is the case the original suite lacked: it hand-built the config
  // from POSIX literals instead of feeding it through
  // normalizeAndValidateArchiveCrawlerConfig, so the separator mismatch
  // between the two functions was invisible. Four of the five old
  // assertions also expected `false`, which the Windows total-deny
  // satisfied by accident.
  const config = normalizeAndValidateArchiveCrawlerConfig({
    scan_paths: [join(ROOT, 'writing'), join(ROOT, 'Dropbox')],
    deny_paths: [join(ROOT, 'Dropbox', 'finances')],
  });

  it('allows a file inside a scan_path', () => {
    expect(isPathAllowed(join(ROOT, 'writing', 'essay.md'), config)).toBe(true);
    expect(isPathAllowed(join(ROOT, 'Dropbox', 'letters', 'a.txt'), config)).toBe(true);
  });

  it('allows the scan_path directory itself', () => {
    expect(isPathAllowed(join(ROOT, 'writing'), config)).toBe(true);
  });

  it('denies a file outside every scan_path', () => {
    expect(isPathAllowed(join(ROOT, 'Other', 'thing.md'), config)).toBe(false);
  });

  it('denies a file inside a deny_path even though it is also in a scan_path', () => {
    expect(isPathAllowed(join(ROOT, 'Dropbox', 'finances', '2024.pdf'), config)).toBe(false);
  });

  it('respects directory boundaries — /writing/ does not match /writing-stuff/', () => {
    // Exact-prefix-with-trailing-separator means .../writing/ does NOT
    // match .../writing-stuff/. This is the codex T7 / storage-config
    // pattern: prefix matching at directory boundaries, not arbitrary
    // string prefixes.
    expect(isPathAllowed(join(ROOT, 'writing-stuff', 'file.md'), config)).toBe(false);
  });

  it('collapses traversal in the candidate before matching', () => {
    // resolve() flattens '..', so an escape attempt lands outside the
    // scan_path and is denied on its resolved form.
    expect(isPathAllowed(join(ROOT, 'writing', '..', 'Other', 'x.md'), config)).toBe(false);
  });

  it('rejects relative paths', () => {
    expect(isPathAllowed('./relative.md', config)).toBe(false);
  });
});

describe('isPathAllowed — platform-specific comparison semantics', () => {
  it.if(WIN)('win32: matches forward-slash input against native-separator config', () => {
    const config = normalizeAndValidateArchiveCrawlerConfig({
      scan_paths: [join(ROOT, 'writing')],
    });
    // A user may legitimately write forward slashes in gbrain.yml on
    // Windows; Win32 accepts them. Comparison must not care.
    expect(isPathAllowed('C:/gbtest/writing/essay.md', config)).toBe(true);
  });

  it.if(WIN)('win32: comparison is case-insensitive (NTFS semantics)', () => {
    const config = normalizeAndValidateArchiveCrawlerConfig({
      scan_paths: [join(ROOT, 'writing')],
      deny_paths: [join(ROOT, 'writing', 'Private')],
    });
    // Drive letter case must not matter.
    expect(isPathAllowed('c:\\gbtest\\writing\\essay.md', config)).toBe(true);
    // And neither may the deny_path's case — this is the fail-OPEN case:
    // 'Private' and 'private' are the SAME directory on NTFS, so a
    // case-sensitive compare would have let the sensitive file through.
    expect(isPathAllowed(join(ROOT, 'writing', 'private', 'tax.md'), config)).toBe(false);
    expect(isPathAllowed(join(ROOT, 'writing', 'PRIVATE', 'tax.md'), config)).toBe(false);
  });

  it.if(!WIN)('posix: comparison stays case-sensitive', () => {
    // Negative control for the win32 case-folding: POSIX filesystems are
    // case-sensitive, so folding there would be a real fail-open.
    const config = normalizeAndValidateArchiveCrawlerConfig({
      scan_paths: ['/home/user/Writing'],
    });
    expect(isPathAllowed('/home/user/Writing/essay.md', config)).toBe(true);
    expect(isPathAllowed('/home/user/writing/essay.md', config)).toBe(false);
  });

  it.if(!WIN)('posix: a literal backslash in a filename is not treated as a separator', () => {
    // Backslash is a legal POSIX filename character. Folding '\' -> '/'
    // on POSIX would collide two genuinely different paths, so the
    // comparator must leave POSIX paths untouched.
    const config = normalizeAndValidateArchiveCrawlerConfig({
      scan_paths: ['/home/user/a\\b'],
    });
    expect(isPathAllowed('/home/user/a\\b/file.md', config)).toBe(true);
    expect(isPathAllowed('/home/user/a/b/file.md', config)).toBe(false);
  });
});
