/**
 * Repo-path hygiene (incident 2026-07-02).
 *
 * Invariant: a repo path is resolved to an absolute path exactly once, at
 * arg ingress; storage (config `sync.repo_path`, `sources.local_path`,
 * generated daemon wrapper scripts) never holds a relative path; a relative
 * value read back from storage is a hard error, never silently resolved
 * against cwd.
 *
 * Why: `sync.repo_path` persisted as "." made a later bare `gbrain sync`
 * from an unrelated project directory import THAT tree as the brain source
 * and reconcile every real brain page as "source file removed" — dropping
 * the links/timeline graph rows. Files survive in git; db-only rows don't.
 */
import { isAbsolute, resolve } from 'path';

/**
 * Resolve a user-typed --repo/--path argument against cwd at parse time.
 * Typing a relative path interactively stays legal — the shell's cwd is the
 * user's stated intent at that moment. What must never happen is persisting
 * the relative form.
 */
export function resolveRepoArg(p: string): string {
  return resolve(p);
}

/**
 * Guard for repo paths read back from storage. Refuses to resolve a relative
 * value against the current cwd — that is exactly the wrong-tree footgun:
 * whichever directory the next bare invocation happens to run from becomes
 * the sync source.
 */
export function requireAbsoluteStoredPath(value: string, storageDesc: string): string {
  if (isAbsolute(value)) return value;
  throw new Error(
    `${storageDesc} holds a relative path "${value}". Refusing to resolve it against ` +
    `the current directory — a bare invocation from the wrong cwd would sync the wrong ` +
    `tree. Fix it once with an absolute path: gbrain sync --repo <absolute-path> ` +
    `(or: gbrain config set sync.repo_path <absolute-path>).`,
  );
}
