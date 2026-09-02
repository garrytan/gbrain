/**
 * #4673 — `gbrain doctor --skills-dir <path>` must be HONORED, not silently
 * ignored. Pre-fix, doctor accepted the flag (the registry declares it legal)
 * and then unconditionally auto-detected, so every skill check graded whatever
 * workspace auto-detect landed on — and `--fix` could write SKILL.md edits
 * into a workspace the operator explicitly steered away from, while doctor's
 * own --fix refusal copy recommends the flag.
 *
 * Doctor now resolves flag-first through check-resolvable's exported
 * resolveSkillsDir, sharing one precedence with check-resolvable and
 * routing-eval.
 *
 * Hermetic: fixture skills trees in tmpdirs, runDoctor(null, ['--fast',
 * '--json', ...]) in-process (no DB), env cleared of the skills-dir vars so
 * only the flag vs auto-detect distinction is under test.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';
import { runDoctor } from '../src/commands/doctor.ts';

let scratch: string;

beforeEach(() => {
  scratch = join(tmpdir(), `gbrain-doctor-sd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Build a minimal valid skills tree (manifest + RESOLVER.md + skills). */
function makeSkillsFixture(root: string, skillNames: string[], bodyBySkill: Record<string, string> = {}): string {
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    join(skillsDir, 'manifest.json'),
    JSON.stringify({ skills: skillNames.map((n) => ({ name: n, path: `${n}/SKILL.md` })) }, null, 2),
  );
  for (const n of skillNames) {
    mkdirSync(join(skillsDir, n), { recursive: true });
    const body = bodyBySkill[n] ?? `# ${n}\n\nA fixture skill.\n`;
    writeFileSync(
      join(skillsDir, n, 'SKILL.md'),
      `---\nname: ${n}\ntriggers:\n  - "${n} trigger"\n---\n${body}`,
    );
  }
  const rows = skillNames.map((n) => `| "${n} trigger" | \`skills/${n}/SKILL.md\` |`);
  writeFileSync(
    join(skillsDir, 'RESOLVER.md'),
    ['# RESOLVER', '', '## Brain operations', '| Trigger | Skill |', '|---------|-------|', ...rows, ''].join('\n'),
  );
  return skillsDir;
}

/** Run doctor in-process, capture the JSON envelope, neutralize process.exit. */
async function runDoctorJson(args: string[], env: Record<string, string | undefined>) {
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    captured.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
  };
  const origExit = process.exit;
  // A failing check makes runDoctor set process.exitCode = 1 — restore it so
  // a deliberately-failing fixture can't turn the whole test process red.
  const origExitCode = process.exitCode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number) => { throw new Error(`__doctor_exit__:${code ?? 0}`); };
  try {
    await withEnv(env, async () => {
      try {
        await runDoctor(null, ['--fast', '--json', ...args]);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith('__doctor_exit__:')) throw e;
      }
    });
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.exitCode = origExitCode;
  }
  const lines = captured.join('').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('{"schema_version"')) {
      return JSON.parse(trimmed) as { checks: { name: string; status: string; message: string }[] };
    }
  }
  throw new Error(`No doctor JSON envelope found; saw: ${captured.join('').slice(-500)}`);
}

const NO_ENV_SKILLS = { GBRAIN_SKILLS_DIR: undefined, OPENCLAW_WORKSPACE: undefined };

