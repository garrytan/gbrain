/**
 * E2E for the v0.36.x skill_brain_first wave (T10 from /plan-eng-review).
 *
 * Two layers:
 *   1. **Fixture-corpus shape assertions (always runs in CI):** assemble a
 *      synthetic skills dir under tempdir using the fixture corpus and the
 *      `manifest.json` shape `loadOrDeriveManifest` accepts. Run the
 *      `skillBrainFirstCheck()` doctor check + the auto-fix INSERT path
 *      and assert structural invariants (T1 — shape, not count):
 *        - structurally-exempt skills MUST be ok
 *        - canonical-callout skills MUST be ok
 *        - skills with `brain_first: exempt` MUST be ok
 *        - external + no compliance + no exempt MUST be warn
 *        - --fix materializes the callout at the correct insertion site
 *        - re-running doctor after --fix reports 0 violations
 *
 *   2. **Live OpenClaw shape (opt-in, $OPENCLAW_WORKSPACE-gated):** lives
 *      at `scripts/live-brain-first-check.ts`. NOT in `bun run verify`.
 *      Manual run during dev/QA to validate the wave against the real
 *      deployment.
 *
 * No DATABASE_URL needed — entirely filesystem. Auto-fix path requires a
 * git repo (the safety gate refuses writes outside one), so the test
 * inits a throwaway git repo in the tempdir and commits the fixtures
 * before exercising --fix.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

import { skillBrainFirstCheck } from '../../src/commands/doctor.ts';
import { autoFixDryViolations } from '../../src/core/dry-fix.ts';

const FIXTURE_SOURCE = join(import.meta.dir, '..', 'fixtures', 'brain-first-skills');

interface Workspace {
  dir: string;
  skillsDir: string;
  cleanup: () => void;
}

function copyFixturesIntoTempWorkspace(): Workspace {
  const root = join(
    tmpdir(),
    `brain-first-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const skills = join(root, 'skills');
  mkdirSync(skills, { recursive: true });

  // Mirror every fixture skill into the tempdir.
  for (const name of readdirSync(FIXTURE_SOURCE)) {
    const srcDir = join(FIXTURE_SOURCE, name);
    const dstDir = join(skills, name);
    mkdirSync(dstDir, { recursive: true });
    const src = readFileSync(join(srcDir, 'SKILL.md'), 'utf-8');
    writeFileSync(join(dstDir, 'SKILL.md'), src);
  }

  // Init git so the dry-fix safety gate sees "clean tracked file" not
  // "not a repo." The auto-fix REFUSES writes when the file isn't under
  // git (would destroy the only copy with no rollback).
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'fixtures'],
    { cwd: root },
  );

  return {
    dir: root,
    skillsDir: skills,
    cleanup: () => {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

let workspace: Workspace;

beforeEach(() => {
  workspace = copyFixturesIntoTempWorkspace();
  // Redirect audit dir to the tempdir so the snapshot file doesn't pollute
  // the real $GBRAIN_AUDIT_DIR.
  process.env.GBRAIN_AUDIT_DIR = join(workspace.dir, 'audit');
});

afterEach(() => {
  delete process.env.GBRAIN_AUDIT_DIR;
  workspace.cleanup();
});

describe('skill_brain_first E2E (fixture corpus)', () => {
  test('SHAPE: warn surfaces non-compliant fixtures by name', () => {
    const result = skillBrainFirstCheck(workspace.skillsDir);
    expect(result.status).toBe('warn');
    const violatorSlugs = (result.issues ?? []).map(i => i.skill).sort();
    // SHAPE: exactly the deliberately-bad fixtures must be in violators.
    expect(violatorSlugs).toContain('missing-brain-first');
    expect(violatorSlugs).toContain('multi-pattern');
    expect(violatorSlugs).toContain('typo-frontmatter');
  });

  test('SHAPE: compliant fixtures MUST NOT appear in violators', () => {
    const result = skillBrainFirstCheck(workspace.skillsDir);
    const violatorSlugs = new Set((result.issues ?? []).map(i => i.skill));
    expect(violatorSlugs.has('compliant-callout')).toBe(false);
    expect(violatorSlugs.has('compliant-phase')).toBe(false);
    expect(violatorSlugs.has('compliant-position')).toBe(false);
    expect(violatorSlugs.has('exempt-frontmatter')).toBe(false);
    expect(violatorSlugs.has('no-external')).toBe(false);
    expect(violatorSlugs.has('negation-prose')).toBe(false);
  });

  test('SHAPE: typo-frontmatter surfaces typo_hint in fix payload', () => {
    const result = skillBrainFirstCheck(workspace.skillsDir);
    const typoIssue = (result.issues ?? []).find(i => i.skill === 'typo-frontmatter');
    expect(typoIssue).toBeDefined();
    expect(typoIssue!.fix.typo_hint).toBeDefined();
    expect(typoIssue!.fix.typo_hint).toContain('snake_case');
  });

  test('--fix INSERT path: dry-run reports proposed callouts without writing', () => {
    const initialContent = readFileSync(
      join(workspace.skillsDir, 'missing-brain-first', 'SKILL.md'),
      'utf-8',
    );
    const report = autoFixDryViolations(workspace.skillsDir, { dryRun: true });
    const proposed = report.fixed.filter(f => f.status === 'proposed' && f.patternLabel === 'brain-first compliance');
    expect(proposed.length).toBeGreaterThanOrEqual(2); // missing-brain-first + multi-pattern at least
    // File MUST NOT have been written during dry-run.
    const afterDryRun = readFileSync(
      join(workspace.skillsDir, 'missing-brain-first', 'SKILL.md'),
      'utf-8',
    );
    expect(afterDryRun).toBe(initialContent);
  });

  test('--fix INSERT path: applied write inserts canonical callout at correct site', () => {
    const before = readFileSync(
      join(workspace.skillsDir, 'missing-brain-first', 'SKILL.md'),
      'utf-8',
    );
    const report = autoFixDryViolations(workspace.skillsDir);
    const applied = report.fixed.filter(f => f.status === 'applied' && f.patternLabel === 'brain-first compliance');
    expect(applied.length).toBeGreaterThanOrEqual(2);
    const after = readFileSync(
      join(workspace.skillsDir, 'missing-brain-first', 'SKILL.md'),
      'utf-8',
    );
    expect(after).not.toBe(before);
    // The callout must be present.
    expect(after).toMatch(/^>\s*\*\*Convention:\*\*[^\n]*brain-first/im);
    // It must land AFTER frontmatter close + AFTER first H1.
    const frontmatterClose = after.indexOf('---\n', 4); // second `---`
    const h1Index = after.indexOf('# missing-brain-first');
    const calloutIndex = after.search(/^>\s*\*\*Convention:\*\*[^\n]*brain-first/im);
    expect(calloutIndex).toBeGreaterThan(frontmatterClose);
    expect(calloutIndex).toBeGreaterThan(h1Index);
  });

  test('--fix INSERT path: second run is idempotent (already_delegated)', () => {
    autoFixDryViolations(workspace.skillsDir);
    const report2 = autoFixDryViolations(workspace.skillsDir);
    const applied = report2.fixed.filter(f => f.status === 'applied' && f.patternLabel === 'brain-first compliance');
    expect(applied.length).toBe(0);
    // The skipped reasons for any brain-first attempts should be `already_delegated`.
    const skippedBf = report2.skipped.filter(f => f.patternLabel === 'brain-first compliance');
    for (const sk of skippedBf) {
      expect(sk.reason).toBe('already_delegated');
    }
  });

  test('--fix INSERT path: re-running doctor after fix reports 0 brain-first violators (excluding typo case which still has invalid frontmatter)', () => {
    autoFixDryViolations(workspace.skillsDir);
    const result = skillBrainFirstCheck(workspace.skillsDir);
    const violatorSlugs = (result.issues ?? []).map(i => i.skill).sort();
    // After --fix, missing-brain-first and multi-pattern should be resolved
    // via the inserted callout. typo-frontmatter ALSO gets the callout
    // inserted (because the typo'd brain_first didn't exempt it, so the
    // analyzer flagged it, so --fix inserted). So it should also flip to ok.
    // (The typo hint goes away too because it's only surfaced for warn cases.)
    expect(violatorSlugs).not.toContain('missing-brain-first');
    expect(violatorSlugs).not.toContain('multi-pattern');
    expect(violatorSlugs).not.toContain('typo-frontmatter');
  });

  test('SHAPE: structural-exemption-by-no-external-pattern is honored (no-external fixture)', () => {
    const result = skillBrainFirstCheck(workspace.skillsDir);
    const issue = (result.issues ?? []).find(i => i.skill === 'no-external');
    expect(issue).toBeUndefined();
  });

  test('SHAPE: declarative opt-out is honored (exempt-frontmatter fixture)', () => {
    const result = skillBrainFirstCheck(workspace.skillsDir);
    const issue = (result.issues ?? []).find(i => i.skill === 'exempt-frontmatter');
    expect(issue).toBeUndefined();
  });

  test('AUDIT: first doctor run bootstraps snapshot + writes detected events for current violators', () => {
    skillBrainFirstCheck(workspace.skillsDir);
    const auditDir = process.env.GBRAIN_AUDIT_DIR!;
    expect(existsSync(join(auditDir, 'skill-brain-first-snapshot.json'))).toBe(true);
    // Read the audit file and confirm detected events are present.
    const files = readdirSync(auditDir).filter(f => f.startsWith('skill-brain-first-') && f.endsWith('.jsonl'));
    expect(files.length).toBe(1);
    const audit = readFileSync(join(auditDir, files[0]), 'utf-8');
    expect(audit).toContain('"event":"detected"');
    expect(audit).toContain('missing-brain-first');
  });

  test('AUDIT: second doctor run with no transitions produces zero new audit lines (A2 contract)', () => {
    skillBrainFirstCheck(workspace.skillsDir); // first run bootstraps
    const auditDir = process.env.GBRAIN_AUDIT_DIR!;
    const files = readdirSync(auditDir).filter(f => f.endsWith('.jsonl'));
    const initialLength = files.length > 0
      ? readFileSync(join(auditDir, files[0]), 'utf-8').split('\n').filter(l => l.length > 0).length
      : 0;
    skillBrainFirstCheck(workspace.skillsDir); // second run — no transitions
    const afterLength = files.length > 0
      ? readFileSync(join(auditDir, files[0]), 'utf-8').split('\n').filter(l => l.length > 0).length
      : 0;
    expect(afterLength).toBe(initialLength);
  });

  test('AUDIT: applied --fix shifts skills from warn → ok across runs (transition signal)', () => {
    skillBrainFirstCheck(workspace.skillsDir); // bootstrap
    autoFixDryViolations(workspace.skillsDir); // resolve violations
    skillBrainFirstCheck(workspace.skillsDir); // post-fix scan
    const auditDir = process.env.GBRAIN_AUDIT_DIR!;
    const files = readdirSync(auditDir).filter(f => f.endsWith('.jsonl'));
    const audit = readFileSync(join(auditDir, files[0]), 'utf-8');
    // The post-fix run should have written resolved events for the
    // skills that flipped from warn → ok.
    expect(audit).toContain('"event":"resolved"');
  });
});
