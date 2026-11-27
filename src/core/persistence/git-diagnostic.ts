/**
 * What a failed Git step was, kept on a Git effect so `gbrain sync status` can name it (git_commit_holds).
 *
 * A Git effect that fails `git_unavailable` used to keep only its code. This keeps the failing step (`add`,
 * `commit-tree`, `push` ...), the phase (`commit`: nothing was committed; `push`: the commit is local) and one reason
 * code from the closed list GIT_REASONS. git's stderr is read once, in memory, to pick the code, and is never stored or
 * printed: a clean filter, a credential helper or a hook can print a token, a private path or a URL with credentials,
 * and no denylist can tell those apart from Git's own prose.
 */

/** Every reason a stored diagnostic can carry; anything git said that matches none of them is `other`. */
export const GIT_REASONS = ['identity_missing', 'index_locked', 'timeout', 'permission_denied', 'disk_full', 'hook_rejected',
  'filter_failed', 'not_a_repository', 'object_missing', 'auth_failed', 'remote_unreachable', 'upstream_invalid', 'other'] as const;
export type GitReason = typeof GIT_REASONS[number];

export interface GitDiagnostic {
  /** `commit`: the step failed before a commit existed; `push`: the commit is local and the push failed. */
  phase: 'commit' | 'push';
  /** The git subcommand that failed (`add`, `commit-tree`, `ls-remote` ...); `git` when it is not a plain subcommand name. */
  step: string;
  /** Why it failed, from the closed list GIT_REASONS; never git's own words. */
  reason: GitReason;
  /** Present when git's stderr says no commit identity is configured (user.name / user.email). */
  identity?: true;
}

const IDENTITY_STDERR = /Author identity unknown|Committer identity unknown|Please tell me who you are|empty ident name|unable to auto-detect email address|no (?:email|name) was given and auto-detection is disabled/i;

