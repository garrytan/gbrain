/**
 * test/e2e/openclaw-reference-compat.test.ts — W1 ship-blocker gate.
 *
 * This is THE test that proves v0.17 delivers on its headline claim:
 * `gbrain check-resolvable` against an OpenClaw-reference workspace
 * layout (AGENTS.md at workspace root, skills/ below, no manifest.json)
 * runs cleanly and surfaces sensible issues.
 *
 * Fixture: `test/fixtures/openclaw-reference-minimal/` ships 4 skills
 * plus an AGENTS.md with a resolver table. Every test here exercises
 * the full W1 + W2 + W3 + W4 + W5 stack against that fixture.
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { checkResolvable } from '../../src/core/check-resolvable.ts';
import { autoDetectSkillsDir } from '../../src/core/repo-root.ts';
import { loadOrDeriveManifest } from '../../src/core/skill-manifest.ts';
import {
  applyInstall,
  planInstall,
} from '../../src/core/skillpack/installer.ts';
import { findGbrainRoot } from '../../src/core/skillpack/bundle.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'openclaw-reference-minimal');
const SKILLS_DIR = join(FIXTURE, 'skills');
const REPO = join(import.meta.dir, '..', '..');
const CLI = join(REPO, 'src', 'cli.ts');

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const d = created.pop();
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('OpenClaw reference workspace compat (W1 + W2 + W3)', () => {
  it('fixture exists at the expected path', () => {
    expect(existsSync(FIXTURE)).toBe(true);
    expect(existsSync(join(FIXTURE, 'AGENTS.md'))).toBe(true);
    expect(existsSync(SKILLS_DIR)).toBe(true);
    expect(existsSync(join(FIXTURE, 'skills', 'manifest.json'))).toBe(false);
  });

  it('auto-detects skills dir via $OPENCLAW_WORKSPACE (D-CX-4 priority)', () => {
    // Priority: explicit env wins over repo-root walk. Without the
    // env var, we'd get gbrain's own repo. With it set, we should
    // get the fixture's skills dir.
    const detected = autoDetectSkillsDir(process.cwd(), { OPENCLAW_WORKSPACE: FIXTURE });
    expect(detected.dir).toBe(SKILLS_DIR);
    // AGENTS.md is at the workspace root, not inside skills/, so the
    // source should be the workspace-root variant.
    expect(detected.source).toBe('openclaw_workspace_env_root');
  });

  it('auto-derives manifest from SKILL.md walk (F-ENG-1)', () => {
    const result = loadOrDeriveManifest(SKILLS_DIR);
    expect(result.derived).toBe(true);
    expect(result.skills.map(s => s.name).sort()).toEqual([
      'brain-ops',
      'context-now',
      'query',
      'signal-detector',
    ]);
  });

  it('checkResolvable accepts AGENTS.md at workspace root and runs all checks', () => {
    const report = checkResolvable(SKILLS_DIR);
    // Top-level ok is errors-only (D-CX-3) — no unreachable/missing-file errors.
    expect(report.ok).toBe(true);
    expect(report.errors.length).toBe(0);
    // All 4 skills should be reachable via AGENTS.md rows.
    expect(report.summary.total_skills).toBe(4);
    expect(report.summary.reachable).toBe(4);
    expect(report.summary.unreachable).toBe(0);
  });

  it('brain-ops declares writes_pages+writes_to — filing audit clean', () => {
    const report = checkResolvable(SKILLS_DIR);
    const filing = report.warnings.filter(w =>
      w.type === 'filing_missing_writes_to' || w.type === 'filing_unknown_directory',
    );
    expect(filing).toEqual([]);
  });

  it('CLI subprocess: gbrain check-resolvable --json --skills-dir FIXTURE clean', () => {
    const r = spawnSync(
      'bun',
      [CLI, 'check-resolvable', '--json', '--skills-dir', SKILLS_DIR],
      { encoding: 'utf-8', cwd: REPO, maxBuffer: 10 * 1024 * 1024 },
    );
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.report.errors).toEqual([]);
    expect(env.report.summary.total_skills).toBe(4);
  });

  it('CLI subprocess: $OPENCLAW_WORKSPACE auto-detect without --skills-dir', () => {
    const r = spawnSync('bun', [CLI, 'check-resolvable', '--json'], {
      encoding: 'utf-8',
      cwd: REPO,
      env: { ...process.env, OPENCLAW_WORKSPACE: FIXTURE },
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.skillsDir).toBe(SKILLS_DIR);
    expect(env.ok).toBe(true);
  });

  it('skillpack install against OpenClaw-reference layout writes managed block to AGENTS.md', () => {
    // Copy fixture into a tmp workspace so we can install without
    // polluting the fixture itself.
    const target = mkdtempSync(join(tmpdir(), 'openclaw-ref-install-'));
    created.push(target);
    mkdirSync(join(target, 'skills'), { recursive: true });
    // Just the AGENTS.md shell — no skills yet, install writes them.
    writeFileSync(
      join(target, 'AGENTS.md'),
      '# AGENTS\n\n| Trigger | Skill |\n|---------|-------|\n',
    );

    const gbrainRoot = findGbrainRoot();
    expect(gbrainRoot).not.toBeNull();

    const opts = {
      gbrainRoot: gbrainRoot!,
      targetWorkspace: target,
      targetSkillsDir: join(target, 'skills'),
      skillSlug: 'brain-ops',
    };
    const plan = planInstall(opts);
    const result = applyInstall(plan, opts);
    expect(result.summary.wroteNew).toBeGreaterThan(0);
    expect(result.managedBlock.applied).toBe(true);
    expect(result.managedBlock.resolverFile).toBe(join(target, 'AGENTS.md'));

    const agents = readFileSync(join(target, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('gbrain:skillpack:begin');
    expect(agents).toContain('`skills/brain-ops/SKILL.md`');
    // Pre-existing resolver table preserved.
    expect(agents).toContain('| Trigger | Skill |');
  });
});
