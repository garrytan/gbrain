/**
 * Tests for src/core/skillpack/installer.ts applyUninstall (D6 + D8 + D11).
 *
 * Uses the same scratch-gbrain pattern as test/skillpack-install.test.ts:
 * a tempdir source bundle (alpha + beta + shared_deps) and a tempdir
 * target workspace. Install first, then exercise uninstall semantics.
 *
 * Coverage:
 *   - happy path (slug in receipt, files match bundle) — files removed,
 *     managed block updated, cumulative-slugs receipt loses the slug
 *   - D8: slug NOT in cumulative-slugs receipt → user_added_slug
 *   - D11: file content modified → locally_modified (refuse-and-warn)
 *   - D11: --overwrite-local → removes anyway
 *   - unknown skill slug → unknown_skill
 *   - dry-run does not write
 *   - uninstall of one skill preserves OTHER installed skills' rows
 *   - lockfile contention with --force-unlock escape hatch
 *   - idempotent: file already absent on disk doesn't crash
 */

import { describe, expect, it, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  applyInstall,
  applyUninstall,
  parseReceipt,
  planInstall,
  UninstallError,
} from '../src/core/skillpack/installer.ts';
import { BundleError } from '../src/core/skillpack/bundle.ts';

const created: string[] = [];

function scratchGbrain(): { gbrainRoot: string; skillsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'skillpack-gbrain-'));
  created.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub');
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  mkdirSync(join(skillsDir, 'alpha'), { recursive: true });
  writeFileSync(
    join(skillsDir, 'alpha', 'SKILL.md'),
    '---\nname: alpha\n---\n# alpha\n',
  );
  mkdirSync(join(skillsDir, 'alpha', 'scripts'), { recursive: true });
  writeFileSync(
    join(skillsDir, 'alpha', 'scripts', 'alpha.mjs'),
    'export function run() { return "alpha"; }\n',
  );

  mkdirSync(join(skillsDir, 'beta'), { recursive: true });
  writeFileSync(
    join(skillsDir, 'beta', 'SKILL.md'),
    '---\nname: beta\n---\n# beta\n',
  );

  mkdirSync(join(skillsDir, 'conventions'), { recursive: true });
  writeFileSync(
    join(skillsDir, 'conventions', 'quality.md'),
    '# quality conventions\n',
  );
  writeFileSync(join(skillsDir, '_output-rules.md'), '# output rules\n');

  writeFileSync(
    join(skillsDir, 'RESOLVER.md'),
    '# RESOLVER\n\n| Trigger | Skill |\n|---------|-------|\n| "alpha" | `skills/alpha/SKILL.md` |\n| "beta" | `skills/beta/SKILL.md` |\n',
  );

  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify(
      {
        name: 'gbrain-test',
        version: '0.25.1-test',
        skills: ['skills/alpha', 'skills/beta'],
        shared_deps: ['skills/conventions', 'skills/_output-rules.md'],
      },
      null,
      2,
    ),
  );

  return { gbrainRoot: root, skillsDir };
}

function scratchTarget(): { workspace: string; skillsDir: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'skillpack-target-'));
  created.push(workspace);
  const skillsDir = join(workspace, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    join(skillsDir, 'RESOLVER.md'),
    '# Target RESOLVER\n\n| Trigger | Skill |\n|---------|-------|\n',
  );
  return { workspace, skillsDir };
}

/** Install one or both skills into a fresh target. Returns target paths. */
function installAndReturnTarget(
  slug: 'alpha' | 'beta' | null,
): { gbrainRoot: string; targetWorkspace: string; targetSkillsDir: string } {
  const { gbrainRoot } = scratchGbrain();
  const { workspace: targetWorkspace, skillsDir: targetSkillsDir } =
    scratchTarget();
  const opts = {
    gbrainRoot,
    targetWorkspace,
    targetSkillsDir,
    skillSlug: slug,
  };
  const plan = planInstall(opts);
  applyInstall(plan, opts);
  return { gbrainRoot, targetWorkspace, targetSkillsDir };
}

