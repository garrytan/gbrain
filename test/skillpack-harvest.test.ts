/**
 * Tests for src/core/skillpack/harvest.ts — the host→gbrain lift.
 *
 * Pins:
 *   - happy path: skill files + paired sources land in gbrain's tree
 *   - openclaw.plugin.json updated (sorted, idempotent)
 *   - slug collision refused unless --overwrite-local
 *   - symlinks in host source rejected
 *   - canonical-path containment rejects traversal
 *   - privacy lint runs by default, rolls back on hit
 *   - --no-lint bypasses
 *   - dry-run reports plan, writes nothing
 *   - host SKILL.md missing → HarvestError(host_skill_missing)
 */

import { describe, expect, it, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { HarvestError, runHarvest, addToBundleManifest } from '../src/core/skillpack/harvest.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function scratchHost(opts: { withPairedSource?: boolean; contaminated?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-h-host-'));
  created.push(root);
  mkdirSync(join(root, 'src', 'commands'), { recursive: true });
  mkdirSync(join(root, 'skills', 'my-fork-skill'), { recursive: true });

  const fm = opts.withPairedSource
    ? '---\nname: my-fork-skill\ntriggers:\n  - trigger\nsources:\n  - src/commands/my-fork-skill.ts\n---\n'
    : '---\nname: my-fork-skill\ntriggers:\n  - trigger\n---\n';
  const body = opts.contaminated
    ? '# my-fork-skill\n\nThis was lifted from Wintermute.\n'
    : '# my-fork-skill\n\nGeneric placeholder content.\n';
  writeFileSync(join(root, 'skills', 'my-fork-skill', 'SKILL.md'), fm + body);

  if (opts.withPairedSource) {
    writeFileSync(
      join(root, 'src', 'commands', 'my-fork-skill.ts'),
      '// real impl\nexport function run() { return 1; }\n',
    );
  }
  return root;
}

function scratchGbrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-h-gbrain-'));
  created.push(root);
  mkdirSync(join(root, 'src', 'commands'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub');
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify(
      {
        name: 'gbrain',
        version: '0.33.0',
        skills: ['skills/existing-skill'],
        shared_deps: [],
      },
      null,
      2,
    ),
  );
  return root;
}

function emptyPatternsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-h-patterns-'));
  created.push(dir);
  const path = join(dir, 'patterns.txt');
  writeFileSync(path, '# only the user-supplied patterns. Defaults still apply.\n');
  return path;
}

describe('runHarvest — happy path', () => {
  it('copies a clean skill into gbrain, updates manifest', () => {
    const hostRoot = scratchHost();
    const gbrainRoot = scratchGbrain();

    const result = runHarvest({
      slug: 'my-fork-skill',
      hostRepoRoot: hostRoot,
      gbrainRoot,
    });

    expect(result.status).toBe('harvested');
    expect(existsSync(join(gbrainRoot, 'skills', 'my-fork-skill', 'SKILL.md'))).toBe(true);
    expect(result.manifestUpdated).toBe(true);

    const manifest = JSON.parse(readFileSync(join(gbrainRoot, 'openclaw.plugin.json'), 'utf-8'));
    expect(manifest.skills).toContain('skills/my-fork-skill');
    // sorted
    expect(manifest.skills).toEqual([...manifest.skills].sort());
  });

  it('copies paired source files declared in host frontmatter', () => {
    const hostRoot = scratchHost({ withPairedSource: true });
    const gbrainRoot = scratchGbrain();

    const result = runHarvest({
      slug: 'my-fork-skill',
      hostRepoRoot: hostRoot,
      gbrainRoot,
    });

    expect(result.pairedSources).toEqual(['src/commands/my-fork-skill.ts']);
    expect(existsSync(join(gbrainRoot, 'src', 'commands', 'my-fork-skill.ts'))).toBe(true);
  });
});

