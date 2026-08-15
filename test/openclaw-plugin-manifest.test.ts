import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { currentRecommendedSet } from '../src/core/advisor/recommended-set.ts';

describe('plugin membership curation (skills = plugin ∪ exclusions, disjoint)', () => {
  const root = join(import.meta.dir, '..');
  const plugin = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'skills', 'manifest.json'), 'utf8'));
  const exclusionsDoc = JSON.parse(readFileSync(join(root, 'skills', 'plugin-exclusions.json'), 'utf8'));

  const bundled: string[] = plugin.skills.map((s: string) => s.replace(/^skills\//, ''));
  const manifestNames: string[] = manifest.skills.map((s: { name: string }) => s.name);
  const excluded = Object.keys(exclusionsDoc.exclusions);

  it('every manifest skill is either bundled or a recorded exclusion', () => {
    const covered = new Set([...bundled, ...excluded]);
    const missing = manifestNames.filter((n) => !covered.has(n));
    expect(missing).toEqual([]);
  });

  it('no skill is both bundled and excluded', () => {
    const both = bundled.filter((n) => excluded.includes(n));
    expect(both).toEqual([]);
  });

  it('every bundled skill exists in the manifest', () => {
    const orphans = bundled.filter((n) => !manifestNames.includes(n));
    expect(orphans).toEqual([]);
  });

  it('every recorded exclusion still exists in the manifest (no stale exclusions)', () => {
    const stale = excluded.filter((n) => !manifestNames.includes(n));
    expect(stale).toEqual([]);
  });

  it('plugin skills array is sorted', () => {
    expect(plugin.skills).toEqual([...plugin.skills].sort());
  });

  it('every exclusion carries a non-empty reason', () => {
    for (const [name, reason] of Object.entries(exclusionsDoc.exclusions)) {
      expect(typeof reason, `exclusion ${name}`).toBe('string');
      expect((reason as string).length).toBeGreaterThan(10);
    }
  });

  it('every manifest skill description is real prose (not a captured block-scalar marker)', () => {
    for (const s of manifest.skills as { name: string; description: string }[]) {
      expect(typeof s.description, `skill ${s.name}`).toBe('string');
      expect(s.description.length, `skill ${s.name} description too short`).toBeGreaterThan(10);
      expect(s.description, `skill ${s.name} captured a YAML block-scalar marker`).not.toBe('|');
      expect(s.description, `skill ${s.name} captured a YAML block-scalar marker`).not.toBe('>');
    }
  });

  it('plugin skills has no duplicates', () => {
    expect(new Set(plugin.skills).size).toBe(plugin.skills.length);
  });

  it('every RECOMMENDED skill is bundled (recommended-but-unscaffoldable is a broken funnel)', () => {
    // The post-install advisory + verify hand-off tell users to install these
    // by slug; `gbrain skillpack scaffold <slug>` resolves against the plugin
    // bundle. A recommendation the scaffold can't fulfill is a dead-end CTA —
    // the exact drift that kept cold-start (the day-one "now what?" skill)
    // unreachable for paste-in bootstrap users until v0.45.11.0.
    const unscaffoldable = currentRecommendedSet()
      .map((s) => s.slug)
      .filter((slug) => !bundled.includes(slug));
    expect(unscaffoldable).toEqual([]);
  });
});

describe('bundled-skill reference closure (nothing bundled points at a non-bundled skill)', () => {
  // A bundled skill's SKILL.md ships downstream, where only bundled skills,
  // conventions/, and the shared top-level skills/_*.md files exist. A path
  // reference (backtick `skills/<x>/...` or relative link `](../<x>/...)`)
  // to a host-only skill dangles on every downstream install. Intentional
  // host-only mentions must be plain prose — the skill name with a
  // "(host-side)" qualifier — never a path reference.
  //
  // Entries are "<bundled-slug> -> <target>". Prefer zero: rephrase the
  // reference to prose instead of adding a line here.
  const HOST_ONLY_REFERENCE_ALLOWLIST: string[] = [];

  const root = join(import.meta.dir, '..');
  const plugin = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'skills', 'manifest.json'), 'utf8'));
  const bundled = new Set<string>(plugin.skills.map((s: string) => s.replace(/^skills\//, '')));
  const manifestNames = new Set<string>(manifest.skills.map((s: { name: string }) => s.name));

  // Documentation placeholders (`skills/X/`, `skills/<slug>/`, `skills/{name}/`)
  // are idiom, not references.
  const PLACEHOLDER_RE = /[<{$]|^X$|^\.\.\.$/;

  it('every skills/ path reference in a bundled SKILL.md resolves inside the bundle', () => {
    const offenders: string[] = [];
    for (const slug of [...bundled].sort()) {
      const text = readFileSync(join(root, 'skills', slug, 'SKILL.md'), 'utf8');

      const refs: { target: string; raw: string }[] = [];
      // backtick path refs: `skills/<x>/...`
      for (const m of text.matchAll(/`skills\/([^`\s]+)`/g)) {
        refs.push({ target: m[1].split('/')[0], raw: m[0] });
      }
      // relative markdown links to sibling skill dirs: ](../<x>/...)
      for (const m of text.matchAll(/\]\(\.\.\/([^)\s]+)\)/g)) {
        const first = m[1].split('/')[0];
        if (first === '..') continue; // escapes skills/ entirely — not skill closure
        refs.push({ target: first, raw: `](../${m[1]})` });
      }

      for (const { target, raw } of refs) {
        if (PLACEHOLDER_RE.test(target)) continue;
        if (target === 'conventions') continue; // ships via shared_deps
        if (target.startsWith('_')) continue; // shared top-level skills/_*.md, ships via shared_deps
        // Non-skill targets (RESOLVER.md, manifest.json, migrations/, brain-page
        // examples) are check-skill-refs.mjs's dangling-ref lane, not closure.
        if (!manifestNames.has(target)) continue;
        if (bundled.has(target)) continue;
        if (HOST_ONLY_REFERENCE_ALLOWLIST.includes(`${slug} -> ${target}`)) continue;
        offenders.push(
          `${slug}: ${raw} -> "${target}" is not bundled — bundle it or rephrase as a plain "(host-side)" prose mention`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('root OpenClaw plugin manifest', () => {
  it('declares the id required by OpenClaw plugin installs', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'openclaw.plugin.json'), 'utf8'));
    const entrySource = readFileSync(join(import.meta.dir, '..', 'src', 'openclaw-context-engine.ts'), 'utf8');
    const entryId = entrySource.match(/id:\s*'([^']+)'/)?.[1];

    expect(manifest.id).toBe(entryId);
    expect(manifest.configSchema).toBeDefined();
    expect(typeof manifest.configSchema).toBe('object');
    expect(manifest.contracts?.contextEngines).toContain('gbrain-context');
    expect(entrySource).toContain('export function register');
  });

  it('plugin.version tracks package.json version (bundle ships at the repo version)', () => {
    const root = join(import.meta.dir, '..');
    const manifest = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(manifest.version).toBe(pkg.version);
  });
});
