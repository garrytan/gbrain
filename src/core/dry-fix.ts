/**
 * dry-fix.ts — Auto-repair DRY violations surfaced by checkResolvable().
 *
 * Called by `gbrain doctor --fix`. Scans every skill in the manifest, locates
 * matches of CROSS_CUTTING_PATTERNS, expands each match to its block
 * boundary, and replaces the block with a `> **Convention:** ...` reference
 * line. Writes are guarded:
 *   - working-tree-dirty  → skip (preserves git-as-backup contract)
 *   - inside code fence   → skip (don't mangle example prose)
 *   - already delegated   → skip (idempotent re-runs)
 *   - multi-match         → skip (ambiguous; manual edit required)
 *
 * Dry-run mode returns proposed edits without writing to disk.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';
import {
  CROSS_CUTTING_PATTERNS,
  DRY_PROXIMITY_LINES,
  extractDelegationTargets,
  type CrossCuttingPattern,
} from './check-resolvable.ts';
import { loadOrDeriveManifest } from './skill-manifest.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoFixOptions {
  dryRun?: boolean;
}

export type FixStatus = 'applied' | 'proposed' | 'skipped' | 'error';

export type SkipReason =
  | 'working_tree_dirty'
  | 'no_git_backup'
  | 'inside_code_fence'
  | 'already_delegated'
  | 'ambiguous_multiple_matches'
  | 'block_is_callout'
  | 'file_missing'
  | 'read_error'
  | 'write_error';

export interface FixOutcome {
  skill: string;
  skillPath: string;   // absolute
  patternLabel: string;
  status: FixStatus;
  reason?: SkipReason | string;
  before?: string;     // snippet (the expanded block)
  after?: string;      // replacement line
}

export interface AutoFixReport {
  fixed: FixOutcome[];     // applied writes (or proposals in dryRun)
  skipped: FixOutcome[];   // skips and errors
}

// ---------------------------------------------------------------------------
// Block-expansion strategy map
// ---------------------------------------------------------------------------

export type BlockShape = 'bullet' | 'blockquote' | 'paragraph';

export interface Block {
  startLine: number;   // 0-indexed inclusive
  endLine: number;     // 0-indexed inclusive
}

/** Detect which block shape the line at `lineIdx` belongs to. */
export function detectBlockShape(lines: string[], lineIdx: number): BlockShape {
  const line = lines[lineIdx] ?? '';
  if (/^(\s*)(?:[-*]\s|\d+\.\s)/.test(line)) return 'bullet';
  if (/^>\s/.test(line)) return 'blockquote';
  return 'paragraph';
}

/**
 * Expand a bullet item: start at the bullet line, end at the next sibling
 * or shallower bullet (sub-bullets included).
 *
 * Fix 3 (v0.20.1): the original walk-up was dead code — it only ran when
 * lineIdx was already a bullet-marker line (because of the `indentMatch`
 * guard), making "walk up to find the start" unreachable for continuation
 * lines. Rewritten to first walk up to the owning bullet when lineIdx is
 * a continuation line, then walk down to the end of the block.
 */
export function expandBullet(lines: string[], lineIdx: number): Block | null {
  const BULLET_RE = /^(\s*)(?:[-*]\s|\d+\.\s)/;
  let bulletIdx = lineIdx;

  if (!BULLET_RE.test(lines[lineIdx] ?? '')) {
    // lineIdx is a continuation line — walk up to find the owning bullet.
    let found = -1;
    for (let i = lineIdx - 1; i >= 0; i--) {
      if ((lines[i] ?? '').trim() === '') break;
      if (BULLET_RE.test(lines[i] ?? '')) { found = i; break; }
    }
    if (found === -1) return null;
    bulletIdx = found;
  }

  const bulletLine = lines[bulletIdx] ?? '';
  const indentMatch = bulletLine.match(BULLET_RE);
  if (!indentMatch) return null;
  const baseIndent = indentMatch[1].length;

  // Walk down: continue until a bullet at <= baseIndent (sibling or
  // shallower), a blank line, or end of file.
  let end = bulletIdx;
  for (let i = bulletIdx + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.trim() === '') break;
    const isBullet = BULLET_RE.test(l);
    const indent = l.match(/^(\s*)/)?.[1].length ?? 0;
    if (isBullet && indent <= baseIndent) break;
    end = i;
  }
  return { startLine: bulletIdx, endLine: end };
}

/** Expand a blockquote: contiguous `>` lines. Returns null if the block is
 *  itself a `> **Convention:**` or `> **Filing rule:**` callout (don't
 *  rewrite a reference into a reference). */
export function expandBlockquote(lines: string[], lineIdx: number): Block | null {
  if (!/^>\s/.test(lines[lineIdx] ?? '')) return null;
  let start = lineIdx;
  while (start > 0 && /^>\s/.test(lines[start - 1])) start--;
  let end = lineIdx;
  while (end + 1 < lines.length && /^>\s/.test(lines[end + 1])) end++;

  const firstLine = lines[start] ?? '';
  if (/\*\*(?:Convention|Filing rule):\*\*/.test(firstLine)) {
    return null; // this IS a delegation callout already
  }
  return { startLine: start, endLine: end };
}

