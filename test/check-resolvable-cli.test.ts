import { describe, it, expect, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  parseFlags,
  resolveSkillsDir,
  DEFERRED,
} from '../src/commands/check-resolvable.ts';

// Path to the CLI entry point. Runs through bun directly so tests don't
// require a pre-built binary. Always invoked from the repo root so bun can
// resolve transitive node_modules (the top-level cli.ts imports pull in
// @anthropic-ai/sdk which walks from the file path, but some internal
// shim resolution requires node_modules to be reachable from cwd too).
const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const REPO_ROOT = resolve(import.meta.dir, '..');

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface SkillSpec {
  name: string;
  triggers?: string[];
  /** Register in manifest.json — defaults true. */
  inManifest?: boolean;
  /** Add a RESOLVER.md row pointing at this skill — defaults true. */
  inResolver?: boolean;
}

function makeFixture(skills: SkillSpec[], created: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'check-resolvable-cli-'));
  created.push(root);
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  const manifest = {
    skills: skills
      .filter(s => s.inManifest !== false)
      .map(s => ({ name: s.name, path: `${s.name}/SKILL.md` })),
  };
  writeFileSync(join(skillsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  for (const s of skills) {
    const skillDir = join(skillsDir, s.name);
    mkdirSync(skillDir, { recursive: true });
    const fm = ['---', `name: ${s.name}`];
    if (s.triggers && s.triggers.length) {
      fm.push('triggers:');
      for (const t of s.triggers) fm.push(`  - "${t}"`);
    }
    fm.push('---');
    fm.push(`# ${s.name}\n\nA test skill.\n`);
    writeFileSync(join(skillDir, 'SKILL.md'), fm.join('\n'));
  }

  const rows = skills
    .filter(s => s.inResolver !== false)
    .map(s => `| "${s.name} trigger" | \`skills/${s.name}/SKILL.md\` |`);
  const resolver = [
    '# RESOLVER',
    '',
    '## Brain operations',
    '| Trigger | Skill |',
    '|---------|-------|',
    ...rows,
    '',
  ].join('\n');
  writeFileSync(join(skillsDir, 'RESOLVER.md'), resolver);

  return skillsDir;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  json: any;
}

function run(args: string[]): RunResult {
  const res = spawnSync('bun', [CLI, 'check-resolvable', ...args], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
  let json: any = null;
  if (args.includes('--json')) {
    try { json = JSON.parse(res.stdout); } catch { /* leave null */ }
  }
  return {
    status: res.status ?? -1,
    stdout: res.stdout,
    stderr: res.stderr,
    json,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: direct helpers (fast, no subprocess)
// ---------------------------------------------------------------------------

describe('check-resolvable — unit: parseFlags', () => {
  it('parses all known flags', () => {
    const f = parseFlags(['--json', '--fix', '--dry-run', '--verbose', '--skills-dir', '/x']);
    expect(f.json).toBe(true);
    expect(f.fix).toBe(true);
    expect(f.dryRun).toBe(true);
    expect(f.verbose).toBe(true);
    expect(f.skillsDir).toBe('/x');
  });

  it('supports --skills-dir=PATH syntax', () => {
    const f = parseFlags(['--skills-dir=/x/y']);
    expect(f.skillsDir).toBe('/x/y');
  });

  it('silently ignores unknown flags (permissive, matches lint/orphans convention)', () => {
    const f = parseFlags(['--json', '--bogus', '--another-unknown']);
    expect(f.json).toBe(true);
    expect(f.help).toBe(false);
  });
});

describe('check-resolvable — unit: resolveSkillsDir', () => {
  it('resolves absolute --skills-dir unchanged', () => {
    const r = resolveSkillsDir({ help: false, json: false, fix: false, dryRun: false, verbose: false, skillsDir: '/tmp/absolute-path' });
    expect(r.dir).toBe('/tmp/absolute-path');
    expect(r.error).toBeNull();
  });

  it('resolves relative --skills-dir against cwd', () => {
    const r = resolveSkillsDir({ help: false, json: false, fix: false, dryRun: false, verbose: false, skillsDir: 'skills' });
    expect(r.dir).toMatch(/\/skills$/);
    expect(r.error).toBeNull();
  });

  it('REGRESSION-GATE: returns no_skills_dir error when no --skills-dir and findRepoRoot fails', () => {
    // Temporarily chdir to a guaranteed-empty tmpdir. findRepoRoot will walk
    // up and fail to find skills/RESOLVER.md.
    const empty = mkdtempSync(join(tmpdir(), 'empty-for-resolve-'));
    const original = process.cwd();
    try {
      process.chdir(empty);
      const r = resolveSkillsDir({ help: false, json: false, fix: false, dryRun: false, verbose: false, skillsDir: null });
      expect(r.error).toBe('no_skills_dir');
      expect(r.dir).toBeNull();
      expect(typeof r.message).toBe('string');
    } finally {
      process.chdir(original);
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('finds skills via findRepoRoot when cwd is inside a repo (no --skills-dir)', () => {
    // Running from this test file — we're inside the real gbrain repo.
    const r = resolveSkillsDir({ help: false, json: false, fix: false, dryRun: false, verbose: false, skillsDir: null });
    expect(r.error).toBeNull();
    expect(r.dir).toMatch(/\/skills$/);
  });
});

describe('check-resolvable — unit: DEFERRED', () => {
  it('exports two deferred check entries for Checks 5 and 6', () => {
    expect(DEFERRED.length).toBe(2);
    expect(DEFERRED[0].check).toBe(5);
    expect(DEFERRED[0].name).toBe('trigger_routing_eval');
    expect(DEFERRED[1].check).toBe(6);
    expect(DEFERRED[1].name).toBe('brain_filing');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: subprocess via bun src/cli.ts (cwd = repo root)
// ---------------------------------------------------------------------------

describe('gbrain check-resolvable CLI — integration', () => {
  const created: string[] = [];
  afterEach(() => {
    while (created.length) {
      const p = created.pop()!;
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('prints usage and exits 0 on --help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gbrain check-resolvable');
    expect(r.stdout).toContain('--json');
    expect(r.stdout).toContain('--fix');
    expect(r.stdout).toContain('Check 5');
    expect(r.stdout).toContain('Check 6');
  });

  it('--json success envelope has all seven stable keys', () => {
    const skillsDir = makeFixture([{ name: 'alpha', triggers: ['alpha'] }], created);
    const r = run(['--json', '--skills-dir', skillsDir]);
    expect(r.json).not.toBeNull();
    const keys = Object.keys(r.json).sort();
    expect(keys).toEqual(['autoFix', 'deferred', 'error', 'message', 'ok', 'report', 'skillsDir']);
    expect(r.json.ok).toBe(true);
    expect(r.json.deferred.length).toBe(2);
    expect(r.json.deferred[0].check).toBe(5);
    expect(r.json.deferred[1].check).toBe(6);
  });

  it('--json success: autoFix is null when --fix was not passed', () => {
    const skillsDir = makeFixture([{ name: 'alpha', triggers: ['alpha'] }], created);
    const r = run(['--json', '--skills-dir', skillsDir]);
    expect(r.json.autoFix).toBeNull();
  });

  it('exits 0 on clean fixture with zero issues', () => {
    const skillsDir = makeFixture([{ name: 'alpha', triggers: ['alpha'] }], created);
    const r = run(['--skills-dir', skillsDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('resolver_health: OK');
  });

  it('REGRESSION-GATE: exits 1 when fixture has a warning-level orphan_trigger only', () => {
    // "alpha" is in resolver but not manifest → orphan_trigger (warning)
    const skillsDir = makeFixture(
      [{ name: 'alpha', triggers: ['alpha'], inManifest: false }],
      created,
    );
    const r = run(['--json', '--skills-dir', skillsDir]);
    expect(r.json).not.toBeNull();
    const warnings = r.json.report.issues.filter((i: any) => i.severity === 'warning');
    const errors = r.json.report.issues.filter((i: any) => i.severity === 'error');
    expect(warnings.length).toBeGreaterThan(0);
    expect(errors.length).toBe(0);
    // Doctor's ok=true-on-warnings-only would exit 0. check-resolvable MUST exit 1.
    expect(r.status).toBe(1);
  });

  it('exits 1 when fixture has an error-level unreachable skill', () => {
    // "alpha" is in manifest but not resolver → unreachable (error)
    const skillsDir = makeFixture(
      [{ name: 'alpha', triggers: ['alpha'], inResolver: false }],
      created,
    );
    const r = run(['--json', '--skills-dir', skillsDir]);
    expect(r.json).not.toBeNull();
    const errors = r.json.report.issues.filter((i: any) => i.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(r.status).toBe(1);
  });

  it('--fix --dry-run includes an autoFix object in the JSON envelope', () => {
    const skillsDir = makeFixture([{ name: 'alpha', triggers: ['alpha'] }], created);
    const r = run(['--json', '--fix', '--dry-run', '--skills-dir', skillsDir]);
    expect(r.json).not.toBeNull();
    expect(r.json.autoFix).not.toBeNull();
    expect(Array.isArray(r.json.autoFix.fixed)).toBe(true);
    expect(Array.isArray(r.json.autoFix.skipped)).toBe(true);
  });

  it('--verbose prints the deferred checks note in human mode', () => {
    const skillsDir = makeFixture([{ name: 'alpha', triggers: ['alpha'] }], created);
    const r = run(['--verbose', '--skills-dir', skillsDir]);
    expect(r.stdout).toContain('Deferred:');
    expect(r.stdout).toContain('trigger_routing_eval');
    expect(r.stdout).toContain('brain_filing');
  });

  it('clean fixture human output says all skills reachable', () => {
    const skillsDir = makeFixture(
      [
        { name: 'alpha', triggers: ['alpha'] },
        { name: 'beta', triggers: ['beta'] },
      ],
      created,
    );
    const r = run(['--skills-dir', skillsDir]);
    expect(r.stdout).toContain('resolver_health: OK');
    expect(r.stdout).toContain('2 skills');
    expect(r.status).toBe(0);
  });
});
