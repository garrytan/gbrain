/**
 * skill-trigger-index.ts — Shared loader for the unified skill trigger
 * index. Folds two surfaces into one ResolverEntry stream:
 *
 *   1. Per-skill SKILL.md frontmatter `triggers:` (canonical source of
 *      truth as of v0.41.11 — every skill ships its own triggers).
 *   2. Curated RESOLVER.md / AGENTS.md rows from `skillsDir` + parent
 *      directory (preserves the human-readable dispatcher map AND the
 *      OpenClaw workspace-root AGENTS.md merge contract from v0.31.7).
 *
 * Merge semantics: UNION, not REPLACE. An explicit RESOLVER.md row that
 * declares trigger T for skill S ADDS to the frontmatter triggers for S
 * (it does NOT replace them). Both surfaces contribute. Dedup is keyed
 * on `(skillPath, trigger.trim().toLowerCase())` so case/whitespace
 * drift between the two surfaces collapses to one entry.
 *
 * Three consumers fold through this primitive: `checkResolvable`,
 * `routing-eval` CLI, and `mounts-cache.composeResolver`. Per-consumer
 * loaders were the v0.41.x drift bug class (#1451) — fixing the
 * frontmatter triggers fixed doctor but not the routing-eval CLI; the
 * shared primitive eliminates that class.
 *
 * Performance: ~50 readFileSync calls per invocation on a stock bundled
 * skills tree. ~5ms cold, sub-millisecond warm. No caching — the real
 * risk codex flagged in #1451 review was consistency, not throughput.
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from 'fs';
import { join } from 'path';
import { parseResolverEntries, type ResolverEntry } from './check-resolvable.ts';
import { findAllResolverFiles } from './resolver-filenames.ts';
import { parseSkillFrontmatter } from './skill-frontmatter.ts';

export type TriggerSource = 'frontmatter' | 'resolver_md';

export interface SkillTriggerEntry extends ResolverEntry {
  /** Which surface produced this entry. Drives action-text generation. */
  source: TriggerSource;
}

/** Section label stamped on every frontmatter-derived entry. */
export const FRONTMATTER_SECTION = 'Auto-registered (from skill frontmatter)';

/** Skill subdirectories the loader will not scan for SKILL.md frontmatter.
 *  - `_*` and dotfiles are docs / conventions / private files.
 *  - `conventions/` is the cross-cutting rules tree (no SKILL.md).
 *  - `migrations/` is version migration files (no SKILL.md).
 */
const FRONTMATTER_SKIP_DIRS = new Set<string>(['conventions', 'migrations']);

/** Process-scoped warn-once tracker so a malformed frontmatter doesn't
 *  spam stderr on every `gbrain doctor` invocation across a session.
 *  Test seam: `_resetWarnedSkillsForTests` lets unit suites re-trigger. */
let _warnedSkills: Set<string> = new Set();

/** Test seam — clears the warn-once cache so test cases that exercise
 *  the malformed-frontmatter branch re-emit the stderr line. */
export function _resetWarnedSkillsForTests(): void {
  _warnedSkills = new Set();
}

/**
 * Walk `skills/<name>/SKILL.md` for each skill, parse the YAML
 * frontmatter via the existing shared `parseSkillFrontmatter`, and
 * synthesize one `SkillTriggerEntry` per declared `triggers:` string.
 *
 * Skip rules (graceful, never throws):
 *   - Non-directory entries.
 *   - Directories starting with `_` or `.` (docs / hidden).
 *   - `conventions/`, `migrations/` (no SKILL.md by design).
 *   - Directories without a `SKILL.md` (deprecated `install/`).
 *   - SKILL.md files with no frontmatter or empty `triggers:` array.
 *   - SKILL.md files that fail to read — warn-once + skip.
 */
function loadFrontmatterEntries(skillsDir: string): SkillTriggerEntry[] {
  const out: SkillTriggerEntry[] = [];
  if (!existsSync(skillsDir)) return out;

  let dirents: Dirent[];
  try {
    dirents = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const name = dirent.name;
    if (name.startsWith('_') || name.startsWith('.')) continue;
    if (FRONTMATTER_SKIP_DIRS.has(name)) continue;

    const skillMdPath = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    let content: string;
    try {
      content = readFileSync(skillMdPath, 'utf-8');
    } catch (err) {
      if (!_warnedSkills.has(skillMdPath)) {
        _warnedSkills.add(skillMdPath);
        console.warn(
          `[skill-trigger-index] could not read ${skillMdPath}: ${(err as Error).message}`,
        );
      }
      continue;
    }

    let parsed: ReturnType<typeof parseSkillFrontmatter> | null = null;
    try {
      parsed = parseSkillFrontmatter(content);
    } catch (err) {
      if (!_warnedSkills.has(skillMdPath)) {
        _warnedSkills.add(skillMdPath);
        console.warn(
          `[skill-trigger-index] frontmatter parse failed for ${skillMdPath}: ${(err as Error).message}`,
        );
      }
      continue;
    }

    if (!parsed || !parsed.triggers || parsed.triggers.length === 0) continue;

    const skillPath = `skills/${name}/SKILL.md`;
    for (const trigger of parsed.triggers) {
      const t = trigger.trim();
      if (t.length === 0) continue;
      out.push({
        trigger: t,
        skillPath,
        isGStack: false,
        section: FRONTMATTER_SECTION,
        source: 'frontmatter',
      });
    }
  }

  return out;
}