describe('doctor --skills-dir (#4673)', () => {
  test('skill checks grade the flagged dir, not the auto-detected workspace', async () => {
    const skillsDir = makeSkillsFixture(scratch, ['alpha-skill', 'beta-skill']);
    const parsed = await runDoctorJson(['--skills-dir', skillsDir], NO_ENV_SKILLS);
    const conformance = parsed.checks.find((c) => c.name === 'skill_conformance');
    expect(conformance).toBeDefined();
    // Auto-detect from the repo cwd would grade the bundled tree (dozens of
    // skills); the flag must pin grading to the 2-skill fixture.
    expect(conformance!.message).toStartWith('2/2');
    const resolver = parsed.checks.find((c) => c.name === 'resolver_health');
    expect(resolver).toBeDefined();
    expect(resolver!.message).toContain('2 skills');
  });

  test('--skills-dir=<path> (equals form) is honored too', async () => {
    const skillsDir = makeSkillsFixture(scratch, ['gamma-skill']);
    const parsed = await runDoctorJson([`--skills-dir=${skillsDir}`], NO_ENV_SKILLS);
    const conformance = parsed.checks.find((c) => c.name === 'skill_conformance');
    expect(conformance).toBeDefined();
    expect(conformance!.message).toStartWith('1/1');
  });

  test('--fix targets the flagged dir (explicit flag bypasses install-path refusal)', async () => {
    // Fixture must be a clean git repo: dry-fix refuses to write without a
    // git backup (no_git_backup) or with a dirty tree (working_tree_dirty).
    const fixtureRoot = join(scratch, 'brainrepo');
    mkdirSync(fixtureRoot, { recursive: true });
    const skillsDir = makeSkillsFixture(fixtureRoot, ['delta-skill'], {
      'delta-skill': '# delta-skill\n\nApply the notability gate before filing new entities.\n',
    });
    const git = (...a: string[]) => execFileSync('git', ['-C', fixtureRoot, ...a], { stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 'Fixture');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');

    const skillPath = join(skillsDir, 'delta-skill', 'SKILL.md');
    const before = readFileSync(skillPath, 'utf-8');
    expect(before).not.toContain('> **Convention:**');

    // Run from a NEUTRAL cwd (sibling of the fixture, no skills/ anywhere on
    // its walk-up path). Without the flag being honored, auto-detect falls
    // through to the gbrain install tree (source install_path) and --fix is
    // refused — the fixture stays untouched. With the fix, the explicit flag
    // targets the fixture (source 'explicit' bypasses the install-path
    // refusal, which is exactly the operator signal that gate wants).
    const neutral = join(scratch, 'neutral');
    mkdirSync(neutral, { recursive: true });
    const origCwd = process.cwd();
    process.chdir(neutral);
    try {
      await runDoctorJson(['--fix', '--skills-dir', skillsDir], NO_ENV_SKILLS);
    } finally {
      process.chdir(origCwd);
    }

    const after = readFileSync(skillPath, 'utf-8');
    expect(after).toContain('> **Convention:**');
    expect(after).toContain('skills/conventions/quality.md');
  });

  test('--skills-dir pointing at a NONEXISTENT dir does not throw; resolver_health grades it and names the path', async () => {
    const missing = join(scratch, 'no-such-skills');
    const parsed = await runDoctorJson(['--skills-dir', missing], NO_ENV_SKILLS);
    const resolver = parsed.checks.find((c) => c.name === 'resolver_health');
    expect(resolver).toBeDefined();
    // An explicit flag at an empty tree is a real finding, never a silent ok
    // (and never a fall-through to the auto-detected workspace).
    expect(['fail', 'warn']).toContain(resolver!.status);
    expect(JSON.stringify(resolver)).toContain(missing);
  });

  test('a RELATIVE --skills-dir resolves against cwd, not the install tree', async () => {
    makeSkillsFixture(scratch, ['rel-skill']);
    const origCwd = process.cwd();
    process.chdir(scratch);
    try {
      const parsed = await runDoctorJson(['--skills-dir', 'skills'], NO_ENV_SKILLS);
      const conformance = parsed.checks.find((c) => c.name === 'skill_conformance');
      expect(conformance).toBeDefined();
      expect(conformance!.message).toStartWith('1/1');
    } finally {
      process.chdir(origCwd);
    }
  });

  test('--fix with a MISSING --skills-dir creates nothing on disk', async () => {
    const missing = join(scratch, 'ghost-skills');
    await runDoctorJson(['--fix', '--skills-dir', missing], NO_ENV_SKILLS);
    expect(existsSync(missing)).toBe(false);
  });
});
