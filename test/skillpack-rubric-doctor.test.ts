/**
 * Tests for src/core/skillpack/rubric.ts + src/core/skillpack/doctor.ts +
 * src/core/skillpack/audit.ts.
 *
 * Build pack fixtures and walk the full rubric. Covers happy path (10/10),
 * each individual dimension failing in isolation, tier eligibility math,
 * auto-fix scaffold, and audit log append.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describeRubric, walkRubric, type RubricInput } from '../src/core/skillpack/rubric.ts';
import { formatDoctorResult, runDoctor } from '../src/core/skillpack/doctor.ts';
import {
  SKILLPACK_API_VERSION,
  loadSkillpackManifest,
  type SkillpackManifest,
} from '../src/core/skillpack/manifest-v1.ts';
import {
  currentAuditFilePath,
  logSkillpackEvent,
  readRecentSkillpackEvents,
} from '../src/core/skillpack/audit.ts';
import { withEnv } from './helpers/with-env.ts';

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rubric-doctor-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Build a "10/10" pack fixture in `dir`. */
function buildTenOutOfTenPack(dir: string, version = '0.1.0'): SkillpackManifest {
  const date = new Date().toISOString().slice(0, 10);
  const manifest: SkillpackManifest = {
    api_version: SKILLPACK_API_VERSION,
    name: 'ten-of-ten',
    version,
    description: 'Reference pack scoring 10/10',
    author: 'Garry Tan',
    license: 'MIT',
    homepage: 'https://example.com/ten-of-ten',
    gbrain_min_version: '0.36.0',
    skills: ['skills/judge-foo', 'skills/judge-bar'],
    unit_tests: ['test/**/*.test.ts'],
    e2e_tests: ['e2e/**/*.test.ts'],
    llm_evals: ['evals/*.judge.json'],
    routing_evals: ['skills/*/routing-eval.jsonl'],
    runbooks: { bootstrap: 'runbooks/bootstrap.md' },
    changelog: 'CHANGELOG.md',
  };

  mkdirSync(join(dir, 'skills/judge-foo'), { recursive: true });
  mkdirSync(join(dir, 'skills/judge-bar'), { recursive: true });
  writeFileSync(
    join(dir, 'skills/judge-foo/SKILL.md'),
    '---\nname: judge-foo\ndescription: foo judger\ntriggers:\n  - judge as foo\n  - foo this\n---\n',
  );
  writeFileSync(
    join(dir, 'skills/judge-bar/SKILL.md'),
    '---\nname: judge-bar\ndescription: bar judger\ntriggers:\n  - judge as bar\n  - bar this\n---\n',
  );
  // 5+ intents per skill.
  const evalA = Array.from({ length: 5 }, (_, i) => ({
    intent: `judge as foo ${i}`,
    expected_skill: 'judge-foo',
  }));
  const evalB = Array.from({ length: 5 }, (_, i) => ({
    intent: `judge as bar ${i}`,
    expected_skill: 'judge-bar',
  }));
  writeFileSync(
    join(dir, 'skills/judge-foo/routing-eval.jsonl'),
    evalA.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  writeFileSync(
    join(dir, 'skills/judge-bar/routing-eval.jsonl'),
    evalB.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );

  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'test/example.test.ts'), `import { test, expect } from 'bun:test'; test('x', () => expect(1).toBe(1));`);
  mkdirSync(join(dir, 'e2e'), { recursive: true });
  writeFileSync(join(dir, 'e2e/example.e2e.test.ts'), `import { test, expect } from 'bun:test'; test('e2e', () => expect(1).toBe(1));`);

  mkdirSync(join(dir, 'evals'), { recursive: true });
  writeFileSync(
    join(dir, 'evals/example.judge.json'),
    JSON.stringify(
      {
        task: 'Judge output quality',
        output: '<output>',
        cases: [
          { name: 'happy', criteria: 'output is correct' },
          { name: 'edge', criteria: 'output handles edge' },
          { name: 'fail', criteria: 'output refuses gracefully' },
        ],
      },
      null,
      2,
    ),
  );

  mkdirSync(join(dir, 'runbooks'), { recursive: true });
  writeFileSync(join(dir, 'runbooks/bootstrap.md'), `# Bootstrap\n\n1. show user: hello\n`);
  writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## [${version}] - ${date}\n\n- initial release\n`);
  writeFileSync(join(dir, 'LICENSE'), 'MIT License — full text here\n');
  writeFileSync(join(dir, 'skillpack.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe('walkRubric — 10/10 fixture', () => {
  test('scores 10 across all dimensions when every artifact is present and valid', async () => {
    const dir = mkdtempSync(join(tmp, 'ten-'));
    const manifest = buildTenOutOfTenPack(dir);
    const score = await walkRubric({ packRoot: dir, manifest });
    expect(score.total).toBe(10);
    expect(score.tier_eligibility).toBe('endorsed');
    expect(score.promotion_blockers).toEqual([]);
    expect(score.dimensions.every((d) => d.passed)).toBe(true);
  });
});