describe('runHarvest — paired source in a sibling folder that starts with the slug', () => {
  // A skill `foo` may pair a source under `skills/foo-extra/`. That folder is
  // NOT the skill folder, so the file must take the paired-source path
  // (copied to the same relative path) instead of the skill-folder path,
  // whose confinement to `skills/foo/` refuses it.
  function hostWithSiblingSource(): string {
    const root = mkdtempSync(join(tmpdir(), 'sp-h-sibling-'));
    created.push(root);
    mkdirSync(join(root, 'skills', 'foo'), { recursive: true });
    mkdirSync(join(root, 'skills', 'foo-extra'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'foo', 'SKILL.md'),
      '---\nname: foo\ntriggers:\n  - trigger\nsources:\n  - skills/foo-extra/x.ts\n---\n# foo\n\nGeneric placeholder content.\n',
    );
    writeFileSync(join(root, 'skills', 'foo-extra', 'x.ts'), 'export const x = 1;\n');
    return root;
  }

  it('harvests the skill and copies the sibling-folder source', () => {
    const hostRoot = hostWithSiblingSource();
    const gbrainRoot = scratchGbrain();

    const result = runHarvest({ slug: 'foo', hostRepoRoot: hostRoot, gbrainRoot });

    expect(result.status).toBe('harvested');
    expect(result.pairedSources).toEqual(['skills/foo-extra/x.ts']);
    expect(readFileSync(join(gbrainRoot, 'skills', 'foo', 'SKILL.md'), 'utf-8')).toContain('# foo');
    expect(readFileSync(join(gbrainRoot, 'skills', 'foo-extra', 'x.ts'), 'utf-8')).toBe(
      'export const x = 1;\n',
    );
  });

  it('dry-run accepts the sibling-folder source and writes nothing', () => {
    const hostRoot = hostWithSiblingSource();
    const gbrainRoot = scratchGbrain();

    const result = runHarvest({ slug: 'foo', hostRepoRoot: hostRoot, gbrainRoot, dryRun: true });

    expect(result.status).toBe('harvested');
    expect(existsSync(join(gbrainRoot, 'skills', 'foo'))).toBe(false);
    expect(existsSync(join(gbrainRoot, 'skills', 'foo-extra'))).toBe(false);
  });

  it('privacy-lint rollback also removes the sibling-folder source', () => {
    const hostRoot = hostWithSiblingSource();
    writeFileSync(join(hostRoot, 'skills', 'foo-extra', 'x.ts'), '// contact: alice@example.com\n');
    const gbrainRoot = scratchGbrain();

    const result = runHarvest({ slug: 'foo', hostRepoRoot: hostRoot, gbrainRoot });

    expect(result.status).toBe('lint_failed');
    expect(existsSync(join(gbrainRoot, 'skills', 'foo'))).toBe(false);
    expect(existsSync(join(gbrainRoot, 'skills', 'foo-extra', 'x.ts'))).toBe(false);
  });

  it('a symlink in the sibling folder is still refused', () => {
    const hostRoot = hostWithSiblingSource();
    const outside = mkdtempSync(join(tmpdir(), 'sp-h-outside-'));
    created.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'PRIVATE\n');
    rmSync(join(hostRoot, 'skills', 'foo-extra', 'x.ts'));
    symlinkSync(join(outside, 'secret.txt'), join(hostRoot, 'skills', 'foo-extra', 'x.ts'));
    const gbrainRoot = scratchGbrain();
    const manifestBefore = readFileSync(join(gbrainRoot, 'openclaw.plugin.json'), 'utf-8');

    try {
      runHarvest({ slug: 'foo', hostRepoRoot: hostRoot, gbrainRoot, noLint: true });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HarvestError);
      expect((err as HarvestError).code).toBe('symlink_rejected');
    }
    // Refused before any write: no half-copied skill dir blocks a retry
    // with slug_collision, and the manifest is untouched.
    expect(existsSync(join(gbrainRoot, 'skills', 'foo'))).toBe(false);
    expect(existsSync(join(gbrainRoot, 'skills', 'foo-extra', 'x.ts'))).toBe(false);
    expect(readFileSync(join(gbrainRoot, 'openclaw.plugin.json'), 'utf-8')).toBe(manifestBefore);
  });

  it('a sibling folder that links outside the host repo is refused', () => {
    // The file itself is ordinary; only its folder is a link. The paired
    // batch must still stay inside the host repo.
    const hostRoot = hostWithSiblingSource();
    const outside = mkdtempSync(join(tmpdir(), 'sp-h-outside-dir-'));
    created.push(outside);
    writeFileSync(join(outside, 'x.ts'), 'PRIVATE\n');
    rmSync(join(hostRoot, 'skills', 'foo-extra'), { recursive: true });
    symlinkSync(outside, join(hostRoot, 'skills', 'foo-extra'));
    const gbrainRoot = scratchGbrain();
    const manifestBefore = readFileSync(join(gbrainRoot, 'openclaw.plugin.json'), 'utf-8');

    try {
      runHarvest({ slug: 'foo', hostRepoRoot: hostRoot, gbrainRoot, noLint: true });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HarvestError);
      expect((err as HarvestError).code).toBe('path_traversal');
    }
    expect(existsSync(join(gbrainRoot, 'skills', 'foo'))).toBe(false);
    expect(existsSync(join(gbrainRoot, 'skills', 'foo-extra', 'x.ts'))).toBe(false);
    expect(readFileSync(join(gbrainRoot, 'openclaw.plugin.json'), 'utf-8')).toBe(manifestBefore);
  });
});

