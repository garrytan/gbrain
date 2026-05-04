import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  composeResolvers,
  composeManifests,
  renderResolverMarkdown,
  renderManifestJson,
  writeMountsCache,
  clearMountsCache,
  __testing,
} from '../src/core/mounts-cache.ts';
import { HOST_BRAIN_ID, type MountEntry } from '../src/core/brain-registry.ts';

const toCleanup: string[] = [];
function mktmp(prefix = 'mounts-cache-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  toCleanup.push(dir);
  return dir;
}
afterEach(() => {
  while (toCleanup.length > 0) {
    const p = toCleanup.pop();
    if (!p) continue;
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Build a tmp skills dir with a minimal RESOLVER.md + manifest.json + SKILL.md stubs. */
function makeSkillsDir(skills: Array<{ name: string; trigger: string; section?: string }>): string {
  const dir = mktmp();
  mkdirSync(join(dir, 'skills'), { recursive: true });
  for (const s of skills) {
    mkdirSync(join(dir, 'skills', s.name), { recursive: true });
    writeFileSync(join(dir, 'skills', s.name, 'SKILL.md'), `---\nname: ${s.name}\n---\n# ${s.name}\n`);
  }
  const resolverLines = ['# RESOLVER', ''];
  const bySection = new Map<string, Array<{ name: string; trigger: string }>>();
  for (const s of skills) {
    const sec = s.section || 'Brain operations';
    const bucket = bySection.get(sec) ?? [];
    bucket.push(s);
    bySection.set(sec, bucket);
  }
  for (const [sec, bucket] of bySection.entries()) {
    resolverLines.push(`## ${sec}`, '', '| Trigger | Skill |', '|---------|-------|');
    for (const s of bucket) {
      resolverLines.push(`| ${s.trigger} | \`skills/${s.name}/SKILL.md\` |`);
    }
    resolverLines.push('');
  }
  writeFileSync(join(dir, 'skills', 'RESOLVER.md'), resolverLines.join('\n'));
  writeFileSync(
    join(dir, 'skills', 'manifest.json'),
    JSON.stringify({ skills: skills.map(s => ({ name: s.name, path: `${s.name}/SKILL.md` })) }, null, 2),
  );
  return join(dir, 'skills');
}

function makeMount(id: string, skillsDir: string, enabled = true): MountEntry {
  // skillsDir is the SKILLS dir; mount.path is the parent (repo root).
  const repoRoot = join(skillsDir, '..');
  return {
    id,
    path: repoRoot,
    engine: 'pglite',
    database_path: join(repoRoot, '.pg'),
    enabled,
  };
}

describe('composeResolvers — host only', () => {
  test('empty world: empty output', () => {
    const hostDir = mktmp();
    const result = composeResolvers(hostDir, []);
    expect(result.entries).toEqual([]);
    expect(result.shadows).toEqual([]);
    expect(result.ambiguities).toEqual([]);
  });

  test('host skills only: no namespace prefix, brainId=host', () => {
    const hostSkills = makeSkillsDir([
      { name: 'query', trigger: 'search' },
      { name: 'enrich', trigger: 'enrich a page' },
    ]);
    const result = composeResolvers(hostSkills, []);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.every(e => e.brainId === HOST_BRAIN_ID)).toBe(true);
    expect(result.entries.map(e => e.qualifiedName).sort()).toEqual(['enrich', 'query']);
  });
});

describe('composeResolvers — mount skills', () => {
  test('single mount: namespace prefix applied', () => {
    const hostSkills = makeSkillsDir([]);
    const mountSkills = makeSkillsDir([{ name: 'ingest', trigger: 'yc-media ingest' }]);
    const mount = makeMount('yc-media', mountSkills);
    const result = composeResolvers(hostSkills, [mount]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].qualifiedName).toBe('yc-media::ingest');
    expect(result.entries[0].brainId).toBe('yc-media');
    expect(result.entries[0].absolutePath).toContain('/skills/ingest/SKILL.md');
  });

  test('disabled mount is excluded', () => {
    const hostSkills = makeSkillsDir([]);
    const mountSkills = makeSkillsDir([{ name: 'ingest', trigger: 'x' }]);
    const mount = makeMount('disabled', mountSkills, false);
    const result = composeResolvers(hostSkills, [mount]);
    expect(result.entries).toEqual([]);
  });

  test('two mounts same skill → ambiguity (host does not define it)', () => {
    const hostSkills = makeSkillsDir([]);
    const m1Skills = makeSkillsDir([{ name: 'ingest', trigger: 'm1 ingest' }]);
    const m2Skills = makeSkillsDir([{ name: 'ingest', trigger: 'm2 ingest' }]);
    const m1 = makeMount('alpha', m1Skills);
    const m2 = makeMount('beta', m2Skills);
    const result = composeResolvers(hostSkills, [m1, m2]);
    expect(result.ambiguities).toHaveLength(1);
    expect(result.ambiguities[0].skillName).toBe('ingest');
    expect(result.ambiguities[0].mountIds).toEqual(['alpha', 'beta']);
    // Both entries still surface (via namespace form).
    const names = result.entries.map(e => e.qualifiedName).sort();
    expect(names).toEqual(['alpha::ingest', 'beta::ingest']);
  });

  test('host + mount same name → host wins BARE name, mount reachable via namespace', () => {
    const hostSkills = makeSkillsDir([{ name: 'ingest', trigger: 'host ingest' }]);
    const mountSkills = makeSkillsDir([{ name: 'ingest', trigger: 'mount ingest' }]);
    const mount = makeMount('yc-media', mountSkills);
    const result = composeResolvers(hostSkills, [mount]);
    // Both entries survive: host wins bare 'ingest', but 'yc-media::ingest'
    // must remain routable (the whole point of namespace-qualified form).
    expect(result.entries).toHaveLength(2);
    const host = result.entries.find(e => e.brainId === HOST_BRAIN_ID);
    const mnt = result.entries.find(e => e.brainId === 'yc-media');
    expect(host?.qualifiedName).toBe('ingest');
    expect(mnt?.qualifiedName).toBe('yc-media::ingest');
    // Shadow recorded so doctor can warn about local-customizing a remote skill
    expect(result.shadows).toHaveLength(1);
    expect(result.shadows[0].skillName).toBe('ingest');
    expect(result.shadows[0].shadowedMounts).toHaveLength(1);
    expect(result.shadows[0].shadowedMounts[0].mountId).toBe('yc-media');
    // Not flagged as ambiguity — host wins the bare name cleanly
    expect(result.ambiguities).toEqual([]);
  });

  test('host shadows two mounts → all three entries survive, shadow tracks both mounts', () => {
    const hostSkills = makeSkillsDir([{ name: 'ingest', trigger: 'host' }]);
    const m1Skills = makeSkillsDir([{ name: 'ingest', trigger: 'm1' }]);
    const m2Skills = makeSkillsDir([{ name: 'ingest', trigger: 'm2' }]);
    const result = composeResolvers(hostSkills, [makeMount('a', m1Skills), makeMount('b', m2Skills)]);
    // Host entry + both namespaced mount entries
    expect(result.entries).toHaveLength(3);
    expect(result.entries.map(e => e.qualifiedName).sort()).toEqual(['a::ingest', 'b::ingest', 'ingest']);
    // No ambiguity: host wins bare name
    expect(result.ambiguities).toEqual([]);
    expect(result.shadows).toHaveLength(1);
    expect(result.shadows[0].shadowedMounts.map(m => m.mountId).sort()).toEqual(['a', 'b']);
  });

  test('mount without RESOLVER.md contributes no entries (not an error)', () => {
    const hostSkills = makeSkillsDir([]);
    // Create a mount path with no skills/RESOLVER.md inside
    const emptyRoot = mktmp();
    const mount: MountEntry = {
      id: 'empty', path: emptyRoot, engine: 'pglite', database_path: `${emptyRoot}/.pg`, enabled: true,
    };
    const result = composeResolvers(hostSkills, [mount]);
    expect(result.entries).toEqual([]);
  });
});

describe('composeManifests', () => {
  test('host only: entries preserved without namespace', () => {
    const hostSkills = makeSkillsDir([{ name: 'query', trigger: 'x' }]);
    const result = composeManifests(hostSkills, []);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('query');
    expect(result.entries[0].brainId).toBe(HOST_BRAIN_ID);
  });

  test('mount entries get namespace prefix (Codex finding #8)', () => {
    const hostSkills = makeSkillsDir([]);
    const mountSkills = makeSkillsDir([{ name: 'ingest', trigger: 'x' }]);
    const result = composeManifests(hostSkills, [makeMount('yc-media', mountSkills)]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('yc-media::ingest');
    expect(result.entries[0].brainId).toBe('yc-media');
  });

  test('manifest keeps namespace-qualified mount entry even when host shadows', () => {
    // Bare-name resolution is composeResolvers' job. The manifest lists every
    // addressable skill by its canonical name, so the namespace-qualified
    // form must survive regardless of host shadow. This matches the
    // corresponding composeResolvers shadow test.
    const hostSkills = makeSkillsDir([{ name: 'ingest', trigger: 'host' }]);
    const mountSkills = makeSkillsDir([{ name: 'ingest', trigger: 'mount' }]);
    const result = composeManifests(hostSkills, [makeMount('yc-media', mountSkills)]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(e => e.name).sort()).toEqual(['ingest', 'yc-media::ingest']);
    const host = result.entries.find(e => e.name === 'ingest');
    const mnt = result.entries.find(e => e.name === 'yc-media::ingest');
    expect(host?.brainId).toBe(HOST_BRAIN_ID);
    expect(mnt?.brainId).toBe('yc-media');
  });

  test('disabled mount excluded', () => {
    const hostSkills = makeSkillsDir([]);
    const mountSkills = makeSkillsDir([{ name: 'ingest', trigger: 'x' }]);
    const result = composeManifests(hostSkills, [makeMount('off', mountSkills, false)]);
    expect(result.entries).toEqual([]);
  });

  test('missing manifest.json in mount → mount contributes nothing (no crash)', () => {
    const hostSkills = makeSkillsDir([]);
    const emptyRoot = mktmp();
    mkdirSync(join(emptyRoot, 'skills'), { recursive: true });
    // No manifest.json written
    const mount: MountEntry = {
      id: 'bare', path: emptyRoot, engine: 'pglite', database_path: `${emptyRoot}/.pg`, enabled: true,
    };
    expect(() => composeManifests(hostSkills, [mount])).not.toThrow();
  });
});

describe('renderResolverMarkdown', () => {
  test('produces stable markdown with brain column', () => {
    const hostSkills = makeSkillsDir([{ name: 'query', trigger: 'search' }]);
    const mountSkills = makeSkillsDir([{ name: 'ingest', trigger: 'media ingest' }]);
    const composed = composeResolvers(hostSkills, [makeMount('yc-media', mountSkills)]);
    const md = renderResolverMarkdown(composed);
    expect(md).toContain('# GBrain Skill Resolver (aggregated)');
    expect(md).toContain('Auto-generated');
    expect(md).toContain('| Trigger | Skill | Brain |');
    expect(md).toContain('| search');
    expect(md).toContain('| host |');
    expect(md).toContain('| media ingest');
    expect(md).toContain('| yc-media |');
  });

  test('shadows section appears only when shadows exist', () => {
    const hostSkills = makeSkillsDir([{ name: 'ingest', trigger: 'x' }]);
    const mountSkills = makeSkillsDir([{ name: 'ingest', trigger: 'y' }]);
    const composed = composeResolvers(hostSkills, [makeMount('m', mountSkills)]);
    const md = renderResolverMarkdown(composed);
    expect(md).toContain('## Shadows');
    expect(md).toContain('`ingest` (host) shadows');
  });

  test('ambiguities section appears only when ambiguities exist', () => {
    const hostSkills = makeSkillsDir([]);
    const m1 = makeSkillsDir([{ name: 'ingest', trigger: 'x' }]);
    const m2 = makeSkillsDir([{ name: 'ingest', trigger: 'y' }]);
    const composed = composeResolvers(hostSkills, [makeMount('a', m1), makeMount('b', m2)]);
    const md = renderResolverMarkdown(composed);
    expect(md).toContain('## Ambiguous bare names');
    expect(md).toContain('`ingest`');
  });
});

describe('renderManifestJson', () => {
  test('produces parseable JSON with expected shape', () => {
    const hostSkills = makeSkillsDir([{ name: 'query', trigger: 'x' }]);
    const composed = composeManifests(hostSkills, []);
    const json = renderManifestJson(composed);
    const parsed = JSON.parse(json);
    expect(parsed.generated_by).toBe('gbrain mounts');
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].name).toBe('query');
    expect(parsed.skills[0].brain).toBe(HOST_BRAIN_ID);
  });
});

