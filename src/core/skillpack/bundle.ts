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
