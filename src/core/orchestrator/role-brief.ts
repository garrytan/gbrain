/**
 * orchestrator/role-brief.ts — load a role's priming brief for the run path.
 *
 * Before an agent runs a clinical skill, it is primed with the brief for its
 * care-team role (roles/<role>.md) plus the shared daily-protocol context
 * (roles/_daily-protocol.md). Briefs answer "who am I / what is my scope"; the
 * skill answers "how do I do this task". Distilled + anonymised from the
 * care-team job descriptions — see roles/README.md.
 *
 * Pure modulo the filesystem (takes a resolved roles dir). Graceful: a missing
 * roles dir or brief returns '' so execution proceeds with the base prompt.
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import type { SkillRole } from '../skill-frontmatter.ts';

/** roles/ is a sibling of skills/ at the repo root. */
export function defaultRolesDir(skillsDir: string): string {
  return resolve(skillsDir, '..', 'roles');
}

/** Strip a leading `---\n…\n---` YAML frontmatter fence; return the body. */
function stripFrontmatter(content: string): string {
  const m = content.match(/^---\n[\s\S]*?\n---\n?/);
  return (m ? content.slice(m[0].length) : content).trim();
}

function readIfPresent(path: string): string {
  try {
    if (!existsSync(path)) return '';
    return stripFrontmatter(readFileSync(path, 'utf-8'));
  } catch {
    return '';
  }
}

export interface RoleBriefOptions {
  /** Append the shared PASA daily-protocol context. Default true. */
  includeProtocol?: boolean;
}

/**
 * Build the priming brief for `role`: the role brief + (optionally) the shared
 * daily protocol. Returns '' when no role brief exists (caller falls back to the
 * base prompt).
 */
export function loadRoleBrief(
  rolesDir: string,
  role: SkillRole,
  opts: RoleBriefOptions = {},
): string {
  const brief = readIfPresent(join(rolesDir, `${role}.md`));
  if (!brief) return '';
  const parts = [brief];
  if (opts.includeProtocol !== false) {
    const protocol = readIfPresent(join(rolesDir, '_daily-protocol.md'));
    if (protocol) parts.push(protocol);
  }
  return parts.join('\n\n');
}
