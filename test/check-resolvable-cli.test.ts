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
    const r = resolveSkillsDir({ help: false, json: false, fix: false, dryRun: false, verbose: false, strict: false, skillsDir: '/tmp/absolute-path' });
    expect(r.dir).toBe('/tmp/absolute-path');
    expect(r.error).toBeNull();
  });

  it('resolves relative --skills-dir against cwd', () => {
    const r = resolveSkillsDir({ help: false, json: false, fix: false, dryRun: false, verbose: false, strict: false, skillsDir: 'skills' });
    expect(r.dir).toMatch(/\/skills$/);
    expect(r.error).toBeNull();
    expect(r.source).toBe('explicit');
  });

  it('REGRESSION-GATE: returns no_skills_dir error when no --skills-dir and findRepoRoot fails', () => {
    // Temporarily chdir to a guaranteed-empty tmpdir. findRepoRoot will walk
    // up and fail to find skills/RESOLVER.md.
    const empty = mkdtempSync(join(tmpdir(), 'empty-for-resolve-'));
    const original = process.cwd();
    try {
      process.chdir(empty);
      const r = resolveSkillsDir({ help: false, json: false, fix: false, dryRun: false, verbose: false, strict: false, skillsDir: null });
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
    const r = resolveSkillsDir({ help: false, json: false, fix: false, dryRun: false, verbose: false, strict: false, skillsDir: null });
    expect(r.error).toBeNull();
    expect(r.dir).toMatch(/\/skills$/);
    expect(r.source).toBe('repo_root');
  });

  it('REGRESSION-GATE: --skills-dir override takes precedence over OpenClaw env auto-detection', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'explicit-skills-'));
    mkdirSync(explicit, { recursive: true });
    writeFileSync(join(explicit, 'RESOLVER.md'), '# RESOLVER\n');

    const workspace = mkdtempSync(join(tmpdir(), 'openclaw-ws-'));
    mkdirSync(join(workspace, 'skills'), { recursive: true });
    writeFileSync(join(workspace, 'skills', 'RESOLVER.md'), '# RESOLVER\n');

    const prev = process.env.OPENCLAW_WORKSPACE;
    process.env.OPENCLAW_WORKSPACE = workspace;
    try {
      const r = resolveSkillsDir({
        help: false,
        json: false,
        fix: false,
        dryRun: false,
        verbose: false,
        strict: false,
        skillsDir: explicit,
      });
      expect(r.error).toBeNull();
      expect(r.dir).toBe(explicit);
      expect(r.source).toBe('explicit');
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_WORKSPACE;
      else process.env.OPENCLAW_WORKSPACE = prev;
      rmSync(explicit, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('check-resolvable — unit: DEFERRED', () => {
  it('v0.17 ships Checks 5 and 6 — DEFERRED is empty', () => {
    // Pre-v0.17: both Check 5 (routing eval) and Check 6 (brain filing)
    // were deferred. v0.17 W2 shipped Check 5; v0.17 W3 shipped Check 6.
    // The DEFERRED export stays (stable --json field) for future checks.
    expect(DEFERRED.length).toBe(0);
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
    expect(r.stdout).toContain('--strict');
    // Check 5 shipped in v0.17 (mentioned in the body); Check 6 is
    // still deferred and must appear under "Deferred to separate issues".
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
    // v0.17 ships Checks 5 and 6; DEFERRED is empty. The key remains
    // stable for future checks.
    expect(Array.isArray(r.json.deferred)).toBe(true);
    expect(r.json.deferred.length).toBe(0);
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

  it('D-CX-3: warnings-only fixture exits 0 in default mode', () => {
    // "alpha" is in resolver but not manifest → orphan_trigger (warning)
    // Per D-CX-3 (codex review outside voice): warnings alone do not flip
    // the exit code. This is the new contract; callers who want strict
    // behavior pass --strict. Prior contract (exit 1 on any warning) broke
    // CI for workspaces emitting warning-level advisories like filing-audit.
    const skillsDir = makeFixture(
      [{ name: 'alpha', triggers: ['alpha'], inManifest: false }],
      created,
    );
    const r = run(['--json', '--skills-dir', skillsDir]);
    expect(r.json).not.toBeNull();
    expect(r.json.report.warnings.length).toBeGreaterThan(0);
    expect(r.json.report.errors.length).toBe(0);
    // warnings.length > 0 but errors.length === 0 → exit 0 (advisory)
    expect(r.status).toBe(0);
    expect(r.json.ok).toBe(true);
  });

  it('D-CX-3: --strict promotes warnings to exit 1', () => {
    const skillsDir = makeFixture(
      [{ name: 'alpha', triggers: ['alpha'], inManifest: false }],
      created,
    );
    const r = run(['--json', '--strict', '--skills-dir', skillsDir]);
    expect(r.json).not.toBeNull();
    expect(r.json.report.warnings.length).toBeGreaterThan(0);
    expect(r.json.report.errors.length).toBe(0);
    // --strict flips ok to false and exit to 1 when warnings exist
    expect(r.json.ok).toBe(false);
    expect(r.status).toBe(1);
  });

  it('D-CX-3: report has separate errors[] and warnings[] arrays alongside issues[]', () => {
    const skillsDir = makeFixture(
      [{ name: 'alpha', triggers: ['alpha'], inManifest: false }],
      created,
    );
    const r = run(['--json', '--skills-dir', skillsDir]);
    expect(r.json).not.toBeNull();
    const rep = r.json.report;
    expect(Array.isArray(rep.errors)).toBe(true);
    expect(Array.isArray(rep.warnings)).toBe(true);
    // Deprecated flat `issues` still present for one-release backcompat
    expect(Array.isArray(rep.issues)).toBe(true);
    expect(rep.issues.length).toBe(rep.errors.length + rep.warnings.length);
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
    // v0.17 ships Checks 5 and 6 → DEFERRED is empty. Verbose still
    // prints the "Deferred:" header for stable UX; downstream content
    // is empty until a future release adds a new deferred check.
    expect(r.stdout).toContain('Deferred:');
    expect(r.stdout).not.toContain('trigger_routing_eval');
    expect(r.stdout).not.toContain('brain_filing');
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

  it('logs the auto-detected skills directory path in human mode', () => {
    const r = run([]);
    expect(r.status === 0 || r.status === 1).toBe(true);
    expect(r.stdout).toContain('Auto-detected skills directory');
    expect(r.stdout).toContain('/skills');
  });
});