describe('walkRubric — individual dimensions fail in isolation', () => {
  test('dimension 2 (skills_have_skill_md) fails when SKILL.md is missing', async () => {
    const dir = mkdtempSync(join(tmp, 'd2-'));
    buildTenOutOfTenPack(dir);
    rmSync(join(dir, 'skills/judge-foo/SKILL.md'));
    const manifest = loadSkillpackManifest(dir);
    const score = await walkRubric({ packRoot: dir, manifest });
    const d2 = score.dimensions.find((d) => d.name === 'skills_have_skill_md');
    expect(d2?.passed).toBe(false);
    expect(d2?.detail).toContain('missing');
  });

  test('dimension 3 (routing_evals_present) fails on < 5 intents', async () => {
    const dir = mkdtempSync(join(tmp, 'd3-'));
    buildTenOutOfTenPack(dir);
    writeFileSync(
      join(dir, 'skills/judge-foo/routing-eval.jsonl'),
      `{"intent":"only one","expected_skill":"judge-foo"}\n`,
    );
    const manifest = loadSkillpackManifest(dir);
    const score = await walkRubric({ packRoot: dir, manifest });
    const d3 = score.dimensions.find((d) => d.name === 'routing_evals_present');
    expect(d3?.passed).toBe(false);
  });

  test('dimension 4 (skills_have_unique_triggers) fails when two skills share a trigger', async () => {
    const dir = mkdtempSync(join(tmp, 'd4-'));
    buildTenOutOfTenPack(dir);
    // Make judge-bar claim the same trigger as judge-foo.
    writeFileSync(
      join(dir, 'skills/judge-bar/SKILL.md'),
      '---\nname: judge-bar\ndescription: bar judger\ntriggers:\n  - judge as foo\n---\n',
    );
    const manifest = loadSkillpackManifest(dir);
    const score = await walkRubric({ packRoot: dir, manifest });
    const d4 = score.dimensions.find((d) => d.name === 'skills_have_unique_triggers');
    expect(d4?.passed).toBe(false);
    expect(d4?.detail).toContain('judge as foo');
  });

  test('dimension 5 (changelog) fails when version entry missing', async () => {
    const dir = mkdtempSync(join(tmp, 'd5-'));
    buildTenOutOfTenPack(dir);
    writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\nNo entries yet.\n`);
    const manifest = loadSkillpackManifest(dir);
    const score = await walkRubric({ packRoot: dir, manifest });
    const d5 = score.dimensions.find((d) => d.name === 'changelog_present_and_current');
    expect(d5?.passed).toBe(false);
  });

  test('badge 8 (llm_eval_present) fails when cases array < 3', async () => {
    const dir = mkdtempSync(join(tmp, 'd8-'));
    buildTenOutOfTenPack(dir);
    writeFileSync(
      join(dir, 'evals/example.judge.json'),
      JSON.stringify({ task: 't', output: 'o', cases: [{ name: 'a' }] }),
    );
    const manifest = loadSkillpackManifest(dir);
    const score = await walkRubric({ packRoot: dir, manifest });
    const d8 = score.dimensions.find((d) => d.name === 'llm_eval_present');
    expect(d8?.passed).toBe(false);
  });

  test('badge 9 (bootstrap_runbook_present) fails when manifest does not declare it', async () => {
    const dir = mkdtempSync(join(tmp, 'd9-'));
    const m = buildTenOutOfTenPack(dir);
    const stripped = { ...m };
    delete stripped.runbooks;
    writeFileSync(join(dir, 'skillpack.json'), JSON.stringify(stripped, null, 2));
    const manifest = loadSkillpackManifest(dir);
    const score = await walkRubric({ packRoot: dir, manifest });
    const d9 = score.dimensions.find((d) => d.name === 'bootstrap_runbook_present');
    expect(d9?.passed).toBe(false);
  });
});

describe('walkRubric — tier eligibility', () => {
  test('all core passed + all badges passed = endorsed', async () => {
    const dir = mkdtempSync(join(tmp, 'tier-end-'));
    const m = buildTenOutOfTenPack(dir);
    const score = await walkRubric({ packRoot: dir, manifest: m });
    expect(score.tier_eligibility).toBe('endorsed');
  });

  test('all core passed + 3 badges = community', async () => {
    const dir = mkdtempSync(join(tmp, 'tier-comm-'));
    const m = buildTenOutOfTenPack(dir);
    // Knock out 2 badges (unit_tests + e2e_tests).
    const stripped = { ...m };
    delete stripped.unit_tests;
    delete stripped.e2e_tests;
    writeFileSync(join(dir, 'skillpack.json'), JSON.stringify(stripped, null, 2));
    const manifest = loadSkillpackManifest(dir);
    const score = await walkRubric({ packRoot: dir, manifest });
    expect(score.badges_passed).toBe(3);
    expect(score.tier_eligibility).toBe('community');
  });

  test('all core + < 3 badges = experimental', async () => {
    const dir = mkdtempSync(join(tmp, 'tier-exp-'));
    const m = buildTenOutOfTenPack(dir);
    const stripped = { ...m };
    delete stripped.unit_tests;
    delete stripped.e2e_tests;
    delete stripped.llm_evals;
    delete stripped.runbooks;
    writeFileSync(join(dir, 'skillpack.json'), JSON.stringify(stripped, null, 2));
    // Also remove the bootstrap.md file so the dimension fails cleanly.
    rmSync(join(dir, 'runbooks/bootstrap.md'));
    // Remove license too to push badges to 1.
    rmSync(join(dir, 'LICENSE'));
    const manifest = loadSkillpackManifest(dir);
    const score = await walkRubric({ packRoot: dir, manifest });
    expect(score.badges_passed).toBeLessThan(3);
    expect(score.tier_eligibility).toBe('experimental');
  });

  test('any core fails = blocked', async () => {
    const dir = mkdtempSync(join(tmp, 'tier-block-'));
    buildTenOutOfTenPack(dir);
    rmSync(join(dir, 'CHANGELOG.md'));
    const manifest = loadSkillpackManifest(dir);
    const score = await walkRubric({ packRoot: dir, manifest });
    expect(score.tier_eligibility).toBe('blocked');
    expect(score.promotion_blockers).toContain('changelog_present_and_current');
  });
});

describe('runDoctor — orchestrator', () => {
  test('returns score=10 for the 10/10 fixture', async () => {
    const dir = mkdtempSync(join(tmp, 'doctor-ten-'));
    buildTenOutOfTenPack(dir);
    const r = await runDoctor({ packRoot: dir, mode: 'quick' });
    expect(r.score).toBe(10);
    expect(r.tier_eligibility).toBe('endorsed');
  });

  test('returns blocked + dimension 1 failure when manifest is malformed', async () => {
    const dir = mkdtempSync(join(tmp, 'doctor-bad-'));
    writeFileSync(join(dir, 'skillpack.json'), '{ broken json');
    const r = await runDoctor({ packRoot: dir, mode: 'quick' });
    expect(r.score).toBe(0);
    expect(r.tier_eligibility).toBe('blocked');
    expect(r.dimensions[0]?.name).toBe('manifest_valid');
    expect(r.dimensions[0]?.passed).toBe(false);
  });

  test('full mode emits the follow-up hint', async () => {
    const dir = mkdtempSync(join(tmp, 'doctor-full-'));
    buildTenOutOfTenPack(dir);
    const r = await runDoctor({ packRoot: dir, mode: 'full' });
    expect(r.full_mode_hint).toBeTruthy();
  });
});

describe('runDoctor --fix — auto-scaffold', () => {
  test('without --yes the plan is shown but nothing written', async () => {
    const dir = mkdtempSync(join(tmp, 'fix-noyes-'));
    const m = buildTenOutOfTenPack(dir);
    rmSync(join(dir, 'skills/judge-foo/routing-eval.jsonl'));
    // Hack: declare routing_evals but leave the file missing.
    const r = await runDoctor({ packRoot: dir, mode: 'quick', fix: true, yes: false });
    expect(r.fixes_applied).toEqual([]);
  });

  test('with --yes the missing artifacts are scaffolded', async () => {
    const dir = mkdtempSync(join(tmp, 'fix-yes-'));
    buildTenOutOfTenPack(dir);
    rmSync(join(dir, 'skills/judge-foo/routing-eval.jsonl'));
    rmSync(join(dir, 'runbooks/bootstrap.md'));
    rmSync(join(dir, 'LICENSE'));
    const r = await runDoctor({ packRoot: dir, mode: 'quick', fix: true, yes: true });
    expect(r.fixes_applied.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'skills/judge-foo/routing-eval.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'runbooks/bootstrap.md'))).toBe(true);
    expect(existsSync(join(dir, 'LICENSE'))).toBe(true);
  });
});

describe('formatDoctorResult — human-readable output', () => {
  test('renders pass/fail markers + dimension names + fix hints', async () => {
    const dir = mkdtempSync(join(tmp, 'fmt-'));
    buildTenOutOfTenPack(dir);
    rmSync(join(dir, 'LICENSE'));
    const r = await runDoctor({ packRoot: dir, mode: 'quick' });
    const text = formatDoctorResult(r);
    expect(text).toContain('ten-of-ten@0.1.0');
    expect(text).toContain('Core');
    expect(text).toContain('Quality badges');
    expect(text).toContain('license_present');
    expect(text).toContain('fix:');
  });
});

describe('describeRubric — pure-data export', () => {
  test('exposes 10 dimensions in stable order', () => {
    const list = describeRubric();
    expect(list).toHaveLength(10);
    expect(list[0]?.id).toBe(1);
    expect(list[9]?.id).toBe(10);
    expect(list.filter((d) => d.category === 'core')).toHaveLength(5);
    expect(list.filter((d) => d.category === 'badge')).toHaveLength(5);
  });
});

describe('audit — JSONL log', () => {
  test('logSkillpackEvent appends a line', async () => {
    const auditDir = mkdtempSync(join(tmp, 'audit-1-'));
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => {
      logSkillpackEvent({ event: 'scaffold_third_party', pack: 'foo', outcome: 'ok' });
      const file = currentAuditFilePath();
      expect(existsSync(file)).toBe(true);
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('"scaffold_third_party"');
      expect(content).toContain('"pack":"foo"');
    });
  });

  test('readRecentSkillpackEvents returns chronological events', async () => {
    const auditDir = mkdtempSync(join(tmp, 'audit-2-'));
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => {
      logSkillpackEvent({ event: 'search', pack: 'foo', outcome: 'ok' });
      logSkillpackEvent({ event: 'doctor_run', pack: 'foo', outcome: 'ok' });
      const events = readRecentSkillpackEvents(7);
      expect(events.length).toBe(2);
      expect(events[0]?.event).toBe('search');
      expect(events[1]?.event).toBe('doctor_run');
    });
  });

  test('readRecentSkillpackEvents skips malformed lines without throwing', async () => {
    const auditDir = mkdtempSync(join(tmp, 'audit-3-'));
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => {
      const file = currentAuditFilePath();
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(file, '{not json}\n{"ts":"2026-01-01","event":"search","outcome":"ok"}\n');
      const events = readRecentSkillpackEvents(365 * 5);
      expect(events.length).toBe(1);
    });
  });
});