/**
 * Walk every RESOLVER.md / AGENTS.md across `skillsDir` AND its parent
 * directory (the OpenClaw workspace-root layout from v0.31.7). For each
 * file: parse via `parseResolverEntries` and stamp `source: 'resolver_md'`.
 */
function loadResolverMdEntries(skillsDir: string): SkillTriggerEntry[] {
  const paths = [
    ...findAllResolverFiles(skillsDir),
    ...findAllResolverFiles(join(skillsDir, '..')),
  ];
  const out: SkillTriggerEntry[] = [];
  for (const p of paths) {
    let content: string;
    try {
      content = readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    for (const e of parseResolverEntries(content)) {
      out.push({ ...e, source: 'resolver_md' });
    }
  }
  return out;
}

/**
 * Merge frontmatter + resolver_md entries with UNION semantics. Dedup
 * is keyed on `(skillPath, normalizedTrigger)` where the normalizer
 * trims and lowercases — so `"Harvest This Skill"` in frontmatter and
 * `"harvest this skill"` in RESOLVER.md collapse to one entry. First
 * occurrence wins (frontmatter entries are passed first, so a
 * frontmatter-declared trigger keeps its `source: 'frontmatter'`
 * even when a duplicate-shaped row also lives in RESOLVER.md).
 */
function mergeEntries(
  fmEntries: SkillTriggerEntry[],
  resolverEntries: SkillTriggerEntry[],
): SkillTriggerEntry[] {
  const seen = new Set<string>();
  const out: SkillTriggerEntry[] = [];
  for (const e of [...fmEntries, ...resolverEntries]) {
    // GStack/external entries (e.g. `GStack: ceo-review`) have prose in
    // skillPath instead of a file path. Dedup them by their raw form
    // since two RESOLVER.md files might list the same external both.
    const key = e.isGStack
      ? `EXT::${e.skillPath}::${e.trigger.trim().toLowerCase()}`
      : `${e.skillPath}::${e.trigger.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * The shared primitive. Returns the unified entry list for a given
 * skills directory. Idempotent. Pure modulo filesystem state.
 */
export function loadSkillTriggerIndex(skillsDir: string): SkillTriggerEntry[] {
  const fmEntries = loadFrontmatterEntries(skillsDir);
  const resolverEntries = loadResolverMdEntries(skillsDir);
  return mergeEntries(fmEntries, resolverEntries);
}

/**
 * Synthesize a single markdown-table resolver-content string from a
 * unified entry list. Output is shape-compatible with
 * `parseResolverEntries`, so downstream code that still expects a
 * string (notably `runRoutingEval` and `lintRoutingFixtures`) can be
 * fed the merged index without an API change.
 *
 * Section heading is stable so the table parses as one logical
 * section. Pipes inside trigger strings are backslash-escaped so a
 * trigger like `"a | b"` doesn't break the row.
 */
export function entriesToResolverContent(
  entries: SkillTriggerEntry[],
): string {
  const lines: string[] = [
    '## Synthesized trigger index',
    '',
    '| trigger | skill |',
    '| --- | --- |',
  ];
  for (const e of entries) {
    const trigger = escapePipe(e.trigger);
    if (e.isGStack) {
      // External/GStack rows: skillPath is the prose label. Re-emit
      // verbatim so parseResolverEntries' isGStack branch fires.
      lines.push(`| ${trigger} | ${escapePipe(e.skillPath)} |`);
    } else {
      lines.push(`| ${trigger} | \`${e.skillPath}\` |`);
    }
  }
  return lines.join('\n');
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/**
 * First RESOLVER.md / AGENTS.md path found across `skillsDir` + parent,
 * or `null`. Used by `checkResolvable` for error messages and `--fix`
 * targets that need a concrete file path to point at.
 */
export function findPrimaryResolverPath(skillsDir: string): string | null {
  const paths = [
    ...findAllResolverFiles(skillsDir),
    ...findAllResolverFiles(join(skillsDir, '..')),
  ];
  return paths[0] ?? null;
}
