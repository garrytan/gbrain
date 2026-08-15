/**
 * skill-fix-gates.ts — Shared safety primitives consumed by every auto-fix
 * pattern in `dry-fix.ts` (F8 from /plan-eng-review).
 *
 * Pre-v0.36.x the dry-fix module had REPLACE-in-place semantics only
 * (`CROSS_CUTTING_PATTERNS`). v0.36.x adds INSERT-missing-rule semantics
 * for the brain-first auto-add (`MISSING_RULE_PATTERNS`). Both share the
 * exact same safety gates:
 *
 *   - **working-tree check** — refuse writes when the file has uncommitted
 *     changes (the git-is-backup contract).
 *   - **not-a-repo check** — refuse writes when the file isn't under git
 *     (writing would destroy the only copy with no rollback).
 *   - **inside-code-fence check** — don't mangle example prose inside
 *     ``` fences.
 *
 * Extracting these as a sibling module is cleaner than duplicating across
 * REPLACE and INSERT pattern handlers in `dry-fix.ts`. Tests import from
 * here directly; `dry-fix.ts` re-exports for back-compat with callers that
 * imported these functions from there pre-v0.36.x.
 *
 * The D6 install-path safety gate (refuse `--fix` when skills dir came
 * from the install-path fallback) lives in `doctor.ts` because it's
 * specific to the doctor `--fix` flow and consults the
 * `autoDetectSkillsDirReadOnly` `detected.source` field that doesn't
 * appear in dry-fix's own argument surface.
 */

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Code-fence guard
// ---------------------------------------------------------------------------

/**
 * True when the byte offset sits inside a fenced code block (``` ... ```).
 * Counts triple-backtick fences at line starts before `offset`. Odd count
 * = inside a fence; even count = outside.
 *
 * Used to skip pattern matches that fall inside example prose so the auto-
 * fix doesn't mangle code samples in skill documentation.
 */
export function isInsideCodeFence(content: string, offset: number): boolean {
  const before = content.slice(0, offset);
  const fenceRe = /^```/gm;
  const fenceCount = (before.match(fenceRe) || []).length;
  return fenceCount % 2 === 1;
}

// ---------------------------------------------------------------------------
// Working-tree status (git check)
// ---------------------------------------------------------------------------

export type WorkingTreeStatus = 'clean' | 'dirty' | 'not_a_repo';

/**
 * Check the git state of a skill file.
 *
 * Three outcomes are deliberately distinct:
 *   - `clean` — file is tracked and has no uncommitted changes.
 *               Safe to write; `git diff` after the write surfaces the change.
 *   - `dirty` — file has uncommitted changes. Refuse to write — auto-fix
 *               would mix its changes with the user's mid-edit work, and
 *               `git stash` / `git checkout -- <file>` wouldn't cleanly
 *               separate them.
 *   - `not_a_repo` — file isn't under git at all. Refuse to write — there
 *               is NO rollback path. The auto-fix contract is "git is
 *               the backup," and writing here breaks the contract.
 *
 * `execFileSync` with array args bypasses the shell entirely so paths
 * with odd characters from a manifest can't inject commands. We change
 * to the file's parent dir so `git status --porcelain -- <path>`
 * resolves correctly even when the calling process's cwd is elsewhere.
 */
export function getWorkingTreeStatus(skillPath: string): WorkingTreeStatus {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', skillPath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: dirname(skillPath),
    });
    return out.trim().length > 0 ? 'dirty' : 'clean';
  } catch {
    // git exits 128 when not inside a repo; treat any non-zero the same.
    return 'not_a_repo';
  }
}

/**
 * Legacy wrapper. Callers that need to distinguish `not_a_repo` from
 * `clean` should use `getWorkingTreeStatus()` directly. The two-state
 * boolean here is preserved for the existing dry-fix call site that
 * was previously content with a coarse "dirty vs everything else"
 * check.
 */
export function isWorkingTreeDirty(skillPath: string): boolean {
  return getWorkingTreeStatus(skillPath) === 'dirty';
}
