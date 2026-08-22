/**
 * Shared link/timeline extraction utilities.
 *
 * Used by:
 *   - src/commands/extract.ts             (batch DB + FS extraction — `gbrain extract links|timeline|all`)
 *   - src/commands/backlinks.ts           (filesystem walk, legacy)
 *   - src/core/operations.ts put_page     (auto-link post-hook)
 *
 * All functions are PURE (no DB access). The DB lives in the engine; these
 * utilities turn page content into candidates that callers persist via engine
 * methods. Auto-link config is the one impure helper (reads engine.getConfig).
 */

import type { BrainEngine } from './engine.ts';
import type { PageType, EffectiveDateSource } from './types.ts';
import { ensureWellFormed } from './text-safe.ts';
import { stripCodeBlocks } from './markdown-code.ts';
import { parseInlineCitationTimelineEntries } from './timeline-citations.ts';
import { slugifyPath } from './sync.ts';
import { SLUG_WORD_CHARS } from './cjk.ts';
// #3190: pack-aware link typing. link-inference imports only manifest-v1
// (zod) + redos-guard (node:vm) — no cycle back into this module.
import type { SchemaPackManifest } from './schema-pack/manifest-v1.ts';
import { inferLinkTypeFromPack, frontmatterLinkTypeFromPack } from './schema-pack/link-inference.ts';
import { PageRegexBudget } from './schema-pack/redos-guard.ts';

/**
 * #3190: the slice of a schema-pack manifest link extraction consumes.
 * Callers thread the ACTIVE pack's manifest (loadActivePackForLocalEngine /
 * loadActivePackBestEffort → `.manifest`); null/undefined keeps the legacy
 * in-code inference exactly as before.
 */
export type LinkExtractionPack = Pick<SchemaPackManifest, 'link_types' | 'frontmatter_links'>;

export { stripCodeBlocks } from './markdown-code.ts';
export { parseInlineCitationTimelineEntries, type InlineCitationTimelineCandidate } from './timeline-citations.ts';

/**
 * v0.42.7 — link-extraction version stamp. Bump this ISO timestamp whenever the
 * shape of `extractPageLinks` / `inferLinkType` / `parseTimelineEntries` changes
 * meaningfully, so the extraction freshness watermark (`pages.links_extracted_at`)
 * treats every previously-stamped page as stale and re-extracts it on the next
 * `gbrain extract --stale` sweep. Same role CHUNKER_VERSION plays for chunking.
 *
 * Consumed by `countStalePagesForExtraction` / `listStalePagesForExtraction`
 * (both engines) and the `links_extraction_lag` doctor check: a page is stale
 * when `links_extracted_at IS NULL OR links_extracted_at < LINK_EXTRACTOR_VERSION_TS
 * OR updated_at > links_extracted_at`. It is an ISO-8601 string (NOT a number) —
 * the column is TIMESTAMPTZ and the predicate binds it as `::timestamptz`.
 */
// 2026-08-21: re-bumped for #2367 — normalizeBasename semantics changed
// (non-Latin scripts kept, accents folded like the slug grammar), so
// pre-#2367 extractions must re-run to pick up the newly-resolvable links.
// Subsumes the 2026-08-19 fix-wave-i bump (#3466 unevidenced people/ ->
// companies/ adjacency infers 'mentions', not 'works_at'; #2576 bug-2
// DIR_PATTERN whitelist no longer drops non-whitelisted-directory links).
// The watermark MUST NOT be in the future: the stamp path clamps
// links_extracted_at up to the watermark (so a fresh extraction isn't
// immediately re-listed), which means a future watermark masks concurrent
// edits until that date — the exact race D4 guards (test/extract-stale.test.ts).
// The converse limitation is inherent and accepted: a stamp written by
// PRE-wave code after this date reads as fresh and won't re-extract until
// the page is next edited; no fixed watermark can cover code that keeps
// running past it.
export const LINK_EXTRACTOR_VERSION_TS = '2026-08-21T00:00:00Z';

// ─── Entity references ──────────────────────────────────────────

export interface EntityRef {
  /** Display name from the markdown link, e.g. "Alice Chen". */
  name: string;
  /** Resolved page slug, e.g. "people/alice-chen". */
  slug: string;
  /** Top-level directory ("people" | "companies" | etc.). */
  dir: string;
  /**
   * v0.17.0: source id when the link was qualified as `[[source:slug]]`.
   * `null` means unqualified — the caller resolves via local-first fallback
   * at extraction time. Mirrors links.resolution_type:
   *   - sourceId set   → 'qualified'
   *   - sourceId null  → 'unqualified'
   */
  sourceId?: string | null;
  /**
   * Issue #972: set when the ref came from the generic `[[bare-name]]`
   * pass (not gated by DIR_PATTERN). The `slug` field holds the literal
   * wikilink text — callers MUST run it through a SlugResolver's
   * `resolveBasenameMatches` (gated by `link_resolution.global_basename`)
   * before persisting. Untagged refs already match a known entity dir
   * (people/, companies/, etc.) and need no resolution.
   *
   * One ref tagged `needsResolution: true` may resolve to MULTIPLE target
   * slugs when multiple pages share the basename. The caller emits one
   * LinkCandidate per resolved match.
   */
  needsResolution?: boolean;
  /**
   * Number of leading `../` segments on the original markdown link (0 when
   * absent or for engine-slug refs). The match regex strips the `../` run, so
   * this preserves the relative depth for callers that know the linking page's
   * slug (`extractPageLinks`) to resolve the target against the page's own
   * directory. Without it, `[x](../concepts/x.md)` from a nested page resolves
   * as the root-relative `concepts/x` instead of `<page-dir-parent>/concepts/x`
   * — the reason subtree-scoped / nested brains got zero cross-dir edges.
   */
  upLevels?: number;
  /**
   * #3190: set for a same-directory markdown link — `[Name](slug.md)` with
   * no directory segment and no scheme. `slug` holds the target basename
   * (`.md` stripped); the caller (`extractPageLinks`) resolves it against
   * the LINKING page's directory, mirroring the FS path's `resolveSlug`.
   * Pre-fix these refs were silently dropped (pass 1 requires `dir/`),
   * so flat directories and sibling links produced zero DB-path edges.
   */
  sameDir?: boolean;
}

/**
 * Issue #972: edge type stamped on graph rows produced by the
 * global-basename wikilink resolution path. Distinct from the verb-
 * inferred types (`mentions`, `works_at`, etc.) so users can audit or
 * prune via `gbrain graph-query <slug> --type wikilink_basename`.
 *
 * All edges from this path also carry `linkSource: 'wikilink-resolved'`
 * (the link-source provenance is the why; this edge type is the what).
 */
export const WIKILINK_BASENAME_LINK_TYPE = 'wikilink_basename';

/** v0.17.0: how a link's target source was pinned at extraction time. */
export type LinkResolutionType = 'qualified' | 'unqualified';

/**
 * Directory prefix whitelist. These are the canonical top-level slug dirs
 * (gbrain-base pack dirs + historical extensions). #2576 (bug 2): this list
 * is NO LONGER a drop-gate for markdown links, bare-slug prose refs, or
 * slash-shaped wikilinks — those now match ANY_DIR_SEGMENT and rely on the
 * downstream page-existence checks that every persist path already runs
 * (resolveCandidateSources in extract.ts, the allSlugs filter in put_page
 * auto-link, and addLinksBatch's INNER JOINs as the final backstop). The
 * whitelist survives only as the typed fast-path for pass-2b wikilinks;
 * non-whitelisted `[[dir/...]]` get equivalent treatment in pass 2c.
 */
const DIR_PATTERN = '(?:people|companies|meetings|concepts|deal|civic|project|projects|source|media|yc|tech|finance|personal|openclaw|entities|reference)';

/**
 * #2576 (bug 2): a plausible top-level slug directory — lowercase alnum
 * with dashes/underscores, digit-leading allowed (`90-people`). Used where
 * the hardcoded DIR_PATTERN whitelist used to silently drop every
 * user-invented directory (`ops/`, `notes/`, custom schema-pack dirs).
 * Candidates matched through this are validated for page existence
 * downstream, so a wider net creates no dead edges — only candidates.
 */
const ANY_DIR_SEGMENT = '[a-z0-9][a-z0-9_-]*';

/**
 * Match `[Name](path)` markdown links pointing at page-shaped paths.
 * Accepts both filesystem-relative format (`[Name](../people/slug.md)`)
 * AND engine-slug format (`[Name](people/slug)`).
 *
 * Captures: name, slug (dir/name, possibly deeper).
 *
 * The regex permits an optional `../` prefix (any number) and an optional
 * `.md` suffix so the same function works for both filesystem and DB content.
 *
 * #2576 (bug 2): the first segment is ANY_DIR_SEGMENT, not the DIR_PATTERN
 * whitelist — `[Pointer](../ops/services/pointer-agent.md)` must produce a
 * candidate for a brain that has an `ops/` directory. Nonexistent targets
 * are dropped by the callers' existence checks, exactly as before.
 */
const ENTITY_REF_RE = new RegExp(
  `\\[([^\\]]+)\\]\\((?:\\.\\.\\/)*(${ANY_DIR_SEGMENT}\\/[^)\\s]+?)(?:\\.md)?\\)`,
  'g',
);

/**
 * Match Obsidian-style `[[path]]` or `[[path|Display Text]]` wikilinks.
 * Captures: slug (dir/...), displayName (optional).
 *
 * Same dir whitelist as ENTITY_REF_RE. Strips trailing `.md`, strips section
 * anchors (`#heading`), skips external URLs. Wiki KBs use this format almost
 * exclusively so missing it leaves the graph empty.
 */
const WIKILINK_RE = new RegExp(
  `\\[\\[(${DIR_PATTERN}\\/[^|\\]#]+?)(?:#[^|\\]]*?)?(?:\\|([^\\]]+?))?\\]\\]`,
  'g',
);

/**
 * v0.17.0: qualified wikilink `[[source-id:dir/slug]]` or
 * `[[source-id:dir/slug|Display Text]]`. The source-id segment pins the
 * target to a specific sources(id) row, overriding the local-first
 * fallback used by unqualified `[[slug]]` references.
 *
 * Captures: sourceId, slug (dir/...), displayName (optional).
 *
 * Matched BEFORE WIKILINK_RE so `[[wiki:topics/ai]]` isn't mis-parsed by
 * the unqualified regex (the source prefix would not satisfy DIR_PATTERN
 * anyway, but the two-pass approach keeps intent crystal-clear).
 */
