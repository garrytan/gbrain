/**
 * Mounts-cache composition + publishing (v0.19.0, PR 0).
 *
 * The runtime ownership seam (Codex finding #3 from plan-eng-review):
 * `check-resolvable.ts` VALIDATES RESOLVER.md; it does not DISPATCH skills.
 * Host agents (your OpenClaw / any Claude Code install) read
 * `skills/RESOLVER.md` directly to route a user request to a skill.
 *
 * For mounted team brains to participate in routing without editing the
 * host's checked-in `skills/RESOLVER.md`, gbrain publishes an aggregated
 * `~/.gbrain/mounts-cache/RESOLVER.md` + `manifest.json` whenever mounts
 * change. Host agents are taught (via AGENTS.md / CLAUDE.md install-path
 * docs) to prefer the aggregated file when it exists.
 *
 * This file exposes:
 *   - composeResolvers(...)  — pure: merge host + mount RESOLVER entries
 *   - composeManifests(...)  — pure: merge host + mount manifest.json entries
 *   - writeMountsCache(...)  — writes both aggregated files to disk
 *   - clearMountsCache(...)  — removes the cache (used on `mounts remove`
 *                              and test teardown)
 *
 * Compose functions are PURE: they take inputs, return structured output,
 * no filesystem writes. Tests can exercise every branch without a tempdir.
 * Only writeMountsCache touches disk.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseResolverEntries } from './check-resolvable.ts';
import { HOST_BRAIN_ID, type MountEntry } from './brain-registry.ts';

/** Default location of the aggregated cache directory. */
function getMountsCacheDir(): string {
  return join(homedir(), '.gbrain', 'mounts-cache');
}

/** A composed resolver entry with full provenance for audit + dispatch. */
export interface ComposedResolverEntry {
  /** The user-facing trigger phrase from the RESOLVER.md table. */
  trigger: string;
  /**
   * Namespace-qualified skill name. Format:
   *   - 'query' for host skills (no prefix)
   *   - 'yc-media::query' for mount skills
   * Stable across mount-path changes — only depends on mount id.
   */
  qualifiedName: string;
  /**
   * Absolute filesystem path to the SKILL.md. Host agents read this
   * directly. For host skills, resolved against the host skills dir;
   * for mount skills, resolved against the mount's clone path.
   */
  absolutePath: string;
  /** Mount id ('host' for host skills, else the mount id). */
  brainId: string;
  /** Section header from RESOLVER.md ('Brain operations', etc.) */
  section: string;
  /**
   * True when this entry represents an external pointer (e.g.
   * 'GStack: /review', 'Check CLAUDE.md'). Not a filesystem path.
   */
  isExternal: boolean;
}

/** Information about a skill shadowed by a host skill of the same name. */
export interface ShadowInfo {
  skillName: string;
  hostEntry: ComposedResolverEntry;
  shadowedMounts: Array<{ mountId: string; absolutePath: string }>;
}

/** Information about a bare name that resolves to two or more mounts. */
export interface AmbiguityInfo {
  /** The short skill name (filename without .SKILL.md) users would type. */
  skillName: string;
  /** The mount ids that ALL claim this name (host excluded — host wins). */
  mountIds: string[];
}

/** Output of composeResolvers — pure, no side effects. */
export interface ComposedResolver {
  entries: ComposedResolverEntry[];
  shadows: ShadowInfo[];
  ambiguities: AmbiguityInfo[];
}

/** A single skill declaration in a manifest.json. */
export interface ManifestEntry {
  /** Namespace-qualified name. 'query' or 'yc-media::query'. */
  name: string;
  /** Absolute filesystem path to the SKILL.md. */
  absolutePath: string;
  /** Mount id ('host' for host skills). */
  brainId: string;
}

/** Output of composeManifests. */
export interface ComposedManifest {
  entries: ManifestEntry[];
}

/** Default skills-subdir within a mount's clone. */
const DEFAULT_SKILLS_SUBDIR = 'skills';

/** Extract the filename-part of a skills-relative path (e.g. 'query/SKILL.md' → 'query'). */
function skillNameFromRelPath(relPath: string): string {
  // 'skills/query/SKILL.md' → 'query'; 'query/SKILL.md' → 'query'
  const parts = relPath.split('/');
  const skillIdx = parts.indexOf('skills');
  const start = skillIdx >= 0 ? skillIdx + 1 : 0;
  if (start >= parts.length) return '';
  return parts[start];
}

