/**
 * v0.41.19.0 `--scope=brain` skip-computation contract.
 *
 * The plan-eng-review D4/D9 lock: `--scope=brain` must SKIP computation of
 * the SKILL check group (resolver_health, skill_conformance,
 * skill_brain_first, whoknows_health), not just filter the output. The
 * observable contract: with `--scope=brain`, the returned checks list
 * contains zero entries with `category: 'skill'`, AND the resolver walk is
 * NOT performed.
 *
 * This is the "sub-second on a brain with thousands of skills" win. Hermetic
 * test: passes `engine=null` so no DB or PGLite is needed; uses `--fast` to
 * skip the DB check path; sets $GBRAIN_SKILLS_DIR to a tmpdir to control the
 * resolver walk's input cheaply.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { buildChecks } from '../src/commands/doctor.ts';

function makeSkillsTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-scope-test-'));
  mkdirSync(join(root, 'foo'), { recursive: true });
  // A minimal SKILL.md so checkResolvable / skill_conformance / skill_brain_first
  // all have content to scan when scope=all. The body doesn't need to be
  // valid in detail; we only care about whether the function INVOKES the
  // resolver walk.
  writeFileSync(
    join(root, 'foo', 'SKILL.md'),
    '---\nname: foo\ntriggers:\n  - "test trigger"\nbrain_first: exempt\n---\n\n# foo\n\nA test skill.\n',
  );
  writeFileSync(
    join(root, 'RESOLVER.md'),
    '| Skill | Triggers |\n|---|---|\n| **foo**: test trigger |\n',
  );
  return root;
}

describe('buildChecks --scope=brain skip-computation contract', () => {
  test('SKILL group is absent from the checks list under --scope=brain', async () => {
    const skillsDir = makeSkillsTree();
    await withEnv({ GBRAIN_SKILLS_DIR: skillsDir, GBRAIN_NO_BANNER: '1' }, async () => {
      const checks = await buildChecks(null, ['--scope=brain', '--fast']);
      const skillChecks = checks.filter(
        (c) =>
          c.name === 'resolver_health' ||
          c.name === 'skill_conformance' ||
          c.name === 'skill_brain_first' ||
          c.name === 'whoknows_health',
      );
      expect(skillChecks).toEqual([]);
    });
  });

  test('SKILL group IS present under default scope (--fast alone)', async () => {
    const skillsDir = makeSkillsTree();
    await withEnv({ GBRAIN_SKILLS_DIR: skillsDir, GBRAIN_NO_BANNER: '1' }, async () => {
      const checks = await buildChecks(null, ['--fast']);
      const names = new Set(checks.map((c) => c.name));
      expect(names.has('resolver_health')).toBe(true);
      // skill_conformance + skill_brain_first only run if skillsDir is detected
      // AND has SKILL.md files — the makeSkillsTree fixture provides one.
      expect(names.has('skill_conformance')).toBe(true);
      expect(names.has('skill_brain_first')).toBe(true);
    });
  });

  test('--scope=brain still emits non-skill checks (the brain figure is meaningful)', async () => {
    const skillsDir = makeSkillsTree();
    await withEnv({ GBRAIN_SKILLS_DIR: skillsDir, GBRAIN_NO_BANNER: '1' }, async () => {
      const checks = await buildChecks(null, ['--scope=brain', '--fast']);
      // At least one non-skill check must be present (e.g. the migration
      // health/meta checks that always run in the FS phase, or schema_version
      // which is the canonical META check).
      expect(checks.length).toBeGreaterThan(0);
      const cats = new Set(checks.map((c) => c.category));
      // No skill-category checks at all.
      expect(cats.has('skill')).toBe(false);
    });
  });

  test('--scope=brain does NOT emit a "Could not find skills directory" warn (we deliberately skipped, not failed)', async () => {
    await withEnv({ GBRAIN_SKILLS_DIR: '/nonexistent/path/should/not/exist', GBRAIN_NO_BANNER: '1' }, async () => {
      const checks = await buildChecks(null, ['--scope=brain', '--fast']);
      const resolverHealth = checks.find((c) => c.name === 'resolver_health');
      // Under scope=brain, we don't even attempt to find the skills dir, so
      // the "Could not find skills directory" branch should NOT fire.
      expect(resolverHealth).toBeUndefined();
    });
  });
});
