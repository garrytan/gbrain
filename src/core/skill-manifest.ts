/**
 * skill-manifest.ts — unified manifest loader for resolver checks.
 *
 * Two call sites converge here (D-CX-12, F-ENG-1):
 *   - `src/core/check-resolvable.ts` — reachability check
 *   - `src/core/dry-fix.ts`          — auto-fix walker
 *
 * Both previously had their own `loadManifest` returning `[]` on missing
 * manifest.json. That silently disabled reachability + auto-fix for any
 * workspace (like an OpenClaw deployment) that doesn't ship a manifest
 * alongside its skills — the exact scenario this release unblocks.
 *
 * Behavior:
 *   1. If `skillsDir/manifest.json` exists and parses, use it verbatim.
 *   2. Otherwise, walk `skillsDir/*` dirs. For each dir containing a
 *      `SKILL.md`, construct `{name, path}` by reading `name:` from the
 *      frontmatter; fall back to the dirname if frontmatter is absent
 *      or unparseable. This is the "auto-derive" path.
 *   3. Return `{skills, derived: boolean}` so callers can surface
 *      derived-manifest mode in `--verbose` / `--json` output.
 *
 * Dotfile dirs (names starting with `_` or `.`) are excluded — they
 * hold conventions and shared rule files, not skills. Files like
 * `_brain-filing-rules.md` live at the root and are not considered
 * skills by either loader.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface ManifestEntry {
  name: string;
  path: string; // relative to skillsDir, e.g. "query/SKILL.md"
}

export interface ManifestLoadResult {
  skills: ManifestEntry[];
  /** True when manifest.json was missing/unparseable and the skill set
   *  was derived from walking skillsDir. Surfaces in --verbose output. */
  derived: boolean;
}

/**
 * Parse the `name:` field from a skill's YAML frontmatter.
 * Tolerant: returns null if no frontmatter, no `name:` key, or unparseable.
 */
function parseSkillName(skillMdPath: string): string | null {
  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    // Match `name: foo` or `name: "foo"` or `name: 'foo'`
    const nameMatch = fm.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
    if (!nameMatch) return null;
    const name = nameMatch[1].trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Walk skillsDir, return every `<skillsDir>/<dir>/SKILL.md` as a
 * ManifestEntry. Dotfile and underscore-prefixed dirs are skipped.
 */
function deriveManifest(skillsDir: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  if (!existsSync(skillsDir)) return out;

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    // Skip hidden dirs and convention-family sibling dirs (_conventions/,
    // conventions/, migrations/, recipes/, etc. are never "skills" in the
    // routing sense). Only entries with a direct `SKILL.md` count.
    if (entry.startsWith('.') || entry.startsWith('_')) continue;

    const subdirAbs = join(skillsDir, entry);
    let isDir = false;
    try {
      isDir = statSync(subdirAbs).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const skillMd = join(subdirAbs, 'SKILL.md');
    if (!existsSync(skillMd)) continue;

    const frontmatterName = parseSkillName(skillMd);
    const name = frontmatterName && frontmatterName !== '' ? frontmatterName : entry;
    out.push({ name, path: `${entry}/SKILL.md` });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Load the skill manifest from `skillsDir/manifest.json`, or derive it
 * from walking `skillsDir` when manifest.json is missing or malformed.
 *
 * Canonical entry point. New code should call THIS, not reach into
 * manifest.json directly.
 */
export function loadOrDeriveManifest(skillsDir: string): ManifestLoadResult {
  const manifestPath = join(skillsDir, 'manifest.json');

  if (existsSync(manifestPath)) {
    try {
      const content = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      // Strict shape gate: `skills` MUST be an array of `{name, path}`.
      // Anything else (missing, object-shaped, entries missing keys) is
      // treated as malformed and falls through to the derive path. This
      // is deliberately stricter than "empty array is fine" because a
      // malformed manifest.json on an OpenClaw deployment otherwise
      // silently disables reachability (F-ENG-1).
      if (Array.isArray(content?.skills)) {
        const skills = content.skills;
        // Empty array is a valid explicit declaration ("no skills yet").
        // Non-empty must have valid shape on every entry.
        const valid = skills.every(
          (s: unknown): s is ManifestEntry =>
            typeof s === 'object' &&
            s !== null &&
            typeof (s as ManifestEntry).name === 'string' &&
            typeof (s as ManifestEntry).path === 'string'
        );
        if (valid) {
          return { skills: skills as ManifestEntry[], derived: false };
        }
      }
      // Non-array skills or entries missing keys → derive
    } catch {
      // Unparseable manifest → fall through to derive
    }
  }

  return { skills: deriveManifest(skillsDir), derived: true };
}