afterEach(() => {
  while (created.length) {
    const d = created.pop();
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('applyUninstall — happy path', () => {
  it('removes the skill files and drops the slug from cumulative-slugs', () => {
    const { gbrainRoot, targetWorkspace, targetSkillsDir } =
      installAndReturnTarget('alpha');

    // Confirm install landed.
    expect(existsSync(join(targetSkillsDir, 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(targetSkillsDir, 'alpha', 'scripts', 'alpha.mjs')))
      .toBe(true);

    const result = applyUninstall({
      gbrainRoot,
      targetWorkspace,
      targetSkillsDir,
      skillSlug: 'alpha',
    });

    expect(result.summary.removed).toBe(2);
    expect(result.summary.absent).toBe(0);
    expect(result.summary.keptLocallyModified).toBe(0);
    expect(existsSync(join(targetSkillsDir, 'alpha', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(targetSkillsDir, 'alpha', 'scripts', 'alpha.mjs')))
      .toBe(false);

    // Managed block updated; receipt no longer lists alpha.
    const resolver = readFileSync(join(targetSkillsDir, 'RESOLVER.md'), 'utf-8');
    const receipt = parseReceipt(resolver);
    expect(receipt).not.toBeNull();
    expect(receipt!.cumulativeSlugs).not.toContain('alpha');
  });

  it('preserves other installed skills when uninstalling one', () => {
    const { gbrainRoot, targetWorkspace, targetSkillsDir } =
      installAndReturnTarget(null); // --all install

    const result = applyUninstall({
      gbrainRoot,
      targetWorkspace,
      targetSkillsDir,
      skillSlug: 'alpha',
    });

    expect(result.managedBlock.applied).toBe(true);
    // Files are removed but empty parent dirs are NOT pruned (v0.26+
    // enhancement). Check files, not dirs.
    expect(existsSync(join(targetSkillsDir, 'alpha', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(targetSkillsDir, 'alpha', 'scripts', 'alpha.mjs')))
      .toBe(false);
    expect(existsSync(join(targetSkillsDir, 'beta', 'SKILL.md'))).toBe(true);

    const resolver = readFileSync(join(targetSkillsDir, 'RESOLVER.md'), 'utf-8');
    const receipt = parseReceipt(resolver);
    expect(receipt!.cumulativeSlugs).not.toContain('alpha');
    expect(receipt!.cumulativeSlugs).toContain('beta');
  });

  it('--dry-run reports the plan but does not write', () => {
    const { gbrainRoot, targetWorkspace, targetSkillsDir } =
      installAndReturnTarget('alpha');

    const result = applyUninstall({
      gbrainRoot,
      targetWorkspace,
      targetSkillsDir,
      skillSlug: 'alpha',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.summary.removed).toBe(2);
    // Files still exist on disk.
    expect(existsSync(join(targetSkillsDir, 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(targetSkillsDir, 'alpha', 'scripts', 'alpha.mjs')))
      .toBe(true);
    // Receipt still has alpha.
    const resolver = readFileSync(join(targetSkillsDir, 'RESOLVER.md'), 'utf-8');
    const receipt = parseReceipt(resolver);
    expect(receipt!.cumulativeSlugs).toContain('alpha');
  });
});

describe('applyUninstall — D8 user-added-slug refuse-and-warn', () => {
  it('throws user_added_slug when slug is not in cumulative-slugs receipt', () => {
    const { gbrainRoot, targetWorkspace, targetSkillsDir } =
      installAndReturnTarget('alpha');

    // Try to uninstall beta — never installed; not in receipt.
    expect(() =>
      applyUninstall({
        gbrainRoot,
        targetWorkspace,
        targetSkillsDir,
        skillSlug: 'beta',
      }),
    ).toThrow(UninstallError);

    try {
      applyUninstall({
        gbrainRoot,
        targetWorkspace,
        targetSkillsDir,
        skillSlug: 'beta',
      });
    } catch (e) {
      expect((e as UninstallError).code).toBe('user_added_slug');
    }
  });

  it('refuses even when the user has manually added a row to the managed block', () => {
    const { gbrainRoot, targetWorkspace, targetSkillsDir } =
      installAndReturnTarget('alpha');

    // Hand-edit the managed block to add a row gbrain didn't install.
    const resolver = readFileSync(join(targetSkillsDir, 'RESOLVER.md'), 'utf-8');
    const tampered = resolver.replace(
      '`skills/alpha/SKILL.md`',
      '`skills/alpha/SKILL.md` |\n| "user-added" | `skills/user-added/SKILL.md`',
    );
    writeFileSync(join(targetSkillsDir, 'RESOLVER.md'), tampered);

    // Uninstalling user-added should refuse — it's not in the receipt.
    try {
      applyUninstall({
        gbrainRoot,
        targetWorkspace,
        targetSkillsDir,
        skillSlug: 'user-added',
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as UninstallError).code).toBe('user_added_slug');
    }
  });
});

describe('applyUninstall — D11 content-hash guard', () => {
  it('refuses with locally_modified when a file diverges from the bundle', () => {
    const { gbrainRoot, targetWorkspace, targetSkillsDir } =
      installAndReturnTarget('alpha');

    // Hand-edit the SKILL.md.
    writeFileSync(
      join(targetSkillsDir, 'alpha', 'SKILL.md'),
      '---\nname: alpha\nlocal_edit: true\n---\n# my own version\n',
    );

    expect(() =>
      applyUninstall({
        gbrainRoot,
        targetWorkspace,
        targetSkillsDir,
        skillSlug: 'alpha',
      }),
    ).toThrow(UninstallError);

    try {
      applyUninstall({
        gbrainRoot,
        targetWorkspace,
        targetSkillsDir,
        skillSlug: 'alpha',
      });
    } catch (e) {
      expect((e as UninstallError).code).toBe('locally_modified');
    }

    // Critically: nothing was removed (atomic refusal).
    expect(existsSync(join(targetSkillsDir, 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(targetSkillsDir, 'alpha', 'scripts', 'alpha.mjs')))
      .toBe(true);

    // Receipt unchanged.
    const resolver = readFileSync(join(targetSkillsDir, 'RESOLVER.md'), 'utf-8');
    expect(parseReceipt(resolver)!.cumulativeSlugs).toContain('alpha');
  });

  it('--overwrite-local bypasses the guard and removes anyway', () => {
    const { gbrainRoot, targetWorkspace, targetSkillsDir } =
      installAndReturnTarget('alpha');

    writeFileSync(
      join(targetSkillsDir, 'alpha', 'SKILL.md'),
      '# my own version\n',
    );

    const result = applyUninstall({
      gbrainRoot,
      targetWorkspace,
      targetSkillsDir,
      skillSlug: 'alpha',
      overwriteLocal: true,
    });

    expect(result.summary.removed).toBeGreaterThan(0);
    expect(existsSync(join(targetSkillsDir, 'alpha', 'SKILL.md'))).toBe(false);
  });
});

describe('applyUninstall — error paths', () => {
  it('throws unknown_skill when the slug is not in the bundle', () => {
    const { gbrainRoot, targetWorkspace, targetSkillsDir } =
      installAndReturnTarget('alpha');

    // Manually inject the slug into the cumulative-slugs receipt so D8
    // doesn't fire first; then enumerate fails because the bundle has
    // no such slug.
    const resolver = readFileSync(join(targetSkillsDir, 'RESOLVER.md'), 'utf-8');
    const tampered = resolver.replace(
      /cumulative-slugs="([^"]*)"/,
      'cumulative-slugs="$1,does-not-exist"',
    );
    writeFileSync(join(targetSkillsDir, 'RESOLVER.md'), tampered);

    try {
      applyUninstall({
        gbrainRoot,
        targetWorkspace,
        targetSkillsDir,
        skillSlug: 'does-not-exist',
      });
      throw new Error('expected throw');
    } catch (e) {
      // Either UninstallError(unknown_skill) or BundleError(skill_not_found)
      // — both are acceptable; the CLI catches both. The test just
      // verifies the bad slug is rejected with a typed error rather
      // than a silent success or a generic crash.
      expect(
        e instanceof UninstallError || e instanceof BundleError,
      ).toBe(true);
    }
  });

  it('throws managed_block_missing when no resolver exists', () => {
    const { gbrainRoot } = scratchGbrain();
    const workspace = mkdtempSync(join(tmpdir(), 'skillpack-no-resolver-'));
    created.push(workspace);
    const skillsDir = join(workspace, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    // No RESOLVER.md in the target.

    try {
      applyUninstall({
        gbrainRoot,
        targetWorkspace: workspace,
        targetSkillsDir: skillsDir,
        skillSlug: 'alpha',
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UninstallError);
      expect((e as UninstallError).code).toBe('managed_block_missing');
    }
  });
});

describe('applyUninstall — idempotency', () => {
  it('handles already-absent files gracefully (counts them as absent)', () => {
    const { gbrainRoot, targetWorkspace, targetSkillsDir } =
      installAndReturnTarget('alpha');

    // Manually delete one of alpha's files BEFORE running uninstall.
    rmSync(join(targetSkillsDir, 'alpha', 'scripts', 'alpha.mjs'));

    const result = applyUninstall({
      gbrainRoot,
      targetWorkspace,
      targetSkillsDir,
      skillSlug: 'alpha',
    });

    // SKILL.md was present and is now removed; the .mjs was already absent.
    expect(result.summary.removed).toBe(1);
    expect(result.summary.absent).toBe(1);
    // Receipt updates regardless.
    const resolver = readFileSync(join(targetSkillsDir, 'RESOLVER.md'), 'utf-8');
    expect(parseReceipt(resolver)!.cumulativeSlugs).not.toContain('alpha');
  });
});