const QUALIFIED_WIKILINK_RE = new RegExp(
  `\\[\\[([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?):(${DIR_PATTERN}\\/[^|\\]#]+?)(?:#[^|\\]]*?)?(?:\\|([^\\]]+?))?\\]\\]`,
  'g',
);

/**
 * Issue #972: generic Obsidian-style wikilink — matches `[[anything]]`
 * with no DIR_PATTERN gate. Wiki/topic/learning pages frequently link
 * via `[[bare-name]]` (`[[Fast-Weigh]]`, `[[2026-05-07-cost-plan]]`,
 * `[[struktura]]`) where the literal text isn't a canonical slug; the
 * resolver is responsible for matching it to the real page via
 * basename uniqueness.
 *
 * Used AFTER QUALIFIED_WIKILINK_RE and WIKILINK_RE pick off their
 * cases — the masked-ranges pass in extractEntityRefs prevents
 * double-emission. Refs from this pass are tagged
 * `needsResolution: true` so callers know to run them through a
 * SlugResolver before the page-existence check.
 *
 * Regex shape is the union of the two existing wikilink regexes,
 * minus the DIR_PATTERN gate. The character class disallows pipe,
 * close-bracket, hash (anchor separator), newline, and open-bracket
 * so we never match across line breaks or capture nested `[[...]]`.
 *
 * Adapted from PR #1233 (rayers).
 */
const WIKILINK_GENERIC_RE = /\[\[([^|\]#\n[]+?)(?:#[^|\]]*?)?(?:\|([^\]]+?))?\]\]/g;

/**
 * Issue #972 (codex [P2]): a markdown link whose LABEL contains a wikilink,
 * e.g. `[see [[acme]]](companies/acme.md)`. Pass-1's ENTITY_REF_RE can't match
 * the nested `]]` so it never spans this; without masking, the generic 2c pass
 * would emit a stray basename ref for the inner `[[acme]]`. Mask the whole
 * span out of the 2c scan so a wikilink inside a markdown label is inert.
 */
const MARKDOWN_LABEL_WIKILINK_RE = /\[[^\]\n]*\[\[[^\]\n]+\]\][^\]\n]*\]\([^)\n]+\)/g;

/**
 * #3190: same-directory markdown link — `[Name](slug.md)` whose target has
 * NO directory segment and NO scheme/anchor (`/`, `:`, `#` all excluded).
 * The `.md` suffix is REQUIRED (mirrors the FS extractor's mdPattern) so
 * bare parenthetical prose (`[sic](reference)`) never produces a ref.
 * Resolution against the linking page's directory happens in
 * extractPageLinks (this module has no page context here).
 */
