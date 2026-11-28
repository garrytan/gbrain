/**
 * GST-4022: gbrain's own skills that read or write the owner's data carry
 * `audience: owner` in their front matter, so OpenClaw's resolver never
 * suggests or pins them outside the owner's sessions (and a skill pack that
 * copies them byte for byte inherits the mark). conversation-archive (the
 * owner's AI chat history) and daily-task-manager (the owner's task list
 * page) meet the same bar: a guest's "search my conversations" or "what are
 * my tasks" would read the owner's pages.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillDoc } from '../src/core/skills/resolver/frontmatter.ts';
import { readDirSources } from '../src/core/skills/resolver/sources.ts';

const SKILLS = join(import.meta.dir, '..', 'skills');
const OWNER_ONLY = ['briefing', 'cold-start', 'company-brainify', 'conversation-archive', 'daily-task-manager', 'daily-task-prep'];

describe('gbrain skills marked audience: owner', () => {
  test('each owner-data skill parses as audience: owner', () => {
    for (const name of OWNER_ONLY) expect([name, parseSkillDoc(readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')).audience]).toEqual([name, 'owner']);
  });

  test('a catalog built from the skills folder records them as owner-only, and a general skill stays open to everyone', () => {
    const byId = new Map(readDirSources([SKILLS]).skills.map((s) => [s.id, s.audience ?? null]));
    for (const name of OWNER_ONLY) expect([name, byId.get(name)]).toEqual([name, 'owner']);
    expect(byId.get('query')).toBeNull();
  });
});