/** Expand a paragraph: previous blank line → next blank line. */
export function expandParagraph(lines: string[], lineIdx: number): Block | null {
  let start = lineIdx;
  while (start > 0 && lines[start - 1].trim() !== '') start--;
  let end = lineIdx;
  while (end + 1 < lines.length && lines[end + 1].trim() !== '') end++;
  return { startLine: start, endLine: end };
}

export const expanders: Record<BlockShape, (lines: string[], lineIdx: number) => Block | null> = {
  bullet: expandBullet,
  blockquote: expandBlockquote,
  paragraph: expandParagraph,
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * True when the match offset sits inside a fenced code block.
 *
 * Fix 2 (v0.20.1): extend beyond triple-backtick to also catch N-backtick
 * (N >= 3) and tilde (~~~ / ~~~~) fences, which are CommonMark-legal.
 * Backtick and tilde counts are tracked independently — a ~~~ fence does
 * not close a ``` fence.
 */
export function isInsideCodeFence(content: string, offset: number): boolean {
  const before = content.slice(0, offset);
  const backtickCount = (before.match(/^`{3,}/gm) || []).length;
  const tildeCount = (before.match(/^~{3,}/gm) || []).length;
  return (backtickCount % 2 === 1) || (tildeCount % 2 === 1);
}

export type WorkingTreeStatus = 'clean' | 'dirty' | 'not_a_repo';

/** Check the git state of a skill file. Three distinct outcomes — callers
 *  must NOT conflate "not a repo" with "clean", because the auto-fix
 *  contract is "git is the backup" and writing to a file outside any repo
 *  destroys user data with no recovery path.
 *
 *  `execFileSync` with array args bypasses the shell entirely, so paths
 *  with odd characters from a manifest can't inject commands. */
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

/** Legacy wrapper. Callers that need to distinguish not_a_repo from clean
 *  should use getWorkingTreeStatus() directly. */
export function isWorkingTreeDirty(skillPath: string): boolean {
  return getWorkingTreeStatus(skillPath) === 'dirty';
}

// ---------------------------------------------------------------------------
// Manifest loading delegated to src/core/skill-manifest.ts. Using the
// shared loader means auto-fix works in AGENTS.md-only workspaces where
// manifest.json is absent — the derive-from-walk path kicks in and
// auto-fix has the same skill set check-resolvable sees. D-CX-12.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Auto-repair DRY violations across every skill in the manifest.
 *
 * @param skillsDir — path to the `skills/` directory
 * @param opts.dryRun — if true, do not write; return proposed edits
 */
export function autoFixDryViolations(
  skillsDir: string,
  opts: AutoFixOptions = {}
): AutoFixReport {
  const fixed: FixOutcome[] = [];
  const skipped: FixOutcome[] = [];
  const { skills: manifest } = loadOrDeriveManifest(skillsDir);
  // Fix 5 (v0.20.1): cache git status per skill path so the N skills ×
  // M patterns loop doesn't spawn `git status` N×M times per invocation.
  const gitCache = new Map<string, WorkingTreeStatus>();

  for (const skill of manifest) {
    const skillPath = join(skillsDir, skill.path);
    if (!existsSync(skillPath)) {
      // Manifest-present but file-missing is already reported by
      // checkResolvable as 'missing_file'; don't double-report here.
      continue;
    }

    let content: string;
    try {
      content = readFileSync(skillPath, 'utf-8');
    } catch (e: any) {
      skipped.push({
        skill: skill.name,
        skillPath,
        patternLabel: '(all)',
        status: 'error',
        reason: 'read_error',
      });
      continue;
    }

    // Compute delegations fresh per pattern — a prior applied fix inserts
    // a new Convention callout that should inform later patterns'
    // idempotency checks.
    let delegations = extractDelegationTargets(content);

    for (const cut of CROSS_CUTTING_PATTERNS) {
      const outcome = attemptFix(skill.name, skillPath, content, delegations, cut, opts, gitCache);
      if (!outcome) continue;
      if (outcome.status === 'applied' || outcome.status === 'proposed') {
        fixed.push(outcome);
        if (outcome.status === 'applied') {
          try {
            content = readFileSync(skillPath, 'utf-8');
            delegations = extractDelegationTargets(content);
          } catch {
            break;
          }
        }
      } else {
        skipped.push(outcome);
      }
    }
  }

  return { fixed, skipped };
}

