/**
 * W4: isGbrainManagedSkillsDir — the marker doctor uses to grade an auto-detected skills folder (and GBRA-225's
 * skill_health check reuses). Only files gbrain writes count; a generic RESOLVER.md does not.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGbrainManagedSkillsDir } from '../src/core/skill-manifest.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function workspace(): { root: string; skills: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-managed-skills-'));
  roots.push(root);
  const skills = join(root, 'skills');
  mkdirSync(join(skills, 'research', 'web-digest'), { recursive: true });
  writeFileSync(join(skills, 'research', 'web-digest', 'SKILL.md'), '---\nname: web-digest\n---\n# web-digest\n');
  return { root, skills };
}

describe('isGbrainManagedSkillsDir', () => {
  test('an agent skills folder with no gbrain file is not managed, even with its own RESOLVER.md or AGENTS.md', () => {
    const { root, skills } = workspace();
    expect(isGbrainManagedSkillsDir(skills)).toBe(false);
    writeFileSync(join(skills, 'RESOLVER.md'), '# RESOLVER\n\n| Trigger | Skill |\n|---|---|\n');
    writeFileSync(join(root, 'AGENTS.md'), '# Agent\n');
    expect(isGbrainManagedSkillsDir(skills)).toBe(false);
  });

  test('a malformed manifest.json is not a marker (the loader derives one)', () => {
    const { skills } = workspace();
    writeFileSync(join(skills, 'manifest.json'), '{"skills": {"not": "an array"}}');
    expect(isGbrainManagedSkillsDir(skills)).toBe(false);
  });

  test('skills.lock.json, a valid manifest.json, or the skillpack managed block marks it managed', () => {
    const lock = workspace();
    writeFileSync(join(lock.skills, 'skills.lock.json'), '{}');
    expect(isGbrainManagedSkillsDir(lock.skills)).toBe(true);

    const manifest = workspace();
    writeFileSync(join(manifest.skills, 'manifest.json'), JSON.stringify({ skills: [{ name: 'web-digest', path: 'research/web-digest/SKILL.md' }] }));
    expect(isGbrainManagedSkillsDir(manifest.skills)).toBe(true);

    const block = workspace();
    writeFileSync(join(block.root, 'AGENTS.md'), '# Agent\n\n<!-- gbrain:skillpack:begin -->\n<!-- gbrain:skillpack:end -->\n');
    expect(isGbrainManagedSkillsDir(block.skills)).toBe(true);
  });
});
