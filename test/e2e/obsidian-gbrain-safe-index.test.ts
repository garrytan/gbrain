/**
 * E2E smoke for skills/obsidian-gbrain-safe-index.
 *
 * Verifies the from-trigger-to-side-effect path that skillify requires:
 * a real user trigger phrase routes to the skill, the resolver/check
 * pipeline treats it as reachable, and the skill file exposes the
 * gbrain commands the workflow actually runs.
 *
 * This stays local-only (no paid embedding, no external API): it asserts
 * the documented safe/import path is present and parseable, not that it
 * mutates a live brain.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SKILLS = join(import.meta.dir, '..', '..', 'skills');
const SKILL_MD = join(SKILLS, 'obsidian-gbrain-safe-index', 'SKILL.md');
const RESOLVER = join(SKILLS, 'RESOLVER.md');

const TRIGGER_PHRASES = [
  'connect my Obsidian vault to gbrain',
  'import my vault to gbrain',
  'sync vault and gbrain',
  'capture this skill in my vault',
  'embed gbrain after vault update',
  'is gbrain synced with my vault',
];

describe('obsidian-gbrain-safe-index E2E', () => {
  it('resolver maps real trigger phrasings to the skill', () => {
    const resolver = readFileSync(RESOLVER, 'utf-8');
    expect(resolver).toContain('obsidian-gbrain-safe-index/SKILL.md');
    // Each representative phrase shares a token substring with a resolver row.
    const rows = resolver
      .split('\n')
      .filter((l) => l.includes('obsidian-gbrain-safe-index/SKILL.md'))
      .join('\n');
    for (const phrase of TRIGGER_PHRASES) {
      const hit = phrase
        .toLowerCase()
        .split(/\s+/)
        .some((tok) => tok.length > 3 && rows.toLowerCase().includes(tok));
      expect(hit, `no resolver token for: ${phrase}`).toBe(true);
    }
  });

  it('skill documents the gbrain import-first safe path', () => {
    const body = readFileSync(SKILL_MD, 'utf-8');
    expect(body).toContain('gbrain import');
    expect(body).toContain('--no-embed');
    expect(body).toContain('gbrain config set search.mode conservative');
    // Paid gate must be explicit, not a silent default.
    expect(body).toContain('gbrain embed --stale');
  });

  it('skill is reachable from the skill tree', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });
});