const SAME_DIR_MD_RE = /\[([^\]]+)\]\(([^)/:#\s]+?)\.md\)/g;

/**
 * A code-reference found in markdown prose. Created by extractCodeRefs and
 * consumed by importFromFile's tail to build doc↔impl edges (v0.19.0 E1).
 */
export interface CodeRef {
  /** Raw matched path (e.g. 'src/core/sync.ts'). */
  path: string;
  /** Optional line number from 'src/foo.ts:42'. */
  line?: number;
  /** Index in the source string. */
  index: number;
}

// v0.19.0 E1 — markdown guides that cite 'src/core/sync.ts:42' create an
// edge to the code page that imported that file. Regex is anchored against
// the common gbrain repo layout directories so arbitrary prose like
// "in foo/bar.js" doesn't generate false positives.
//
// The extension list is aligned with detectCodeLanguage in chunkers/code.ts.
// Paths NOT matching these extensions are ignored because they wouldn't
// have a code page to edge to anyway.
const CODE_REF_REGEX = /\b((?:src|lib|app|test|tests|scripts|docs|packages|internal|cmd|examples)\/[\w\-./]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|cs|cpp|cc|hpp|c|h|php|swift|kt|scala|lua|ex|exs|elm|ml|dart|zig|sol|sh|bash|css|html|astro|svelte|vue|json|yaml|yml|toml))(?::(\d+))?\b/g;

/**
 * Extract code-path references (e.g. 'src/core/sync.ts:42') from markdown
 * prose. Deduped by path.
 */
/**
 * v0.27.1 (cherry-3): path-proximity auto-link candidate finder for image
 * ingest. Given an image slug like `originals/photos/2026-05-04-foo.jpg`,
 * proposes candidate sibling slugs for an `image_of` edge:
 *   1. `originals/meetings/2026-05-04-foo.md` (parallel directory + same basename)
 *   2. `<parent>/foo.md` (same directory + sibling basename minus extension)
 *
 * Returns slug candidates in priority order. Caller (importImageFile) checks
 * which candidates exist as pages and emits the edge for the first match.
 */
export function imageOfCandidates(imageSlug: string): string[] {
  const lower = imageSlug.toLowerCase();
  const lastSlash = lower.lastIndexOf('/');
  if (lastSlash < 0) return [];
  const dir = lower.slice(0, lastSlash);
  const file = lower.slice(lastSlash + 1);
  // Strip image extension from basename to get a stable identifier.
  const base = file.replace(/\.(png|jpg|jpeg|gif|webp|heic|heif|avif)$/i, '');
  if (!base) return [];

  const out: string[] = [];

  // Heuristic 1: parallel directory swap. originals/photos/X → originals/meetings/X
  const dirParts = dir.split('/');
  const PHOTO_DIRS = new Set(['photos', 'images', 'screenshots', 'media']);
  const SIBLING_DIRS = ['meetings', 'notes', 'daily', 'people', 'companies', 'deals', 'projects'];
  for (let i = 0; i < dirParts.length; i++) {
    if (PHOTO_DIRS.has(dirParts[i])) {
      for (const sib of SIBLING_DIRS) {
        const swapped = [...dirParts];
        swapped[i] = sib;
        out.push(`${swapped.join('/')}/${base}`);
      }
    }
  }

  // Heuristic 2: same directory, basename without ext as a markdown page.
  out.push(`${dir}/${base}`);

  // Deduplicate, drop the imageSlug itself if it accidentally roundtrips.
  const seen = new Set<string>();
  return out.filter(s => {
    if (s === lower) return false;
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

export function extractCodeRefs(content: string): CodeRef[] {
  const seen = new Set<string>();
  const refs: CodeRef[] = [];
  let match: RegExpExecArray | null;
  // Using a fresh regex object per call to avoid lastIndex state leaking
  // across invocations.
  const re = new RegExp(CODE_REF_REGEX.source, 'g');
  while ((match = re.exec(content)) !== null) {
    const path = match[1]!;
    if (seen.has(path)) continue;
    seen.add(path);
    const line = match[2] ? parseInt(match[2], 10) : undefined;
    refs.push({ path, line, index: match.index });
  }
  return refs;
}

/**
 * Extract `[Name](path-to-people-or-company)` references from arbitrary content.
 * Both filesystem-relative paths (with `../` and `.md`) and bare engine-style
 * slugs (`people/slug`) are matched. Returns one EntityRef per match (no dedup
 * here; caller dedups). Slugs appearing inside fenced or inline code blocks
 * are excluded — those are typically code samples, not real entity references.
 */
export function extractEntityRefs(content: string): EntityRef[] {
  const stripped = stripCodeBlocks(content);
  const refs: EntityRef[] = [];
  let match: RegExpExecArray | null;

  // 1. Markdown links: [Name](path)
  //    Markdown links have no source-qualification syntax — they're
  //    always unqualified. Omit sourceId so the shape stays compatible
  //    with pre-v0.17 consumers doing strict equality.
  const markdownRanges: Array<[number, number]> = [];
  const mdPattern = new RegExp(ENTITY_REF_RE.source, ENTITY_REF_RE.flags);
  while ((match = mdPattern.exec(stripped)) !== null) {
    const name = match[1];
    let fullPath = match[2];
    // Obsidian's useMarkdownLinks mode percent-encodes link targets
    // (`[Alice](people/alice%20chen)`). Decode before resolution; a
    // malformed escape keeps the raw text rather than throwing.
    if (fullPath.includes('%')) {
      try { fullPath = decodeURIComponent(fullPath); } catch { /* keep raw */ }
    }
    const slug = fullPath;
    const dir = fullPath.split('/')[0];
    // The regex strips the leading `../` run from `fullPath`; recover its depth
    // from the raw link target so extractPageLinks can resolve relative to the
    // linking page's directory. `[x](path)` has no `](` collision because the
    // capture stops before the first unescaped `)`.
    const rawTarget = match[0].slice(match[0].indexOf('](') + 2, -1);
    const up = rawTarget.match(/^(?:\.\.\/)+/);
    const ref: EntityRef = { name, slug, dir };
    // Only relative links carry depth; absolute / engine-slug refs keep the
    // exact {name, slug, dir} shape (no upLevels key) so equality consumers
    // are unaffected.
    if (up) ref.upLevels = up[0].length / 3;
    refs.push(ref);
    markdownRanges.push([match.index, match.index + match[0].length]);
  }

  // 1b. #3190: same-directory markdown links — `[Name](slug.md)` (no `/`,
  //     no scheme). Pass 1 requires a `dir/` segment, so sibling links in
  //     flat directories were silently dropped on the DB path while the FS
  //     walker (extractMarkdownLinks → resolveSlug) linked them. Tagged
  //     `sameDir: true`; extractPageLinks resolves against the page's dir.
  //     Disjoint from pass 1 (its targets always contain `/`).
  const sameDirPattern = new RegExp(SAME_DIR_MD_RE.source, SAME_DIR_MD_RE.flags);
  while ((match = sameDirPattern.exec(stripped)) !== null) {
    const name = match[1];
    let target = match[2];
    if (target.includes('%')) {
      try { target = decodeURIComponent(target); } catch { /* keep raw */ }
    }
    refs.push({ name, slug: target, dir: '', sameDir: true });
    markdownRanges.push([match.index, match.index + match[0].length]);
  }

  // 2a. v0.17.0 qualified wikilinks: [[source-id:path]] or [[source-id:path|Display]]
  //     Must run BEFORE the unqualified pass or we'd double-emit. We also
  //     mask out the matched spans so pass 2b can't grab them.
  const qualifiedRanges: Array<[number, number]> = [];
  const qualPattern = new RegExp(QUALIFIED_WIKILINK_RE.source, QUALIFIED_WIKILINK_RE.flags);
  while ((match = qualPattern.exec(stripped)) !== null) {
    const sourceId = match[1];
    let slug = stripEscapedPipeTail(match[2].trim());
    if (!slug) continue;
    if (slug.includes('://')) continue;
    if (slug.endsWith('.md')) slug = slug.slice(0, -3);
    const displayName = (match[3] || slug).trim();
    const dir = slug.split('/')[0];
    refs.push({ name: displayName, slug, dir, sourceId });
    qualifiedRanges.push([match.index, match.index + match[0].length]);
  }

  // 2b. Unqualified Obsidian wikilinks: [[path]] or [[path|Display Text]]
  //     Same shape rule: omit sourceId when unqualified.
  const unqualifiedRanges: Array<[number, number]> = [];
  const unmasked = maskRanges(stripped, qualifiedRanges);
  const wikiPattern = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
  while ((match = wikiPattern.exec(unmasked)) !== null) {
    let slug = stripEscapedPipeTail(match[1].trim());
    if (!slug) continue;
    if (slug.includes('://')) continue;
    if (slug.endsWith('.md')) slug = slug.slice(0, -3);
    const displayName = (match[2] || slug).trim();
    const dir = slug.split('/')[0];
    refs.push({ name: displayName, slug, dir });
    unqualifiedRanges.push([match.index, match.index + match[0].length]);
  }

  // 2c. Issue #972: generic `[[bare-name]]` wikilinks not gated by
  //     DIR_PATTERN. Wiki/topic/learning content frequently uses these
  //     where the bare text isn't a canonical brain slug. Tagged
  //     `needsResolution: true` so the caller routes them through a
  //     SlugResolver's `resolveBasenameMatches` before persisting.
  //     Mask out 2a/2b ranges so we don't double-emit; skip qualified-
  //     syntax tokens (contain `:`) that would be 2a's job. Issue #972
  //     (codex [P2]): ALSO mask pass-1 markdown-link ranges so a wikilink
  //     inside a markdown label — `[see [[acme]]](companies/acme.md)` —
  //     doesn't spawn a stray generic basename ref from inside the label.
  const labelWikilinkRanges: Array<[number, number]> = [];
  const labelWlPattern = new RegExp(MARKDOWN_LABEL_WIKILINK_RE.source, MARKDOWN_LABEL_WIKILINK_RE.flags);
  while ((match = labelWlPattern.exec(stripped)) !== null) {
    labelWikilinkRanges.push([match.index, match.index + match[0].length]);
  }
  const genericMasked = maskRanges(
    stripped,
    [...markdownRanges, ...qualifiedRanges, ...unqualifiedRanges, ...labelWikilinkRanges],
  );
  const genericPattern = new RegExp(WIKILINK_GENERIC_RE.source, WIKILINK_GENERIC_RE.flags);
  while ((match = genericPattern.exec(genericMasked)) !== null) {
    let slug = stripEscapedPipeTail(match[1].trim());
    if (!slug) continue;
    if (slug.includes('://')) continue;
    if (slug.includes(':')) continue; // qualified-syntax token; 2a owns these
    if (slug.endsWith('.md')) slug = slug.slice(0, -3);
    const displayName = (match[2] || slug).trim();
    const dir = slug.includes('/') ? slug.split('/')[0] : '';
    refs.push({ name: displayName, slug, dir, needsResolution: true });
  }

  return refs;
}

/**
 * #4062: strip the trailing backslash(es) an escaped pipe leaves on a
 * wikilink target. Inside a markdown table cell the pipe separating the
 * target from its display alias MUST be escaped (`[[dir/slug\|Alias]]`,
 * Obsidian's own table syntax) or it would end the cell. The wikilink
 * slug captures stop at the literal `|`, so the escape backslash lands as
 * the final character of the captured target — a slug shape that can
 * never match a real page. Slugs never legitimately contain backslashes,
 * so stripping the trailing run is lossless. Applied to passes 2a/2b/2c.
 */
function stripEscapedPipeTail(slug: string): string {
  return slug.replace(/\\+$/, '');
}

/**
 * Replace the byte ranges with spaces, preserving offsets. Used by
 * extractEntityRefs to prevent the unqualified wikilink regex from
 * matching inside a qualified wikilink span.
 */
function maskRanges(content: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return content;
  const chars = content.split('');
  for (const [s, e] of ranges) {
    for (let i = s; i < e && i < chars.length; i++) chars[i] = ' ';
  }
  return chars.join('');
}

/**
 * Resolve a markdown ref's target against the LINKING page's directory when the
 * original link was relative (had one or more `../`). Filesystem markdown links
 * are relative to the file that contains them: `[x](../concepts/x.md)` from a
 * page at `wiki/sources/foo` points at `wiki/concepts/x`, not the root-relative
 * `concepts/x`. The match regex discards the `../` run, so `ref.upLevels` carries
 * the depth and this reconstructs the absolute page slug.
 *
 * Backward-compatible: for a page one level below the root (`meetings/m` +
 * `../people/alice` → `people/alice`) the parent walk lands exactly at the root,
 * so the result is identical to the old `../`-stripping behavior. It only
 * diverges — correctly — when the linking page is nested deeper than the `../`
 * count unwinds, i.e. content under a prefix (subtree-scoped sources). An over-
 * long `../` run clamps at the root. Absolute refs (upLevels 0, e.g. engine-slug
 * `people/x` or `[[wikilinks]]`) are returned unchanged.
 */
function resolveRelativeSlug(pageSlug: string, ref: EntityRef): string {
  if (!ref.upLevels || ref.upLevels <= 0) return ref.slug;
  const dirSegs = pageSlug.includes('/') ? pageSlug.split('/').slice(0, -1) : [];
  const keep = Math.max(0, dirSegs.length - ref.upLevels);
  return [...dirSegs.slice(0, keep), ref.slug].join('/');
}

// ─── Link candidates (richer than EntityRef) ────────────────────

export interface LinkCandidate {
  /**
   * Source page slug for the edge. When omitted, callers default to
   * "the page being written" (operations.ts runAutoLink) or "the page
   * currently being processed" (extract.ts). Explicitly set when
   * frontmatter emits an incoming edge — e.g. a company page's
   * `key_people: [pedro-franceschi]` produces a candidate whose
   * fromSlug is `people/pedro-franceschi`, not the company.
   */
  fromSlug?: string;
  /** Target page slug (no .md, no ../). */
  targetSlug: string;
  /** Inferred relationship type. */
  linkType: string;
  /** Surrounding text (up to ~80 chars) used for inference + storage. */
  context: string;
  /**
   * Provenance (v0.13+). Defaults to 'markdown' on older call sites;
   * frontmatter-derived candidates set 'frontmatter'; user-created edges
   * via explicit API pass 'manual'.
   */
  linkSource?: string;
  /**
   * Origin-page slug. Only populated for link_source='frontmatter' so
   * reconciliation can scope cleanups to edges THIS page's frontmatter
   * created (never touching edges other pages authored).
   */
  originSlug?: string;
  /** Frontmatter field name (e.g. 'key_people'), for debug + unresolved report. */
  originField?: string;
}

/**
 * Result of extractPageLinks. `candidates` includes markdown refs + bare
 * slug refs + frontmatter-derived edges (v0.13). `unresolved` lists
 * frontmatter names that did not resolve to any page — surfaced in the
 * put_page auto_links response and the extract summary so users know
 * where the graph has holes.
 */
export interface PageLinksResult {
  candidates: LinkCandidate[];
  unresolved: UnresolvedFrontmatterRef[];
}

/**
 * Extract all link candidates from a page.
 *
 * Sources:
 *   1. Markdown entity refs in compiled_truth + timeline (extractEntityRefs).
 *   2. Bare slug references in text (people/slug, companies/slug).
 *   3. Frontmatter fields → typed graph edges (v0.13: company, investors,
 *      attendees, key_people, etc.). See FRONTMATTER_LINK_MAP.
 *
 * ASYNC (v0.13): frontmatter extraction resolves display names to slugs
 * via the supplied resolver, which may hit the DB. Pre-v0.13 callers
 * that don't care about frontmatter can pass a resolver that always
 * returns null; only markdown/bare-slug candidates are emitted.
 *
 * Within-page dedup: multiple mentions of the same (fromSlug, targetSlug,
 * linkType) tuple collapse to one candidate. First occurrence wins.
 */
export async function extractPageLinks(
  slug: string,
  content: string,
  frontmatter: Record<string, unknown>,
  pageType: PageType,
  resolver: SlugResolver,
  opts: { globalBasename?: boolean; skipFrontmatter?: boolean; pack?: LinkExtractionPack | null } = {},
): Promise<PageLinksResult> {
  const candidates: LinkCandidate[] = [];

  // #3190: pack-aware verb inference. Pack-declared verbs win (page-type
  // bindings, then pack regexes under the shared per-page ReDoS budget);
  // the in-code inferLinkType stays the fall-through for everything the
  // pack doesn't claim — matching the resolution order extract-ner already
  // ships (schema-pack/link-inference.ts header). Pre-fix a user pack's
  // `link_types[].inference.regex` (e.g. parent_of) was silently ignored
  // here and every such edge landed as 'mentions'.
  const pack = opts.pack ?? null;
  const packBudget = pack ? new PageRegexBudget() : undefined;
  const typeFor = (ctx: string, targetSlug: string): string => {
    if (pack) {
      const packVerb = inferLinkTypeFromPack(pack, pageType as string, ctx, packBudget);
      if (packVerb) return packVerb;
    }
    return inferLinkType(pageType, ctx, content, targetSlug);
  };

  // 1. Markdown entity refs.
  for (const ref of extractEntityRefs(content)) {
    // #3190: same-directory markdown link — resolve against THIS page's
    // directory (the FS path's resolveSlug does exactly this via
    // join(fileDir, target)). Slugified through the sync grammar so
    // `[Alice](Alice%20Chen.md)` reaches `people/alice-chen`. Downstream
    // existence checks drop targets that aren't pages.
    if (ref.sameDir) {
      const dirSegs = slug.includes('/') ? slug.split('/').slice(0, -1) : [];
      const target = slugifyPath([...dirSegs, ref.slug].join('/'));
      if (target && target !== slug) {
        const idx = content.indexOf(ref.name);
        const context = idx >= 0 ? excerpt(content, idx, 240) : ref.name;
        candidates.push({
          targetSlug: target,
          linkType: typeFor(context, target),
          context,
          linkSource: 'markdown',
        });
      }
      continue;
    }
    // Issue #972: refs from the generic `[[bare-name]]` pass carry the
    // literal wikilink text, not a real page slug. When global_basename
    // mode is on AND the resolver implements basename lookup, resolve
    // to every matching page and emit one candidate per match. When the
    // flag is off (default), drop silently — back-compat with the
    // pre-v0.40.8.2 behavior of dropping bare wikilinks outside
    // DIR_PATTERN.
    if (ref.needsResolution) {
      const slashIdx = ref.slug.lastIndexOf('/');
      // #2576 (bug 2): a slash-shaped wikilink outside DIR_PATTERN
      // (`[[ops/services/pointer-agent]]`) gets the SAME treatment a
      // whitelisted dir gets from pass 2b — a direct, verb-typed candidate
      // for the literal path, emitted regardless of the global_basename
      // flag. Downstream existence checks (resolveCandidateSources /
      // put_page's allSlugs filter / addLinksBatch's INNER JOINs) drop it
      // when no such page exists, exactly as they do for 2b candidates.
      // Pre-fix these refs were silently dropped (flag off) or demoted to
      // untyped wikilink_basename edges (flag on).
      if (slashIdx !== -1 && ref.slug !== slug) {
        const litIdx = content.indexOf(ref.slug);
        const litContext = litIdx >= 0 ? excerpt(content, litIdx, 240) : ref.name;
        candidates.push({
          targetSlug: ref.slug,
          linkType: typeFor(litContext, ref.slug),
          context: litContext,
          linkSource: 'markdown',
        });
      }
      // #4062: a bare `[[name]]` (no slash) gets a direct verb-typed
      // candidate for its root-exact slugified form, emitted regardless of
      // the global_basename flag — mirroring the FS path, where resolveSlug's
      // ancestor walk resolves `[[x]]` to a root page `x` before the
      // basename fallback ever runs. Pre-fix the DB path dropped these
      // entirely flag-off (0 candidates) while the FS path linked them.
      // Downstream existence checks (resolveCandidateSources / put_page's
      // allSlugs filter / addLinksBatch's INNER JOINs) drop the candidate
      // when no root page exists, exactly as for slash-shaped refs above.
      let bareDirect = '';
      if (slashIdx === -1) {
        bareDirect = slugifyPath(ref.slug);
        // Self-loop guard: `[[own-basename]]` on the root page itself.
        if (bareDirect && bareDirect !== slug) {
          const litIdx = content.indexOf(ref.slug);
          const litContext = litIdx >= 0 ? excerpt(content, litIdx, 240) : ref.name;
          candidates.push({
            targetSlug: bareDirect,
            linkType: typeFor(litContext, bareDirect),
            context: litContext,
            linkSource: 'markdown',
          });
        }
      }
      if (typeof resolver.resolveBasenameMatches !== 'function') continue;
      // Issue #972 (codex): resolve by the wikilink TARGET (ref.slug — the
      // text inside `[[...]]` before any `|`), NOT the display alias
      // (ref.name = match[2]). `[[struktura|the project]]` must resolve
      // `struktura`, not "the project". The display text is for context only.
      //
      // Issue #1964: a dir-qualified wikilink (`[[llm-wiki/entities/AI 3.0]]`)
      // carries a raw Obsidian path while page slugs are sync-slugified
      // (`llm-wiki/entities/ai-3.0`). Slugify the path the same way sync does,
      // then match by exact slug or path-suffix (wiki-root-relative authoring).
      // This runs regardless of global_basename — it's dir-qualified, so the
      // cross-dir false-positive risk the flag guards against doesn't apply.
      // Mirrors the FS path's resolveSlug ancestor walk. Bare `[[name]]`
      // wikilinks still require the global_basename flag.
      // The EXACT raw literal is excluded — the direct typed candidate
      // above already covers it (#2576), so keeping it would double-emit.
      let matches: string[] = [];
      const slugified = ref.slug.includes('/') ? slugifyPath(ref.slug) : '';
      if (slugified.includes('/')) {
        const tail = slugified.slice(slugified.lastIndexOf('/') + 1);
        matches = (await resolver.resolveBasenameMatches(tail))
          .filter(m => m !== ref.slug && (m === slugified || m.endsWith(`/${slugified}`)));
      } else if (opts.globalBasename) {
        // #4062: exclude the root-exact slugified form — the direct typed
        // candidate above already covers it (same rule the dir-qualified
        // branch applies to its raw literal). Keeping it would double-emit.
        matches = (await resolver.resolveBasenameMatches(ref.slug))
          .filter(m => m !== bareDirect);
      }
      if (matches.length === 0) continue;
      const idx = content.indexOf(ref.slug);
      const context = idx >= 0 ? excerpt(content, idx, 240) : ref.name;
      for (const matched of matches) {
        // Issue #972 (codex [P2]): a basename `[[own-tail]]` on its own page
        // resolves back to itself — drop the self-loop.
        if (matched === slug) continue;
        candidates.push({
          targetSlug: matched,
          linkType: WIKILINK_BASENAME_LINK_TYPE,
          context,
          linkSource: 'wikilink-resolved',
        });
      }
      continue;
    }
    const idx = content.indexOf(ref.name);
    // Wider context window (240 chars vs original 80) catches verbs that
    // appear at sentence-or-paragraph distance from the slug — common in
    // narrative prose where a partner's investment verbs appear once and
    // then portfolio companies are listed in subsequent sentences.
    const context = idx >= 0 ? excerpt(content, idx, 240) : ref.name;
    // Relative markdown links resolve against THIS page's directory (fixes
    // cross-dir edges for nested / subtree-scoped content); absolute refs pass
    // through unchanged.
    const targetSlug = resolveRelativeSlug(slug, ref);
    candidates.push({
      targetSlug,
      linkType: typeFor(context, targetSlug),
      context,
      linkSource: 'markdown',
    });
  }

  // 2. Bare slug references (e.g. "see people/alice-chen for context").
  // #2576 (bug 2): any dir-shaped path, not just the DIR_PATTERN whitelist —
  // `see ops/services/pointer-agent` must produce a candidate. Prose noise
  // that happens to look like a path (`on/off`, `com/foo/bar` inside a URL)
  // is dropped by the callers' page-existence checks, never persisted.
  // Code blocks are stripped first — slugs in code samples are not real refs.
  // Wikilink spans are masked too (equal-length blanks, so match indices stay
  // valid for excerpt()): the wikilink pass above owns `[[...]]` interiors,
  // and without the mask a dir-qualified wikilink like
  // `[[llm-wiki/entities/AI 3.0]]` leaves its lowercase prefix
  // `llm-wiki/entities` as a bare-path match — a spurious edge to the parent
  // page whenever that page exists.
  const strippedContent = stripCodeBlocks(content)
    .replace(/\[\[[^\]]*\]\]/g, (s) => ' '.repeat(s.length));
  const bareRe = new RegExp(
    `\\b(${ANY_DIR_SEGMENT}\\/[a-z0-9][a-z0-9/-]*[a-z0-9])\\b`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = bareRe.exec(strippedContent)) !== null) {
    // Skip matches that are part of a markdown link (already handled above).
    const charBefore = m.index > 0 ? strippedContent[m.index - 1] : '';
    if (charBefore === '/' || charBefore === '(') continue;
    // #2576: never emit a self-loop for a page mentioning its own slug.
    if (m[1] === slug) continue;
    const context = excerpt(strippedContent, m.index, 240);
    candidates.push({
      targetSlug: m[1],
      linkType: typeFor(context, m[1]),
      context,
      linkSource: 'markdown',
    });
  }

  // 3. Frontmatter-derived edges (v0.13). Includes the legacy `source:`
  // field along with the full field map. Caller can suppress via
  // `opts.skipFrontmatter` — used by `extractLinksFromDB` to keep
  // `--include-frontmatter` off semantics while still passing a real
  // resolver (needed for `resolveBasenameMatches` in global-basename
  // mode). Pre-issue-#972 this gating lived in the caller via a
  // synthetic `nullResolver`; that pattern broke once the bare-wikilink
  // path needed `resolveBasenameMatches` on the real resolver.
  let fmUnresolved: UnresolvedFrontmatterRef[] = [];
  if (!opts.skipFrontmatter) {
    const fm = await extractFrontmatterLinks(slug, pageType, frontmatter, resolver, opts.globalBasename, pack);
    candidates.push(...fm.candidates);
    fmUnresolved = fm.unresolved;
  }

  // Within-page dedup: same (fromSlug, targetSlug, linkType, linkSource)
  // collapses to one entry. First occurrence wins.
  // Issue #972 (codex P2d, decided): a qualified `[[companies/acme]]` (typed
  // markdown edge) and a bare `[[acme]]` (wikilink-resolved edge) to the SAME
  // target are KEPT as separate rows — they carry different provenance
  // (link_source) and link_type, and the audit trail (which kind of reference
  // created the edge) is worth more than collapsing them. graph-query callers
  // that want a unique target set dedup on to_slug themselves.
  const seen = new Set<string>();
  const result: LinkCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.fromSlug ?? ''}\u0000${c.targetSlug}\u0000${c.linkType}\u0000${c.linkSource ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return { candidates: result, unresolved: fmUnresolved };
}

/**
 * Excerpt a window of `width` chars around `idx`, collapsed to one line.
 *
 * The window is sliced by raw UTF-16 index, so a boundary can land inside a
 * surrogate pair (any non-BMP char — emoji, math alphanumerics, non-BMP CJK)
 * and leave a lone surrogate half. That lone half flows into the link `context`
 * field and, when the batch is serialized for the `jsonb_to_recordset` insert,
 * makes Postgres reject the WHOLE batch on the `::jsonb` cast — aborting the
 * entire `extract --stale` run (#2011). `ensureWellFormed` replaces any orphaned
 * half with U+FFFD before the slice escapes this function.
 */
function excerpt(s: string, idx: number, width: number): string {
  const half = Math.floor(width / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(s.length, idx + half);
  return ensureWellFormed(s.slice(start, end)).replace(/\s+/g, ' ').trim();
}

// ─── Relationship type inference (deterministic, zero LLM) ──────

// ─── Type-inference patterns ────────────────────────────────────
//
// Calibrated against the BrainBench rich-prose corpus (240 pages of
// LLM-generated narrative). The templated 80-page benchmark hit 94.4% type
// accuracy, but rich prose dropped to 70.7% before this round of tuning —
// LLMs use far more verb forms than the original regexes covered.
//
// Key issues fixed:
//   - INVESTED_RE missed "led the seed", "led the Series A", "early investor",
//     "invests in" (present), "investing in" (gerund), "portfolio company".
//   - ADVISES_RE matched generic "board member" / "sits on the board" which
//     also describes investors holding board seats. Tightened to require
//     explicit "advisor"/"advise" rooting.

// Employment context: position + at/of, or explicit work verbs.
//
// v0.10.5 additions (drive works_at 58% → >85% on rich prose):
//   - Role-prefixed engineer patterns: "senior engineer at", "staff engineer at",
//     "principal engineer at", "lead engineer at". Current "engineer at" only
//     hits if the word "engineer" is immediately adjacent; prose often uses
//     rank-qualified forms.
//   - Generic role patterns: "backend engineer at", "frontend engineer at",
//     "ML engineer at", "data engineer at", "full-stack engineer at".
//   - Broader role verbs: "manages engineering at", "running product at",
//     "leads the [team] at", "heads up engineering at".
//   - Possessive time: "his time at", "her time at", "their time at", "my time at".
//   - Role noun forms: "role at", "tenure as", "stint as", "position at".
//   - Promoted/staff-engineer forms: "promoted to (staff|senior|principal) engineer at".
const WORKS_AT_RE = /\b(?:CEO of|CTO of|COO of|CFO of|CMO of|CRO of|VP at|VP of|VPs? Engineering|VPs? Product|works at|worked at|working at|employed by|employed at|joined as|joined the team|engineer at|engineer for|director at|director of|head of|heads up .{0,20} at|leads engineering|leads product|leads the .{0,20} (?:team|org) at|manages engineering at|manages product at|running (?:engineering|product|design) at|currently at|previously at|previously worked at|spent .* (?:years|months) at|stint at|stint as|tenure at|tenure as|role at|position at|(?:senior|staff|principal|lead|backend|frontend|full-?stack|ML|data|security) engineer at|promoted to (?:senior|staff|principal|lead) .{0,20} at|(?:his|her|their|my) time at)\b/i;

// Investment context. Order patterns from most-specific to least to keep
// regex efficient. Includes funding-round verbs ("led the seed", "led X's
// Series A"), narrative verbs ("invests in", "investing in"), historical
// ("early investor in", "first check"), and portfolio framing ("portfolio
// company", "portfolio includes").
const INVESTED_RE = /\b(?:invested in|invests in|investing in|invest in|investment in|investments in|backed by|funding from|funded by|raised from|led the (?:seed|Series|round|investment|round)|led .{0,30}(?:Series [A-Z]|seed|round|investment)|participated in (?:the )?(?:seed|Series|round)|wrote (?:a |the )?check|first check|early investor|portfolio (?:company|includes)|board seat (?:at|in|on)|term sheet for)\b/i;

// Founded patterns. Includes the noun-form "founder of" / "founders include"
// because that's how real prose identifies founders ("Carol Wilson is the
// founder of Anchor"). Diagnosed via BrainBench rich-corpus misses.
const FOUNDED_RE = /\b(?:founded|co-?founded|started the company|incorporated|founder of|founders? (?:include|are)|the founder|is a co-?founder|is one of the founders)\b/i;

// Advise context: must be rooted in "advisor"/"advise" (investors also sit on
// boards). Keep "board advisor" / "advisory board" but drop generic "board
// member" / "sits on the board" which over-matches.
//
// v0.10.5 additions (drive advises 41% → >85% on rich prose):
//   - Advisory capacity phrasings: "in an advisory capacity", "advisory engagement",
//     "advisory partnership", "advisory contract", "advisory relationship".
//   - "as an advisor" form: joined/serves/brought on "as an advisor" / "as a
//     security advisor" / "as a technical advisor" / "as an industry advisor".
//   - "consults for / consulting role": advisor-adjacent verbs that appear in
//     narratives where the direct "advises" verb isn't used.
//   - Advisor-qualified: "strategic advisor to|at", "technical advisor to|at",
//     "security advisor to|at", "product advisor to|at", "industry advisor".
const ADVISES_RE = /\b(?:advises|advised|advisor (?:to|at|for|of)|advisory (?:board|role|position|capacity|engagement|partnership|contract|relationship|work)|board advisor|on .{0,20} advisory board|joined .{0,20} advisory board|in an? advisory (?:capacity|role|position)|as an? (?:advisor|security advisor|technical advisor|strategic advisor|industry advisor|product advisor|board advisor|senior advisor)|(?:strategic|technical|security|product|industry|senior|board) advisor (?:to|at|for|of)|consults for|consulting role (?:at|with))\b/i;

// Chinese link type patterns for CJK entity mentions.
// NOTE: These patterns are Chinese-only (zh). Japanese and Korean link
// type extraction is not yet implemented. Entity NAME extraction in
// by-mention.ts covers all three scripts (CJK = Chinese/Japanese/Korean)
// via Unicode-aware tokenization.
const ZH_FOUNDED_RE = /(?:创立|创办|成立|创建|建立|开创|发起)(?:了|的)/;
const ZH_INVESTED_RE = /(?:投资|入股|融资|注资|参股)(?:了|的|了?于)/;
const ZH_ADVISES_RE = /(?:顾问|咨询|指导)(?:了|的)?/;
const ZH_WORKS_AT_RE = /(?:任职|就职|担任|供职|在.{0,10}(?:工作|上班|负责))(?:于|在|的)?/;
const ZH_CITED_RE = /(?:引用|援引|提到|提及|转述|摘录)(?:了|的|自)?/;

// Page-role detection: if the source page describes a partner/investor at
// page level, that's a strong prior for outbound company refs being
// invested_in even when per-edge context lacks explicit investment verbs.
const PARTNER_ROLE_RE = /\b(?:partner at|partner of|venture partner|VC partner|invested early|investor at|investor in|portfolio|venture capital|early-stage investor|seed investor|fund [A-Z]|invests across|backs companies)\b/i;

// Advisor role prior: fires when the page-level description indicates the
// person IS an advisor (not just mentions advising). Broadened in v0.10.5
// from "full-time/professional/advises multiple" to catch any page that
// self-identifies the subject as an advisor.
const ADVISOR_ROLE_RE = /\b(?:full-time advisor|professional advisor|advises (?:multiple|several|various)|is an? (?:advisor|security advisor|technical advisor|strategic advisor|industry advisor|product advisor|senior advisor)|took on advisory roles|(?:her|his|their) advisory (?:work|role|engagement|portfolio)|serves as (?:an )?advisor)\b/i;

// Employee role prior (new in v0.10.5): fires when the page-level description
// indicates the person IS an employee (senior/staff/lead engineer, director,
// head, etc.) at some company. Biases outbound company refs on that page
// toward works_at when per-edge verbs are absent (e.g. possessive phrasings
// "her work on Delta's pipeline..." where the verb "works" doesn't appear
// near the slug).
//
// Scope: only fires for person-page → company-page links. Companies' own
// pages mentioning their employees use the page-role layer differently.
const EMPLOYEE_ROLE_RE = /\b(?:is an? (?:senior|staff|principal|lead|backend|frontend|full-?stack|ML|data|security|DevOps|platform)? ?engineer at|is an? (?:senior|staff|principal|lead)? ?(?:developer|designer|product manager|engineering manager|director|VP) (?:at|of)|holds? the (?:CTO|CEO|CFO|COO|CMO|CRO|VP) (?:role|position|seat|title) at|is the (?:CTO|CEO|CFO|COO|CMO|CRO) of|employee at|on the team at|works on .{0,30} at)\b/i;

/**
 * Infer link_type from page context. Deterministic regex heuristics, no LLM.
 *
 * Two layers of inference:
 *   1. Per-edge: ~240 char window around the slug mention. Looks for explicit
 *      verbs (FOUNDED_RE, INVESTED_RE, ADVISES_RE, WORKS_AT_RE).
 *   2. Page-role prior: when per-edge inference falls through to 'mentions',
 *      check if the SOURCE page describes the author as a partner/investor.
 *      If yes, bias outbound company refs toward 'invested_in'.
 *
 * Precedence: founded > invested_in > advises > works_at > role prior > mentions.
 *
 * The role-prior layer is what closes the gap on partner bios where the prose
 * lists portfolio companies without repeating the investment verb each time
 * ("Her current board seats reflect her portfolio: [Co A], [Co B], [Co C]").
 */
export function inferLinkType(pageType: PageType, context: string, globalContext?: string, targetSlug?: string): string {
  if (pageType === 'media') {
    return 'mentions';
  }
  // v0.27.1: image pages link to their text sibling via 'image_of' (the
  // image is OF that meeting/note). Set explicitly by the import-image
  // path-proximity helper, not by markdown extraction — but the type is
  // declared here so graph-query knows the edge name.
  if ((pageType as string) === 'image') return 'image_of';
  if ((pageType as string) === 'meeting') return 'attended';
  // Per-edge verb rules.
  if (FOUNDED_RE.test(context)) return 'founded';
  if (INVESTED_RE.test(context)) return 'invested_in';
  if (ADVISES_RE.test(context)) return 'advises';
  if (WORKS_AT_RE.test(context)) return 'works_at';
  // Chinese link type patterns
  if (ZH_FOUNDED_RE.test(context)) return 'founded';
  if (ZH_INVESTED_RE.test(context)) return 'invested_in';
  if (ZH_ADVISES_RE.test(context)) return 'advises';
  if (ZH_WORKS_AT_RE.test(context)) return 'works_at';
  if (ZH_CITED_RE.test(context)) return 'cited';
  // Page-role prior: only fires for person -> company links. Concept pages
  // about VC topics naturally contain "venture capital" in their text, but
  // their company refs are mentions, not investments. Partner pages mentioning
  // other people (co-investors, friends) should also stay as mentions.
  //
  // Precedence within priors: investor > advisor > employee. Investors often
  // also sit on boards ("board seat at portfolio company") which a naive
  // employee/advisor match would mis-classify; keep investor first so those
  // phrasings resolve correctly.
  if (pageType === 'person' && globalContext && targetSlug?.startsWith('companies/')) {
    if (PARTNER_ROLE_RE.test(globalContext)) return 'invested_in';
    if (ADVISOR_ROLE_RE.test(globalContext)) return 'advises';
    if (EMPLOYEE_ROLE_RE.test(globalContext)) return 'works_at';
  }
  return 'mentions';
}

// ─── Frontmatter link extraction (v0.13) ────────────────────────
//
// YAML frontmatter on entity pages carries rich relationship data:
//
//   company: "Stripe"                       # person page
//   companies: [Stripe, Plaid]              # person page (alias of company)
//   key_people: [Patrick Collison, John]    # company page (incoming works_at)
//   investors: [{name: Sequoia}, Benchmark] # deal page (incoming invested_in)
//   attendees: [Pedro, Garry]               # meeting page (incoming attended)
//
// Each maps to a typed graph edge. The mapping lives here (one source of
// truth) so the three entry points — operations.ts auto-link, extract.ts
// fs source, extract.ts db source — emit identical edges for the same
// frontmatter. This is the point of the v0.13 rewrite.
//
// DIRECTION: "incoming" means the page being written is the TO side;
// the FROM side is the resolved frontmatter value. E.g. `key_people:
// [Pedro]` on company/stripe emits `people/pedro -> companies/stripe
// type=works_at`, preserving subject-of-verb semantics for graph reads.
//
// MULTI-DIR HINTS: investors can be companies, funds, or people. The
// resolver tries each hint in order and takes the first match.

export interface FrontmatterFieldMapping {
  /** Field name(s). Multiple entries are aliases (e.g. company + companies). */
  fields: string[];
  /**
   * Only applies when page.type matches. Omitted = any page type. String
   * (not PageType) because some page types like 'meeting' exist in the
   * pages table without being in the TypeScript PageType enum.
   */
  pageType?: string;
  /** Edge link_type. */
  type: string;
  /** 'outgoing' = page→target. 'incoming' = target→page (subject of verb = from). */
  direction: 'outgoing' | 'incoming';
  /**
   * Target directory hints for slug resolution. Single string or ordered
   * array; resolver tries each. E.g. investors → ['companies', 'funds', 'people'].
   */
  dirHint: string | string[];
}

/**
 * Canonical field → (type, direction, dir-hint) map. Consulted by
 * extractFrontmatterLinks for every YAML field on every written page.
 *
 * NOT normalization: kept as a flat array so duplicate field names with
 * different pageType filters coexist cleanly (vs an object-literal which
 * would last-write-wins on key collision).
 */
export const FRONTMATTER_LINK_MAP: FrontmatterFieldMapping[] = [
  // Person pages → companies
  { fields: ['company', 'companies'], pageType: 'person', type: 'works_at', direction: 'outgoing', dirHint: 'companies' },
  { fields: ['founded'], pageType: 'person', type: 'founded', direction: 'outgoing', dirHint: 'companies' },
  // Company pages (incoming relationships — subject of the verb lives elsewhere)
  { fields: ['key_people'], pageType: 'company', type: 'works_at', direction: 'incoming', dirHint: 'people' },
  { fields: ['partner'], pageType: 'company', type: 'yc_partner', direction: 'incoming', dirHint: 'people' },
  { fields: ['investors'], pageType: 'company', type: 'invested_in', direction: 'incoming',
    dirHint: ['companies', 'funds', 'people'] },
  // Deal pages (all incoming — deals are the object)
  { fields: ['investors'], pageType: 'deal', type: 'invested_in', direction: 'incoming',
    dirHint: ['companies', 'funds', 'people'] },
  { fields: ['lead'], pageType: 'deal', type: 'led_round', direction: 'incoming',
    dirHint: ['companies', 'funds', 'people'] },
  // Meeting pages
  { fields: ['attendees'], pageType: 'meeting', type: 'attended', direction: 'incoming', dirHint: 'people' },
  // Any page type
  { fields: ['sources'], type: 'discussed_in', direction: 'incoming', dirHint: ['source', 'media'] },
  { fields: ['source'], type: 'source', direction: 'outgoing', dirHint: '' /* already slug-shaped */ },
  { fields: ['related', 'see_also'], type: 'related_to', direction: 'outgoing', dirHint: '' },
];

// ─── Slug resolver ──────────────────────────────────────────────

export interface SlugResolver {
  /**
   * Resolve a display name to a canonical slug.
   * Returns null when no match meets confidence threshold — callers should
   * skip (not write a dead link) and the unresolved name goes into the
   * extract/put_page summary so the user can see the gap.
   */
  resolve(name: string, dirHint?: string | string[]): Promise<string | null>;
  /**
   * Issue #972: return every slug whose basename (final `/`-segment, or
   * the whole slug if it has no `/`) matches `name`. Multi-match by
   * design — `[[struktura]]` referencing both `projects/struktura` and
   * `archive/struktura` returns both; the caller emits one graph edge
   * per result. Returns `[]` when no matches.
   *
   * Optional so existing SlugResolver consumers (e.g. synthetic
   * frontmatter-only resolvers) keep working without code changes.
   * Implementations should make this cheap to call repeatedly within
   * a single extract run (build the index once, reuse it).
   */
  resolveBasenameMatches?(name: string): Promise<string[]>;
}

/**
 * Issue #972 (codex [P2] DRY): the ONE basename matcher. makeResolver, the
 * FS resolver, and the doctor `link_resolution_opportunity` check all
 * build/query through these two functions so they cannot drift.
 *
 * Keying: raw tail + lowercase tail + slugified tail (the final `/`-segment,
 * or the whole slug when it has no `/`). #2367: slugified keys mirror
 * slugifySegment (NFD → strip accents → NFC → lowercase → SLUG_WORD_CHARS
 * filter); the old ASCII-only strip emptied CJK basenames.
 */
const BASENAME_KEEP_RE = new RegExp(`[^${SLUG_WORD_CHARS}\\s\\-]`, 'gu');
export function normalizeBasename(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
    .toLowerCase().replace(BASENAME_KEEP_RE, '').trim().replace(/\s+/g, '-');
}

/** Stable order: shorter slug first (likely closer to brain root), then lexical. */
function basenameSort(a: string, b: string): number {
  return (a.length - b.length) || a.localeCompare(b);
}

/** Build a `key → slug[]` index over a slug collection. Keys: raw/lower/slugified tail. */
export function buildBasenameIndex(slugs: Iterable<string>): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  const addKey = (key: string, slug: string) => {
    const existing = idx.get(key);
    if (existing) { if (!existing.includes(slug)) existing.push(slug); }
    else idx.set(key, [slug]);
  };
  for (const slug of slugs) {
    const tail = slug.includes('/') ? slug.slice(slug.lastIndexOf('/') + 1) : slug;
    addKey(tail, slug);
    const lower = tail.toLowerCase();
    if (lower !== tail) addKey(lower, slug);
    const slugified = normalizeBasename(tail);
    if (slugified && slugified !== tail && slugified !== lower) addKey(slugified, slug);
  }
  return idx;
}

/** Look a name up in a basename index (raw → lower → slugified), stable-sorted. */
export function queryBasenameIndex(idx: Map<string, string[]>, name: string): string[] {
  if (!name || typeof name !== 'string') return [];
  const trimmed = name.trim();
  if (!trimmed) return [];
  const hit = idx.get(trimmed) ?? idx.get(trimmed.toLowerCase()) ?? idx.get(normalizeBasename(trimmed));
  return hit ? [...hit].sort(basenameSort) : [];
}

/**
 * Create a resolver scoped to a single extract run or single put_page call.
 *
 * mode: 'batch' (migration / gbrain extract) — pg_trgm only, NO search
 * fallback. On a 46K-page brain this avoids N-thousand OpenAI embedding
 * calls + Anthropic Haiku expansion calls (see operations-query-hidden-haiku
 * learning) and keeps the backfill deterministic + under a wall-clock budget.
 *
 * mode: 'live' (put_page auto-link) — can afford the (rare, bounded) search
 * fallback for names that don't fuzzy-match. Still passes expand=false to
 * dodge Haiku.
 *
 * cache: per-resolver instance. Same name → same slug lookup every call.
 * Callers never need to dedupe names themselves.
 */
export function makeResolver(
  engine: BrainEngine,
  opts: { mode: 'batch' | 'live'; sourceId?: string } = { mode: 'live' },
): SlugResolver {
  const cache = new Map<string, string | null>();

  // Issue #972: lazy-built basename → slug[] index for global-basename
  // resolution. Built on first call to `resolveBasenameMatches`; reused
  // for the rest of the resolver instance's lifetime. Cost is bounded
  // (one `engine.getAllSlugs()` call per extract run / put_page). The
  // index keys BOTH the raw tail and the slugified-tail so a wikilink
  // `[[Fast-Weigh]]` matches a page slugged `companies/fast-weigh` as
  // well as `notes/Fast-Weigh`.
  let basenameIndex: Map<string, string[]> | null = null;
  async function ensureBasenameIndex(): Promise<Map<string, string[]>> {
    if (basenameIndex !== null) return basenameIndex;
    const idx = new Map<string, string[]>();
    if (typeof engine.getAllSlugs !== 'function') {
      basenameIndex = idx;
      return idx;
    }
    try {
      // Issue #972 (codex [P1]): scope the basename index to the resolver's
      // source. getAllSlugs({sourceId}) keeps wikilink resolution from
      // spanning unrelated sources — a bare [[name]] must NOT resolve to a
      // same-tail page in a DIFFERENT source and create a cross-source edge.
      // #972 is "global basename across folders," not "cross-source federation."
      const all = await engine.getAllSlugs(opts.sourceId ? { sourceId: opts.sourceId } : undefined);
      // Issue #972 (codex [P2] DRY): one shared index builder for all surfaces.
      basenameIndex = buildBasenameIndex(all);
      return basenameIndex;
    } catch {
      // Index build failed — empty map → resolveBasenameMatches finds
      // nothing, resolver continues as if the flag was off. Never throw.
    }
    basenameIndex = idx;
    return idx;
  }

  return {
    async resolveBasenameMatches(name: string): Promise<string[]> {
      // Issue #972 (codex [P2] DRY): shared query so resolver + FS + doctor
      // return the same matches in the same stable order.
      return queryBasenameIndex(await ensureBasenameIndex(), name);
    },

    async resolve(name: string, dirHint?: string | string[]): Promise<string | null> {
      if (!name || typeof name !== 'string') return null;
      const trimmed = name.trim();
      if (!trimmed) return null;

      const cacheKey = `${trimmed}\u0000${Array.isArray(dirHint) ? dirHint.join(',') : (dirHint || '')}`;
      if (cache.has(cacheKey)) return cache.get(cacheKey)!;

      const hints = Array.isArray(dirHint) ? dirHint : (dirHint ? [dirHint] : []);

      // Step 1: already a slug? Try an exact page lookup for any slug-shaped
      // value (contains '/', slug charset). Broadened beyond the original
      // single-segment lowercase-leading form (`^[a-z][a-z0-9-]*\/[a-z0-9]...`)
      // to also accept digit-leading folders (`90-people/nicolai`,
      // `01-trading/...`) and nested paths (`a/b/c`) — common in PARA-numbered
      // vaults. This is an EXACT getPage match only — no fuzzy — so it never
      // produces a false positive; a non-existent slug just falls through to
      // the steps below. Fixes frontmatter `related: [[dir/slug]]` values
      // (unwrapped by unwrapWikilink) that name a real page the strict regex
      // could not reach and whose full-path fuzzy score is below threshold.
      if (/\//.test(trimmed) && /^[a-z0-9][a-z0-9/_-]*$/.test(trimmed)) {
        // Same source scope as the basename index above (#972): a wikilink in
        // source A must not resolve to a same-slug page in source B.
        const page = await engine.getPage(trimmed, opts.sourceId ? { sourceId: opts.sourceId } : undefined); // gbrain-allow-unscoped-getpage: read-only wikilink resolution; unscoped-when-no-source is the documented single-source behavior
        if (page) {
          cache.set(cacheKey, trimmed);
          return trimmed;
        }
      }

      // Step 2: dir-hint + slugify → exact getPage
      const slugified = normalizeBasename(trimmed); // #2367: shared normalizer
      for (const hint of hints) {
        if (!hint) continue;
        const candidate = `${hint}/${slugified}`;
        const page = await engine.getPage(candidate, opts.sourceId ? { sourceId: opts.sourceId } : undefined); // gbrain-allow-unscoped-getpage: read-only wikilink resolution; unscoped-when-no-source is the documented single-source behavior
        if (page) {
          cache.set(cacheKey, candidate);
          return candidate;
        }
      }

      // Step 3: pg_trgm fuzzy title match — both modes. Tries each hint in
      // order; first hint with a ≥0.55 similarity match wins. If no hints,
      // try the whole pages table. When opts.sourceId is set, the fuzzy
      // search is constrained to that source (and skips soft-deleted pages)
      // so cross-source slug suggestions don't get silently dropped at the
      // FK filter downstream. Mirrors the same scope fix `tryFuzzyMatch` got
      // via #1436.
      const searchHints = hints.length > 0 ? hints : [undefined];
      for (const hint of searchHints) {
        const match = await engine.findByTitleFuzzy(trimmed, hint, 0.55, opts.sourceId);
        if (match) {
          cache.set(cacheKey, match.slug);
          return match.slug;
        }
      }

      // Step 4: live-mode ONLY — fall back to hybrid search. expand: false
      // is MANDATORY (see operations-query-hidden-haiku learning). Batch
      // mode skips this step entirely to keep migration deterministic.
      if (opts.mode === 'live') {
        try {
          const results = await engine.searchKeyword(trimmed, { limit: 3 });
          if (results.length > 0 && results[0].score >= 0.8) {
            // Filter by dir hint if provided.
            const top = hints.length > 0
              ? results.find(r => hints.some(h => r.slug.startsWith(`${h}/`)))
              : results[0];
            if (top) {
              cache.set(cacheKey, top.slug);
              return top.slug;
            }
          }
        } catch { /* search errors are non-fatal; fall through to null */ }
      }

      // Null = unresolvable. Caller records for the unresolved report.
      cache.set(cacheKey, null);
      return null;
    },
  };
}

// ─── Frontmatter extractor ──────────────────────────────────────

/**
 * Unwrap an Obsidian `[[wikilink]]` frontmatter value to its bare link
 * target so the resolver (which expects bare titles / dir slugs) can match
 * it. Mainstream Obsidian authors frontmatter links as `related: ["[[Page]]"]`;
 * without this, the resolver treats the brackets as part of the value and a
 * `[[90-people/nicolai]]` is normalized into `90peoplenicolai`, so it never
 * resolves. Strips a trailing `|alias`, `#heading`, or `^block` suffix — the
 * link target only. The regex is anchored to a wholly-wrapped value
 * (`^\s*\[\[…\]\]\s*$`), so bare titles and any value not fully wrapped pass
 * through unchanged and existing behavior is preserved exactly.
 */
export function unwrapWikilink(value: string): string {
  const match = /^\s*\[\[(.+?)\]\]\s*$/.exec(value);
  if (!match) return value;
  // Take the link target: drop |alias, then #heading / ^block suffixes.
  const target = match[1].split('|')[0].split('#')[0].split('^')[0];
  return target.trim();
}

export interface UnresolvedFrontmatterRef {
  /** The frontmatter field name. */
  field: string;
  /** The name that did not resolve. */
  name: string;
}

export interface FrontmatterExtractResult {
  candidates: LinkCandidate[];
  unresolved: UnresolvedFrontmatterRef[];
}

/**
 * Extract typed graph edges from YAML frontmatter. Async because the
 * resolver may need to query the DB for fuzzy matches.
 *
 * Arrays of strings: each entry resolved independently.
 * Arrays of objects: uses the `name` or `slug` property (codex tension 6.3).
 * Non-string / non-object entries: silently skipped (log-only).
 */
export async function extractFrontmatterLinks(
  slug: string,
  pageType: PageType,
  frontmatter: Record<string, unknown>,
  resolver: SlugResolver,
  globalBasename = false,
  pack?: LinkExtractionPack | null,
): Promise<FrontmatterExtractResult> {
  const candidates: LinkCandidate[] = [];
  const unresolved: UnresolvedFrontmatterRef[] = [];

  // #3190: append pack-declared frontmatter_links as OUTGOING mappings.
  // Pre-fix a pack's `frontmatter_links` table (e.g. `parents:` →
  // parent_of) was dead weight — only the hardcoded FRONTMATTER_LINK_MAP
  // ever ran, so pack-declared fields produced 0 candidates. Field → verb
  // resolution goes through frontmatterLinkTypeFromPack (first matching
  // pack rule for this page type wins, the helper's documented contract).
  // Built-ins keep their table order; pack mappings run after, and the
  // final within-page dedup collapses exact duplicates.
  const packMappings: FrontmatterFieldMapping[] = [];
  if (pack && pack.frontmatter_links.length > 0) {
    const seenFields = new Set<string>();
    for (const fl of pack.frontmatter_links) {
      for (const field of fl.fields) {
        if (seenFields.has(field)) continue;
        seenFields.add(field);
        const type = frontmatterLinkTypeFromPack(pack, pageType as string, field);
        if (!type) continue; // no pack rule for this page type
        packMappings.push({ fields: [field], type, direction: 'outgoing', dirHint: '' });
      }
    }
  }

  for (const mapping of [...FRONTMATTER_LINK_MAP, ...packMappings]) {
    if (mapping.pageType && mapping.pageType !== pageType) continue;
    for (const field of mapping.fields) {
      const value = frontmatter[field];
      if (value == null) continue;
      const entries = Array.isArray(value) ? value : [value];

      for (const entry of entries) {
        // Extract the name to resolve. Strings pass through; objects use
        // the `name` / `slug` / `title` field in that preference order.
        let name: string | null = null;
        let contextExtra = '';
        if (typeof entry === 'string') {
          name = entry;
        } else if (entry && typeof entry === 'object') {
          const obj = entry as Record<string, unknown>;
          const n = obj.name ?? obj.slug ?? obj.title;
          if (typeof n === 'string') {
            name = n;
            // Carry interesting object fields (role, title) into the context.
            const extras: string[] = [];
            if (typeof obj.role === 'string') extras.push(obj.role);
            if (typeof obj.title === 'string' && obj.title !== n) extras.push(obj.title);
            if (extras.length > 0) contextExtra = ` (${extras.join(', ')})`;
          }
        }
        if (!name) continue;   // skip numbers, nulls, malformed objects

        // Accept Obsidian `[[wikilink]]` values in frontmatter link fields by
        // unwrapping to the bare target before resolution. Bare titles pass
        // through unchanged; the original `name` is preserved for the
        // unresolved report and edge context.
        const linkTarget = unwrapWikilink(name);
        let resolved = await resolver.resolve(linkTarget, mapping.dirHint);
        if (!resolved && globalBasename && typeof resolver.resolveBasenameMatches === 'function') {
          // Issue #972 follow-up: extend global_basename resolution to
          // frontmatter link fields. resolve() can't reach a bare-title
          // wikilink value (e.g. `sources: "[[2025-12-25_mentor-extraction]]"`)
          // — it has no '/', so the slug-direct getPage is skipped, and the
          // field's dirHint may name folders that don't exist in this brain,
          // so the dir-scoped exact + fuzzy steps miss too. When
          // link_resolution.global_basename is on, fall back to the SAME
          // basename index the body bare-wikilink pass uses. Unique-match-only:
          // ambiguous basenames (e.g. archive duplicates, generic hubs like
          // `_index`) stay unresolved rather than create a wrong edge.
          const matches = (await resolver.resolveBasenameMatches(linkTarget))
            .filter((s) => s !== slug);
          if (matches.length === 1) resolved = matches[0];
        }
        if (!resolved) {
          unresolved.push({ field, name });
          continue;
        }

        // Outgoing: page → resolved. Incoming: resolved → page.
        const fromSlug = mapping.direction === 'outgoing' ? slug : resolved;
        const toSlug   = mapping.direction === 'outgoing' ? resolved : slug;
        // Context enrichment (review Finding 7): readable in backlink panels
        // and search snippets instead of bare `frontmatter.key_people`.
        const context = `frontmatter.${field}: ${name}${contextExtra}`;

        candidates.push({
          fromSlug,
          targetSlug: toSlug,
          linkType: mapping.type,
          context,
          linkSource: 'frontmatter',
          originSlug: slug,       // the page whose frontmatter created this edge
          originField: field,
        });
      }
    }
  }

  return { candidates, unresolved };
}

// ─── Timeline parsing ───────────────────────────────────────────

export interface TimelineCandidate {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** First-line summary. */
  summary: string;
  /** Optional detail (subsequent lines until next entry/heading). */
  detail: string;
  /**
   * #3957: source label. Pipe-separated bullets split `Source — Summary`
   * (via findTimelineSourceDelimiter, the SAME split the FS extractor in
   * timeline-extract.ts applies), inline citations carry their `[Source: X]`
   * label, everything else defaults to 'markdown'. Pre-fix the DB path left
   * this unset, so callers wrote source='' while the FS path wrote the split
   * label + trimmed summary — the (page_id, date, summary, source) dedup
   * index saw two shapes for the same bullet and every FS-then-DB (or
   * DB-then-FS) re-extraction duplicated the row.
   */
  source?: string;
}

/**
 * #3957 (moved from timeline-extract.ts so BOTH parsers share it): index of
 * the first dash (—, –, -) that can serve as the `Source — Summary`
 * delimiter: it must have whitespace on both sides and sit outside every
 * markdown-link span. Hyphens inside link targets
 * (`../people/alice-example.md`) and dashes inside link labels
 * (`[Deals — Q1 Review](...)`) are content, not delimiters — splitting on
 * them shatters one entry into two fragments whose halves re-insert on
 * every sync (the (page_id, date, summary, source) uniqueness sees each
 * fragment shape as a new row). Returns -1 when the line has no delimiter.
 */
export function findTimelineSourceDelimiter(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') { if (depth > 0) depth--; }
    else if (
      depth === 0 &&
      (c === '—' || c === '–' || c === '-') &&
      i > 0 && /\s/.test(text[i - 1]) &&
      i + 1 < text.length && /\s/.test(text[i + 1])
    ) {
      return i;
    }
  }
  return -1;
}

// Match: `- **YYYY-MM-DD** | summary` or `- **YYYY-MM-DD** -- summary`
// or `- **YYYY-MM-DD** - summary` or just `**YYYY-MM-DD** | summary`.
// #3957: the separator run is captured so the parser can apply the
// `Source — Summary` split ONLY to pipe-separated bullets (the canonical
// shape the FS extractor matches); a dash-separated bullet's rest is one
// summary and must not be shattered on its first interior dash.
const TIMELINE_LINE_RE = /^\s*-?\s*\*\*(\d{4}-\d{2}-\d{2})\*\*\s*([|\-–—]+)\s*(.+?)\s*$/;
// Chinese date lines: `- 2020年1月2日 | summary` (bold optional). Requires the
// 年/月 markers so plain ASCII `- 2020-01-02 - text` does NOT match — non-bold
// ASCII dates were never timeline entries and must stay that way.
const TIMELINE_LINE_RE_CN = /^\s*-?\s*(?:\*\*)?(\d{4})年(\d{1,2})月(\d{1,2})日?(?:\*\*)?\s*([|\-–—]+)\s*(.+?)\s*$/;

/**
 * Parse timeline entries from content. Looks at:
 *   - The full content (most pages have a top-level "## Timeline" heading).
 *   - Free-form `- **DATE** | text` lines anywhere.
 *
 * Skips dates that don't represent valid calendar dates (e.g. 2026-13-45).
 * Multi-line entries: a date line followed by indented or blank-then-text
 * lines until the next date line or section heading.
 */
export function parseTimelineEntries(content: string): TimelineCandidate[] {
  const result: TimelineCandidate[] = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    // Try English format first, then Chinese
    const m = TIMELINE_LINE_RE.exec(lines[i]);
    let date: string;
    let summary: string;
    let separator: string;
    if (m) {
      date = m[1];
      separator = m[2];
      summary = m[3].trim();
    } else {
      const cm = TIMELINE_LINE_RE_CN.exec(lines[i]);
      if (!cm) { i++; continue; }
      // Normalize Chinese date to YYYY-MM-DD
      date = `${cm[1]}-${cm[2].padStart(2, '0')}-${cm[3].padStart(2, '0')}`;
      separator = cm[4];
      summary = cm[5].trim();
    }
    if (!isValidDate(date) || summary.length === 0) { i++; continue; }
    // #3957: pipe-separated bullets carry the canonical `Source — Summary`
    // shape; split them exactly like the FS extractor (extractTimelineFromContent
    // Format 1) so FS- and DB-extracted rows share one (source, summary) shape
    // and the DB dedup index collapses re-extractions instead of duplicating.
    // Dash-separated bullets (`- **DATE** - text`) are one summary — no split.
    let source = 'markdown';
    if (separator.includes('|')) {
      const at = findTimelineSourceDelimiter(summary);
      if (at >= 0) {
        source = summary.slice(0, at).trim();
        summary = summary.slice(at + 1).trim();
      }
    }
    // Collect optional detail lines (indented, until next date or heading).
    const detailLines: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (TIMELINE_LINE_RE.test(next)) break;
      if (/^#{1,6}\s/.test(next)) break;
      if (next.trim().length === 0 && detailLines.length === 0) {
        // skip leading blank line; if we hit a blank after detail content
        // and still no new entry, treat detail as ended.
        j++;
        continue;
      }
      if (next.trim().length === 0 && detailLines.length > 0) break;
      // Indented continuation lines are detail; flush-left non-list lines too.
      if (/^\s+/.test(next) || (!next.startsWith('-') && !next.startsWith('*') && !next.startsWith('#'))) {
        detailLines.push(next.trim());
        j++;
        continue;
      }
      break;
    }
    result.push({ date, summary, detail: detailLines.join(' ').trim(), source });
    i = j;
  }

  // Format 3: inline citation — [Source: <source>, YYYY-MM-DD]. The citation
  // convention gbrain's own quality rules require on every brain write;
  // until now this parser (the db-source extract + ingest path) could not
  // see it, so a page whose dates all live in citations scored zero
  // timeline coverage. Kept in sync with extractTimelineFromContent's
  // Format 3 (the fs-source path). Blocks already captured by the timeline
  // bullet pass are skipped (a bullet often carries its own citation).
  for (const entry of parseInlineCitationTimelineEntries(content, {
    skipLine: (line) => TIMELINE_LINE_RE.test(line) || TIMELINE_LINE_RE_CN.test(line),
  })) {
    // #3957: carry the citation's source label in `source` (the dedup-key
    // column) so the row shape matches the FS extractor's Format 3; the
    // human-readable detail is kept for existing consumers.
    result.push({ date: entry.date, summary: entry.summary, detail: `Source: ${entry.source}`, source: entry.source });
  }
  return result;
}

