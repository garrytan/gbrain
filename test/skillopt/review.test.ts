/**
 * SkillOpt review/promote route tests.
 *
 * Covers the safe default review path plus the explicit promotion path.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseFlags } from '../../src/commands/skillopt.ts';
import { reviewSkillOptCandidate } from '../../src/core/skillopt/review.ts';
import { bestPath, skillPath } from '../../src/core/skillopt/version-store.ts';

const SKILL = 'review-example';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-review-'));
  fs.mkdirSync(path.join(tmpDir, SKILL, 'skillopt'), { recursive: true });
  fs.writeFileSync(skillPath(tmpDir, SKILL), '# Review Example\n\nCurrent behavior.\n');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('reviewSkillOptCandidate', () => {
  test('reports a candidate without mutating SKILL.md by default', () => {
    const candidate = '# Review Example\n\nCurrent behavior.\n\nBetter guardrail.\n';
    fs.writeFileSync(bestPath(tmpDir, SKILL), candidate);

    const result = reviewSkillOptCandidate({ skillsDir: tmpDir, skillName: SKILL });

    expect(result.recommendation).toBe('agent_review_required');
    expect(result.applied).toBe(false);
    expect(result.best_path).toBe(bestPath(tmpDir, SKILL));
    expect(result.changed).toBe(true);
    expect(result.line_delta).toBe(2);
    expect(fs.readFileSync(skillPath(tmpDir, SKILL), 'utf8')).not.toContain('Better guardrail');
  });

  test('promotes best.md into SKILL.md only with apply', () => {
    const candidate = '# Review Example\n\nPromoted behavior.\n';
    fs.writeFileSync(bestPath(tmpDir, SKILL), candidate);

    const result = reviewSkillOptCandidate({ skillsDir: tmpDir, skillName: SKILL, apply: true });

    expect(result.recommendation).toBe('promoted');
    expect(result.applied).toBe(true);
    expect(fs.readFileSync(skillPath(tmpDir, SKILL), 'utf8')).toBe(candidate);
  });

  test('reports no_candidate when best.md is absent', () => {
    const result = reviewSkillOptCandidate({ skillsDir: tmpDir, skillName: SKILL });

    expect(result.recommendation).toBe('no_candidate');
    expect(result.applied).toBe(false);
    expect(result.changed).toBe(false);
  });
});

describe('parseFlags — review route', () => {
  test('parses review subcommand and explicit apply', () => {
    const parsed = parseFlags(['review', SKILL, '--apply', '--json']);

    expect(parsed.review).toBe(true);
    expect(parsed.reviewApply).toBe(true);
    expect(parsed.skillName).toBe(SKILL);
    expect(parsed.json).toBe(true);
  });
});

