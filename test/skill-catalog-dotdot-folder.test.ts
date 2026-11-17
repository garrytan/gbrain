/**
 * `confineManifestPath` (src/core/skill-catalog.ts) confines a skills-manifest entry to the skills directory before
 * `get_skill` and `list_skills` read it.
 * Protects: an entry whose SKILL.md sits in a first folder named `..shared` (or `...`), or is reached through an
 * in-directory symlink to such a folder, resolves to its real path; an entry that leaves the directory (`../`), points
 * into a sibling folder that shares the directory's name prefix, or goes through a symlink that points outside, is still
 * refused with invalid_params.
 * Authoring gate: (1) whether a legal skill in the skills directory can be read through get_skill and list_skills;
 * (2) a startsWith('..') check that is not component-aware refuses `..shared/alpha/SKILL.md` as "escapes skills dir";
 * (3) skill-catalog.test.ts only uses ordinary folder names; (4) no seam: the exported function on real temp dirs.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { confineManifestPath } from '../src/core/skill-catalog.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** `<dir>/skills` (the skills directory) plus `<dir>/skills2` and `<dir>/outside` siblings. */
function layout(): { dir: string; skills: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-skill-catalog-dotdot-')));
  dirs.push(dir);
  const skills = join(dir, 'skills');
  mkdirSync(skills, { recursive: true });
  return { dir, skills };
}

function skillAt(root: string, rel: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '---\nname: alpha\n---\n# alpha\n');
  return abs;
}

describe('confineManifestPath with a first folder whose name starts with two dots', () => {
  test('a SKILL.md under ..shared or ... resolves to its real path', () => {
    const { skills } = layout();
    const shared = skillAt(skills, '..shared/alpha/SKILL.md');
    const dots = skillAt(skills, '.../beta/SKILL.md');
    expect(confineManifestPath(skills, { name: 'alpha', path: '..shared/alpha/SKILL.md' })).toBe(shared);
    expect(confineManifestPath(skills, { name: 'beta', path: '.../beta/SKILL.md' })).toBe(dots);
  });

  test('an in-directory symlink to a ..real folder resolves', () => {
    const { skills } = layout();
    const real = skillAt(skills, '..real/gamma/SKILL.md');
    symlinkSync('..real/gamma', join(skills, 'gamma'), 'dir');
    expect(confineManifestPath(skills, { name: 'gamma', path: 'gamma/SKILL.md' })).toBe(real);
  });

  test('an ordinary folder resolves the same way (control)', () => {
    const { skills } = layout();
    const plain = skillAt(skills, 'alpha/SKILL.md');
    expect(confineManifestPath(skills, { name: 'alpha', path: 'alpha/SKILL.md' })).toBe(plain);
  });

  test('entries that leave the directory stay refused: ../, name-prefix sibling, symlink out', () => {
    const { dir, skills } = layout();
    skillAt(dir, 'outside/alpha/SKILL.md');
    skillAt(dir, 'skills2/alpha/SKILL.md');
    symlinkSync(join(dir, 'outside', 'alpha'), join(skills, 'linked'), 'dir');
    for (const path of ['../outside/alpha/SKILL.md', '../skills2/alpha/SKILL.md', 'linked/SKILL.md']) {
      let code = 'none';
      try { confineManifestPath(skills, { name: 'alpha', path }); } catch (e) { code = (e as { code?: string }).code ?? String(e); }
      expect(`${path}: ${code}`).toBe(`${path}: invalid_params`);
    }
  });
});
