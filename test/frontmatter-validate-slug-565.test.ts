import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { spawnSync } from 'child_process';

const fence = '---';

function runValidate(path: string): { stdout: string; code: number } {
  const r = spawnSync(process.execPath, ['run', 'src/cli.ts', 'frontmatter', 'validate', path], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: process.env,
  });
  return { stdout: r.stdout ?? '', code: r.status ?? -1 };
}

function hasGitAncestor(path: string): boolean {
  let candidate = resolve(path);
  while (true) {
    if (existsSync(join(candidate, '.git'))) return true;
    const parent = dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

// Regression for #565. Single-file `frontmatter validate` derived the expected
// slug from the ABSOLUTE path: `relative(resolve(target), file)` is empty when
// the target IS the file, so it fell back to `|| file` (the full path),
// yielding bogus "root/<abs-path>" slugs and a false SLUG_MISMATCH. The hook
// installed by `frontmatter install-hook` validates staged files one-by-one,
// so this rejected every commit in a markdown brain. The expected slug must be
// derived relative to the brain root (nearest `.git`).
describe('frontmatter validate single-file slug (#565)', () => {
  let brain: string;

  beforeEach(() => {
    brain = mkdtempSync(join(tmpdir(), 'fm-565-'));
    mkdirSync(join(brain, '.git'), { recursive: true }); // brain-root marker
  });

  afterEach(() => {
    rmSync(brain, { recursive: true, force: true });
  });

  test('single file with a correct nested slug validates clean', () => {
    mkdirSync(join(brain, 'companies'), { recursive: true });
    const f = join(brain, 'companies', 'readme.md');
    writeFileSync(f, `${fence}\ntype: company\ntitle: Readme\nslug: companies/readme\n${fence}\n\nbody`);
    const { stdout, code } = runValidate(f);
    expect(stdout).not.toContain('SLUG_MISMATCH');
    expect(code).toBe(0);
  });

  test('directory validation still derives brain-root-relative slugs', () => {
    mkdirSync(join(brain, 'people'), { recursive: true });
    writeFileSync(
      join(brain, 'people', 'alice.md'),
      `${fence}\ntype: person\ntitle: Alice\nslug: people/alice\n${fence}\n\nbody`,
    );
    const { stdout, code } = runValidate(join(brain, 'people'));
    expect(stdout).not.toContain('SLUG_MISMATCH');
    expect(code).toBe(0);
  });

  test('file with no .git ancestor falls back to basename (no crash, no abs-path slug)', () => {
    // Common temporary roots may themselves be Git worktrees on developer
    // machines. Select a writable fixture root whose ancestor chain is
    // genuinely marker-free, otherwise the premise of this test is false.
    const fixtureRoot = [tmpdir(), homedir(), '/dev/shm', '/var/tmp']
      .find(candidate => existsSync(candidate) && !hasGitAncestor(candidate));
    expect(fixtureRoot).toBeDefined();
    const noGitBrain = mkdtempSync(join(fixtureRoot!, 'fm-565-no-git-'));
    try {
      const f = join(noGitBrain, 'note.md');
      writeFileSync(f, `${fence}\ntype: note\ntitle: Note\nslug: note\n${fence}\n\nbody`);
      const { stdout, code } = runValidate(f);
      expect(stdout).not.toContain('SLUG_MISMATCH');
      expect(code).toBe(0);
    } finally {
      rmSync(noGitBrain, { recursive: true, force: true });
    }
  });
});