describe('writeMountsCache + clearMountsCache', () => {
  test('writes both RESOLVER.md and manifest.json atomically', () => {
    const hostSkills = makeSkillsDir([{ name: 'query', trigger: 'x' }]);
    const cacheDir = mktmp();
    const { resolverPath, manifestPath } = writeMountsCache(hostSkills, [], { cacheDir });
    expect(existsSync(resolverPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
    const md = readFileSync(resolverPath, 'utf-8');
    expect(md).toContain('# GBrain Skill Resolver (aggregated)');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.skills).toHaveLength(1);
  });

  test('rewriting overwrites cleanly', () => {
    const hostSkills1 = makeSkillsDir([{ name: 'query', trigger: 'x' }]);
    const cacheDir = mktmp();
    writeMountsCache(hostSkills1, [], { cacheDir });
    const hostSkills2 = makeSkillsDir([{ name: 'ingest', trigger: 'y' }]);
    writeMountsCache(hostSkills2, [], { cacheDir });
    const manifest = JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf-8'));
    expect(manifest.skills.map((s: { name: string }) => s.name)).toEqual(['ingest']);
  });

  test('clearMountsCache removes the directory', () => {
    const hostSkills = makeSkillsDir([{ name: 'query', trigger: 'x' }]);
    const cacheDir = mktmp();
    writeMountsCache(hostSkills, [], { cacheDir });
    expect(existsSync(cacheDir)).toBe(true);
    clearMountsCache({ cacheDir });
    expect(existsSync(cacheDir)).toBe(false);
  });

  test('clearMountsCache on missing dir is a no-op', () => {
    const fake = join(tmpdir(), `does-not-exist-${Date.now()}`);
    expect(() => clearMountsCache({ cacheDir: fake })).not.toThrow();
  });
});

describe('skillNameFromRelPath', () => {
  test('extracts name from skills/ prefix', () => {
    expect(__testing.skillNameFromRelPath('skills/query/SKILL.md')).toBe('query');
    expect(__testing.skillNameFromRelPath('skills/yc-media/SKILL.md')).toBe('yc-media');
  });
  test('handles name without skills/ prefix', () => {
    expect(__testing.skillNameFromRelPath('query/SKILL.md')).toBe('query');
  });
});