/** Validate date string represents a real calendar date in ISO YYYY-MM-DD form. */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, mo, d] = s.split('-').map(Number);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  // Use Date object as final check (catches 2026-02-30 etc.)
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Input for {@link deriveTimelineAnchor}: a page's identity + its computed content date. */
export interface TimelineAnchorInput {
  slug: string;
  title?: string | null;
  effectiveDate?: Date | string | null;
  effectiveDateSource?: EffectiveDateSource | null;
}

/**
 * Anchor a single timeline entry from a page's computed content date, for pages
 * whose body carries no parseable timeline line.
 *
 * Comms- and calendar-dominated brains keep the date in frontmatter or the
 * filename (slug `2026-04-24-...`), not in the prose, so `parseTimelineEntries`
 * returns nothing and the page-level `timeline` table stays empty even though
 * the page is firmly dated — leaving `get_timeline` and the brain-score
 * `timeline_coverage` component blind to it. This recovers that signal from the
 * already-computed `effective_date` (no re-parsing). (It does NOT feed the
 * facts-based `find_trajectory`, which reads the `facts` table by entity_slug.)
 *
 * Fires ONLY for a trustworthy content date — frontmatter (`event_date` / `date`
 * / `published`) or the `filename` date — never the `fallback` source, which is
 * `updated_at` (link-churn noise, not when the thing happened). Returns null
 * when no trustworthy date is available. Callers MUST apply this only when body
 * parsing yields zero entries, so it can never shadow a real in-body timeline.
 */