/**
 * Compose host + mount RESOLVER.md entries into a single aggregated list
 * with shadow + ambiguity detection.
 *
 * Host skills always win over any mount skill of the same name (locked
 * decision 1 from plan). When two mounts ship the same skill name and the
 * host does NOT define it, both entries are emitted with namespace prefixes
 * and the name is reported in `ambiguities` so doctor can warn.
 */
export function composeResolvers(
  hostSkillsDir: string,
  mounts: MountEntry[],
  opts: { readFile?: (path: string) => string | null } = {},
): ComposedResolver {
  const readFile = opts.readFile ?? ((p: string) => {
    try { return existsSync(p) ? readFileSync(p, 'utf-8') : null; } catch { return null; }
  });

  const hostResolverPath = join(hostSkillsDir, 'RESOLVER.md');
  const hostContent = readFile(hostResolverPath);
  const hostRawEntries = hostContent ? parseResolverEntries(hostContent) : [];

  // Host entries: fully qualified against the host skills dir.
  const hostEntries: ComposedResolverEntry[] = hostRawEntries.map(e => {
    const isExternal = e.isGStack;
    const abs = isExternal
      ? e.skillPath
      : join(hostSkillsDir, e.skillPath.replace(/^skills\//, ''));
    const name = isExternal ? e.skillPath : skillNameFromRelPath(e.skillPath);
    return {
      trigger: e.trigger,
      qualifiedName: name,
      absolutePath: abs,
      brainId: HOST_BRAIN_ID,
      section: e.section,
      isExternal,
    };
  });

  // Build fast lookup of host skill names (the shadow set).
  const hostSkillNames = new Set<string>();
  for (const e of hostEntries) {
    if (!e.isExternal) hostSkillNames.add(e.qualifiedName);
  }

  // Track which mount a skill-name came from so we can detect ambiguity.
  const byNameMountIds = new Map<string, Set<string>>(); // short name → {mount ids}
  const mountEntriesByMount: Array<{ mount: MountEntry; entries: ComposedResolverEntry[] }> = [];
  const shadowedByName = new Map<string, Array<{ mountId: string; absolutePath: string }>>();

  for (const mount of mounts) {
    if (mount.enabled === false) continue;
    const mountSkillsDir = join(mount.path, DEFAULT_SKILLS_SUBDIR);
    const resolverPath = join(mountSkillsDir, 'RESOLVER.md');
    const content = readFile(resolverPath);
    if (!content) continue; // Mount without a RESOLVER.md contributes no routing entries. Not an error.
    const rawEntries = parseResolverEntries(content);
    const composed: ComposedResolverEntry[] = rawEntries.map(e => {
      const isExternal = e.isGStack;
      const shortName = isExternal ? e.skillPath : skillNameFromRelPath(e.skillPath);
      const qualifiedName = isExternal ? shortName : `${mount.id}::${shortName}`;
      const abs = isExternal
        ? e.skillPath
        : join(mountSkillsDir, e.skillPath.replace(/^skills\//, ''));
      return {
        trigger: e.trigger,
        qualifiedName,
        absolutePath: abs,
        brainId: mount.id,
        section: e.section,
        isExternal,
      };
    });
    mountEntriesByMount.push({ mount, entries: composed });

    for (const entry of composed) {
      if (entry.isExternal) continue;
      const shortName = entry.qualifiedName.split('::').pop() ?? '';
      if (!shortName) continue;
      if (hostSkillNames.has(shortName)) {
        // Shadow: host wins. Record so doctor can emit a warning.
        const list = shadowedByName.get(shortName) ?? [];
        list.push({ mountId: mount.id, absolutePath: entry.absolutePath });
        shadowedByName.set(shortName, list);
        continue;
      }
      const set = byNameMountIds.get(shortName) ?? new Set();
      set.add(mount.id);
      byNameMountIds.set(shortName, set);
    }
  }

  // Ambiguities: any bare name with 2+ mounts (host excluded).
  const ambiguities: AmbiguityInfo[] = [];
  for (const [name, ids] of byNameMountIds.entries()) {
    if (ids.size >= 2) {
      ambiguities.push({ skillName: name, mountIds: Array.from(ids).sort() });
    }
  }
  ambiguities.sort((a, b) => a.skillName.localeCompare(b.skillName));

  // Shadows: group by host entry.
  const shadows: ShadowInfo[] = [];
  for (const [name, shadowedMounts] of shadowedByName.entries()) {
    const hostEntry = hostEntries.find(h => h.qualifiedName === name && !h.isExternal);
    if (!hostEntry) continue;
    shadows.push({
      skillName: name,
      hostEntry,
      shadowedMounts: shadowedMounts.sort((a, b) => a.mountId.localeCompare(b.mountId)),
    });
  }
  shadows.sort((a, b) => a.skillName.localeCompare(b.skillName));

  // Final entry list: host first, then all mount entries in mount-id order.
  // Shadow detection applies to BARE-NAME routing only (the host entry wins
  // when the agent types `ingest`), NOT to namespace-qualified routing
  // (`yc-media::ingest` must always resolve to the mount, even when shadowed
  // by a host skill of the same short name). Codex review 2026-04-23 caught
  // the earlier version that dropped shadowed mount entries — that broke
  // the entire namespace-disambiguation model.
  const mountEntries: ComposedResolverEntry[] = [];
  mountEntriesByMount.sort((a, b) => a.mount.id.localeCompare(b.mount.id));
  for (const { entries } of mountEntriesByMount) {
    for (const e of entries) mountEntries.push(e);
  }

  return {
    entries: [...hostEntries, ...mountEntries],
    shadows,
    ambiguities,
  };
}

/**
 * Read a manifest.json and return its skills[] array. Returns [] when the
 * file is absent or malformed (propagating the same forgiving semantics as
 * check-resolvable's loadManifest).
 */
function readManifestSkills(skillsDir: string, readFile?: (p: string) => string | null): Array<{ name: string; path: string }> {
  const path = join(skillsDir, 'manifest.json');
  const reader = readFile ?? ((p: string) => {
    try { return existsSync(p) ? readFileSync(p, 'utf-8') : null; } catch { return null; }
  });
  const content = reader(path);
  if (!content) return [];
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.skills) ? parsed.skills : [];
  } catch {
    return [];
  }
}

/**
 * Compose host + mount manifest.json entries. Host wins on name
 * collisions (shadow). Mount entries get namespace-prefixed names.
 * Codex finding #8: without this, remote skills break doctor conformance.
 */
export function composeManifests(
  hostSkillsDir: string,
  mounts: MountEntry[],
  opts: { readFile?: (path: string) => string | null } = {},
): ComposedManifest {
  const hostSkills = readManifestSkills(hostSkillsDir, opts.readFile);
  const hostEntries: ManifestEntry[] = hostSkills.map(s => ({
    name: s.name,
    absolutePath: join(hostSkillsDir, s.path),
    brainId: HOST_BRAIN_ID,
  }));
  const hostNames = new Set(hostEntries.map(e => e.name));

  // Mount entries always get their namespace-qualified name regardless of
  // shadow by a host skill. The namespace form `yc-media::ingest` must stay
  // routable even when host defines `ingest` (bare-name host-wins only
  // governs un-namespaced resolution). Codex review caught the earlier
  // version that silently dropped shadowed mount entries from the manifest,
  // making the aggregated cache inconsistent with composeResolvers' output.
  const mountEntries: ManifestEntry[] = [];
  const seenMounts = [...mounts].sort((a, b) => a.id.localeCompare(b.id));
  for (const mount of seenMounts) {
    if (mount.enabled === false) continue;
    const mountSkillsDir = join(mount.path, DEFAULT_SKILLS_SUBDIR);
    const skills = readManifestSkills(mountSkillsDir, opts.readFile);
    for (const s of skills) {
      mountEntries.push({
        name: `${mount.id}::${s.name}`,
        absolutePath: join(mountSkillsDir, s.path),
        brainId: mount.id,
      });
    }
  }
  void hostNames; // retained for future shadow metadata (PR 1 doctor warning)

  return { entries: [...hostEntries, ...mountEntries] };
}

/**
 * Render the composed resolver as markdown matching the existing
 * skills/RESOLVER.md format. The table groups by section (preserving
 * host section headings) with mount entries appended under a new
 * "Mounted brains" section.
 */
export function renderResolverMarkdown(composed: ComposedResolver): string {
  const lines: string[] = [];
  lines.push('# GBrain Skill Resolver (aggregated)');
  lines.push('');
  lines.push('Auto-generated by `gbrain mounts add|remove|sync`. Do not edit by hand.');
  lines.push('Host agents (your OpenClaw / Claude Code install) should prefer this file over');
  lines.push('the repo-checked-in `skills/RESOLVER.md` when it exists.');
  lines.push('');
  lines.push('See `docs/architecture/brains-and-sources.md` for the mental model.');
  lines.push('');

  // Group entries by section in insertion order.
  const bySection = new Map<string, ComposedResolverEntry[]>();
  for (const e of composed.entries) {
    const key = e.section || '(uncategorized)';
    const bucket = bySection.get(key) ?? [];
    bucket.push(e);
    bySection.set(key, bucket);
  }

  for (const [section, entries] of bySection.entries()) {
    lines.push(`## ${section}`);
    lines.push('');
    lines.push('| Trigger | Skill | Brain |');
    lines.push('|---------|-------|-------|');
    for (const e of entries) {
      const skillCol = e.isExternal ? e.absolutePath : `\`${e.absolutePath}\``;
      lines.push(`| ${e.trigger} | ${skillCol} | ${e.brainId} |`);
    }
    lines.push('');
  }

  if (composed.shadows.length > 0) {
    lines.push('## Shadows');
    lines.push('');
    lines.push('Host skills that shadow mount skills of the same name:');
    lines.push('');
    for (const s of composed.shadows) {
      lines.push(`- \`${s.skillName}\` (host) shadows ${s.shadowedMounts.map(m => `\`${m.mountId}::${s.skillName}\``).join(', ')}`);
    }
    lines.push('');
  }

  if (composed.ambiguities.length > 0) {
    lines.push('## Ambiguous bare names');
    lines.push('');
    lines.push('These skill names are defined in multiple mounts. Use the explicit');
    lines.push('namespace form (e.g. `yc-media::ingest`) to disambiguate.');
    lines.push('');
    for (const a of composed.ambiguities) {
      lines.push(`- \`${a.skillName}\` → ${a.mountIds.map(m => `\`${m}::${a.skillName}\``).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Render the composed manifest as manifest.json bytes. */
export function renderManifestJson(composed: ComposedManifest): string {
  return JSON.stringify(
    {
      generated_by: 'gbrain mounts',
      generated_at: new Date().toISOString(),
      skills: composed.entries.map(e => ({
        name: e.name,
        path: e.absolutePath,
        brain: e.brainId,
      })),
    },
    null,
    2,
  ) + '\n';
}

/**
 * Write the aggregated cache to ~/.gbrain/mounts-cache/. Safe to call
 * repeatedly. The directory is created if missing. Both files are
 * rewritten atomically (write-then-rename via a .tmp sibling).
 */
export function writeMountsCache(
  hostSkillsDir: string,
  mounts: MountEntry[],
  opts: { cacheDir?: string } = {},
): { resolverPath: string; manifestPath: string } {
  const cacheDir = opts.cacheDir ?? getMountsCacheDir();
  mkdirSync(cacheDir, { recursive: true });

  const resolver = composeResolvers(hostSkillsDir, mounts);
  const manifest = composeManifests(hostSkillsDir, mounts);

  const resolverPath = join(cacheDir, 'RESOLVER.md');
  const manifestPath = join(cacheDir, 'manifest.json');

  // Unique tmp names per call so concurrent `gbrain mounts add|remove`
  // invocations don't clobber each other's .tmp file. The two-file swap
  // (RESOLVER.md + manifest.json) is not itself atomic across files —
  // readers may briefly observe RESOLVER.md(new) + manifest.json(old).
  // That's acceptable: the aggregated cache is recomputable from
  // mounts.json at any time, and doctor will flag divergence. A true
  // generation-swap (cacheDir/current → new-gen dir) is deferred to PR 1.
  const suffix = `${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  const resolverTmp = `${resolverPath}.tmp.${suffix}`;
  const manifestTmp = `${manifestPath}.tmp.${suffix}`;

  writeFileSync(resolverTmp, renderResolverMarkdown(resolver), { mode: 0o644 });
  writeFileSync(manifestTmp, renderManifestJson(manifest), { mode: 0o644 });

  // Atomic swap via rename on each file.
  renameSync(resolverTmp, resolverPath);
  renameSync(manifestTmp, manifestPath);

  return { resolverPath, manifestPath };
}

/** Remove the aggregated cache dir. Called by `gbrain mounts remove` and tests. */
export function clearMountsCache(opts: { cacheDir?: string } = {}): void {
  const cacheDir = opts.cacheDir ?? getMountsCacheDir();
  if (!existsSync(cacheDir)) return;
  rmSync(cacheDir, { recursive: true, force: true });
}

/** Exposed for tests. */
export const __testing = {
  getMountsCacheDir,
  skillNameFromRelPath,
  DEFAULT_SKILLS_SUBDIR,
};