describe('runHarvest — error paths', () => {
  it('host_skill_missing when --from points at the wrong place', () => {
    const hostRoot = scratchHost();
    const gbrainRoot = scratchGbrain();

    try {
      runHarvest({ slug: 'nonexistent', hostRepoRoot: hostRoot, gbrainRoot });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HarvestError);
      expect((err as HarvestError).code).toBe('host_skill_missing');
    }
  });

  it('slug_collision when gbrain already has skills/<slug>/ — without --overwrite-local', () => {
    const hostRoot = scratchHost();
    const gbrainRoot = scratchGbrain();
    mkdirSync(join(gbrainRoot, 'skills', 'my-fork-skill'), { recursive: true });
    writeFileSync(join(gbrainRoot, 'skills', 'my-fork-skill', 'SKILL.md'), '# already here\n');

    try {
      runHarvest({
        slug: 'my-fork-skill',
        hostRepoRoot: hostRoot,
        gbrainRoot,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HarvestError);
      expect((err as HarvestError).code).toBe('slug_collision');
    }
  });

  it('symlinks in host skill dir are rejected (D13 security gate)', () => {
    const hostRoot = scratchHost();
    const gbrainRoot = scratchGbrain();

    // Plant a symlink inside the skill dir pointing outside.
    const outside = mkdtempSync(join(tmpdir(), 'sp-h-outside-'));
    created.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'PRIVATE\n');
    symlinkSync(
      join(outside, 'secret.txt'),
      join(hostRoot, 'skills', 'my-fork-skill', 'leaked.txt'),
    );

    try {
      runHarvest({
        slug: 'my-fork-skill',
        hostRepoRoot: hostRoot,
        gbrainRoot,
        noLint: true,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HarvestError);
      expect(['symlink_rejected', 'path_traversal']).toContain((err as HarvestError).code);
    }
    // Nothing landed.
    expect(existsSync(join(gbrainRoot, 'skills', 'my-fork-skill'))).toBe(false);
  });
});

describe('runHarvest — privacy linter integration (T7)', () => {
  it('default Wintermute pattern triggers rollback (no manifest update)', () => {
    const hostRoot = scratchHost({ contaminated: true });
    const gbrainRoot = scratchGbrain();

    const result = runHarvest({
      slug: 'my-fork-skill',
      hostRepoRoot: hostRoot,
      gbrainRoot,
    });

    expect(result.status).toBe('lint_failed');
    expect(result.lintHits.length).toBeGreaterThan(0);
    expect(result.lintHits[0]).toContain('Wintermute');

    // Rollback: nothing in gbrain tree.
    expect(existsSync(join(gbrainRoot, 'skills', 'my-fork-skill'))).toBe(false);
    // Manifest NOT updated.
    const manifest = JSON.parse(readFileSync(join(gbrainRoot, 'openclaw.plugin.json'), 'utf-8'));
    expect(manifest.skills).not.toContain('skills/my-fork-skill');
  });

  it('--no-lint bypasses the linter (editorial workflow opt-out)', () => {
    const hostRoot = scratchHost({ contaminated: true });
    const gbrainRoot = scratchGbrain();

    const result = runHarvest({
      slug: 'my-fork-skill',
      hostRepoRoot: hostRoot,
      gbrainRoot,
      noLint: true,
    });

    expect(result.status).toBe('harvested');
    expect(existsSync(join(gbrainRoot, 'skills', 'my-fork-skill', 'SKILL.md'))).toBe(true);
  });
});

describe('runHarvest — dry-run', () => {
  it('reports plan, writes nothing', () => {
    const hostRoot = scratchHost();
    const gbrainRoot = scratchGbrain();

    const result = runHarvest({
      slug: 'my-fork-skill',
      hostRepoRoot: hostRoot,
      gbrainRoot,
      dryRun: true,
    });

    expect(result.status).toBe('harvested');
    expect(result.dryRun).toBe(true);
    expect(result.manifestUpdated).toBe(false);
    expect(existsSync(join(gbrainRoot, 'skills', 'my-fork-skill'))).toBe(false);
  });
});

describe('addToBundleManifest', () => {
  it('adds a new slug, sorts skills array, idempotent', () => {
    const gbrainRoot = scratchGbrain();

    expect(addToBundleManifest(gbrainRoot, 'new-skill')).toBe(true);
    expect(addToBundleManifest(gbrainRoot, 'new-skill')).toBe(false); // idempotent

    const manifest = JSON.parse(readFileSync(join(gbrainRoot, 'openclaw.plugin.json'), 'utf-8'));
    expect(manifest.skills).toContain('skills/new-skill');
    expect(manifest.skills).toEqual([...manifest.skills].sort());
  });
});
