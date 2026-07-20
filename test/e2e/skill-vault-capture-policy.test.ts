/**
 * E2E smoke for skills/skill-vault-capture-policy.
 *
 * Verifies the from-trigger-to-side-effect path: a real capture request
 * routes to the skill, and the skill documents the vault navigation
 * obligations (index.md / log.md) that make a capture durable.
 *
 * Local-only: it asserts documented behavior, not live vault writes.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SKILLS = join(import.meta.dir, '..', '..', 'skills');
const SKILL_MD = join(SKILLS, 'skill-vault-capture-policy', 'SKILL.md');
const RESOLVER = join(SKILLS, 'RESOLVER.md');

const TRIGGER_PHRASES = [
  'save this learning to the vault',
  'capture this skill in Obsidian',
  'record this workflow in my notes',
  'put this setup change in the knowledge base',
];

describe('skill-vault-capture-policy E2E', () => {
  it('resolver maps real capture phrasings to the skill', () => {
    const resolver = readFileSync(RESOLVER, 'utf-8');
    expect(resolver).toContain('skill-vault-capture-policy/SKILL.md');
    const rows = resolver
      .split('\n')
      .filter((l) => l.includes('skill-vault-capture-policy/SKILL.md'))
      .join('\n');
    for (const phrase of TRIGGER_PHRASES) {
      const hit = phrase
        .toLowerCase()
        .split(/\s+/)
        .some((tok) => tok.length > 3 && rows.toLowerCase().includes(tok));
      expect(hit, `no resolver token for: ${phrase}`).toBe(true);
    }
  });

  it('skill documents index.md and log.md update obligations', () => {
    const body = readFileSync(SKILL_MD, 'utf-8');
    expect(body).toContain('index.md');
    expect(body).toContain('log.md');
  });

  it('skill is reachable from the skill tree', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });
});
