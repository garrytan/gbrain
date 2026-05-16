/**
 * Pure functions for gbrain audit-name-links. No I/O, no DB, no engine.
 * Mirrors the canonical-name derivation rules of src/core/linkify.ts's
 * buildAliasMap (see Phase 0 Task 0.2 for the shared helpers).
 *
 * See: docs/superpowers/specs/2026-05-16-gbrain-audit-name-links-design.md
 */

import { caseFold, expandApostropheVariants } from './linkify.ts';
import { stripCodeBlocks, QUALIFIED_WIKILINK_RE } from './link-extraction.ts';

/**
 * Canonical-name sets keyed on slug for the brain-wide (unqualified) lookup
 * path. When the audit needs to honor a qualified wikilink's source-id, it
 * consults `setsBySource` first and falls back to the brain-wide `sets`.
 *
 * Brain-wide lookup is the union of every source's canonical set for a given
 * slug — matches linkify.ts:buildAliasMap's slug-only posture (slugs treated
 * brain-wide). See `buildCanonicalNameSets` for the documented policy.
 */
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
  /**
   * Source-id captured from a qualified wikilink (`[[source-id:dir/slug|X]]`).
   * Undefined for markdown links and unqualified wikilinks, which carry no
   * source-id and fall through to the brain-wide lookup. See
   * `buildCanonicalNameSets` for the policy.
   */
  source_id?: string;
  // Code-unit offsets in the ORIGINAL (un-masked) source. JavaScript strings
  // are indexed by UTF-16 code units, not bytes; multi-byte display names
  // (e.g. emoji, CJK) span the right number of code units for splice math
  // to remain stable.
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
 * Internal helper that derives the canonical-name key list from a person
 * page's `name` + `linkify_aliases` frontmatter. Mirrors the key derivation
 * in `src/core/linkify.ts:buildAliasMap` so the audit cannot drift from
 * linkify's notion of "what counts as a canonical name".
 *
 * Returns one entry per derived key (full + first + last + aliases), each
 * already caseFolded and expanded to its apostrophe variants. No stopword
 * filter — explicit author-supplied links bypass the stopword guard.
 *
 * DRY follow-up: `linkify.ts:buildAliasMap` inlines this derivation; lift it
 * out once both sites can share a single implementation without churning the
 * linkify diagnostic surface (TODOS.md).
 */
function deriveCanonicalKeys(name: string, aliases: unknown): string[] {
  const tokens = name.split(/\s+/).filter(Boolean);
  const derived: string[] = [name];
  if (tokens.length > 0) derived.push(tokens[0]);
  if (tokens.length > 1) derived.push(tokens[tokens.length - 1]);

  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (typeof a === 'string' && a.trim()) derived.push(a.trim());
    }
  }

  const out: string[] = [];
  for (const k of derived) {
    const folded = caseFold(k);
    for (const variant of expandApostropheVariants(folded)) {
      out.push(variant);
    }
  }
  return out;
}

/**
 * Build canonical-name sets from person-page frontmatter rows. The audit
 * mirrors `src/core/linkify.ts:buildAliasMap`'s slug-only routing posture:
 * linkify treats slugs as brain-wide unique (does not key on source_id),
 * so the audit's unqualified lookups do the same. Qualified wikilinks
 * (`[[source-id:dir/slug|Display]]`) carry an explicit source-id and may
 * validate against that source's canonical set specifically.
 *
 * Source-axis policy:
 *   - **Unqualified** markdown `[X](people/Y)` and wikilinks `[[people/Y|X]]`:
 *     no source-id is supplied, so the audit looks up the brain-wide union
 *     of every source's canonical set for slug Y. A display that's legitimate
 *     in any source for Y is treated as legitimate (mirrors linkify's
 *     behavior; same backward-compat posture).
 *   - **Qualified** wikilink `[[source-id:dir/slug|X]]`: the source-id is
 *     captured and used for a per-source lookup. Falls through to brain-wide
 *     when the source-id has no row for that slug (typically because the
 *     producer wrote a stale qualified link; the audit will emit
 *     `unknown_target` in that case).
 *
 * For single-source brains (the only shape supported in v1 user vaults)
 * every per-source lookup degenerates to the brain-wide lookup, so the
 * policy is forward-compatible. See TODOS.md for multi-source stress
 * testing and an `ambiguous_target` diagnostic kind.
 *
 * Derivation per row:
 *   - name (full, trimmed)
 *   - first whitespace-split token of name
 *   - last whitespace-split token of name (when name has >=2 tokens)
 *   - every non-empty string in linkify_aliases
 * All entries are caseFolded and expanded to apostrophe variants
 * (U+0027 <-> U+2019). No stopword filter (per spec: an explicit
 * author-supplied link bypasses the stopword guard linkify needs).
 *
 * Returns:
 *   - sets: slug -> Set<case-folded canonical strings> (brain-wide union)
 *   - setsBySource: "source_id:slug" -> Set<...> (per-source map used by
 *     qualified wikilinks; unqualified links never consult this map)
 *   - pageNames: slug -> original `name` field (preserved case). When
 *     multiple sources have the same slug with different `name` fields,
 *     deterministic alphabetical-first source_id wins. Used by
 *     applyDisplayFixes as the canonical replacement target.
 *   - pageNamesBySource: "source_id:slug" -> original `name` field, used
 *     for qualified-wikilink fixes that should snap to the matching source.
 *   - malformedSlugs: slug -> human-readable reason for any page missing
 *     a usable `name` field. A slug is malformed only when EVERY source's
 *     row for that slug is malformed; otherwise the valid sources win.
 *     Malformed slugs are NOT present in `sets`.
 */
