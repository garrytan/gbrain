/**
 * SkillOpt bundled-skill mutation gate (D16).
 *
 * A "bundled" skill is one that lives in the gbrain repo's `skills/` tree
 * (shipped alongside the binary). These are load-bearing for production
 * workflows; mutating them via SkillOpt without explicit operator opt-in
 * is too risky. By default, bundled-skill optimization runs in `--no-mutate`
 * mode automatically — the proposed best is written to `proposed.md` for
 * human review.
 *
 * User-owned skills (under a user's `~/.gbrain/skills/` or their own
 * project's `skills/`) are NOT bundled — they can be mutated freely.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { autoDetectSkillsDirReadOnly } from '../repo-root.ts';
import type { BundledSkillContext } from './types.ts';

/**
 * Build the bundled-skill context for a (skillsDir, skillName) pair.
 *
 * The resolution chain:
 *  1. Resolve the absolute skill path: `skillsDir/<name>/SKILL.md`.
 *  2. Check whether the skillsDir came from the install-path fallback
 *     (i.e. it's `<gbrain-install>/skills`). If so, this is a bundled skill.
 *  3. Otherwise, the skill is user-owned and freely mutable.
 */
export function getBundledSkillContext(skillsDir: string, skillName: string): BundledSkillContext {
  const skillPath = path.join(skillsDir, skillName, 'SKILL.md');
  // Detect bundled by checking whether autoDetectSkillsDirReadOnly would
  // have routed here via the install-path fallback. The simpler heuristic:
  // if the resolved skillsDir is under the gbrain install tree (somewhere
  // up the chain has node_modules/gbrain or VERSION matching this binary),
  // it's bundled. Use the read-only detector to find the canonical install
  // skillsDir and compare.
  const detected = autoDetectSkillsDirReadOnly(process.cwd());
  const isBundled = detected.source === 'install_path' && detected.dir !== null
    && resolvesToSame(detected.dir, skillsDir);
  return { skillName, skillsDir, skillPath, isBundled };
}

function resolvesToSame(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * Decide whether SkillOpt should mutate SKILL.md or just write proposed.md.
 *
 * Logic:
 *  - `--no-mutate` flag → never mutate (write proposed.md).
 *  - Bundled skill + no `--allow-mutate-bundled` → never mutate (D16).
 *  - User-owned skill (or bundled + `--allow-mutate-bundled`) → mutate
 *    in place.
 */
export function shouldMutateSkillFile(
  ctx: BundledSkillContext,
  flags: { noMutate: boolean; allowMutateBundled: boolean },
): { mutate: boolean; reason?: string } {
  if (flags.noMutate) {
    return { mutate: false, reason: 'user_passed_no_mutate' };
  }
  if (ctx.isBundled && !flags.allowMutateBundled) {
    return { mutate: false, reason: 'bundled_skill_requires_allow_flag' };
  }
  return { mutate: true };
}
