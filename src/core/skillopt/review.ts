/**
 * SkillOpt candidate review/promotion helper.
 *
 * This is intentionally deterministic and file-local: it gives agents a stable
 * review surface for `skillopt/best.md` without asking Sawyer to inspect raw
 * files. Human/LLM judgment can decide whether to call the explicit apply path.
 */

import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWrite, getWorkingTreeStatusForFile } from './apply-edits.ts';
import { bestPath, loadHistory, skillPath } from './version-store.ts';
import { errorFor } from '../errors.ts';

export type SkillOptReviewRecommendation =
  | 'no_candidate'
  | 'already_live'
  | 'agent_review_required'
  | 'promoted';

export interface SkillOptReviewResult {
  skill: string;
  skill_path: string;
  best_path: string;
  recommendation: SkillOptReviewRecommendation;
  current_sha8: string;
  best_sha8?: string;
  changed: boolean;
  current_lines: number;
  best_lines?: number;
  line_delta?: number;
  committed_versions: number;
  pending_versions: number;
  applied: boolean;
  summary: string;
}

export interface ReviewSkillOptCandidateOpts {
  skillsDir: string;
  skillName: string;
  apply?: boolean;
  force?: boolean;
}

export function reviewSkillOptCandidate(opts: ReviewSkillOptCandidateOpts): SkillOptReviewResult {
  const skillFile = skillPath(opts.skillsDir, opts.skillName);
  const candidateFile = bestPath(opts.skillsDir, opts.skillName);

  if (!fs.existsSync(skillFile)) {
    throw errorFor({
      class: 'NoSkill',
      code: 'no_skill_md',
      message: `Cannot find SKILL.md for '${opts.skillName}' at ${skillFile}.`,
      hint: `Create the skill first or pass --skills-dir <path>.`,
    });
  }

  const currentText = fs.readFileSync(skillFile, 'utf8');
  const history = loadHistory(opts.skillsDir, opts.skillName);
  const committedVersions = history.filter((r) => r.status === 'committed').length;
  const pendingVersions = history.filter((r) => r.status === 'pending').length;

  if (!fs.existsSync(candidateFile)) {
    return {
      skill: opts.skillName,
      skill_path: skillFile,
      best_path: candidateFile,
      recommendation: 'no_candidate',
      current_sha8: sha8(currentText),
      changed: false,
      current_lines: lineCount(currentText),
      committed_versions: committedVersions,
      pending_versions: pendingVersions,
      applied: false,
      summary: `No SkillOpt candidate found at ${candidateFile}. Run with --no-mutate first.`,
    };
  }

  const bestText = fs.readFileSync(candidateFile, 'utf8');
  const changed = currentText !== bestText;
  const currentLines = lineCount(currentText);
  const bestLines = lineCount(bestText);

  if (!changed) {
    return {
      skill: opts.skillName,
      skill_path: skillFile,
      best_path: candidateFile,
      recommendation: 'already_live',
      current_sha8: sha8(currentText),
      best_sha8: sha8(bestText),
      changed: false,
      current_lines: currentLines,
      best_lines: bestLines,
      line_delta: 0,
      committed_versions: committedVersions,
      pending_versions: pendingVersions,
      applied: false,
      summary: `SkillOpt best.md already matches SKILL.md.`,
    };
  }

  if (opts.apply) {
    if (!opts.force) {
      const status = getWorkingTreeStatusForFile(skillFile);
      if (status === 'dirty') {
        throw errorFor({
          class: 'DirtyTree',
          code: 'dirty_tree',
          message: `${skillFile} has uncommitted changes.`,
          hint: `Commit or stash changes before promotion, or pass --force to override.`,
        });
      }
    }
    atomicWrite(skillFile, bestText);
    return {
      skill: opts.skillName,
      skill_path: skillFile,
      best_path: candidateFile,
      recommendation: 'promoted',
      current_sha8: sha8(currentText),
      best_sha8: sha8(bestText),
      changed: true,
      current_lines: currentLines,
      best_lines: bestLines,
      line_delta: bestLines - currentLines,
      committed_versions: committedVersions,
      pending_versions: pendingVersions,
      applied: true,
      summary: `Promoted SkillOpt best.md into SKILL.md.`,
    };
  }

  return {
    skill: opts.skillName,
    skill_path: skillFile,
    best_path: candidateFile,
    recommendation: 'agent_review_required',
    current_sha8: sha8(currentText),
    best_sha8: sha8(bestText),
    changed: true,
    current_lines: currentLines,
    best_lines: bestLines,
    line_delta: bestLines - currentLines,
    committed_versions: committedVersions,
    pending_versions: pendingVersions,
    applied: false,
    summary: `SkillOpt has a candidate. Review SKILL.md versus best.md, then rerun with --apply to promote it.`,
  };
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function sha8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}
