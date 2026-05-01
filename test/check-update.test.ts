import { describe, test, expect } from 'bun:test';
import { parseSemver, isMinorOrMajorBump, extractChangelogBetween } from '../src/commands/check-update.ts';

describe('parseSemver', () => {
  test('parses standard version', () => {
    expect(parseSemver('0.4.0')).toEqual([0, 4, 0]);
  });

  test('strips v prefix', () => {
    expect(parseSemver('v0.5.0')).toEqual([0, 5, 0]);
  });

  test('returns null for malformed version', () => {
    expect(parseSemver('0.4')).toBeNull();
    expect(parseSemver('abc')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });

  test('handles 4-part versions (takes first 3)', () => {
    expect(parseSemver('0.2.0.1')).toEqual([0, 2, 0]);
  });
});

describe('isMinorOrMajorBump', () => {
  test('0.4.0 vs 0.5.0 → update available (minor bump)', () => {
    expect(isMinorOrMajorBump('0.4.0', '0.5.0')).toBe(true);
  });

  test('0.4.0 vs 0.4.1 → NOT available (patch only)', () => {
    expect(isMinorOrMajorBump('0.4.0', '0.4.1')).toBe(false);
  });

  test('0.4.0 vs 1.0.0 → update available (major bump)', () => {
    expect(isMinorOrMajorBump('0.4.0', '1.0.0')).toBe(true);
  });

  test('0.4.0 vs 0.4.0 → NOT available (same version)', () => {
    expect(isMinorOrMajorBump('0.4.0', '0.4.0')).toBe(false);
  });

  test('0.4.0 vs 0.3.0 → NOT available (older)', () => {
    expect(isMinorOrMajorBump('0.4.0', '0.3.0')).toBe(false);
  });

  test('0.4.1 vs 0.5.0 → update available (minor bump, different patch)', () => {
    expect(isMinorOrMajorBump('0.4.1', '0.5.0')).toBe(true);
  });

  test('malformed version → returns false', () => {
    expect(isMinorOrMajorBump('0.4.0', 'abc')).toBe(false);
    expect(isMinorOrMajorBump('bad', '0.5.0')).toBe(false);
  });

  test('handles v prefix on latest', () => {
    expect(isMinorOrMajorBump('0.4.0', 'v0.5.0')).toBe(true);
  });
});

describe('extractChangelogBetween', () => {
  const changelog = `# Changelog

## [0.5.0] - 2026-05-01

### Added
- Feature X

## [0.4.1] - 2026-04-15

### Fixed
- Bug Y

## [0.4.0] - 2026-04-09

### Added
- Feature Z

## [0.3.0] - 2026-04-08

### Added
- Feature W
`;

  test('extracts entries between 0.4.0 and 0.5.0', () => {
    const result = extractChangelogBetween(changelog, '0.4.0', '0.5.0');
    expect(result).toContain('Feature X');
    expect(result).toContain('Bug Y');
    expect(result).not.toContain('Feature Z');
    expect(result).not.toContain('Feature W');
  });

  test('extracts only 0.5.0 when upgrading from 0.4.1', () => {
    const result = extractChangelogBetween(changelog, '0.4.1', '0.5.0');
    expect(result).toContain('Feature X');
    expect(result).not.toContain('Bug Y');
  });

  test('returns empty for same version', () => {
    const result = extractChangelogBetween(changelog, '0.5.0', '0.5.0');
    expect(result).toBe('');
  });

  test('returns empty for malformed from version', () => {
    const result = extractChangelogBetween(changelog, 'bad', '0.5.0');
    expect(result).toBe('');
  });

  test('does not capture older major versions incorrectly', () => {
    const crossMajor = `# Changelog

## [2.0.0] - 2026-06-01
### Added
- Major 2

## [0.5.0] - 2026-05-01
### Added
- Minor 5
`;
    const result = extractChangelogBetween(crossMajor, '1.2.0', '2.0.0');
    expect(result).toContain('Major 2');
    expect(result).not.toContain('Minor 5');
  });
});

describe('check-update CLI', () => {
  test('check-update is in CLI_ONLY set', async () => {
    const source = await Bun.file(
      new URL('../src/cli.ts', import.meta.url).pathname
    ).text();
    expect(source).toContain("'check-update'");
  });

  test('check-update recommends Bun global update for Bun installs', async () => {
    const source = await Bun.file(
      new URL('../src/commands/check-update.ts', import.meta.url).pathname
    ).text();
    expect(source).toContain("case 'bun': return 'bun update -g mbrain'");
    expect(source).not.toContain("case 'bun': return 'bun update mbrain'");
  });

  test('--help prints usage and exits 0', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'check-update', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('check-update');
    expect(exitCode).toBe(0);
  });

  test('--json returns valid JSON with required fields', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'check-update', '--json'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const output = JSON.parse(stdout);
    expect(output).toHaveProperty('current_version');
    expect(output).toHaveProperty('update_available');
    expect(output).toHaveProperty('upgrade_command');
    expect(output).toHaveProperty('current_source', 'package-json');
    expect(typeof output.update_available).toBe('boolean');
  });
});