export function deriveTimelineAnchor(input: TimelineAnchorInput): TimelineCandidate | null {
  const { slug, title, effectiveDate, effectiveDateSource } = input;
  if (!effectiveDate) return null;
  // 'fallback' === updated_at; the rest ('event_date'|'date'|'published'|'filename')
  // are real content dates. null/undefined source is not trustworthy either.
  if (effectiveDateSource == null || effectiveDateSource === 'fallback') return null;
  const dt = typeof effectiveDate === 'string' ? new Date(effectiveDate) : effectiveDate;
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
  const iso = dt.toISOString().slice(0, 10);
  if (!isValidDate(iso)) return null;
  const summary = (title ?? '').trim() || slug.split('/').pop() || slug;
  return { date: iso, summary, detail: '' };
}

// ─── Auto-link config ───────────────────────────────────────────

/**
 * Read the auto_link config flag. Defaults to TRUE (auto-link is on by default).
 *
 * Accepts as falsy: 'false', '0', 'no', 'off' (case-insensitive, whitespace-trimmed).
 * Anything else (including null, '', 'true', '1', 'yes', garbage) -> true.
 *
 * The config is stored as a string via engine.setConfig/getConfig.
 */
export async function isAutoLinkEnabled(engine: BrainEngine): Promise<boolean> {
  const val = await engine.getConfig('auto_link');
  if (val == null) return true;
  const normalized = val.trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(normalized);
}

