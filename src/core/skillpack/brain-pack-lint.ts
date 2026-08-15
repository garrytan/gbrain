/**
 * skillpack/brain-pack-lint.ts — E6 version-skew lint for brain-resident packs.
 *
 * A brain ships skills that call gbrain operations. If the connecting gbrain is
 * older/newer than the pack assumed, a skill's declared `tools:` may reference
 * ops that don't exist on this binary — silent breakage when the harness tries
 * to call them. This lint reads every pack skill's SKILL.md frontmatter `tools:`
 * and flags any tool not present in the serving op set, so packs fail loud on
 * drift instead of mysteriously half-working.
 *
 * Pure-ish: filesystem reads only, no mutation. Used by
 * `gbrain skillpack init-brain-pack` (lint the freshly-generated pack) and
 * `gbrain skillpack check` (lint an existing brain repo's pack).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { parseMarkdown } from '../markdown.ts';
import { loadSkillpackManifest, type SkillpackManifest } from './manifest-v1.ts';

export interface ToolSkewFinding {
  /** Skill path relative to the pack root (e.g. "skills/diligence"). */
  skill: string;
  /** The declared tool name that is not in the serving op set. */
  tool: string;
}

export interface BrainPackLintResult {
  packRoot: string;
  manifest: SkillpackManifest;
  /** Every `tools:` value across the pack that the serving binary cannot satisfy. */
  unknownTools: ToolSkewFinding[];
}

/**
 * Lint a brain-resident pack's declared `tools:` against the set of op names the
 * serving gbrain actually exposes. `knownOps` is the authoritative op-name set
 * (callers pass `new Set(operations.map(o => o.name))`).
 *
 * A skill with no `tools:` frontmatter contributes nothing (the common case for
 * a freshly-scaffolded pack). Skills whose SKILL.md is missing or unparseable
 * are skipped silently — discovery is fail-open, this is a quality lint, not a
 * gate that should explode on a half-written pack.
 */
export function lintBrainPackTools(packRoot: string, knownOps: Set<string>): BrainPackLintResult {
  const manifest = loadSkillpackManifest(packRoot);
  const unknownTools: ToolSkewFinding[] = [];

  for (const skillDir of manifest.skills) {
    const skillMd = join(packRoot, skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    let tools: unknown;
    try {
      tools = parseMarkdown(readFileSync(skillMd, 'utf-8'), skillMd).frontmatter.tools;
    } catch {
      continue;
    }
    if (!Array.isArray(tools)) continue;
    for (const tool of tools) {
      if (typeof tool !== 'string' || tool.length === 0) continue;
      if (!knownOps.has(tool)) {
        unknownTools.push({ skill: skillDir, tool });
      }
    }
  }

  return { packRoot, manifest, unknownTools };
}
