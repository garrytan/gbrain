import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'check-skill-refs.mjs');
const REPO_ROOT = join(import.meta.dir, '..', '..');

function runOn(
  setup: (dir: string) => void,
  allowlist = '',
  opts: { cwd?: (dir: string) => string; cliRefs?: boolean } = {},
): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'skill-refs-'));
  try {
    const skills = join(dir, 'skills');
    mkdirSync(skills, { recursive: true });
    setup(skills);
    const allowPath = join(dir, 'allow.txt');
    writeFileSync(allowPath, allowlist);
    const args = [SCRIPT, '--skills-dir', skills, '--allowlist', allowPath];
    if (!opts.cliRefs) args.push('--no-cli-refs');
    const res = spawnSync('bun', args, {
      encoding: 'utf8',
      cwd: opts.cwd ? opts.cwd(dir) : dir,
    });
    return { code: res.status ?? -1, out: `${res.stdout}\n${res.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-skill-refs', () => {
  test('passes on a clean tree with resolving refs and placeholders', () => {
    const { code, out } = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      mkdirSync(join(skills, 'beta'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nSee `skills/beta/SKILL.md` and the template `skills/<slug>/SKILL.md` and `skills/{name}/SKILL.md`.\n');
      writeFileSync(join(skills, 'beta', 'SKILL.md'), '---\nname: beta\n---\nbody\n');
    });
    expect(out).toContain('OK');
    expect(code).toBe(0);
  });

  test('fails on a dangling backtick skills/ path', () => {
    const { code, out } = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), 'Read `skills/ghost/SKILL.md` for details.\n');
    });
    expect(code).toBe(1);
    expect(out).toContain('dangling-ref');
  });

  test('fails on a composes: slug that is not a skill dir', () => {
    const { code, out } = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), '---\nname: alpha\ncomposes: ghost-skill, alpha\n---\nbody\n');
    });
    expect(code).toBe(1);
    expect(out).toContain('dangling-composes');
    expect(out).toContain('ghost-skill');
  });

  test('fails on a dangling dispatcher slug in RESOLVER.md', () => {
    const { code, out } = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), 'body\n');
      writeFileSync(join(skills, 'RESOLVER.md'), '| "do things" (dispatcher for: alpha, ghost) | `skills/alpha/SKILL.md` |\n');
    });
    expect(code).toBe(1);
    expect(out).toContain('dangling-dispatcher');
    expect(out).toContain('ghost');
  });

  test('fails on a donor path outside the allowlist, passes when allowlisted', () => {
    // Assemble the banned prefix at runtime so this test file itself passes
    // the repo-wide privacy check (which bans the literal in source files).
    const bannedPath = ['/data', 'brain', 'notes.md'].join('/');
    const setup = (skills: string) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), `Writes go to ${bannedPath}\n`);
    };
    const fail = runOn(setup);
    expect(fail.code).toBe(1);
    expect(fail.out).toContain('donor-remnant');
    const pass = runOn(setup, 'skills/alpha/SKILL.md\n');
    expect(pass.code).toBe(0);
  });

  test('scans .jsonl (routing-eval) files for donor remnants; allowlist ratchets them too', () => {
    // Assemble the banned prefix at runtime (repo-wide privacy check bans the literal).
    const bannedPath = ['/data', 'brain', 'fixture.md'].join('/');
    const setup = (skills: string) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nclean body\n');
      writeFileSync(
        join(skills, 'alpha', 'routing-eval.jsonl'),
        `{"utterance":"do a thing","expected":"alpha","note":"${bannedPath}"}\n`,
      );
    };
    const fail = runOn(setup);
    expect(fail.code).toBe(1);
    expect(fail.out).toContain('donor-remnant');
    expect(fail.out).toContain('routing-eval.jsonl');
    const pass = runOn(setup, 'skills/alpha/routing-eval.jsonl\n');
    expect(pass.code).toBe(0);
  });

  test('a .jsonl file is not subject to the markdown-only lanes (backtick/composes)', () => {
    // A dangling `skills/ghost/...` inside a .jsonl string must NOT fail — the
    // dangling-ref lane is markdown-only; only donor remnants scan .jsonl.
    const { code, out } = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nclean body\n');
      writeFileSync(
        join(skills, 'alpha', 'routing-eval.jsonl'),
        '{"utterance":"read `skills/ghost/SKILL.md`","expected":"alpha"}\n',
      );
    });
    expect(code).toBe(0);
    expect(out).toContain('OK');
  });

  test('exempts skills/migrations wholesale', () => {
    const { code } = runOn((skills) => {
      mkdirSync(join(skills, 'migrations'));
      writeFileSync(join(skills, 'migrations', 'v0.1.0.md'), `Old world: ${['/data', 'brain'].join('/')} and \`skills/long-gone/SKILL.md\`\n`);
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), 'clean body\n');
    });
    expect(code).toBe(0);
  });

  test('fails on a block-list composes: form with a ghost slug', () => {
    const { code, out } = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(
        join(skills, 'alpha', 'SKILL.md'),
        '---\nname: alpha\ncomposes:\n  - ghost-two\n  - alpha\n---\nbody\n',
      );
    });
    expect(code).toBe(1);
    expect(out).toContain('dangling-composes');
    expect(out).toContain('ghost-two');
  });

  test('exits 2 when --skills-dir does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-refs-'));
    try {
      const res = spawnSync('bun', [SCRIPT, '--skills-dir', join(dir, 'nope'), '--no-cli-refs'], {
        encoding: 'utf8',
        cwd: dir,
      });
      expect(res.status).toBe(2);
      expect(`${res.stdout}\n${res.stderr}`).toContain('skills dir not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is cwd-independent: same results when run from a sibling dir', () => {
    const setup = (skills: string) => {
      mkdirSync(join(skills, 'alpha'));
      mkdirSync(join(skills, 'beta'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), 'See `skills/beta/SKILL.md`.\n');
      writeFileSync(join(skills, 'beta', 'SKILL.md'), 'body\n');
    };
    const fromParent = runOn(setup);
    const fromSibling = runOn(setup, '', {
      cwd: (dir) => {
        const sibling = join(dir, 'elsewhere');
        mkdirSync(sibling, { recursive: true });
        return sibling;
      },
    });
    expect(fromParent.code).toBe(0);
    expect(fromSibling.code).toBe(0);

    // Dangling refs must ALSO fail identically regardless of cwd.
    const dangling = (skills: string) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), 'See `skills/ghost/SKILL.md`.\n');
    };
    const dParent = runOn(dangling);
    const dSibling = runOn(dangling, '', {
      cwd: (dir) => {
        const sibling = join(dir, 'elsewhere');
        mkdirSync(sibling, { recursive: true });
        return sibling;
      },
    });
    expect(dParent.code).toBe(1);
    expect(dSibling.code).toBe(1);
    expect(dSibling.out).toContain('dangling-ref');
  });

  test('fails on a dangling relative markdown link; skips placeholder link targets', () => {
    const fail = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      writeFileSync(join(skills, 'alpha', 'SKILL.md'), 'Read [the missing doc](./missing.md) first.\n');
    });
    expect(fail.code).toBe(1);
    expect(fail.out).toContain('dangling-md-link');

    const pass = runOn((skills) => {
      mkdirSync(join(skills, 'alpha'));
      mkdirSync(join(skills, 'beta'));
      writeFileSync(join(skills, 'beta', 'SKILL.md'), 'body\n');
      writeFileSync(
        join(skills, 'alpha', 'SKILL.md'),
        [
          'Real link: [beta](../beta/SKILL.md).',
          'Brain-page example: [Alice Example](../people/alice-example.md).',
          'Company example: [Acme](../companies/acme-example.md).',
          'Template: [any skill](../<slug>/SKILL.md) and [var]({topic}/index.md).',
          '',
        ].join('\n'),
      );
    });
    expect(pass.code).toBe(0);
    expect(pass.out).toContain('OK');
  });

  test('cli-refs warn lane: unknown gbrain command in a fenced block warns without failing', () => {
    // The script derives the known-command set from src/cli.ts +
    // src/core/operations.ts of the CWD repo, so this one runs from the real
    // repo root against a temp skills dir.
    const { code, out } = runOn(
      (skills) => {
        mkdirSync(join(skills, 'alpha'));
        writeFileSync(
          join(skills, 'alpha', 'SKILL.md'),
          'Run:\n\n```bash\ngbrain not-a-real-command --flag\n```\n',
        );
      },
      '',
      { cliRefs: true, cwd: () => REPO_ROOT },
    );
    expect(out).toContain('[cli-refs]');
    expect(out).toContain('not-a-real-command');
    expect(code).toBe(0); // warn-only lane never fails the build
  }, 30_000);
});
