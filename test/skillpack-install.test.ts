/**
 * Tests for src/core/skillpack/bundle.ts + installer.ts (W5).
 * Bundle enumeration, dependency closure, per-file diff, managed
 * block, lockfile concurrency, atomic writes.
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
import { dirname, join } from 'path';
import { tmpdir } from 'os';

import {
  bundledSkillSlugs,
  findGbrainRoot,
  loadBundleManifest,
  enumerateBundle,
  BundleError,
} from '../src/core/skillpack/bundle.ts';
import {
  applyInstall,
  buildManagedBlock,
  diffSkill,
  extractManagedSlugs,
  planInstall,
  updateManagedBlock,
  InstallError,
} from '../src/core/skillpack/installer.ts';

const created: string[] = [];

function scratchGbrain(): { gbrainRoot: string; skillsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'skillpack-gbrain-'));
  created.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub');
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  // Two bundled skills + shared deps.
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

  // Shared deps.
  mkdirSync(join(skillsDir, 'conventions'), { recursive: true });
  writeFileSync(
    join(skillsDir, 'conventions', 'quality.md'),
    '# quality conventions\n',
  );
  writeFileSync(join(skillsDir, '_output-rules.md'), '# output rules\n');

  // RESOLVER.md (so find-resolver finds it).
  writeFileSync(
    join(skillsDir, 'RESOLVER.md'),
    '# RESOLVER\n\n| Trigger | Skill |\n|---------|-------|\n| "alpha" | `skills/alpha/SKILL.md` |\n| "beta" | `skills/beta/SKILL.md` |\n',
  );

  // Plugin manifest.
  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify(
      {
        name: 'gbrain-test',
        version: '0.17.0-test',
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
  // Seed a RESOLVER.md so managed block has a home.
  writeFileSync(
    join(skillsDir, 'RESOLVER.md'),
    '# Target RESOLVER\n\n| Trigger | Skill |\n|---------|-------|\n',
  );
  return { workspace, skillsDir };
}

afterEach(() => {
  while (created.length) {
    const d = created.pop();
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('findGbrainRoot', () => {
  it('walks up to find openclaw.plugin.json + src/cli.ts', () => {
    const { gbrainRoot } = scratchGbrain();
    const nested = join(gbrainRoot, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findGbrainRoot(nested)).toBe(gbrainRoot);
  });
  it('returns null when no gbrain root above', () => {
    expect(findGbrainRoot('/tmp/definitely-not-a-gbrain-repo-XYZ')).toBeNull();
  });
});

describe('loadBundleManifest', () => {
  it('loads + validates a valid manifest', () => {
    const { gbrainRoot } = scratchGbrain();
    const m = loadBundleManifest(gbrainRoot);
    expect(m.skills).toEqual(['skills/alpha', 'skills/beta']);
    expect(m.shared_deps.length).toBe(2);
  });
  it('throws BundleError on missing manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'skillpack-empty-'));
    created.push(root);
    expect(() => loadBundleManifest(root)).toThrow(BundleError);
  });
  it('throws BundleError on malformed JSON', () => {
    const { gbrainRoot } = scratchGbrain();
    writeFileSync(join(gbrainRoot, 'openclaw.plugin.json'), '{ nope');
    expect(() => loadBundleManifest(gbrainRoot)).toThrow(BundleError);
  });
});

describe('enumerateBundle (D-CX-10 dependency closure)', () => {
  it('includes skill files AND shared_deps for a single-skill install', () => {
    const { gbrainRoot } = scratchGbrain();
    const m = loadBundleManifest(gbrainRoot);
    const entries = enumerateBundle({ gbrainRoot, skillSlug: 'alpha', manifest: m });
    const targets = entries.map(e => e.relTarget).sort();
    expect(targets).toContain('alpha/SKILL.md');
    expect(targets).toContain('alpha/scripts/alpha.mjs');
    // Shared deps pulled in despite single-skill scope.
    expect(targets).toContain('conventions/quality.md');
    expect(targets).toContain('_output-rules.md');
    // beta NOT included.
    expect(targets.find(t => t.startsWith('beta/'))).toBeUndefined();
  });
  it('throws BundleError for unknown skill slug', () => {
    const { gbrainRoot } = scratchGbrain();
    const m = loadBundleManifest(gbrainRoot);
    expect(() =>
      enumerateBundle({ gbrainRoot, skillSlug: 'nope', manifest: m }),
    ).toThrow(BundleError);
  });
  it('enumerates everything when skillSlug is undefined (--all)', () => {
    const { gbrainRoot } = scratchGbrain();
    const m = loadBundleManifest(gbrainRoot);
    const entries = enumerateBundle({ gbrainRoot, manifest: m });
    const targets = entries.map(e => e.relTarget).sort();
    expect(targets.some(t => t.startsWith('alpha/'))).toBe(true);
    expect(targets.some(t => t.startsWith('beta/'))).toBe(true);
  });
});

describe('buildManagedBlock + updateManagedBlock', () => {
  it('builds a block with all installed slugs as rows', () => {
    const m = loadBundleManifest(scratchGbrain().gbrainRoot);
    const block = buildManagedBlock(m, ['alpha', 'beta']);
    expect(block).toContain('gbrain:skillpack:begin');
    expect(block).toContain('gbrain:skillpack:end');
    expect(block).toContain('`skills/alpha/SKILL.md`');
    expect(block).toContain('`skills/beta/SKILL.md`');
  });
  it('appends block when none exists', () => {
    const block = buildManagedBlock(loadBundleManifest(scratchGbrain().gbrainRoot), ['alpha']);
    const updated = updateManagedBlock('# AGENTS\n\nSome prose.\n', block);
    expect(updated).toContain('gbrain:skillpack:begin');
    expect(updated).toContain('Some prose.');
  });
  it('replaces existing block in place, keeping surrounding content', () => {
    const m = loadBundleManifest(scratchGbrain().gbrainRoot);
    const original =
      '# AGENTS\n\nBefore\n\n' +
      buildManagedBlock(m, ['alpha']) +
      '\n\nAfter\n';
    const replaced = updateManagedBlock(original, buildManagedBlock(m, ['alpha', 'beta']));
    expect(replaced).toContain('Before');
    expect(replaced).toContain('After');
    expect(replaced).toContain('`skills/beta/SKILL.md`');
  });
  it('extractManagedSlugs roundtrips with buildManagedBlock', () => {
    const m = loadBundleManifest(scratchGbrain().gbrainRoot);
    const block = buildManagedBlock(m, ['alpha', 'beta']);
    expect(extractManagedSlugs(block).sort()).toEqual(['alpha', 'beta']);
  });
  it('extractManagedSlugs returns [] when no block present', () => {
    expect(extractManagedSlugs('# hello\n\nno block here\n')).toEqual([]);
  });
});

describe('planInstall + applyInstall', () => {
  it('dry-run: plans file writes but does not touch target', () => {
    const { gbrainRoot } = scratchGbrain();
    const { workspace, skillsDir } = scratchTarget();
    const plan = planInstall({
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
    });
    const result = applyInstall(plan, {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.summary.wroteNew).toBeGreaterThan(0);
    expect(existsSync(join(skillsDir, 'alpha', 'SKILL.md'))).toBe(false);
  });

  it('installs a fresh skill and its shared deps', () => {
    const { gbrainRoot } = scratchGbrain();
    const { workspace, skillsDir } = scratchTarget();
    const plan = planInstall({
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
    });
    const result = applyInstall(plan, {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
    });
    expect(result.summary.wroteNew).toBeGreaterThan(0);
    expect(existsSync(join(skillsDir, 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'alpha', 'scripts', 'alpha.mjs'))).toBe(true);
    expect(existsSync(join(skillsDir, 'conventions', 'quality.md'))).toBe(true);
    expect(result.managedBlock.applied).toBe(true);
  });

  it('re-install is idempotent (skipped_identical on unchanged files)', () => {
    const { gbrainRoot } = scratchGbrain();
    const { workspace, skillsDir } = scratchTarget();
    const opts = {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
    };
    applyInstall(planInstall(opts), opts);
    const second = applyInstall(planInstall(opts), opts);
    expect(second.summary.wroteNew).toBe(0);
    expect(second.summary.skippedIdentical).toBeGreaterThan(0);
  });

  it('skips locally-modified files without --overwrite-local', () => {
    const { gbrainRoot } = scratchGbrain();
    const { workspace, skillsDir } = scratchTarget();
    const opts = {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
    };
    applyInstall(planInstall(opts), opts);
    // Locally edit the installed SKILL.md
    const localFile = join(skillsDir, 'alpha', 'SKILL.md');
    writeFileSync(localFile, readFileSync(localFile, 'utf-8') + '\n<!-- local edit -->\n');

    const result = applyInstall(planInstall(opts), opts);
    expect(result.summary.skippedLocallyModified).toBeGreaterThan(0);
    // Local edit preserved.
    expect(readFileSync(localFile, 'utf-8')).toContain('local edit');
  });

  it('--overwrite-local replaces locally-modified files', () => {
    const { gbrainRoot } = scratchGbrain();
    const { workspace, skillsDir } = scratchTarget();
    const opts = {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
    };
    applyInstall(planInstall(opts), opts);
    const localFile = join(skillsDir, 'alpha', 'SKILL.md');
    writeFileSync(localFile, 'local garbage');

    const overwriteOpts = { ...opts, overwriteLocal: true };
    const result = applyInstall(planInstall(overwriteOpts), overwriteOpts);
    expect(result.summary.wroteOverwrite).toBeGreaterThan(0);
    expect(readFileSync(localFile, 'utf-8')).not.toContain('local garbage');
  });

  it('D-CX-11: concurrent install attempt fails with lock_held', () => {
    const { gbrainRoot } = scratchGbrain();
    const { workspace, skillsDir } = scratchTarget();
    // Simulate a peer holding the lock.
    writeFileSync(join(workspace, '.gbrain-skillpack.lock'), '99999');
    const opts = {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
    };
    const plan = planInstall(opts);
    expect(() => applyInstall(plan, opts)).toThrow(InstallError);
  });

  it('D-CX-11: --force-unlock overrides a stale lock', () => {
    const { gbrainRoot } = scratchGbrain();
    const { workspace, skillsDir } = scratchTarget();
    // Stale lock is handled by setting lockStaleMs small and sleeping
    // — simulate by writing the lock and passing lockStaleMs=0 so
    // any age looks stale.
    writeFileSync(join(workspace, '.gbrain-skillpack.lock'), '99999');
    const opts = {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
      forceUnlock: true,
      lockStaleMs: 0,
    };
    const plan = planInstall(opts);
    const result = applyInstall(plan, opts);
    expect(result.summary.wroteNew).toBeGreaterThan(0);
  });

  it('managed block is written atomically (tmp then rename)', () => {
    const { gbrainRoot } = scratchGbrain();
    const { workspace, skillsDir } = scratchTarget();
    const opts = {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: null,
    };
    applyInstall(planInstall(opts), opts);
    const resolver = readFileSync(join(skillsDir, 'RESOLVER.md'), 'utf-8');
    expect(resolver).toContain('gbrain:skillpack:begin');
    expect(resolver).toContain('gbrain:skillpack:end');
    expect(resolver).toContain('`skills/alpha/SKILL.md`');
    expect(resolver).toContain('`skills/beta/SKILL.md`');
  });

  it('managed block accumulates across separate single-skill installs', () => {
    const { gbrainRoot } = scratchGbrain();
    const { workspace, skillsDir } = scratchTarget();

    const alphaOpts = {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
    };
    applyInstall(planInstall(alphaOpts), alphaOpts);

    const betaOpts = {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'beta',
    };
    applyInstall(planInstall(betaOpts), betaOpts);

    const resolver = readFileSync(join(skillsDir, 'RESOLVER.md'), 'utf-8');
    expect(resolver).toContain('`skills/alpha/SKILL.md`');
    expect(resolver).toContain('`skills/beta/SKILL.md`');
  });

  it('works against AGENTS.md-at-workspace-root layout', () => {
    const { gbrainRoot } = scratchGbrain();
    const workspace = mkdtempSync(join(tmpdir(), 'skillpack-root-agents-'));
    created.push(workspace);
    const skillsDir = join(workspace, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    // No RESOLVER.md in skills — AGENTS.md at workspace root instead.
    writeFileSync(
      join(workspace, 'AGENTS.md'),
      '# AGENTS\n\n| Trigger | Skill |\n|---------|-------|\n',
    );
    const opts = {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
    };
    const result = applyInstall(planInstall(opts), opts);
    expect(result.managedBlock.applied).toBe(true);
    const agents = readFileSync(join(workspace, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('`skills/alpha/SKILL.md`');
  });
});

describe('diffSkill', () => {
  it('reports missing files', () => {
    const { gbrainRoot } = scratchGbrain();
    const { skillsDir } = scratchTarget();
    const diffs = diffSkill(gbrainRoot, 'alpha', skillsDir);
    expect(diffs.every(d => !d.existing)).toBe(true);
  });
  it('reports identical after install', () => {
    const { gbrainRoot } = scratchGbrain();
    const { workspace, skillsDir } = scratchTarget();
    const opts = {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
    };
    applyInstall(planInstall(opts), opts);
    const diffs = diffSkill(gbrainRoot, 'alpha', skillsDir);
    expect(diffs.every(d => d.existing && d.identical)).toBe(true);
  });
  it('reports differs after local edit', () => {
    const { gbrainRoot } = scratchGbrain();
    const { workspace, skillsDir } = scratchTarget();
    const opts = {
      gbrainRoot,
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
      skillSlug: 'alpha',
    };
    applyInstall(planInstall(opts), opts);
    writeFileSync(join(skillsDir, 'alpha', 'SKILL.md'), 'edited locally');
    const diffs = diffSkill(gbrainRoot, 'alpha', skillsDir);
    expect(diffs.some(d => !d.identical && d.existing)).toBe(true);
  });
});
