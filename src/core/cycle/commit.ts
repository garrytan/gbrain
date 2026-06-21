/**
 * cycle/commit.ts — Autopilot cycle git-commit phase.
 *
 * Stages every change in brainDir, commits with a timestamped message, and
 * pushes to origin. Mirrors the execFileSync git pattern from
 * src/core/skillpack/endorse.ts (lines 183-213) — see that file for the
 * canonical "stage → commit → rev-parse → push" idiom.
 *
 * Push failure is intentionally NON-FATAL: a missing remote, expired
 * credentials, or a flaky network should never crash the autopilot cycle.
 * The phase returns status 'ok' with pushed:false and a console.warn so the
 * operator can investigate without losing the local commit.
 *
 * The caller (runCycle) overwrites duration_ms; every return here sets it
 * to 0 as a placeholder, matching every other phase in this codebase.
 */

import { execFileSync } from 'child_process';

import type { PhaseError, PhaseResult } from '../cycle.ts';

// ─── Local helper (mirrors cycle.ts's private makeErrorFromException) ────────
// makeErrorFromException is not exported from cycle.ts; other sub-phase files
// (patterns.ts, synthesize.ts) follow the same convention of defining a local
// equivalent. The logic is identical to cycle.ts:668-682.

function makeErrorFromException(e: unknown, fallbackClass = 'InternalError'): PhaseError {
  const err = e instanceof Error ? e : new Error(String(e));
  const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
  let className = fallbackClass;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') className = 'DatabaseConnection';
  if (code === 'ETIMEDOUT') className = 'Timeout';
  if (/OpenAI|embed/i.test(err.message)) className = 'LLMError';
  if (/ENOENT|EACCES|EISDIR|ENOTDIR/.test(code)) className = 'FilesystemError';
  return {
    class: className,
    code,
    message: err.message.slice(0, 200),
  };
}

// ─── Local helper: redact credentials / tokens from git output ───────────────

function redactGit(s: string): string {
  return s
    .replace(/(\w+:\/\/)[^@\s\/]+@/g, '$1<redacted>@')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '<redacted>');
}

// ─── Phase implementation ─────────────────────────────────────────────────────

/**
 * Autopilot git-commit phase.
 *
 * @param brainDir  Absolute path to the brain git repository.
 * @param dryRun    When true, skips all git operations and returns 'skipped'.
 * @param signal    Optional AbortSignal; if already aborted at entry, returns
 *                  'skipped' immediately.
 *
 * NEVER throws — all error paths return a PhaseResult with status 'fail'.
 */
