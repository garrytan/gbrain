/**
 * Pure functions for gbrain audit-name-links. No I/O, no DB, no engine.
 * Mirrors the canonical-name derivation rules of src/core/linkify.ts's
 * buildAliasMap (see Phase 0 Task 0.2 for the shared helpers).
 *
 * See: docs/superpowers/specs/2026-05-16-gbrain-audit-name-links-design.md
 */

import { caseFold, expandApostropheVariants } from './linkify.ts';
import { stripCodeBlocks, QUALIFIED_WIKILINK_RE } from './link-extraction.ts';

export type CanonicalNameSets = Map<string, Set<string>>;

/**
 * One row from the link-scan phase. Carries the byte offsets we need later
 * to splice in display-name fixes (Mode 1 auto-fix).
 */
export interface LinkOccurrence {
  file: string;
  line: number;
  slug: string;                  // e.g., 'people/cwaytek-aseva' (lowercase, no .md)
  display: string;
  linkForm: 'markdown' | 'wikilink';
  // Byte offsets in the ORIGINAL (un-masked) source.
  matchStart: number;            // start of the full link
  displayStart: number;          // start of the display-text capture
  displayEnd: number;            // exclusive end of the display-text capture
}

/**
 * One mismatch diagnostic. The dedup key is (kind, file, slug, display).
 */
export interface AuditMismatch {
  kind: 'name_mismatch' | 'unknown_target' | 'malformed_target';
  file: string;
  line: number;
  slug: string;
  display: string;
  linkForm: 'markdown' | 'wikilink';
  canonicalNames: string[];      // sorted; empty for unknown_target
  malformedReason?: string;      // populated only for malformed_target
  occurrences: number;
}

/**
 * Diagnostic union for the CLI's stderr stream. Mirrors linkify.ts's
 * Diagnostic shape conceptually but is local to audit (no coupling).
 */
export type AuditDiagnostic =
  | AuditMismatch
  | { kind: 'display_fixed'; file: string; line: number; slug: string; oldDisplay: string; newDisplay: string; linkForm: 'markdown' | 'wikilink' }
  | { kind: 'concurrent_modification_skipped'; file: string }
  | { kind: 'icloud_placeholder_skipped'; file: string }
  | { kind: 'enoent'; file: string };

/**
 * Build per-page canonical-name sets from person-page frontmatter rows.
 *
 * Derivation mirrors buildAliasMap (src/core/linkify.ts) exactly so the audit's
 * notion of "legitimate display text" cannot drift from linkify's:
 *   - name (full, trimmed)
 *   - first whitespace-split token of name
 *   - last whitespace-split token of name (when name has >=2 tokens)
 *   - every non-empty string in linkify_aliases
 * All entries are caseFolded and expanded to apostrophe variants
 * (U+0027 <-> U+2019). No stopword filter (per spec: an explicit
 * author-supplied link bypasses the stopword guard linkify needs).
 *
 * Returns:
 *   - sets: slug -> Set<case-folded canonical strings>
 *   - pageNames: slug -> original `name` field (preserved case; used by
 *     applyDisplayFixes as the canonical replacement target)
 *   - malformedSlugs: slug -> human-readable reason for any page missing
 *     a usable `name` field. Such slugs are NOT present in `sets`.
 */
export function buildCanonicalNameSets(rows: Array<{
  slug: string;
  frontmatter: Record<string, unknown>;
}>): { sets: CanonicalNameSets; pageNames: Map<string, string>; malformedSlugs: Map<string, string> } {
  const sets: CanonicalNameSets = new Map();
  const pageNames = new Map<string, string>();
  const malformedSlugs = new Map<string, string>();

  for (const row of rows) {
    const fm = row.frontmatter ?? {};
    const rawName = fm.name;
    if (typeof rawName !== 'string') {
      malformedSlugs.set(row.slug, rawName === undefined
        ? 'name field absent'
        : 'name field not a string');
      continue;
    }
    const name = rawName.trim();
    if (!name) {
      malformedSlugs.set(row.slug, 'name field is empty');
      continue;
    }

    const tokens = name.split(/\s+/).filter(Boolean);
    const derived: string[] = [name];
    if (tokens.length > 0) derived.push(tokens[0]);
    if (tokens.length > 1) derived.push(tokens[tokens.length - 1]);

    if (Array.isArray(fm.linkify_aliases)) {
      for (const a of fm.linkify_aliases) {
        if (typeof a === 'string' && a.trim()) derived.push(a.trim());
      }
    }

    const set = new Set<string>();
    for (const k of derived) {
      const folded = caseFold(k);
      for (const variant of expandApostropheVariants(folded)) {
        set.add(variant);
      }
    }
    sets.set(row.slug, set);
    pageNames.set(row.slug, name);
  }

  return { sets, pageNames, malformedSlugs };
}

