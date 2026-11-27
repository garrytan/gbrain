/**
 * What a failed Git step said, kept on a Git effect so `gbrain sync status` can name it (git_commit_holds).
 *
 * A Git effect that fails `git_unavailable` used to keep only its code. This keeps the failing step (`add`, `commit-tree`,
 * `push` ...), the phase (`commit`: nothing was committed; `push`: the commit is local) and git's first stderr line,
 * after one sanitizer removes anything that can carry a secret. Git stderr is not only Git's own prose: a clean filter,
 * a credential helper or a hook can print a token, an Authorization header or a URL with credentials, so the line is
 * redacted before it is stored, and it is never placed in an executable command.
 */
import { applyRedaction, planRedaction } from '../secret-scan.ts';
import { stripUrlSecrets } from '../url-redact.ts';

export interface GitDiagnostic {
  /** `commit`: the step failed before a commit existed; `push`: the commit is local and the push failed. */
  phase: 'commit' | 'push';
  /** The git subcommand that failed (`add`, `commit-tree`, `ls-remote` ...). */
  step: string;
  /** git's first non-empty stderr line, sanitized and capped at LINE_MAX characters; null when git printed nothing. */
  line: string | null;
  /** Present when git's stderr says no commit identity is configured (user.name / user.email). */
  identity?: true;
}

/** The longest diagnostic line kept; redaction runs on the whole text first, so a secret crossing the cap is never cut. */
export const GIT_DIAGNOSTIC_LINE_MAX = 200;

const IDENTITY_STDERR = /Author identity unknown|Committer identity unknown|Please tell me who you are|empty ident name|unable to auto-detect email address|no (?:email|name) was given and auto-detection is disabled/i;

/** Terminal control sequences (CSI, OSC) and other control characters except newline and tab. */
const CONTROLS = [/\x1b\[[0-?]*[ -/]*[@-~]/g, /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, /[\x00-\x08\x0b-\x1f\x7f]/g];

/**
 * git's first stderr line with secrets removed: URL userinfo, query and fragment (any scheme), scp-style `user:pw@host:`,
 * Authorization / Proxy-Authorization values, `Bearer|Basic|token <value>`, `<name containing token|secret|password|key|auth>=<value>`
 * and whatever the secret scanner recognizes. Then the first non-empty line, capped. Null when nothing is left.
 */
export function sanitizeGitStderr(stderr: string): string | null {
  let text = stderr;
  for (const control of CONTROLS) text = text.replace(control, '');
  text = stripUrlSecrets(text)
    .replace(/\b([\w.-]+):[^\s@/:]+@([\w.-]+):/g, '$1:<REDACTED>@$2:')
    .replace(/\b(proxy-authorization|authorization)\s*:\s*\S+(?:[ \t]+\S+)?/gi, '$1: <REDACTED>')
    .replace(/\b(bearer|basic|token)[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <REDACTED>')
    .replace(/\b([\w-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth)[\w-]*)[ \t]*[=:][ \t]*("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1=<REDACTED>');
  text = applyRedaction(planRedaction(text));
  const line = text.split('\n').map(l => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > GIT_DIAGNOSTIC_LINE_MAX ? `${line.slice(0, GIT_DIAGNOSTIC_LINE_MAX - 1)}…` : line;
}

/** The diagnostic of one failed git step. */
export function gitDiagnostic(phase: GitDiagnostic['phase'], step: string, stderr: string | undefined): GitDiagnostic {
  const raw = stderr ?? '';
  return { phase, step, line: sanitizeGitStderr(raw), ...(IDENTITY_STDERR.test(raw) ? { identity: true as const } : {}) };
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
