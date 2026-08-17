/**
 * Shared helpers for the peeled `gbrain skillpack` subcommand modules.
 *
 * Peeled from src/commands/skillpack.ts (module-size ratchet): the façade
 * keeps dispatch + HELP_TOP + the v0.33 install/uninstall removal errors;
 * per-subcommand handlers live in this directory. The flag registry scans
 * this directory through the façade's facadeExpansion entry in
 * scripts/generate-flag-registry.ts — spell foreign (non-skillpack) CLI
 * flags WITHOUT leading dashes in comments and strings here.
 */

import { isAbsolute, resolve as resolvePath } from 'path';

import { findGbrainRoot } from '../../core/skillpack/bundle.ts';
import { autoDetectSkillsDir } from '../../core/repo-root.ts';

// Semgrep path-resolve suppressions below: skillpack subcommands run on the
// LOCAL operator-invoked CLI plane only (never remote); `p`, `--workspace`,
// and skills-dir come from the operator's own flags — there is no untrusted
// input in these paths.
export function resolveAbs(p: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return isAbsolute(p) ? p : resolvePath(process.cwd(), p);
}

export function findGbrainOrDie(): string {
  const root = findGbrainRoot();
  if (!root) {
    console.error('Error: could not find gbrain repo root.');
    process.exit(2);
  }
  return root;
}

export function resolveWorkspace(opts: { workspace?: string | null; skillsDir?: string | null }): string {
  if (opts.workspace) return resolveAbs(opts.workspace);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  if (opts.skillsDir) return resolvePath(resolveAbs(opts.skillsDir), '..');
  const detected = autoDetectSkillsDir();
  if (detected.dir) return resolvePath(detected.dir, '..');
  console.error(
    'Error: could not auto-detect a target workspace. Pass --workspace <path> or set $OPENCLAW_WORKSPACE.',
  );
  process.exit(2);
}