/**
 * Mask the leading YAML frontmatter slice with spaces so offsets transfer
 * cleanly to the original (un-masked) source.
 */
function maskFrontmatter(content: string): string {
  const fmMatch = /^---\n[\s\S]*?\n---\n/.exec(content);
  if (!fmMatch) return content;
  return ' '.repeat(fmMatch[0].length) + content.slice(fmMatch[0].length);
}

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([./]*people\/[a-z][a-z0-9-]{0,61}[a-z0-9])(\.md)?\)/g;

/**
 * Scan a markdown file's content for [Display](people/Slug) and
 * [[people/Slug|Display]] links. Skip zones (frontmatter, fenced code blocks,
 * inline code) are masked before scanning. Byte offsets are captured against
 * the ORIGINAL (un-masked) source so applyDisplayFixes can splice into the
 * exact display-text range.
 */
export function findOccurrences(fileContent: string, filePath: string): LinkOccurrence[] {
  // Mask skip zones. Strip code blocks first (replaces with spaces, preserving
  // length), then mask the leading frontmatter slice. Offsets transfer cleanly
  // to fileContent because both transforms preserve byte-length.
  let masked = stripCodeBlocks(fileContent);
  masked = maskFrontmatter(masked);

  const occurrences: LinkOccurrence[] = [];

  // --- Markdown links: [Display](people/Slug) or [Display](people/Slug.md) ---
  const mdRe = new RegExp(MARKDOWN_LINK_RE.source, MARKDOWN_LINK_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(masked)) !== null) {
    const matchStart = m.index;
    const display = m[1];
    const slugCapture = m[2];

    // Normalize slug: strip leading ./ or ../, lowercase. The regex already
    // restricts to lowercase but be defensive.
    let slug = slugCapture.replace(/^(?:\.\.?\/)+/, '');
    slug = slug.toLowerCase();

    // [Display](slug)
    //  ^      ^
    // displayStart sits one byte past matchStart (after '[').
    const displayStart = matchStart + 1;
    const displayEnd = displayStart + display.length;
    const line = fileContent.slice(0, matchStart).split('\n').length;

    occurrences.push({
      file: filePath,
      line,
      slug,
      display,
      linkForm: 'markdown',
      matchStart,
      displayStart,
      displayEnd,
    });
  }

  // --- Qualified wikilinks: [[source-id:dir/slug|Display]] (people/* only) ---
  const wlRe = new RegExp(QUALIFIED_WIKILINK_RE.source, QUALIFIED_WIKILINK_RE.flags);
  while ((m = wlRe.exec(masked)) !== null) {
    const matchStart = m.index;
    const fullMatch = m[0];
    // Captures from QUALIFIED_WIKILINK_RE: 1=sourceId, 2=slug, 3=display.
    const slugCapture = m[2];
    const display = m[3];
    if (!display) continue;  // bare wikilinks (no display) are out of scope
    if (!slugCapture.startsWith('people/')) continue;

    const slug = slugCapture.toLowerCase();

    // Locate '|<display>' within the matched substring so we can compute
    // displayStart against the original content.
    const pipeIdxInMatch = fullMatch.lastIndexOf('|' + display);
    if (pipeIdxInMatch < 0) continue;
    const displayStart = matchStart + pipeIdxInMatch + 1;
    const displayEnd = displayStart + display.length;
    const line = fileContent.slice(0, matchStart).split('\n').length;

    occurrences.push({
      file: filePath,
      line,
      slug,
      display,
      linkForm: 'wikilink',
      matchStart,
      displayStart,
      displayEnd,
    });
  }

  // --- Unqualified wikilinks: [[people/slug|Display]] (no source-id prefix) ---
  // QUALIFIED_WIKILINK_RE requires `source-id:` so unqualified forms slip past.
  // Scan them with a narrow regex anchored on people/.
  const UNQUALIFIED_PEOPLE_WIKILINK = /\[\[(people\/[a-z][a-z0-9-]{0,61}[a-z0-9])(?:#[^|\]]*?)?\|([^\]]+?)\]\]/g;
  while ((m = UNQUALIFIED_PEOPLE_WIKILINK.exec(masked)) !== null) {
    const matchStart = m.index;
    const fullMatch = m[0];
    const slugCapture = m[1];
    const display = m[2];
    if (!display) continue;
    const slug = slugCapture.toLowerCase();
    const pipeIdxInMatch = fullMatch.lastIndexOf('|' + display);
    if (pipeIdxInMatch < 0) continue;
    const displayStart = matchStart + pipeIdxInMatch + 1;
    const displayEnd = displayStart + display.length;
    const line = fileContent.slice(0, matchStart).split('\n').length;

    occurrences.push({
      file: filePath,
      line,
      slug,
      display,
      linkForm: 'wikilink',
      matchStart,
      displayStart,
      displayEnd,
    });
  }

  return occurrences;
}

/**
 * Classify each LinkOccurrence against the canonical-name sets. Emits one
 * AuditMismatch per (kind, file, slug, display) tuple; duplicate occurrences
 * are collapsed onto the first emission with `occurrences` incremented and
 * the FIRST `line` seen preserved.
 *
 * Resolution order per occurrence:
 *   1. slug in malformedSlugs           -> malformed_target
 *   2. slug not in sets (and not above) -> unknown_target
 *   3. caseFold(display) in sets.get(slug) -> legitimate, skip
 *   4. otherwise                        -> name_mismatch
 */
export function classifyOccurrences(
  occurrences: LinkOccurrence[],
  sets: CanonicalNameSets,
  malformedSlugs: Map<string, string>,
): AuditMismatch[] {
  const out: AuditMismatch[] = [];
  const byKey = new Map<string, AuditMismatch>();

  for (const occ of occurrences) {
    const malformedReason = malformedSlugs.get(occ.slug);
    let kind: AuditMismatch['kind'];
    let canonicalNames: string[] = [];
    let reason: string | undefined;

    if (malformedReason !== undefined) {
      kind = 'malformed_target';
      reason = malformedReason;
    } else {
      const set = sets.get(occ.slug);
      if (!set) {
        kind = 'unknown_target';
      } else {
        if (set.has(caseFold(occ.display))) continue;  // legitimate
        kind = 'name_mismatch';
        canonicalNames = Array.from(set).sort();
      }
    }

    const key = JSON.stringify([kind, occ.file, occ.slug, occ.display]);
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    const mismatch: AuditMismatch = {
      kind,
      file: occ.file,
      line: occ.line,
      slug: occ.slug,
      display: occ.display,
      linkForm: occ.linkForm,
      canonicalNames,
      occurrences: 1,
    };
    if (reason !== undefined) mismatch.malformedReason = reason;
    byKey.set(key, mismatch);
    out.push(mismatch);
  }

  return out;
}

/**
 * Apply Mode-1 auto-fix to a file's content. Replaces the display text in
 * every name_mismatch occurrence with the page's canonical `name` (from
 * pageNames). Mode 2 (unknown_target, malformed_target) is NOT touched.
 *
 * Rewrites end-to-start (sorted by displayStart desc) so earlier offsets
 * remain valid as later splices land.
 *
 * Idempotent: a second call on the same content produces no further fixes
 * because the rewritten display matches caseFold's set membership.
 */
export function applyDisplayFixes(
  fileContent: string,
  occurrences: LinkOccurrence[],
  mismatches: AuditMismatch[],
  pageNames: Map<string, string>,
): { newContent: string; appliedFixes: Array<{ slug: string; oldDisplay: string; newDisplay: string; line: number; linkForm: 'markdown' | 'wikilink' }> } {
  // Mode-1 only.
  const modeOneKeys = new Set<string>();
  for (const mm of mismatches) {
    if (mm.kind !== 'name_mismatch') continue;
    modeOneKeys.add(JSON.stringify([mm.slug, mm.display]));
  }

  // Match occurrences whose (slug, display) is in the Mode-1 set.
  const fixable = occurrences.filter(o => modeOneKeys.has(JSON.stringify([o.slug, o.display])));

  // Sort by displayStart desc so earlier offsets are preserved as we splice.
  fixable.sort((a, b) => b.displayStart - a.displayStart);

  let content = fileContent;
  const appliedFixes: Array<{ slug: string; oldDisplay: string; newDisplay: string; line: number; linkForm: 'markdown' | 'wikilink' }> = [];

  for (const occ of fixable) {
    const canonical = pageNames.get(occ.slug);
    if (canonical === undefined) continue;  // defensive: Mode-1 occurrence must have a name
    content = content.slice(0, occ.displayStart) + canonical + content.slice(occ.displayEnd);
    appliedFixes.push({
      slug: occ.slug,
      oldDisplay: occ.display,
      newDisplay: canonical,
      line: occ.line,
      linkForm: occ.linkForm,
    });
  }

  // Reverse appliedFixes so they're reported in source order (top-to-bottom).
  appliedFixes.reverse();

  return { newContent: content, appliedFixes };
}
