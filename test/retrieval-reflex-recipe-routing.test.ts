/**
 * test/retrieval-reflex-recipe-routing.test.ts — #4292 routing MECE.
 *
 * The retrieval-reflex recipe ships a policy SKILL.md into the host
 * resolver. Its triggers must be REFLEX-ONLY: the direct lookup phrases
 * ("who is", "what do we know about", "tell me about") belong to the
 * query skill (skills/RESOLVER.md + skills/query/SKILL.md). When both
 * skills claim the same phrase, host routing becomes ambiguous and
 * queries misroute silently.
 *
 * Also pins the install pointer honesty half of #4292: `gbrain
 * integrations install` prints "next steps: see
 * recipes/<id>/install/post-install-hint.md" — that pointer must be
 * gated on the file actually existing (and retrieval-reflex now ships
 * one).
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';

const REPO_ROOT = resolve(import.meta.dir, '..');
const RECIPE_ROOT = join(REPO_ROOT, 'recipes', 'retrieval-reflex');

/** The query skill owns these direct-lookup phrases (skills/RESOLVER.md). */
const QUERY_SKILL_PHRASES = ['who is', 'what do we know about', 'tell me about', 'search for', 'background on', 'notes on'];

describe('retrieval-reflex recipe routing is MECE with the query skill (#4292)', () => {
  it('SKILL.md frontmatter triggers carry no query-skill lookup phrases', () => {
    const skillPath = join(RECIPE_ROOT, 'skills', 'retrieval-reflex', 'SKILL.md');
    const fm = matter(readFileSync(skillPath, 'utf8'));
    const triggers: unknown = fm.data.triggers;
    expect(Array.isArray(triggers)).toBe(true);
    expect((triggers as unknown[]).length).toBeGreaterThan(0);
    for (const trigger of triggers as unknown[]) {
      expect(typeof trigger).toBe('string');
      const lower = (trigger as string).toLowerCase();
      for (const phrase of QUERY_SKILL_PHRASES) {
        expect(lower).not.toContain(phrase);
      }
    }
  });

  it('the query skill still owns "who is" (the phrases moved, not vanished)', () => {
    const querySkill = readFileSync(join(REPO_ROOT, 'skills', 'query', 'SKILL.md'), 'utf8');
    expect(querySkill.toLowerCase()).toContain('"who is"');
  });

  it('install manifest resolver row carries no query-skill lookup phrases', () => {
    const manifest = JSON.parse(readFileSync(join(RECIPE_ROOT, 'install', 'manifest.json'), 'utf8')) as {
      resolver_rows_to_append?: string[];
    };
    const rows = manifest.resolver_rows_to_append ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const lower = row.toLowerCase();
      for (const phrase of QUERY_SKILL_PHRASES) {
        expect(lower).not.toContain(phrase);
      }
    }
  });

  it('retrieval-reflex ships the post-install hint the install pointer names', () => {
    expect(existsSync(join(RECIPE_ROOT, 'install', 'post-install-hint.md'))).toBe(true);
  });

  it('the install pointer is gated on the hint file existing (source guard)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'commands', 'integrations.ts'), 'utf8');
    // The "next steps" pointer must not print unconditionally: a recipe
    // without a post-install-hint.md would send the operator to a 404.
    const pointerIdx = src.indexOf("next steps: see recipes/");
    expect(pointerIdx).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, pointerIdx - 400), pointerIdx);
    expect(window).toContain('post-install-hint.md');
    expect(window).toContain('existsSync');
  });
});