export function buildCanonicalNameSets(rows: Array<{
  slug: string;
  source_id?: string;
  frontmatter: Record<string, unknown>;
}>): {
  sets: CanonicalNameSets;
  setsBySource: Map<string, Set<string>>;
  pageNames: Map<string, string>;
  pageNamesBySource: Map<string, string>;
  malformedSlugs: Map<string, string>;
} {
  const sets: CanonicalNameSets = new Map();
  const setsBySource = new Map<string, Set<string>>();
  const pageNames = new Map<string, string>();
  const pageNamesBySource = new Map<string, string>();
  // Track per-slug malformed reason candidates; only commit a slug to
  // malformedSlugs if every source's row was malformed.
  const malformedReasonBySlug = new Map<string, string>();
  const validSlugs = new Set<string>();
  // Track per-slug winning source_id for deterministic pageNames pick
  // (alphabetical-first source_id wins).
  const pageNameWinningSource = new Map<string, string>();

  for (const row of rows) {
    const sourceId = row.source_id ?? 'default';
    const fm = row.frontmatter ?? {};
    const rawName = fm.name;
    if (typeof rawName !== 'string') {
      const reason = rawName === undefined ? 'name field absent' : 'name field not a string';
      if (!validSlugs.has(row.slug) && !malformedReasonBySlug.has(row.slug)) {
        malformedReasonBySlug.set(row.slug, reason);
      }
      continue;
    }
    const name = rawName.trim();
    if (!name) {
      if (!validSlugs.has(row.slug) && !malformedReasonBySlug.has(row.slug)) {
        malformedReasonBySlug.set(row.slug, 'name field is empty');
      }
      continue;
    }

    const variants = deriveCanonicalKeys(name, fm.linkify_aliases);

    // Per-source set.
    const bySourceKey = `${sourceId}:${row.slug}`;
    const bySourceSet = setsBySource.get(bySourceKey) ?? new Set<string>();
    for (const v of variants) bySourceSet.add(v);
    setsBySource.set(bySourceKey, bySourceSet);
    pageNamesBySource.set(bySourceKey, name);

    // Brain-wide union set.
    const unionSet = sets.get(row.slug) ?? new Set<string>();
    for (const v of variants) unionSet.add(v);
    sets.set(row.slug, unionSet);

    // Track the winning source_id for pageNames (alphabetical-first wins).
    const prior = pageNameWinningSource.get(row.slug);
    if (prior === undefined || sourceId < prior) {
      pageNameWinningSource.set(row.slug, sourceId);
      pageNames.set(row.slug, name);
    }

    validSlugs.add(row.slug);
    // A slug becomes valid as soon as one source has a usable name; drop any
    // earlier malformed reason recorded against it.
    malformedReasonBySlug.delete(row.slug);
  }

  // Only mark a slug malformed if no source ever produced a valid row.
  const malformedSlugs = new Map<string, string>();
  for (const [slug, reason] of malformedReasonBySlug) {
    if (!validSlugs.has(slug)) malformedSlugs.set(slug, reason);
  }

  return { sets, setsBySource, pageNames, pageNamesBySource, malformedSlugs };
}

/**
 * Mask the leading YAML frontmatter slice with spaces so offsets transfer
 * cleanly to the original (un-masked) source. Tolerates CRLF line endings
 * (Windows producers + iCloud sync sometimes carry `\r\n` through).
 */
function maskFrontmatter(content: string): string {
  const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content);
  if (!fmMatch) return content;
  return ' '.repeat(fmMatch[0].length) + content.slice(fmMatch[0].length);
}

