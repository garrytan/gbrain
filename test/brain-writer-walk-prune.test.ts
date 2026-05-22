/**
 * v0.38.2.0 — descent-time pruning regression suite.
 *
 * The original bug (PR #1287 reported, this PR fixes): `gbrain doctor` hung
 * indefinitely on a 216K-page brain because the frontmatter walker descended
 * into every node_modules / .git / .obsidian / *.raw / ops subtree on disk
 * and let `isSyncable` filter at the leaf — paying the IO cost of stat'ing
 * hundreds of thousands of vendor entries that were never going to be parsed.
 *
 * Why output-based tests don't catch this: `isSyncable` rejects the
 * vendor-tree files at the leaf, so a test that just asserts "no bad
 * markdown reported" passes BOTH before and after Fix 1 (codex outside-voice
 * C6). The load-bearing assertion is `walker did NOT DESCEND` — fired by
 * the new `visitDir` test seam.
 *
 * This file covers both walkers that were missing pruneDir:
 *   - brain-writer.ts:walkDir (driven by scanBrainSources / doctor)
 *   - frontmatter.ts:collectFiles (driven by `gbrain frontmatter validate`)
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { walkDir } from '../src/core/brain-writer.ts';
import { collectFiles } from '../src/commands/frontmatter.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'walk-prune-'));
  // Real syncable files under regular dirs — walker MUST descend here.
  mkdirSync(join(root, 'people'), { recursive: true });
  writeFileSync(join(root, 'people', 'alice.md'), '---\ntitle: Alice\n---\n\nbody\n');
  mkdirSync(join(root, 'concepts', 'subdir'), { recursive: true });
  writeFileSync(join(root, 'concepts', 'subdir', 'thing.md'), '---\ntitle: Thing\n---\n\nbody\n');
  // Vendor / hidden / generated trees — walker MUST NOT descend.
  mkdirSync(join(root, 'node_modules', 'fake-pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'fake-pkg', 'README.md'), '# Should not be visited\n');
  mkdirSync(join(root, '.git', 'objects'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), '[core]\n');
  mkdirSync(join(root, '.obsidian'), { recursive: true });
  writeFileSync(join(root, '.obsidian', 'workspace.json'), '{}');
  mkdirSync(join(root, 'people', 'pedro.raw'), { recursive: true });
  writeFileSync(join(root, 'people', 'pedro.raw', 'source.md'), '---\ntitle: should not visit\n---\n');
  mkdirSync(join(root, 'ops', 'logs'), { recursive: true });
  writeFileSync(join(root, 'ops', 'logs', 'run.md'), '# nope\n');
  // Nested node_modules — must also be pruned, not just at the root.
  mkdirSync(join(root, 'people', 'tools', 'node_modules', 'inner'), { recursive: true });
  writeFileSync(join(root, 'people', 'tools', 'node_modules', 'inner', 'a.md'), '---\ntitle: nope\n---\n');
  // Git-submodule pattern: a dir containing `.git` as a FILE (gitfile).
  mkdirSync(join(root, 'people', 'submod'), { recursive: true });
  writeFileSync(join(root, 'people', 'submod', '.git'), 'gitdir: ../../.git/modules/submod\n');
  writeFileSync(join(root, 'people', 'submod', 'README.md'), '---\ntitle: submod page\n---\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('walkDir (brain-writer.ts) — descent-time pruning', () => {
  test('does NOT descend into node_modules at any depth', () => {
    const visited: string[] = [];
    walkDir(root, () => {}, (dir) => visited.push(dir));
    expect(visited.some(d => d.includes('/node_modules'))).toBe(false);
  });

  test('does NOT descend into .git', () => {
    const visited: string[] = [];
    walkDir(root, () => {}, (dir) => visited.push(dir));
    expect(visited.some(d => d.endsWith('/.git') || d.includes('/.git/'))).toBe(false);
  });

  test('does NOT descend into .obsidian (dot-prefix heuristic)', () => {
    const visited: string[] = [];
    walkDir(root, () => {}, (dir) => visited.push(dir));
    expect(visited.some(d => d.includes('/.obsidian'))).toBe(false);
  });

  test('does NOT descend into *.raw sidecar dirs', () => {
    const visited: string[] = [];
    walkDir(root, () => {}, (dir) => visited.push(dir));
    expect(visited.some(d => d.endsWith('.raw'))).toBe(false);
  });

  test('does NOT descend into git submodule directories (.git as FILE)', () => {
    const visited: string[] = [];
    walkDir(root, () => {}, (dir) => visited.push(dir));
    expect(visited.some(d => d.endsWith('/people/submod'))).toBe(false);
  });

  test('DOES descend into regular subdirs and visits .md files there', () => {
    const visited: string[] = [];
    const files: string[] = [];
    walkDir(root, (f) => { files.push(f); }, (dir) => visited.push(dir));
    expect(visited.some(d => d.endsWith('/people'))).toBe(true);
    expect(visited.some(d => d.endsWith('/concepts/subdir'))).toBe(true);
    expect(files.some(f => f.endsWith('/people/alice.md'))).toBe(true);
    expect(files.some(f => f.endsWith('/concepts/subdir/thing.md'))).toBe(true);
    // And explicitly does NOT visit the file under node_modules.
    expect(files.some(f => f.includes('/node_modules/'))).toBe(false);
  });

  test('regression: pre-v0.38.2.0 walker would have descended into node_modules and stat\'d every entry', () => {
    // This is the load-bearing assertion. If a future contributor removes
    // the `pruneDir(name, dir)` gate in walkDir, this test fails because
    // visitDir would be called with node_modules paths.
    const descents: string[] = [];
    walkDir(root, () => {}, (d) => descents.push(d));
    const vendor = descents.filter(d => /\/(node_modules|\.git|\.obsidian|ops)(\/|$)/.test(d) || /\.raw$/.test(d));
    expect(vendor).toEqual([]);
  });
});

describe('collectFiles (frontmatter.ts) — descent-time pruning parity', () => {
  test('does NOT descend into node_modules at any depth', () => {
    const visited: string[] = [];
    collectFiles(root, (dir) => visited.push(dir));
    expect(visited.some(d => d.includes('/node_modules'))).toBe(false);
  });

  test('does NOT descend into .git, .obsidian, *.raw, or ops', () => {
    const visited: string[] = [];
    collectFiles(root, (dir) => visited.push(dir));
    expect(visited.some(d => d.includes('/.git'))).toBe(false);
    expect(visited.some(d => d.includes('/.obsidian'))).toBe(false);
    expect(visited.some(d => d.endsWith('.raw'))).toBe(false);
    expect(visited.some(d => d.endsWith('/ops') || d.includes('/ops/'))).toBe(false);
  });

  test('does NOT descend into git submodule directories', () => {
    const visited: string[] = [];
    collectFiles(root, (dir) => visited.push(dir));
    expect(visited.some(d => d.endsWith('/people/submod'))).toBe(false);
  });

  test('DOES collect .md files under regular subdirs', () => {
    const files = collectFiles(root);
    expect(files.some(f => f.endsWith('/people/alice.md'))).toBe(true);
    expect(files.some(f => f.endsWith('/concepts/subdir/thing.md'))).toBe(true);
    expect(files.some(f => f.includes('/node_modules/'))).toBe(false);
    expect(files.some(f => f.includes('/.git/'))).toBe(false);
    expect(files.some(f => f.includes('.raw/'))).toBe(false);
  });

  test('single-file target returns that file unchanged (no walk)', () => {
    const target = join(root, 'people', 'alice.md');
    const files = collectFiles(target);
    expect(files).toEqual([target]);
  });
});