export async function runPhaseCommit(
  brainDir: string,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<PhaseResult> {
  // 1. Dry-run guard.
  if (dryRun) {
    return {
      phase: 'commit' as PhaseResult['phase'],
      status: 'skipped',
      duration_ms: 0,
      summary: 'dry-run: commit phase skipped',
      details: { dryRun: true },
    };
  }

  // 2. Abort-at-entry guard.
  if (signal?.aborted) {
    return {
      phase: 'commit' as PhaseResult['phase'],
      status: 'skipped',
      duration_ms: 0,
      summary: 'aborted before commit',
      details: { reason: 'aborted' },
    };
  }

  // Common options for every git call: hard timeout, no interactive prompts,
  // SIGKILL on timeout so a hung git never holds the cycle lock indefinitely.
  const GIT_OPTS = {
    encoding: 'utf-8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
    },
  } as const;

  // 2.5. Skip cleanly when brainDir is not a git work tree (misconfig or a
  //      checkout-less brain). This is "not applicable", not a failure — a
  //      non-repo must never degrade the overall cycle status.
  try {
    execFileSync('git', ['-C', brainDir, 'rev-parse', '--is-inside-work-tree'], GIT_OPTS);
  } catch {
    return {
      phase: 'commit' as PhaseResult['phase'],
      status: 'skipped',
      duration_ms: 0,
      summary: 'brainDir is not a git work tree; commit skipped',
      details: { reason: 'not_a_git_repo' },
    };
  }

  // 3. Stage everything.
  try {
    execFileSync('git', ['-C', brainDir, 'add', '-A'], GIT_OPTS);
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    const detail = (errObj as NodeJS.ErrnoException & { stderr?: string }).stderr ?? errObj.message;
    return {
      phase: 'commit' as PhaseResult['phase'],
      status: 'fail',
      duration_ms: 0,
      summary: 'git add -A failed',
      details: { committed: false, reason: 'git_add_failed', detail },
      error: makeErrorFromException(err),
    };
  }

  // 4. Detect staged changes.
  //    `git diff --cached --quiet` exits 0 when nothing is staged (no output),
  //    exits 1 when there ARE staged changes — which causes execFileSync to throw.
  //    Any other non-zero exit (128 = broken index/lock, undefined = timeout) is
  //    a real error that must NOT proceed to commit.
  try {
    execFileSync('git', ['-C', brainDir, 'diff', '--cached', '--quiet'], GIT_OPTS);
    // Did NOT throw → exit 0 → nothing staged.
    return {
      phase: 'commit' as PhaseResult['phase'],
      status: 'ok',
      duration_ms: 0,
      summary: 'nothing to commit (working tree clean)',
      details: { committed: false },
    };
  } catch (err) {
    const status = (err as NodeJS.ErrnoException & { status?: number }).status;
    if (status === 1) {
      // Exit 1 = staged changes exist. Fall through to commit.
    } else {
      // Exit 128 (broken index/lock), timeout (status undefined), or anything
      // else — do NOT attempt the commit.
      const errObj = err instanceof Error ? err : new Error(String(err));
      const detail = (errObj as NodeJS.ErrnoException & { stderr?: string }).stderr ?? errObj.message;
      return {
        phase: 'commit' as PhaseResult['phase'],
        status: 'fail',
        duration_ms: 0,
        summary: 'git index/diff error',
        details: { committed: false, reason: 'git_index_error', detail },
        error: makeErrorFromException(err),
      };
    }
  }

  // 5. Commit.
  try {
    execFileSync(
      'git',
      ['-C', brainDir, 'commit', '-m', `gbrain autopilot [${new Date().toISOString()}]`],
      GIT_OPTS,
    );
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    const detail = (errObj as NodeJS.ErrnoException & { stderr?: string }).stderr ?? errObj.message;
    return {
      phase: 'commit' as PhaseResult['phase'],
      status: 'fail',
      duration_ms: 0,
      summary: 'git commit failed',
      details: { committed: false, reason: 'git_commit_failed', detail },
      error: makeErrorFromException(err),
    };
  }

  // 6. Capture short SHA.
  let commitSha: string;
  try {
    commitSha = execFileSync(
      'git',
      ['-C', brainDir, 'rev-parse', '--short', 'HEAD'],
      GIT_OPTS,
    ).trim();
  } catch (err) {
    // rev-parse failure is unusual but should not mask the successful commit.
    commitSha = '(unknown)';
    console.warn(`[cycle/commit] rev-parse --short HEAD failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 7. Push — non-fatal.
  try {
    execFileSync('git', ['-C', brainDir, 'push', 'origin', 'HEAD'], GIT_OPTS);
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    const rawMessage = errObj.message;
    const pushMessage = redactGit(rawMessage);
    // Derive a short reason for the summary (first non-empty line, capped at 80 chars).
    const shortReason = redactGit(pushMessage.split('\n').find(l => l.trim()) ?? pushMessage);
    const cappedReason = shortReason.length > 80 ? shortReason.slice(0, 77) + '...' : shortReason;
    console.warn(`[cycle/commit] push to origin failed (non-fatal): ${pushMessage}`);
    return {
      phase: 'commit' as PhaseResult['phase'],
      status: 'ok',
      duration_ms: 0,
      summary: `committed ${commitSha}; push skipped (${cappedReason})`,
      details: { committed: true, commit_sha: commitSha, pushed: false, push_error: pushMessage },
    };
  }

  // 8. Full success.
  return {
    phase: 'commit' as PhaseResult['phase'],
    status: 'ok',
    duration_ms: 0,
    summary: `committed ${commitSha}; pushed to origin`,
    details: { committed: true, commit_sha: commitSha, pushed: true },
  };
}
