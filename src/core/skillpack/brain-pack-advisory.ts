/**
 * skillpack/brain-pack-advisory.ts — agent-readable "this brain ships skills"
 * advisory, printed to stderr when a federated source carrying a brain-resident
 * pack is added (Topology A discovery).
 *
 * Same print-never-execute contract as post-install-advisory.ts: we describe the
 * pack and tell the harness to ASK THE USER before scaffolding. We never install
 * anything. The recommended set is read from the brain's own skillpack.json, not
 * a hardcoded constant.
 *
 * `level` drives the nag policy (nag-state.ts): 'full' on first sight / version
 * bump, 'short' on subsequent reminders.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { parseMarkdown } from '../markdown.ts';
import { coerceFrontmatterString } from '../markdown.ts';
import type { SkillpackManifest } from './manifest-v1.ts';

export interface BrainPackAdvisoryInput {
  /** The validated brain-resident manifest. */
  manifest: SkillpackManifest;
  /** Absolute pack root (where skillpack.json + skills/ live). */
  packRoot: string;
  /** The exact source spec to put in the scaffold command (local path or git spec). */
  scaffoldSource: string;
  /** True when the pack is already scaffolded at this version (skillpack-state). */
  installed: boolean;
  /** The brain's active schema pack, for the mismatch note. */
  activeSchemaPack?: string | null;
  /** Nag level — 'full' (first/bump) or 'short' (reminder). Default 'full'. */
  level?: 'full' | 'short';
}

/** Read a skill's one-line description from its SKILL.md frontmatter. */
function readSkillDescription(packRoot: string, skillDir: string): string {
  const skillMd = join(packRoot, skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return '(no description)';
  try {
    const fm = parseMarkdown(readFileSync(skillMd, 'utf-8'), skillMd).frontmatter;
    const desc = coerceFrontmatterString(fm.description);
    return desc && desc.length > 0 ? desc : '(no description)';
  } catch {
    return '(no description)';
  }
}

function schemaMismatch(input: BrainPackAdvisoryInput): boolean {
  const want = input.manifest.schema_pack;
  if (!want) return false;
  const active = input.activeSchemaPack ?? null;
  return active != null && active !== want;
}

/**
 * Build the brain-pack advisory text. Returns null when there is nothing to
 * surface (pack already installed AND no schema-pack mismatch).
 */
export function buildBrainPackAdvisory(input: BrainPackAdvisoryInput): string | null {
  const mismatch = schemaMismatch(input);
  if (input.installed && !mismatch) return null;

  const bar = '='.repeat(72);
  const lines: string[] = [];
  const m = input.manifest;

  if (input.level === 'short') {
    // One-line escalating reminder.
    lines.push('');
    lines.push(
      `[gbrain] This brain ships ${m.skills.length} skill${m.skills.length === 1 ? '' : 's'} ` +
        `you haven't installed (${m.name} ${m.version}). Install: gbrain skillpack scaffold ${input.scaffoldSource}`,
    );
    if (mismatch) {
      lines.push(
        `[gbrain] NOTE: pack targets schema_pack "${m.schema_pack}" but this brain is on ` +
          `"${input.activeSchemaPack}". Skills may assume a different schema.`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(bar);
  lines.push(`gbrain — THIS BRAIN SHIPS A SKILLPACK (${m.name} ${m.version})`);
  lines.push(bar);
  lines.push('');
  lines.push(m.description);
  lines.push('');
  lines.push('SKILLS IN THIS PACK:');
  lines.push('');
  for (const skillDir of m.skills) {
    const slug = skillDir.replace(/^skills\//, '');
    lines.push(`  - ${slug}`);
    for (const wl of wrap(readSkillDescription(input.packRoot, skillDir), 68, '      ')) lines.push(wl);
    lines.push('');
  }
  if (mismatch) {
    lines.push(
      `SCHEMA NOTE: this pack targets schema_pack "${m.schema_pack}", but this brain is on ` +
        `"${input.activeSchemaPack}". The skills may assume a different schema; review before installing ` +
        `(see \`gbrain list_schema_packs\`).`,
    );
    lines.push('');
  }
  lines.push('ACTION FOR THE AGENT:');
  lines.push('');
  lines.push('  1. Show this list to the user. Briefly explain each skill.');
  lines.push('  2. Ask the user explicitly: "Want me to install these brain skills now?"');
  lines.push('  3. If YES, run this command:');
  lines.push('');
  lines.push(`         gbrain skillpack scaffold ${input.scaffoldSource}`);
  lines.push('');
  lines.push('  Do NOT scaffold without asking. The user owns this decision.');
  lines.push(bar);
  lines.push('');
  return lines.join('\n');
}

/** Print to stderr; no-op when buildBrainPackAdvisory returns null. */
export function printBrainPackAdvisory(input: BrainPackAdvisoryInput): boolean {
  const text = buildBrainPackAdvisory(input);
  if (!text) return false;
  process.stderr.write(text);
  return true;
}

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = indent;
  for (const word of words) {
    if ((current + (current === indent ? '' : ' ') + word).length > width + indent.length) {
      lines.push(current.trimEnd());
      current = indent + word;
    } else {
      current = current === indent ? indent + word : current + ' ' + word;
    }
  }
  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines;
}
