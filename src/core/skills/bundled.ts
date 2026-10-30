/**
 * skills/bundled.ts — gbrain's own bundled skills, embedded at build time
 * (bundled-skills.generated.ts), so they are the same on a source install and
 * a compiled binary and never come from the caller's working directory or a
 * host skills dir.
 *
 * The set is the plugin lane (skills/plugin-lanes.json), the curated set the
 * Claude Code and Codex plugins publish; repo-development skills are never in
 * it. Each skill carries an audience: `downstream` skills are also in
 * openclaw.plugin.json#skills, whose curation keeps host-only workflows
 * (migrate, setup, db-repair, upgrades, …) away from agents that do not run
 * on the brain host; `owner` skills are offered only to callers on the host.
 *
 * Every read is a key lookup in the embedded map: a client-supplied name or
 * asset is a lookup key, never a path.
 *
 * Read by `gbrain bundled-skill` (src/cli/commands/bundled-skill.ts), which
 * needs no brain connection, and by the skills index (spring-index.ts).
 */
import { createHash } from 'node:crypto';
import { parseSkillFrontmatter } from '../skill-frontmatter.ts';
import { BUNDLED_SKILLS, BUNDLED_SKILL_FILES, type BundledSkillMeta } from './bundled-skills.generated.ts';

export type BundledSkill = BundledSkillMeta;
export type SkillAudience = 'owner' | 'downstream';

/** The bundled skills an audience may see: an owner (on the brain host) sees all of them. */
export function bundledSkills(audience: SkillAudience): readonly BundledSkill[] {
  return audience === 'owner' ? BUNDLED_SKILLS : BUNDLED_SKILLS.filter(s => s.audience === 'downstream');
}

export function findBundledSkill(name: string, audience: SkillAudience): BundledSkill | undefined {
  return bundledSkills(audience).find(s => s.name === name);
}

/** The SKILL.md text of a bundled skill. */
export function bundledSkillText(skill: BundledSkill): string {
  return BUNDLED_SKILL_FILES[`${skill.name}/SKILL.md`] ?? '';
}

/** The skill's frontmatter `triggers:` (the canonical routing signal), read from the embedded text. */
export function bundledSkillTriggers(skill: BundledSkill): string[] {
  return (parseSkillFrontmatter(bundledSkillText(skill))?.triggers ?? []).map(t => String(t).trim()).filter(Boolean);
}

/** The skill's one-line description, as the skill catalog derives it. */
export async function bundledSkillDescription(skill: BundledSkill): Promise<string> {
  const { oneLineDescription } = await import('../skill-catalog.ts');
  const text = bundledSkillText(skill);
  return oneLineDescription(parseSkillFrontmatter(text)?.raw ?? '', text.replace(/^---\n[\s\S]*?\n---\n?/, '')).replace(/\s+/g, ' ').trim();
}

/** One file the skill lists in its assets; undefined for anything else. */
export function bundledSkillAsset(skill: BundledSkill, asset: string): string | undefined {
  return skill.assets.includes(asset) ? BUNDLED_SKILL_FILES[asset] : undefined;
}

/**
 * Identity of what the skills index shows and what `bundled-skill` accepts:
 * each skill's name, audience, triggers and file list. A body-only edit keeps
 * it, so it does not mark installed indexes stale; a renamed, added or removed
 * skill, a trigger change or a new file changes it.
 */
export function bundledCatalogId(): string {
  const h = createHash('sha256');
  for (const s of BUNDLED_SKILLS) h.update(JSON.stringify([s.name, s.audience, bundledSkillTriggers(s), s.assets]));
  return h.digest('hex').slice(0, 12);
}
