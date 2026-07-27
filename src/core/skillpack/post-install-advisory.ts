/**
 * post-install-advisory.ts (v0.25.1) — agent-readable "what to do next"
 * after `gbrain init` or `gbrain upgrade`.
 *
 * gbrain users typically interact through their host agent (openclaw,
 * claude-code) rather than the gbrain CLI directly. So an interactive
 * TTY prompt at install time misses most of the audience.
 *
 * Instead: every `init` and `post-upgrade` ends by printing an advisory
 * that the agent reads from terminal output. The advisory:
 *
 *   1. Names the version that just landed.
 *   2. Lists the new skills that aren't yet installed in this workspace.
 *   3. Includes a one-line description per skill.
 *   4. Tells the agent EXPLICITLY: ask the user before installing.
 *   5. Prints the exact command to run if the user says yes.
 *
 * Detection: parse the cumulative-slugs receipt in the workspace's
 * managed block (RESOLVER.md / AGENTS.md). Any skill in the recommended
 * set that isn't in the receipt is "not yet installed."
 *
 * Recommended set: hardcoded for v0.25.1 (the 9 new skills). Future
 * releases either bump the constant or read it from the latest
 * migration file's frontmatter; for v0.25.1 the constant is the simpler
 * path.
 *
 * No-op safely:
 *   - No workspace detected → no advisory (don't fabricate paths).
 *   - All recommended skills already installed → no advisory
 *     (don't nag the agent every command).
 *   - Pre-v0.19 fence with no receipt → use the row-extracted slug set.
 */

import { readFileSync } from 'fs';
import { findResolverFile } from '../resolver-filenames.ts';
import { extractManagedSlugs, parseReceipt } from './installer.ts';
import { autoDetectSkillsDir } from '../repo-root.ts';
import { resolve as resolvePath } from 'path';
import { currentRecommendedSet, type RecommendedSkill } from '../advisor/recommended-set.ts';
import { renderRecommendedSkills } from '../advisor/render.ts';

/**
 * Read the managed block's cumulative-slugs receipt to find what's
 * already installed. Returns the empty set when no managed block
 * exists (fresh workspace).
 */
export function detectInstalledSlugs(targetSkillsDir: string, targetWorkspace: string): Set<string> {
  const resolver =
    findResolverFile(targetSkillsDir) ?? findResolverFile(targetWorkspace);
  if (!resolver) return new Set();
  const content = readFileSync(resolver, 'utf-8');
  const receipt = parseReceipt(content);
  if (receipt) return new Set(receipt.cumulativeSlugs);
  return new Set(extractManagedSlugs(content));
}

/**
 * Build the post-install advisory text. Returns null when there's
 * nothing to recommend (no workspace, all recommended skills already
 * installed, etc.) — caller should skip printing entirely on null.
 */
export function buildAdvisory(opts: {
  version: string;
  context: 'init' | 'upgrade';
  targetWorkspace?: string | null;
  targetSkillsDir?: string | null;
}): string | null {
  let workspace = opts.targetWorkspace ?? null;
  let skillsDir = opts.targetSkillsDir ?? null;

  if (!skillsDir) {
    const detected = autoDetectSkillsDir();
    if (detected.dir) {
      skillsDir = detected.dir;
      if (!workspace) workspace = resolvePath(skillsDir, '..');
    }
  }
  if (!workspace || !skillsDir) {
    return buildAdvisoryWithoutWorkspace(opts.version, opts.context);
  }

  const installed = detectInstalledSlugs(skillsDir, workspace);
  const all = currentRecommendedSet();
  const missing = all.filter((s) => !installed.has(s.slug));

  if (missing.length === 0) return null;

  // #8: `skillpack install` was removed — scaffold is canonical. The shared
  // renderer emits scaffold commands so this surface and `gbrain advisor` agree.
  return renderRecommendedSkills({
    version: opts.version,
    context: opts.context,
    skills: missing,
    scaffoldAllCommand: scaffoldCommandFor(missing, all),
  });
}

function scaffoldCommandFor(missing: RecommendedSkill[], all: RecommendedSkill[]): string {
  return missing.length === all.length
    ? 'gbrain skillpack scaffold --all'
    : `gbrain skillpack scaffold ${missing.map((s) => s.slug).join(' ')}`;
}

function buildAdvisoryWithoutWorkspace(
  version: string,
  context: 'init' | 'upgrade',
): string {
  const all = currentRecommendedSet();
  return renderRecommendedSkills({
    version,
    context,
    skills: all,
    scaffoldAllCommand: 'gbrain skillpack scaffold --all',
    workspaceNotDetected: true,
  });
}

/**
 * Print the advisory to stderr at the end of init / post-upgrade.
 * No-op when buildAdvisory returns null.
 */
export function printAdvisoryIfRecommended(opts: {
  version: string;
  context: 'init' | 'upgrade';
  targetWorkspace?: string | null;
  targetSkillsDir?: string | null;
}): void {
  const advisory = buildAdvisory(opts);
  if (!advisory) return;
  process.stderr.write(advisory);
}