/**
 * Read the auto_timeline config flag. Defaults to TRUE (on by default).
 * Same truthiness rules as isAutoLinkEnabled. Controls whether put_page
 * parses timeline entries from freshly-written content and inserts them
 * via addTimelineEntriesBatch.
 */
export async function isAutoTimelineEnabled(engine: BrainEngine): Promise<boolean> {
  const val = await engine.getConfig('auto_timeline');
  if (val == null) return true;
  const normalized = val.trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(normalized);
}

/**
 * Read the `link_resolution.global_basename` config flag. Defaults to
 * FALSE (opt-in only; existing brains keep ancestor-walk resolution).
 *
 * When TRUE: bare wikilinks like `[[struktura]]` (no DIR_PATTERN prefix)
 * that don't resolve via the existing path are matched against every
 * page's basename. Each unique match emits a graph edge tagged
 * `linkType: 'wikilink_basename'`. Multiple matches emit multiple edges.
 *
 * Resolution order (highest → lowest):
 *   1. Env var `GBRAIN_LINK_RESOLUTION_GLOBAL_BASENAME=1` (operator override)
 *   2. DB plane via `engine.getConfig('link_resolution.global_basename')`
 *   3. Default false
 *
 * Closes https://github.com/garrytan/gbrain/issues/972.
 */
export async function isGlobalBasenameEnabled(engine: BrainEngine): Promise<boolean> {
  const envVal = process.env.GBRAIN_LINK_RESOLUTION_GLOBAL_BASENAME;
  if (envVal != null) {
    const normalized = envVal.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  }
  const val = await engine.getConfig('link_resolution.global_basename');
  if (val == null) return false;
  const normalized = val.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}
