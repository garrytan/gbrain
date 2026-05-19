import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { skillBrainFirstCheck } from '../src/commands/doctor.ts';

const TMP_DIR = join(import.meta.dir, '.tmp-brain-first-test');

function makeSkill(name: string, content: string): void {
  const dir = join(TMP_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
}

describe('skillBrainFirstCheck', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('returns ok when no skills directory exists', () => {
    const result = skillBrainFirstCheck('/nonexistent/path/skills');
    expect(result.name).toBe('skill_brain_first');
    expect(result.status).toBe('ok');
    expect(result.message).toContain('skipped');
  });

  test('returns ok when all external-lookup skills have brain-first steps', () => {
    makeSkill('good-skill', `---
name: good-skill
---
# Good Skill

## Step 0: Brain Context
Search the brain first with \`gbrain search\` for relevant context.

## Step 1: External Lookup
Use web_search to find additional information.
`);
    const result = skillBrainFirstCheck(TMP_DIR);
    expect(result.status).toBe('ok');
    expect(result.message).toContain('brain-first checks');
  });

  test('returns warn when skill has external lookup without brain-first', () => {
    makeSkill('bad-skill', `---
name: bad-skill
---
# Bad Skill

## Step 1: Research
Use web_search to find information about the entity.
Then use Perplexity for deeper research.
`);
    const result = skillBrainFirstCheck(TMP_DIR);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('bad-skill');
    expect(result.message).toContain('brain-first search step');
  });

  test('detects multiple external lookup patterns', () => {
    // Exa
    makeSkill('exa-user', `---\nname: exa-user\n---\nUse exa.search for lookups.`);
    // Happenstance
    makeSkill('hap-user', `---\nname: hap-user\n---\nQuery happenstance API.`);
    // Crustdata
    makeSkill('crust-user', `---\nname: crust-user\n---\nUse crustdata for LinkedIn data.`);

    const result = skillBrainFirstCheck(TMP_DIR);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('3 skill(s)');
  });

  test('skills with brain search are not flagged', () => {
    makeSkill('brain-first-skill', `---
name: brain-first-skill
---
# Brain-First Skill

First, search the brain for existing context.
Then use web_search for anything missing.
`);
    const result = skillBrainFirstCheck(TMP_DIR);
    expect(result.status).toBe('ok');
  });

  test('exempt skills are skipped even with external lookups', () => {
    // brain-ops is exempt
    makeSkill('brain-ops', `---\nname: brain-ops\n---\nUse web_search for research.`);
    const result = skillBrainFirstCheck(TMP_DIR);
    expect(result.status).toBe('ok');
  });

  test('skills without external lookups are not flagged', () => {
    makeSkill('internal-skill', `---
name: internal-skill
---
# Internal Skill
This skill only operates on local files. No external lookups.
`);
    const result = skillBrainFirstCheck(TMP_DIR);
    expect(result.status).toBe('ok');
    expect(result.message).toContain('0 skill(s)');
  });

  test('recognizes various brain-first patterns', () => {
    // "brain-first" keyword
    makeSkill('s1', `---\nname: s1\n---\nBrain-first lookup required.\nUse web_search.`);
    // "gbrain get" 
    makeSkill('s2', `---\nname: s2\n---\nRun gbrain get entity.\nUse web_fetch for enrichment.`);
    // "check the brain"
    makeSkill('s3', `---\nname: s3\n---\nCheck the brain before calling Perplexity.`);
    // "query the brain"
    makeSkill('s4', `---\nname: s4\n---\nQuery the brain for context. Use exa.search for rest.`);

    const result = skillBrainFirstCheck(TMP_DIR);
    expect(result.status).toBe('ok');
  });

  test('hidden directories and underscore-prefixed dirs are skipped', () => {
    makeSkill('.hidden', `---\nname: hidden\n---\nUse web_search.`);
    makeSkill('_internal', `---\nname: internal\n---\nUse web_search.`);
    const result = skillBrainFirstCheck(TMP_DIR);
    expect(result.status).toBe('ok');
  });

  test('mix of good and bad skills reports only the bad ones', () => {
    makeSkill('good', `---\nname: good\n---\nSearch brain first. Then web_search.`);
    makeSkill('bad', `---\nname: bad\n---\nJust use web_search directly.`);
    const result = skillBrainFirstCheck(TMP_DIR);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('bad');
    expect(result.message).not.toContain('good');
  });
});