/** First match wins; the identity test runs before every other one, so a missing identity is never `other`. */
const REASON_TESTS: ReadonlyArray<readonly [GitReason, RegExp]> = [
  ['identity_missing', IDENTITY_STDERR],
  // The synthetic text git() records when a step did not finish within its deadline or could not start.
  ['timeout', /did not finish within \d+ seconds|timed out/i],
  ['index_locked', /index\.lock|Unable to create '[^'\n]*\.lock'|Another git process seems to be running/i],
  ['disk_full', /No space left on device|Disk quota exceeded/i],
  ['permission_denied', /Permission denied|Operation not permitted|insufficient permission|Read-only file system/i],
  ['auth_failed', /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|HTTP Basic: Access denied|returned error: 40[13]\b/i],
  ['remote_unreachable', /Could not resolve host|Connection refused|Connection timed out|Network is unreachable|Could not read from remote repository|unable to access '|repository '[^'\n]*' not found|does not appear to be a git repository/i],
  ['hook_rejected', /\bhook\b[^\n]*(?:declined|rejected|failed|exit)|pre-receive hook declined|\[remote rejected\]/i],
  ['filter_failed', /\bfilter\b[^\n]*failed|external filter|clean filter|smudge filter/i],
  ['not_a_repository', /not a git repository/i],
  ['object_missing', /\bbad object\b|missing (?:blob|tree|commit) object|\bcorrupt\b|unknown revision|bad revision|invalid revision|unable to read tree|bad tree object/i],
];

/** The reason code of one failed git step, read from its stderr in memory; the stderr itself goes nowhere. */
export function gitReason(stderr: string | undefined): GitReason {
  const text = stderr ?? '';
  return REASON_TESTS.find(([, test]) => test.test(text))?.[0] ?? 'other';
}

/**
 * SEC-02: the steps a diagnostic can name, the git subcommands the Git effect runs (plus `commit-push`, the publish
 * child); anything else, written by a caller or read from a stored row, is `git`, so a value never rides in as a step.
 */
export const GIT_STEPS: ReadonlySet<string> = new Set(['add', 'check-ignore', 'commit', 'commit-push', 'commit-tree', 'config', 'diff', 'diff-index',
  'diff-tree', 'fetch', 'git', 'hash-object', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge-base', 'mktree', 'push', 'read-tree',
  'reset', 'rev-list', 'rev-parse', 'rm', 'status', 'symbolic-ref', 'update-index', 'update-ref', 'write-tree']);
const stepName = (step: unknown) => typeof step === 'string' && GIT_STEPS.has(step) ? step : 'git';

/** The diagnostic of one failed git step. `reason` overrides the classifier (a caller that knows why). */
export function gitDiagnostic(phase: GitDiagnostic['phase'], step: string, stderr: string | undefined, reason?: GitReason): GitDiagnostic {
  const code = reason ?? gitReason(stderr);
  return { phase, step: stepName(step), reason: code, ...(code === 'identity_missing' ? { identity: true as const } : {}) };
}

/** The non-enumerable property a gitFailure carries its diagnostic on (never serialized with the error). */
const DIAGNOSTIC = 'gitDiagnostic';

/** Attaches a diagnostic to an error (a gitFailure); recordFailure reads it back with gitDiagnosticOf. */
export function withGitDiagnostic<E extends object>(error: E, diagnostic: GitDiagnostic | undefined): E {
  if (diagnostic) Object.defineProperty(error, DIAGNOSTIC, { value: diagnostic, enumerable: false, configurable: true, writable: false });
  return error;
}

export function gitDiagnosticOf(error: unknown): GitDiagnostic | undefined {
  return error !== null && typeof error === 'object' ? (error as Record<string, GitDiagnostic | undefined>)[DIAGNOSTIC] : undefined;
}

/**
 * A stored diagnostic as a fixed-shape object, so every engine prints the same bytes (jsonb reorders keys). Only the
 * phase, a listed step name and a listed reason code survive; anything else an older release stored (git's own stderr
 * line) is dropped, never printed. The commit holds and the push holds both read their `last_error` through it.
 */
export function storedGitDiagnostic(value: unknown): GitDiagnostic | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.step !== 'string') return null;
  const identity = v.identity === true || v.reason === 'identity_missing';
  const reason: GitReason = identity ? 'identity_missing' : (GIT_REASONS as readonly unknown[]).includes(v.reason) ? v.reason as GitReason : 'other';
  return { phase: v.phase === 'push' ? 'push' : 'commit', step: stepName(v.step), reason, ...(identity ? { identity: true as const } : {}) };
}

/**
 * GCH-01a: the parked list of a Git effect with each target's `last_error` in the fixed shape (storedGitDiagnostic),
 * dropped when nothing usable is left. A row an older release wrote can hold git's own stderr line on a target; every
 * read that prints targets (retry-effects, doctor parked_effects, settle-effects) and every write that stores them
 * again goes through this, so that line is neither printed nor carried forward. Idempotent; other fields are kept.
 */
export function storedParkedTargets<T>(parked: readonly T[]): T[] {
  return parked.map(entry => {
    if (!entry || typeof entry !== 'object' || !('last_error' in entry)) return entry;
    const { last_error, ...rest } = entry as Record<string, unknown>;
    const diagnostic = storedGitDiagnostic(last_error);
    return (diagnostic ? { ...rest, last_error: diagnostic } : rest) as T;
  });
}

/**
 * GCH-01a: a Git effect's data with `last_error` and every parked target's `last_error` in the fixed shape. The
 * write chokepoints (requeue, park, the retry's requeue, the withheld-target re-arm, settle and un-settle, the
 * conversion's ignored-target declare) store data through it. Data that is not an object is returned as it is;
 * idempotent.
 */
export function storedGitData<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  if ('last_error' in out) {
    const diagnostic = storedGitDiagnostic(out.last_error);
    if (diagnostic) out.last_error = diagnostic; else delete out.last_error;
  }
  if (Array.isArray(out.parked)) out.parked = storedParkedTargets(out.parked);
  return out as T;
}
