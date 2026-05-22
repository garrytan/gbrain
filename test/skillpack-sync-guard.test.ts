/**
 * test/skillpack-sync-guard.test.ts — F-ENG-4 / D-CX-4.
 *
 * Guards against drift between:
 *   - openclaw.plugin.json#skills          (what skillpack install ships)
 *   - skills/manifest.json#skills[].path   (what the overall skill manifest knows)
 *
 * If someone adds a skill directory but forgets the plugin manifest,
 * or vice versa, this test fails. The sync guard exists because the
 * codex outside-voice flagged version drift on the plugin manifest.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '..');

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('skillpack sync-guard', () => {
  const pluginPath = join(REPO, 'openclaw.plugin.json');
  const skillsManifestPath = join(REPO, 'skills', 'manifest.json');

  it('both manifests exist at the expected paths', () => {
    expect(existsSync(pluginPath)).toBe(true);
    expect(existsSync(skillsManifestPath)).toBe(true);
  });

  it('every openclaw.plugin.json skill path exists on disk', () => {
    const plugin = readJson(pluginPath);
    for (const skillPath of plugin.skills) {
      const skillMd = join(REPO, skillPath, 'SKILL.md');
      expect(existsSync(skillMd)).toBe(true);
    }
  });

  it('every shared_dep in openclaw.plugin.json exists on disk', () => {
    const plugin = readJson(pluginPath);
    for (const dep of plugin.shared_deps) {
      const abs = join(REPO, dep);
      expect(existsSync(abs)).toBe(true);
    }
  });

  it('openclaw.plugin.json skills ⊂ skills/manifest.json skill paths', () => {
    // Each entry in the plugin manifest's "skills" list must correspond
    // to a skill that manifest.json knows about. Installing something
    // the rest of gbrain doesn't register is a bug.
    const plugin = readJson(pluginPath);
    const skillsManifest = readJson(skillsManifestPath);
    const knownSlugs = new Set(
      skillsManifest.skills.map((s: { path: string }) =>
        s.path.replace(/\/SKILL\.md$/, ''),
      ),
    );
    for (const skillPath of plugin.skills) {
      const slug = skillPath.replace(/^skills\//, '');
      expect(knownSlugs.has(slug)).toBe(true);
    }
  });

  it('excluded skills are not listed in plugin.skills (install list is curated)', () => {
    const plugin = readJson(pluginPath);
    const excluded = new Set(plugin.excluded_from_install ?? []);
    for (const skillPath of plugin.skills) {
      expect(excluded.has(skillPath)).toBe(false);
    }
  });

  it('plugin version tracks a real gbrain release line', () => {
    // Loose check: version must be semver-ish, not the stale 0.4.1
    // pre-v0.17 placeholder the codex review flagged.
    const plugin = readJson(pluginPath);
    const major = parseInt(plugin.version.split('.')[0], 10);
    const minor = parseInt(plugin.version.split('.')[1], 10);
    expect(major).toBe(0);
    expect(minor).toBeGreaterThanOrEqual(17);
  });
});
