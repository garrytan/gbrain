/**
 * Tests for `loadSkillSources` in src/core/skillpack/bundle.ts —
 * the per-skill paired-source declaration via SKILL.md frontmatter
 * `sources:` array (v0.33+, D2).
 *
 * Pins the fail-loud validation contract:
 *   - empty/absent `sources:` → empty array, no error
 *   - non-string entry → BundleError(manifest_malformed)
 *   - absolute path → BundleError
 *   - `..` traversal → BundleError
 *   - declared file missing on disk → BundleError
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { BundleError, loadSkillSources } from '../src/core/skillpack/bundle.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function scratchGbrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'fms-gbrain-'));
  created.push(root);
  mkdirSync(join(root, 'src', 'commands'), { recursive: true });
  mkdirSync(join(root, 'skills', 'sample'), { recursive: true });
  return root;
}

function writeSkill(root: string, name: string, frontmatter: string): void {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n# ${name}\n`);
}

describe('loadSkillSources', () => {
  it('returns empty array when frontmatter has no `sources:` field', () => {
    const root = scratchGbrain();
    writeSkill(root, 'plain', 'name: plain\nversion: 0.1.0');

    const out = loadSkillSources(root, 'skills/plain');
    expect(out.slug).toBe('plain');
    expect(out.sources).toEqual([]);
  });

  it('returns empty array when SKILL.md is missing (shared-conventions dirs)', () => {
    const root = scratchGbrain();
    mkdirSync(join(root, 'skills', 'no-md-dir'));
    writeFileSync(join(root, 'skills', 'no-md-dir', 'README.md'), 'no skill here');

    const out = loadSkillSources(root, 'skills/no-md-dir');
    expect(out.sources).toEqual([]);
  });

  it('reads a valid `sources:` array and returns repo-relative paths', () => {
    const root = scratchGbrain();
    writeFileSync(join(root, 'src', 'commands', 'demo.ts'), '// stub');
    writeSkill(
      root,
      'demo',
      'name: demo\nsources:\n  - src/commands/demo.ts',
    );

    const out = loadSkillSources(root, 'skills/demo');
    expect(out.sources).toEqual(['src/commands/demo.ts']);
  });

  it('returns empty array when `sources: []` is explicitly empty', () => {
    const root = scratchGbrain();
    writeSkill(root, 'empty-sources', 'name: empty-sources\nsources: []');

    const out = loadSkillSources(root, 'skills/empty-sources');
    expect(out.sources).toEqual([]);
  });

  it('throws BundleError when `sources:` is not an array', () => {
    const root = scratchGbrain();
    writeSkill(root, 'bad', 'name: bad\nsources: not-an-array');

    expect(() => loadSkillSources(root, 'skills/bad')).toThrow(BundleError);
  });

  it('throws when an entry is not a string', () => {
    const root = scratchGbrain();
    writeSkill(root, 'bad', 'name: bad\nsources:\n  - 42');

    expect(() => loadSkillSources(root, 'skills/bad')).toThrow(BundleError);
  });

  it('throws on absolute paths', () => {
    const root = scratchGbrain();
    writeSkill(root, 'bad', 'name: bad\nsources:\n  - /etc/passwd');

    expect(() => loadSkillSources(root, 'skills/bad')).toThrow(/absolute/);
  });

  it('throws on `..` traversal', () => {
    const root = scratchGbrain();
    writeSkill(root, 'bad', 'name: bad\nsources:\n  - ../other-repo/src/leak.ts');

    expect(() => loadSkillSources(root, 'skills/bad')).toThrow(/traversal/);
  });

  it('throws when a declared source file is missing on disk', () => {
    const root = scratchGbrain();
    writeSkill(
      root,
      'gone',
      'name: gone\nsources:\n  - src/commands/never-built.ts',
    );

    expect(() => loadSkillSources(root, 'skills/gone')).toThrow(/missing from/);
  });

  it('throws on empty string entries', () => {
    const root = scratchGbrain();
    writeSkill(root, 'bad', 'name: bad\nsources:\n  - ""');

    expect(() => loadSkillSources(root, 'skills/bad')).toThrow(BundleError);
  });
});
