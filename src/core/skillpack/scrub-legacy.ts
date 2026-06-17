/**
 * skillpack/scrub-legacy.ts — `gbrain skillpack scrub-legacy-fence-rows`
 * (TODO-2 folded into v0.33).
 *
 * Opt-in companion to `migrate-fence`. After the agent confirms it
 * walks frontmatter `triggers:` for routing, this command removes the
 * legacy table rows that `migrate-fence` left behind.
 *
 * Gate (two conditions must BOTH hold for a row to be removed):
 *   1. `skills/<slug>/` exists on host (it was a real scaffold)
 *   2. That skill's frontmatter declares a non-empty `triggers:` array
 *      (proof that frontmatter discovery covers this skill)
 *
 * Rows whose slug fails either gate are preserved — user-owned rows
 * the migration shouldn't touch.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { findResolverFile } from '../resolver-filenames.ts';
import { parseMarkdown } from '../markdown.ts';

const MANAGED_BEGIN = '<!-- gbrain:skillpack:begin -->';
const MANAGED_END = '<!-- gbrain:skillpack:end -->';
// Row shape that migrate-fence leaves behind:
//   | "trigger phrase" | `skills/<slug>/SKILL.md` |
// Anchored to the start of a line so we don't accidentally strip
// rows the user typed differently.
const LEGACY_ROW_RE =
  /^\| ".*" \| `skills\/([^/`]+)\/SKILL\.md` \|\s*$/;

export interface ScrubLegacyOptions {
  targetWorkspace: string;
  dryRun?: boolean;
}

export interface ScrubLegacyResult {
  resolverFile: string | null;
  /** Slugs whose rows were removed. */
  removed: string[];
  /** Slugs whose rows survived (skill missing OR no triggers declared). */
  preserved: string[];
  dryRun: boolean;
}

export function runScrubLegacy(opts: ScrubLegacyOptions): ScrubLegacyResult {
  const dryRun = opts.dryRun ?? false;
  const skillsDir = join(opts.targetWorkspace, 'skills');
  const resolverFile = findResolverFile(skillsDir) ?? findResolverFile(opts.targetWorkspace);
  if (!resolverFile) {
    return { resolverFile: null, removed: [], preserved: [], dryRun };
  }

  const content = readFileSync(resolverFile, 'utf-8');

  // Determine "outside any current fence" ranges. After migrate-fence,
  // the markers should be gone — but defensively skip rows still
  // inside a fence (user might run scrub-legacy without having run
  // migrate-fence first).
  const beginIdx = content.indexOf(MANAGED_BEGIN);
  const endIdx = content.indexOf(MANAGED_END);
  const inFenceRange =
    beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx
      ? { start: beginIdx, end: endIdx + MANAGED_END.length }
      : null;

  const lines = content.split('\n');
  const removed: string[] = [];
  const preserved: string[] = [];
  const outLines: string[] = [];
  let offset = 0; // byte offset for fence-range comparison

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the newline we removed via split

    const m = LEGACY_ROW_RE.exec(line);
    if (!m) {
      outLines.push(line);
      continue;
    }
    const slug = m[1];

    // Skip rows inside an existing fence (defensive).
    if (inFenceRange && lineStart >= inFenceRange.start && lineStart < inFenceRange.end) {
      outLines.push(line);
      continue;
    }

    // Gate: skill dir exists AND frontmatter triggers are declared.
    if (!skillHasFrontmatterTriggers(opts.targetWorkspace, slug)) {
      outLines.push(line);
      preserved.push(slug);
      continue;
    }

    // Row qualifies for removal.
    removed.push(slug);
    // (do NOT push the line — it's dropped)
  }

  if (!dryRun && removed.length > 0) {
    writeFileSync(resolverFile, outLines.join('\n'));
  }

  return { resolverFile, removed, preserved, dryRun };
}

function skillHasFrontmatterTriggers(workspace: string, slug: string): boolean {
  const skillMd = join(workspace, 'skills', slug, 'SKILL.md');
  if (!existsSync(skillMd)) return false;
  let raw: string;
  try {
    raw = readFileSync(skillMd, 'utf-8');
  } catch {
    return false;
  }
  let parsed;
  try {
    parsed = parseMarkdown(raw, skillMd);
  } catch {
    return false;
  }
  const triggers = parsed.frontmatter.triggers;
  return Array.isArray(triggers) && triggers.length > 0;
}
