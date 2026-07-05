/**
 * Unit suite for the `role:` frontmatter field — the FROZEN interface contract
 * the T2 patient orchestrator ranks skills against
 * (hackathon_planning/00-setup-and-split.md).
 *
 * Coverage:
 *   - canonical values (nurse | psychiatrist | shared) parse to `role`
 *   - case-insensitivity + surrounding quotes normalize to lowercase canonical
 *   - non-canonical values populate `role_typo`, never silently drop
 *   - absent `role:` leaves both fields unset
 *   - SKILL_ROLES is the single source of truth for the allowed set
 *
 * Hermetic: pure content-in / struct-out, no I/O.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseSkillFrontmatter,
  SKILL_ROLES,
  type SkillRole,
} from '../src/core/skill-frontmatter.ts';

/** Wrap a role line in a minimal valid frontmatter fence. */
function fm(roleLine: string): string {
  return `---\nname: demo\n${roleLine}\n---\n\n# Demo\n`;
}

describe('role frontmatter — canonical values', () => {
  for (const role of SKILL_ROLES) {
    test(`\`role: ${role}\` parses to role=${role}`, () => {
      const parsed = parseSkillFrontmatter(fm(`role: ${role}`));
      expect(parsed?.role).toBe(role);
      expect(parsed?.role_typo).toBeUndefined();
    });
  }

  test('SKILL_ROLES is the exact allowed set', () => {
    expect([...SKILL_ROLES]).toEqual(['nurse', 'psychiatrist', 'shared']);
  });
});

describe('role frontmatter — normalization', () => {
  test('uppercase normalizes to lowercase canonical', () => {
    expect(parseSkillFrontmatter(fm('role: NURSE'))?.role).toBe('nurse');
  });

  test('mixed case normalizes', () => {
    expect(parseSkillFrontmatter(fm('role: Psychiatrist'))?.role).toBe('psychiatrist');
  });

  test('double-quoted value parses', () => {
    expect(parseSkillFrontmatter(fm('role: "shared"'))?.role).toBe('shared');
  });

  test('single-quoted value parses', () => {
    expect(parseSkillFrontmatter(fm("role: 'nurse'"))?.role).toBe('nurse');
  });

  test('trailing whitespace tolerated', () => {
    expect(parseSkillFrontmatter(fm('role:    shared   '))?.role).toBe('shared');
  });
});

describe('role frontmatter — typos are loud, not silent', () => {
  test('unknown value populates role_typo and leaves role unset', () => {
    const parsed = parseSkillFrontmatter(fm('role: doctor'));
    expect(parsed?.role).toBeUndefined();
    expect(parsed?.role_typo).toBe('doctor');
  });

  test('near-miss value is captured verbatim', () => {
    const parsed = parseSkillFrontmatter(fm('role: nurses'));
    expect(parsed?.role).toBeUndefined();
    expect(parsed?.role_typo).toBe('nurses');
  });

  test('empty value sets neither field', () => {
    const parsed = parseSkillFrontmatter(fm('role:'));
    expect(parsed?.role).toBeUndefined();
    expect(parsed?.role_typo).toBeUndefined();
  });
});

describe('role frontmatter — absence', () => {
  test('no role line leaves both fields unset', () => {
    const parsed = parseSkillFrontmatter('---\nname: demo\n---\n\n# Demo\n');
    expect(parsed?.role).toBeUndefined();
    expect(parsed?.role_typo).toBeUndefined();
  });

  test('role coexists with other fields', () => {
    const content = [
      '---',
      'name: triage',
      'description: Triage nursing intake',
      'role: nurse',
      'triggers:',
      '  - "chest pain"',
      'mutating: false',
      '---',
      '',
      '# Triage',
    ].join('\n');
    const parsed = parseSkillFrontmatter(content);
    expect(parsed?.role).toBe('nurse');
    expect(parsed?.name).toBe('triage');
    expect(parsed?.triggers).toEqual(['chest pain']);
    expect(parsed?.mutating).toBe(false);
  });
});

describe('SkillRole type', () => {
  test('assignment compiles for each canonical value', () => {
    const roles: SkillRole[] = ['nurse', 'psychiatrist', 'shared'];
    expect(roles).toHaveLength(3);
  });
});
