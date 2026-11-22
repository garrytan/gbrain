/**
 * recordScaffoldBases (src/core/skillpack/safe-update.ts) records an install
 * base for a skill folder named `..drafts`, and still skips a file that sits
 * outside the skills root.
 *
 * Authoring gate:
 * 1. Protects: a scaffolded skill whose folder name starts with two dots gets
 *    its install base recorded, so a later `--update-untouched` can update it;
 *    a file outside the skills root (a `../` path, a sibling folder sharing the
 *    root's name prefix, or a symlinked parent pointing outside) is never
 *    recorded as a skill of this root.
 * 2. Regression that fails it: the "outside the root" test matching any
 *    relative path that starts with the two characters `..` rather than a `..`
 *    path component; or loosening it so outside files get recorded.
 * 3. Why existing coverage misses it: skillpack-safe-update.test.ts records
 *    bases only for ordinary slugs (`demo`, `other`) and has no outside-root
 *    case for recordScaffoldBases.
 * 4. Production seam: none. The exported recordScaffoldBases and loadState are
 *    used with a private state file, as the sibling test does.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { recordScaffoldBases, skillsRootKey } from '../src/core/skillpack/safe-update.ts';
import { sha256 } from '../src/core/skillpack/update-journal.ts';
import { loadState } from '../src/core/skillpack/state.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

interface Env { dir: string; skillsRoot: string; statePath: string }

function setup(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-bases-dotdot-'));
  created.push(dir);
  const skillsRoot = join(dir, 'skills');
  mkdirSync(skillsRoot, { recursive: true });
  return { dir, skillsRoot, statePath: join(dir, 'state', 'skillpack-state.json') };
}

function writeSkill(path: string, body: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** The recorded slugs of the skills root, or [] when nothing was recorded. */
function recordedSlugs(env: Env): string[] {
  const roots = loadState({ statePath: env.statePath }).roots ?? {};
  return Object.keys(roots[skillsRootKey(env.skillsRoot)] ?? {});
}

/**
 * Record `target` together with an ordinary in-root skill (`demo`). The control
 * proves recording works at all, so an empty result for `target` is the skip.
 */
async function recordWithControl(env: Env, target: string): Promise<void> {
  const control = writeSkill(join(env.skillsRoot, 'demo', 'SKILL.md'), '# demo\n');
  await recordScaffoldBases(env.skillsRoot, [
    { target, outcome: 'wrote_new', sharedDep: false },
    { target: control, outcome: 'wrote_new', sharedDep: false },
  ], { statePath: env.statePath });
}

describe('recordScaffoldBases with a skill folder whose name starts with two dots', () => {
  test('records the base of a skill written under a ..drafts folder', async () => {
    const env = setup();
    const target = writeSkill(join(env.skillsRoot, '..drafts', 'SKILL.md'), '# drafts\n');

    await recordScaffoldBases(env.skillsRoot, [{ target, outcome: 'wrote_new', sharedDep: false }], { statePath: env.statePath });

    const roots = loadState({ statePath: env.statePath }).roots ?? {};
    const record = roots[skillsRootKey(env.skillsRoot)]?.['..drafts'];
    expect(record?.files['..drafts/SKILL.md']).toBe(sha256('# drafts\n'));
  });

  test('records an ordinary skill next to a ..drafts one', async () => {
    const env = setup();
    const dotted = writeSkill(join(env.skillsRoot, '..x', 'SKILL.md'), '# x\n');
    const plain = writeSkill(join(env.skillsRoot, 'demo', 'SKILL.md'), '# demo\n');

    await recordScaffoldBases(env.skillsRoot, [
      { target: dotted, outcome: 'wrote_new', sharedDep: false },
      { target: plain, outcome: 'wrote_new', sharedDep: false },
    ], { statePath: env.statePath });

    expect(recordedSlugs(env).sort()).toEqual(['..x', 'demo']);
  });
});

describe('recordScaffoldBases still skips a file outside the skills root', () => {
  test('skips a file in a plain folder above the skills root', async () => {
    const env = setup();
    const target = writeSkill(join(env.dir, 'elsewhere', 'SKILL.md'), '# elsewhere\n');

    await recordWithControl(env, target);

    expect(recordedSlugs(env)).toEqual(['demo']);
  });

  test('skips a file in a sibling folder that shares the skills root name prefix', async () => {
    const env = setup();
    const target = writeSkill(join(env.dir, 'skills2', 'demo', 'SKILL.md'), '# sibling\n');

    await recordWithControl(env, target);

    expect(recordedSlugs(env)).toEqual(['demo']);
  });

  test('skips a file in a ..outside folder next to the skills root', async () => {
    const env = setup();
    const target = writeSkill(join(env.dir, '..outside', 'demo', 'SKILL.md'), '# outside\n');

    await recordWithControl(env, target);

    expect(recordedSlugs(env)).toEqual(['demo']);
  });

  test('skips a file whose skill folder is a symlink pointing outside the skills root', async () => {
    const env = setup();
    const outside = join(env.dir, 'outside-skill');
    writeSkill(join(outside, 'SKILL.md'), '# outside\n');
    symlinkSync(outside, join(env.skillsRoot, 'linked'), 'dir');

    await recordWithControl(env, join(env.skillsRoot, 'linked', 'SKILL.md'));

    expect(recordedSlugs(env)).toEqual(['demo']);
  });
});