// CommonMark permits optional whitespace immediately after `(` and before `)`
// in inline links. We tolerate that on either side of the slug capture but
// not inside the slug itself (slug shape is still strict). We intentionally
// do NOT handle nested-bracket labels like `[[X]](people/Y)` — the producer
// markdown subset we audit does not emit that shape; see TODOS.md for the
// formal contract list.
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(\s*([./]*people\/[a-z][a-z0-9-]{0,61}[a-z0-9])(\.md)?\s*\)/g;

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
    const sourceIdCapture = m[1];
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
      source_id: sourceIdCapture,
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
 * Normalize a display string for case-folded set membership. Collapses
 * any run of ASCII whitespace (including embedded newlines from links that
 * wrap across lines) into a single space before caseFolding. The canonical
 * set's keys come from `split(/\s+/)` so they're already single-space
 * normalized; this matches.
 */
function normalizeDisplayForLookup(display: string): string {
  return caseFold(display.replace(/\s+/g, ' ').trim());
}

/**
 * Look up the canonical-name set for a given (slug, source_id?) pair.
 *
 * Qualified wikilinks pass `source_id`. The lookup tries the per-source
 * set first; if that source has no row for the slug, it falls through to
 * the brain-wide union (covers cases where a producer wrote a qualified
 * link before the multi-source schema landed, or where the slug only
 * exists in a different source). Unqualified links always use the
 * brain-wide union.
 *
 * Returns undefined when neither lookup yields a set — the caller treats
 * that as `unknown_target`.
 */
function lookupCanonicalSet(
  occ: LinkOccurrence,
  sets: CanonicalNameSets,
  setsBySource: Map<string, Set<string>>,
): Set<string> | undefined {
  if (occ.source_id) {
    const bySource = setsBySource.get(`${occ.source_id}:${occ.slug}`);
    if (bySource) return bySource;
  }
  return sets.get(occ.slug);
}

/**
 * Classify each LinkOccurrence against the canonical-name sets. Emits one
 * AuditMismatch per (kind, file, slug, display) tuple; duplicate occurrences
 * are collapsed onto the first emission with `occurrences` incremented and
 * the FIRST `line` seen preserved.
 *
 * Resolution order per occurrence:
 *   1. slug in malformedSlugs              -> malformed_target
 *   2. neither (source_id, slug) nor slug
 *      in sets                             -> unknown_target
 *   3. normalized(display) in set          -> legitimate, skip
 *   4. otherwise                           -> name_mismatch
 *
 * Source-axis routing (see `buildCanonicalNameSets` docstring): qualified
 * wikilinks consult the per-source set first; unqualified links match
 * brain-wide.
 */
export function classifyOccurrences(
  occurrences: LinkOccurrence[],
  sets: CanonicalNameSets,
  malformedSlugs: Map<string, string>,
  setsBySource: Map<string, Set<string>> = new Map(),
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
      const set = lookupCanonicalSet(occ, sets, setsBySource);
      if (!set) {
        kind = 'unknown_target';
      } else {
        if (set.has(normalizeDisplayForLookup(occ.display))) continue;  // legitimate
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
 * every name_mismatch occurrence with the page's canonical `name`. Mode 2
 * (unknown_target, malformed_target) is NOT touched.
 *
 * Canonical name pick (multi-source): when `occurrence.source_id` is set
 * (qualified wikilink) and a per-source `pageNamesBySource` entry exists
 * for that (source_id, slug) pair, the auto-fix snaps to the matching
 * source's `name`. Otherwise it falls back to the brain-wide `pageNames`
 * entry, which is the alphabetical-first source_id's `name` per
 * `buildCanonicalNameSets`. Single-source brains have a one-row
 * `pageNamesBySource` map so the policy degenerates to the v1 behavior.
 *
 * Rewrites end-to-start (sorted by displayStart desc) so earlier offsets
 * remain valid as later splices land.
 *
 * Idempotent: a second call on the same content produces no further fixes
 * because the rewritten display matches the canonical set's membership.
 */
export function applyDisplayFixes(
  fileContent: string,
  occurrences: LinkOccurrence[],
  mismatches: AuditMismatch[],
  pageNames: Map<string, string>,
  pageNamesBySource: Map<string, string> = new Map(),
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
    let canonical: string | undefined;
    if (occ.source_id) {
      canonical = pageNamesBySource.get(`${occ.source_id}:${occ.slug}`);
    }
    if (canonical === undefined) canonical = pageNames.get(occ.slug);
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
