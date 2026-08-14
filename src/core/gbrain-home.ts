/**
 * gbrain-home.ts — the single choke point for resolving + creating the gbrain
 * home directory (agent-bootstrap plan: S3#10, CX2-8).
 *
 * Semantics are `config.ts:configDir()`'s, by DELEGATION (not duplication):
 * `GBRAIN_HOME` is a PARENT dir and `.gbrain` is always appended; unset falls
 * back to `~/.gbrain`. Pre-CX2-8, `brain-repo-durability.ts` used the env
 * value directly while config appended `.gbrain`, so with `GBRAIN_HOME` set
 * the credential store and push log landed OUTSIDE the directory the rest of
 * gbrain considered home. Every module that derives paths under the gbrain
 * home (durability, workspace-push, bootstrap) resolves through here so the
 * two semantics can never diverge again.
 *
 * `ensureGbrainHome()` additionally creates the directory 0700 and tightens
 * an existing one to 0700 best-effort (the home holds `git-credentials`,
 * `bootstrap/push-status.json`, and lock state — never group/other readable).
 */

import { chmodSync, existsSync, mkdirSync } from 'fs';
import { configDir } from './config.ts';

/**
 * Resolve the gbrain home directory WITHOUT touching the filesystem.
 * Exactly `configDir()` — exported under a task-shaped name so call sites
 * read as "the home resolver", and so a future non-config-coupled resolver
 * has one place to land.
 */
export function resolveGbrainHome(): string {
  return configDir();
}

/**
 * Resolve + create the gbrain home directory with 0700 permissions.
 * Chmods an already-existing home to 0700 best-effort (never throws for a
 * permissions failure — an unwritable mode bit must not break a push or a
 * harden run; the create failure itself DOES throw, because callers are
 * about to write under the path).
 */
export function ensureGbrainHome(): string {
  const home = resolveGbrainHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(home, 0o700);
  } catch {
    /* best-effort — e.g. home owned by another uid in shared CI */
  }
  return home;
}
