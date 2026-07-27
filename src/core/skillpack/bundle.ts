/**
 * skillpack/bundle.ts — read the bundled-skills manifest.
 *
 * gbrain ships a curated set of skills (plus shared rule/convention
 * files they depend on) that agents install into their OpenClaw
 * workspace via `gbrain skillpack install`. The source of truth is
 * `openclaw.plugin.json` at the gbrain repo root.
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { join, dirname, isAbsolute, resolve } from 'path';

import { parseMarkdown } from '../markdown.ts';

export interface BundleManifest {
  name: string;
  version: string;
  description?: string;
  skills: string[]; // e.g. "skills/brain-ops" (relative to gbrain root)
  shared_deps: string[]; // files + dirs every skill depends on
  excluded_from_install?: string[];
}

export class BundleError extends Error {
  constructor(
    message: string,
    public code:
      | 'manifest_not_found'
      | 'manifest_malformed'
      | 'skill_not_found'
      | 'gbrain_root_not_found',
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

/**
 * Walk up from `start` (default cwd) looking for an `openclaw.plugin.json`
 * sibling to `src/cli.ts`. That pair identifies a gbrain repo root.
 */
export function findGbrainRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(join(dir, 'openclaw.plugin.json')) &&
      existsSync(join(dir, 'src', 'cli.ts'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Parse `openclaw.plugin.json` from the supplied gbrain root (absolute).
 * Throws BundleError on missing file or malformed JSON.
 */
export function loadBundleManifest(gbrainRoot: string): BundleManifest {
  const manifestPath = join(gbrainRoot, 'openclaw.plugin.json');
  if (!existsSync(manifestPath)) {
    throw new BundleError(
      `openclaw.plugin.json not found at ${manifestPath}`,
      'manifest_not_found',
    );
  }
  let content: string;
  try {
    content = readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    throw new BundleError(
      `Failed to read ${manifestPath}: ${(err as Error).message}`,
      'manifest_malformed',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new BundleError(
      `openclaw.plugin.json is not valid JSON: ${(err as Error).message}`,
      'manifest_malformed',
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new BundleError(
      'openclaw.plugin.json: top-level must be an object',
      'manifest_malformed',
    );
  }
  const m = parsed as Partial<BundleManifest>;
  if (typeof m.name !== 'string' || typeof m.version !== 'string') {
    throw new BundleError(
      'openclaw.plugin.json: name and version must be strings',
      'manifest_malformed',
    );
  }
  if (!Array.isArray(m.skills)) {
    throw new BundleError(
      'openclaw.plugin.json: "skills" must be an array',
      'manifest_malformed',
    );
  }
  if (!Array.isArray(m.shared_deps)) {
    // Tolerate older manifests; default to empty.
    m.shared_deps = [];
  }
  return m as BundleManifest;
}

/**
 * Enumerate every absolute path the bundle would install:
 *   - For each skill dir: every regular file under it.
 *   - For each shared dep: the file, or every regular file under it
 *     if it's a directory.
 */
export interface BundleEntry {
  /** Absolute source path under gbrainRoot. */
  source: string;
  /** Path under the skill bundle, joined with target skills dir. */
  relTarget: string;
  /** Whether this comes from shared_deps (true) or a skill (false). */
  sharedDep: boolean;
}

function walkFiles(absDir: string, prefix: string, out: BundleEntry[], sharedDep: boolean): void {
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(absDir, e);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkFiles(abs, join(prefix, e), out, sharedDep);
    } else if (stat.isFile()) {
      out.push({ source: abs, relTarget: join(prefix, e), sharedDep });
    }
  }
}

export interface EnumerateOptions {
  /** Absolute path to gbrain repo root (source). */
  gbrainRoot: string;
  /** If set, scope enumeration to just this skill by its slug (last
   *  segment of `skills/<slug>`). Undefined enumerates everything. */
  skillSlug?: string;
  manifest: BundleManifest;
}

/**
 * Enumerate the full bundle (or just one skill + its shared deps) as
 * a flat list of BundleEntry objects, each with a source path and a
 * target-relative path.
 */
export function enumerateBundle(opts: EnumerateOptions): BundleEntry[] {
  const { gbrainRoot, skillSlug, manifest } = opts;
  const entries: BundleEntry[] = [];

  const skillsToIncludePaths = skillSlug
    ? manifest.skills.filter(p => pathSlug(p) === skillSlug)
    : manifest.skills;

  if (skillSlug && skillsToIncludePaths.length === 0) {
    throw new BundleError(
      `Skill '${skillSlug}' is not listed in openclaw.plugin.json#skills`,
      'skill_not_found',
    );
  }

  for (const rel of skillsToIncludePaths) {
    const abs = join(gbrainRoot, rel);
    if (!existsSync(abs)) {
      throw new BundleError(
        `Bundle lists '${rel}' but the path does not exist in ${gbrainRoot}`,
        'skill_not_found',
      );
    }
    const prefix = rel.replace(/^skills\//, '');
    walkFiles(abs, prefix, entries, false);
  }

  // Shared deps always included — installing any skill pulls the full
  // convention/rules bundle so the skill's references don't break
  // (D-CX-10 dependency closure).
  for (const dep of manifest.shared_deps) {
    const abs = join(gbrainRoot, dep);
    if (!existsSync(abs)) continue; // missing shared dep is a warning, not fatal
    const prefix = dep.replace(/^skills\//, '');
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkFiles(abs, prefix, entries, true);
    } else if (stat.isFile()) {
      entries.push({ source: abs, relTarget: prefix, sharedDep: true });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Git-aware change filter (v0.36 — `reference --since <version>`)
// ---------------------------------------------------------------------------

/**
 * Return the set of skill slugs whose files under `skills/<slug>/` changed
 * between `version` and HEAD in the gbrain source tree. Used by
 * `gbrain skillpack reference --since <version>` so an agent can sweep
 * only the skills that actually moved since the last time it looked.
 *
 * Returns `null` (not an empty array) when:
 *   - the gbrain root is not a git checkout (tarball install)
 *   - the version tag doesn't resolve in this repo
 *   - any other git error
 *
 * Callers fall back to "scan every bundled skill" when null is returned,
 * with a stderr note explaining why.
 *
 * `version` accepts the same shapes git rev-parse does — a tag like
 * `v0.36.0.0`, a bare version like `0.36.0.0` (will retry with `v` prefix),
 * a commit SHA, or a branch name.
 */
export function changedSlugsSinceVersion(
  gbrainRoot: string,
  version: string,
): string[] | null {
  // Synchronously execute git via Bun.spawnSync to avoid the async overhead
  // and keep this callable from CLI dispatch without awaiting.
  const { spawnSync } = require('child_process') as typeof import('child_process');

  // Probe git availability + repo state. `.git` may be a directory OR a file
  // (worktrees). Either is fine for `git log`.
  if (!existsSync(join(gbrainRoot, '.git'))) return null;

  // Try the literal version first, then with a `v` prefix.
  const candidates: string[] = [version];
  if (!version.startsWith('v')) candidates.push(`v${version}`);

  for (const ref of candidates) {
    const probe = spawnSync(
      'git',
      ['-C', gbrainRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { encoding: 'utf-8' },
    );
    if (probe.status !== 0) continue;

    const log = spawnSync(
      'git',
      [
        '-C',
        gbrainRoot,
        'log',
        '--name-only',
        '--format=',
        `${ref}..HEAD`,
        '--',
        'skills/',
      ],
      { encoding: 'utf-8' },
    );
    if (log.status !== 0) return null;

    const slugs = new Set<string>();
    for (const line of (log.stdout ?? '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = /^skills\/([^/]+)\//.exec(trimmed);
      if (m) slugs.add(m[1]);
    }
    return [...slugs].sort();
  }

  // No candidate ref resolved.
  return null;
}

export function pathSlug(relPath: string): string {
  const trimmed = relPath.replace(/\/+$/, '');
  const parts = trimmed.split('/');
  return parts[parts.length - 1];
}

/**
 * Return the list of slugs this bundle installs (skills only, not
 * shared deps). Used by `skillpack list`.
 */
export function bundledSkillSlugs(manifest: BundleManifest): string[] {
  return manifest.skills.map(pathSlug).sort();
}

// ---------------------------------------------------------------------------
// Frontmatter `sources:` — paired source files declared by a skill (v0.33+)
// ---------------------------------------------------------------------------
//
// A skill that ships paired implementation (e.g. book-mirror's
// `src/commands/book-mirror.ts`) declares it in its SKILL.md frontmatter:
//
//   ---
//   name: book-mirror
//   sources:
//     - src/commands/book-mirror.ts
//   ---
//
// The bundler reads this on every enumerate; scaffold copies the paired
// files alongside the skill markdown. Single source of truth co-located
// with the skill — no parallel manifest in openclaw.plugin.json.

/** A skill's declared paired-source paths (repo-relative). */
export interface SkillSources {
  slug: string;
  sources: string[];
}

/**
 * Read `<gbrainRoot>/<skillRel>/SKILL.md` and return its `sources:`
 * frontmatter array. Empty array when absent or empty.
 *
 * Fail-loud validation (throws `BundleError` with `manifest_malformed`):
 *   - every entry must be a string
 *   - relative path only (no leading `/`, no `../` traversal)
 *   - every referenced file must exist under `<gbrainRoot>`
 *
 * Skills without `sources:` declared, or with `sources: []`, return an
 * empty array (no validation work performed).
 */
export function loadSkillSources(gbrainRoot: string, skillRel: string): SkillSources {
  const slug = pathSlug(skillRel);
  const skillMd = join(gbrainRoot, skillRel, 'SKILL.md');
  if (!existsSync(skillMd)) {
    // Some bundled "skills" are markdown-only without a SKILL.md (rare,
    // e.g. shared-conventions directories). Treat as no sources.
    return { slug, sources: [] };
  }
  let content: string;
  try {
    content = readFileSync(skillMd, 'utf-8');
  } catch (err) {
    throw new BundleError(
      `Failed to read ${skillMd}: ${(err as Error).message}`,
      'manifest_malformed',
    );
  }
  let parsed;
  try {
    parsed = parseMarkdown(content, skillMd);
  } catch (err) {
    throw new BundleError(
      `${skillMd}: frontmatter parse error — ${(err as Error).message}`,
      'manifest_malformed',
    );
  }
  const raw = parsed.frontmatter.sources;
  if (raw === undefined || raw === null) {
    return { slug, sources: [] };
  }
  if (!Array.isArray(raw)) {
    throw new BundleError(
      `${skillMd}: frontmatter \`sources:\` must be an array of strings`,
      'manifest_malformed',
    );
  }
  const sources: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new BundleError(
        `${skillMd}: every entry in frontmatter \`sources:\` must be a string`,
        'manifest_malformed',
      );
    }
    if (entry.length === 0) {
      throw new BundleError(
        `${skillMd}: empty string in frontmatter \`sources:\``,
        'manifest_malformed',
      );
    }
    if (isAbsolute(entry)) {
      throw new BundleError(
        `${skillMd}: frontmatter \`sources:\` entry "${entry}" must be relative to the repo root, not absolute`,
        'manifest_malformed',
      );
    }
    if (entry.includes('..')) {
      throw new BundleError(
        `${skillMd}: frontmatter \`sources:\` entry "${entry}" contains \`..\` traversal — refusing for safety`,
        'manifest_malformed',
      );
    }
    const abs = join(gbrainRoot, entry);
    if (!existsSync(abs)) {
      throw new BundleError(
        `${skillMd}: frontmatter \`sources:\` declares "${entry}" but the file is missing from ${gbrainRoot}`,
        'manifest_malformed',
      );
    }
    sources.push(entry);
  }
  return { slug, sources };
}

// ---------------------------------------------------------------------------
// ScaffoldEntry — workspace-rooted, includes paired-source files
// ---------------------------------------------------------------------------

/**
 * Like `BundleEntry`, but `relWorkspaceTarget` is rooted at the target
 * workspace (not the target skills dir). Lets scaffold place paired
 * source files at their mirror path (`src/commands/foo.ts`) alongside
 * the skill markdown (`skills/<slug>/SKILL.md`).
 */
export interface ScaffoldEntry {
  source: string;
  relWorkspaceTarget: string;
  sharedDep: boolean;
  /** Whether from a skill's frontmatter `sources:` declaration. */
  pairedSource: boolean;
}

/**
 * Enumerate every file the new scaffold model would copy. Workspace-
 * rooted targets:
 *   - skill files     → `skills/<slug>/<rel>`
 *   - shared deps     → `skills/<rel>`
 *   - paired sources  → `<source>` (e.g. `src/commands/book-mirror.ts`)
 *
 * Fail-loud on missing declared paired sources via `loadSkillSources`.
 */
export function enumerateScaffoldEntries(opts: EnumerateOptions): ScaffoldEntry[] {
  const { gbrainRoot, skillSlug, manifest } = opts;
  const entries: ScaffoldEntry[] = [];

  const skillsToIncludePaths = skillSlug
    ? manifest.skills.filter(p => pathSlug(p) === skillSlug)
    : manifest.skills;

  if (skillSlug && skillsToIncludePaths.length === 0) {
    throw new BundleError(
      `Skill '${skillSlug}' is not listed in openclaw.plugin.json#skills`,
      'skill_not_found',
    );
  }

  // 1. Skill files — every file under `<gbrainRoot>/skills/<slug>/`.
  //    relWorkspaceTarget = `skills/<slug>/<rest>` (workspace-rooted).
  for (const rel of skillsToIncludePaths) {
    const abs = join(gbrainRoot, rel);
    if (!existsSync(abs)) {
      throw new BundleError(
        `Bundle lists '${rel}' but the path does not exist in ${gbrainRoot}`,
        'skill_not_found',
      );
    }
    walkScaffoldFiles(abs, rel, entries, false, false);
  }

  // 2. Paired sources — declared via each skill's frontmatter `sources:`.
  //    relWorkspaceTarget = `<source>` (already workspace-relative).
  for (const rel of skillsToIncludePaths) {
    const { sources } = loadSkillSources(gbrainRoot, rel);
    for (const src of sources) {
      entries.push({
        source: join(gbrainRoot, src),
        relWorkspaceTarget: src,
        sharedDep: false,
        pairedSource: true,
      });
    }
  }

  // 3. Shared deps — convention files etc. relWorkspaceTarget = `skills/<rest>`.
  for (const dep of manifest.shared_deps) {
    const abs = join(gbrainRoot, dep);
    if (!existsSync(abs)) continue; // missing shared dep is a warning, not fatal
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkScaffoldFiles(abs, dep, entries, true, false);
    } else if (stat.isFile()) {
      entries.push({
        source: abs,
        relWorkspaceTarget: dep,
        sharedDep: true,
        pairedSource: false,
      });
    }
  }

  return entries;
}

function walkScaffoldFiles(
  absDir: string,
  workspaceRelPrefix: string,
  out: ScaffoldEntry[],
  sharedDep: boolean,
  pairedSource: boolean,
): void {
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(absDir, e);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkScaffoldFiles(abs, join(workspaceRelPrefix, e), out, sharedDep, pairedSource);
    } else if (stat.isFile()) {
      out.push({
        source: abs,
        relWorkspaceTarget: join(workspaceRelPrefix, e),
        sharedDep,
        pairedSource,
      });
    }
  }
}