function attemptFix(
  skillName: string,
  skillPath: string,
  content: string,
  delegations: ReturnType<typeof extractDelegationTargets>,
  cut: CrossCuttingPattern,
  opts: AutoFixOptions,
  // Fix 5 (v0.20.1): per-invocation cache so git status is only spawned
  // once per skill path, not once per skill × pattern.
  gitCache?: Map<string, WorkingTreeStatus>
): FixOutcome | null {
  const base = {
    skill: skillName,
    skillPath,
    patternLabel: cut.label,
  };

  // Find ALL matches (for multi-match handling).
  const globalRe = new RegExp(
    cut.pattern.source,
    cut.pattern.flags.includes('g') ? cut.pattern.flags : cut.pattern.flags + 'g'
  );
  const matches = [...content.matchAll(globalRe)];
  if (matches.length === 0) return null;

  let selectedMatch: RegExpMatchArray;

  if (matches.length === 1) {
    // Single match — fall through to individual guard checks below so we
    // preserve the specific skip reasons (inside_code_fence, already_delegated)
    // that existing tests and humans rely on for actionable feedback.
    selectedMatch = matches[0]!;
  } else {
    // Fix 4 (v0.20.1): multiple matches — filter out fence and already-delegated
    // occurrences, then fix the single remaining eligible one. The outer loop
    // re-reads after each apply, so any leftover matches get a follow-up pass.
    // This resolves the "TOC + body" case that returned ambiguous_multiple_matches
    // forever: once the body occurrence is fixed, the TOC reference is already
    // a delegation and the next pass skips cleanly.
    const eligible = matches.filter(m => {
      const off = m.index ?? 0;
      if (isInsideCodeFence(content, off)) return false;
      const ln = content.slice(0, off).split('\n').length;
      return !delegations.some(
        d => cut.conventions.includes(d.convention) && Math.abs(d.line - ln) <= DRY_PROXIMITY_LINES
      );
    });
    if (eligible.length === 0) return null;
    if (eligible.length > 1) {
      return { ...base, status: 'skipped', reason: 'ambiguous_multiple_matches' };
    }
    selectedMatch = eligible[0]!;
  }

  const offset = selectedMatch.index ?? 0;

  // Individual guards (only reached on the single-match path; multi-match
  // already filtered these above, so we skip straight to the block expander).
  if (matches.length === 1) {
    if (isInsideCodeFence(content, offset)) {
      return { ...base, status: 'skipped', reason: 'inside_code_fence' };
    }
  }

  const matchLine = content.slice(0, offset).split('\n').length;

  if (matches.length === 1) {
    const alreadyDelegated = delegations.some(
      d => cut.conventions.includes(d.convention) && Math.abs(d.line - matchLine) <= DRY_PROXIMITY_LINES
    );
    if (alreadyDelegated) {
      return { ...base, status: 'skipped', reason: 'already_delegated' };
    }
  }

  // Fix 5: use the per-invocation cache to avoid spawning git status per pattern.
  let treeStatus: WorkingTreeStatus;
  if (gitCache) {
    if (!gitCache.has(skillPath)) gitCache.set(skillPath, getWorkingTreeStatus(skillPath));
    treeStatus = gitCache.get(skillPath)!;
  } else {
    treeStatus = getWorkingTreeStatus(skillPath);
  }
  if (treeStatus === 'dirty') {
    return { ...base, status: 'skipped', reason: 'working_tree_dirty' };
  }
  if (treeStatus === 'not_a_repo') {
    // File isn't tracked by git — writing would destroy the user's only
    // copy with no rollback path. Refuse.
    return { ...base, status: 'skipped', reason: 'no_git_backup' };
  }

  // Expand to block boundary.
  const lines = content.split('\n');
  const lineIdx = matchLine - 1; // 0-indexed
  const shape = detectBlockShape(lines, lineIdx);
  const expander = expanders[shape];
  const block = expander(lines, lineIdx);
  if (!block) {
    return { ...base, status: 'skipped', reason: 'block_is_callout' };
  }

  // Build replacement line.
  const canonical = cut.conventions[0];
  const replacement = `> **Convention:** See \`skills/${canonical}\` for ${cut.label}.`;

  // Splice: replace lines[startLine..endLine] with [replacement].
  const before = lines.slice(0, block.startLine).join('\n');
  const originalBlock = lines.slice(block.startLine, block.endLine + 1).join('\n');
  const after = lines.slice(block.endLine + 1).join('\n');

  // Preserve structure: one newline between sections, preserve the file's
  // trailing newline if the original had one (POSIX convention).
  const parts: string[] = [];
  if (before.length > 0) parts.push(before);
  parts.push(replacement);
  if (after.length > 0) parts.push(after);
  let next = parts.join('\n');
  if (content.endsWith('\n') && !next.endsWith('\n')) {
    next += '\n';
  }

  if (opts.dryRun) {
    return {
      ...base,
      status: 'proposed',
      before: originalBlock,
      after: replacement,
    };
  }

  try {
    // Fix 1 (v0.20.1): TOCTOU guard. Re-read immediately before writing
    // and verify the file hasn't changed since we computed the edit.
    // A concurrent editor save between our read and write would otherwise
    // be silently overwritten with our stale edit.
    const currentContent = readFileSync(skillPath, 'utf-8');
    if (currentContent !== content) {
      return { ...base, status: 'skipped', reason: 'working_tree_dirty' };
    }
    writeFileSync(skillPath, next, 'utf-8');
    // Invalidate the cached git status so re-reads on the next pattern
    // reflect the newly-written file.
    gitCache?.delete(skillPath);
  } catch {
    return { ...base, status: 'error', reason: 'write_error' };
  }

  return {
    ...base,
    status: 'applied',
    before: originalBlock,
    after: replacement,
  };
}
