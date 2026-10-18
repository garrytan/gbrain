/**
 * scripts/check-shared-tree-git.sh — #6530 shared-checkout git guard.
 *
 * Protects: skills, recipes, templates, docs, plugin trees and the three agent
 * entry docs never teach a git command that stashes, rebases, sweeps up or
 * discards other writers' files in a brain checkout several agents share
 * (git pull --rebase, --autostash, git stash, repo-wide add/commit, reset
 * --hard, force or bare push), while `git stash store`, `git push --dry-run`,
 * path-scoped adds and lines with a reasoned allow marker pass; and the
 * Multi-agent rules block stays identical in AGENTS.md, BOOTSTRAP_FOR_AGENTS.md
 * and INSTALL_FOR_AGENTS.md.
 * Fails when: a flagged form stops failing, an allowed form starts failing,
 * an allow marker without a reason or an unclosed allow region passes, an
 * exempt contributor doc starts failing, the failure loses its FAIL / Why /
 * Fix / See lines or the file:line, or the script stops parsing under
 * /bin/bash (3.2 on macOS).
 * Seam: GBRAIN_GUARD_ROOT pointed at temp trees and the committed fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const SCRIPT = join(REPO, 'scripts/check-shared-tree-git.sh');
const FIXTURES = join(REPO, 'test/fixtures/guards/check-shared-tree-git.sh');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shared-tree-git-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(resolve(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

function run(guardRoot = root, args: string[] = [], shell = 'bash') {
  return spawnSync(shell, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: guardRoot } });
}

const fence = (body: string) => `# Skill\n\n\`\`\`bash\n${body}\n\`\`\`\n`;

const FLAGGED: Array<[string, string]> = [
  ['git pull --rebase origin main', 'pull-rebase'],
  ['git -C ~/brain pull -r', 'pull-rebase'],
  ['git pull --rebase --autostash', 'pull-rebase'],
  ['git rebase --autostash origin/main', 'autostash'],
  ['git stash', 'stash'],
  ['git stash pop', 'stash'],
  ['git add -A', 'add-all'],
  ['git add -A && git commit -m "x"', 'add-all'],
  ['git add --all', 'add-all'],
  ['git add .', 'add-all'],
  ['git commit -am "x"', 'commit-all'],
  ['git commit -a -m "x"', 'commit-all'],
  ['git -C ~/brain commit -qam "x"', 'commit-all'],
  ['git reset --hard origin/main', 'reset-hard'],
  ['git push --force origin main', 'force-push'],
  ['git push -f', 'force-push'],
  ['git push --force-with-lease', 'force-push'],
  ['git push origin +main', 'force-push'],
  ['git push', 'push'],
  ['git push -u origin main', 'push'],
  ['cd brain && git commit -m "x" -- a.md && git push', 'push'],
];

const ALLOWED = [
  'gbrain git commit-push -m "x" -- people/alice-example.md',
  'gbrain git commit-push --push-only',
  'scripts/brain-commit-push.sh --pull',
  'git stash store -m "rescued" "$(cat "$f")"',
  'git stash list',
  'git stash show -p stash@{0}',
  'git push --dry-run origin HEAD:main',
  'git add -A -- people/alice-example.md',
  'git add people/alice-example.md',
  'git commit -m "x" -- people/alice-example.md',
  'git commit --amend --no-edit',
  'git merge --ff-only --no-autostash origin/main',
  'git pull --no-rebase --ff-only',
  'ls .git/rebase-merge',
];

describe('check-shared-tree-git.sh', () => {
  it('passes a tree that uses the shared-checkout commands', () => {
    write('skills/s/SKILL.md', fence(ALLOWED.join('\n')));
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✓ shared-tree git');
  });

  for (const [cmd, kind] of FLAGGED) {
    it(`fails on \`${cmd}\` in a code block as ${kind}, with FAIL / Why / Fix / See`, () => {
      write('skills/s/SKILL.md', fence(cmd));
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`FAIL: skills/s/SKILL.md:4 ${kind} `);
      expect(r.stderr).toMatch(/^Why: {2}\S/m);
      expect(r.stderr).toMatch(/^Fix: {2}\S/m);
      expect(r.stderr).toContain('See:  docs/guides/shared-checkout-git.md');
    });
  }

  it('checks inline code spans in prose but not plain prose', () => {
    write('docs/a.md', 'Run `git pull --rebase` first.\n');
    write('docs/b.md', 'The recipe spreads at the speed of a git push.\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL: docs/a.md:1 pull-rebase "git pull --rebase"');
    expect(r.stderr).not.toContain('docs/b.md');
  });

  it('checks every line of a .sh file, comments included', () => {
    write('skills/s/scripts/run.sh', '#!/bin/sh\n# then git push\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL: skills/s/scripts/run.sh:2 push ');
  });

  it('passes the three allow-marker forms, each with a reason', () => {
    write('skills/s/SKILL.md', [
      '```bash',
      'git push --force origin main  # gbrain-allow-shared-tree-git: confirmed purge of a private clone',
      '```',
      '',
      '<!-- gbrain-allow-shared-tree-git: names what never to run -->',
      'Never run `git pull --rebase` here.',
      '',
      '<!-- gbrain-allow-shared-tree-git-begin: the forbidden list -->',
      '- `git stash`',
      '- `git reset --hard`',
      '<!-- gbrain-allow-shared-tree-git-end -->',
      '',
      'A same-line prose note: `git push -u origin main` <!-- gbrain-allow-shared-tree-git: first push of a new branch -->',
      '',
    ].join('\n'));
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('a prose marker covers only the next line', () => {
    write('docs/a.md', '<!-- gbrain-allow-shared-tree-git: one line -->\nRun `git stash` once.\nThen `git stash` again.\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL: docs/a.md:3 stash ');
    expect(r.stderr).not.toContain('docs/a.md:2');
  });

  it('fails a marker without a reason and an unclosed allow region', () => {
    write('recipes/a.md', fence('git reset --hard  # gbrain-allow-shared-tree-git:'));
    write('docs/b.md', '<!-- gbrain-allow-shared-tree-git-begin: never closed -->\n- `git stash`\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL: recipes/a.md:4 allow-marker-without-reason ');
    expect(r.stderr).toContain('FAIL: docs/b.md:1 unclosed allow region');
  });

  it('scans skills, recipes, templates, docs, plugin trees and the agent docs', () => {
    const scanned = ['skills/a/SKILL.md', 'recipes/r.md', 'templates/bootstrap/AGENTS.md.template', 'docs/guides/g.md',
      'plugin/skills/a/SKILL.md', 'plugin-variants/v/skills/a/SKILL.md'];
    for (const rel of scanned) write(rel, 'Run `git stash` now.\n');
    const r = run();
    expect(r.status).toBe(1);
    for (const rel of scanned) expect(r.stderr).toContain(`FAIL: ${rel}:1 stash `);
  });

  it('exempts generated error codes, contributor docs about the gbrain repo and historical records', () => {
    for (const rel of ['docs/guides/error-codes.md', 'docs/RELEASING.md', 'docs/TESTING.md', 'docs/contributing/v.md',
      'docs/designs/d.md', 'docs/plans/p.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'TODOS.md', 'test/x.md', 'src/x.md']) {
      write(rel, 'Run `git push --force` now.\n');
    }
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('requires the Multi-agent rules block to be identical in every agent doc', () => {
    const block = (body: string) => `# Doc\n\n<!-- BEGIN multi-agent-rules -->\n${body}\n<!-- END multi-agent-rules -->\n`;
    write('AGENTS.md', block('Use `gbrain git commit-push`.'));
    write('INSTALL_FOR_AGENTS.md', block('Use `gbrain git commit-push`.'));
    expect(run().status).toBe(0);
    write('BOOTSTRAP_FOR_AGENTS.md', block('Use the helper.'));
    let r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL: BOOTSTRAP_FOR_AGENTS.md Multi-agent rules block differs from AGENTS.md');
    write('BOOTSTRAP_FOR_AGENTS.md', '# Bootstrap\n');
    r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL: BOOTSTRAP_FOR_AGENTS.md has no Multi-agent rules block');
  });

  it('scans only the named files when given arguments', () => {
    write('docs/a.md', 'Run `git stash`.\n');
    write('docs/b.md', 'Run `git push`.\n');
    const r = run(root, ['docs/b.md']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL: docs/b.md:1 push ');
    expect(r.stderr).not.toContain('docs/a.md');
  });

  it('the committed fixtures: good passes and every bad tree fails', () => {
    expect(run(join(FIXTURES, 'good')).status).toBe(0);
    const bad = readdirSync(FIXTURES).filter(d => d === 'bad' || d.startsWith('bad-'));
    expect(bad.length).toBeGreaterThan(1);
    for (const d of bad) expect({ d, status: run(join(FIXTURES, d)).status }).toEqual({ d, status: 1 });
  });
});

describe('check-shared-tree-git.sh under /bin/bash (3.2 on macOS)', () => {
  it('parses', () => {
    const r = spawnSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('still flags a stash', () => {
    write('docs/a.md', fence('git stash'));
    const r = run(root, [], '/bin/bash');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL: docs/a.md:4 stash ');
  });

  it('reads the awk program without a heredoc inside $(...)', () => {
    expect(readFileSync(SCRIPT, 'utf8')).not.toMatch(/\$\(\s*cat\s+<</);
  });
});
