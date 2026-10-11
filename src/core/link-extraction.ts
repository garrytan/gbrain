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
import type { EffectiveDateSource, PageType } from './types.ts';
import { ensureWellFormed } from './text-safe.ts';
import { posix } from 'node:path';
import { pathToSlug } from './sync.ts';
import { inferLinkTypeFromPack, frontmatterLinkTypeFromPack, ownsAttendanceInference } from './schema-pack/link-inference.ts';
import { PageRegexBudget } from './schema-pack/redos-guard.ts';
import type { SchemaPackManifest } from './schema-pack/manifest-v1.ts';
import { statedRelationTypes } from './line-grammar.ts';

/**
 * Link-extraction version stamp.
 * Verb windows, the "joined … as <role>" works_at form, and typed relation
 * lines follow local GBrain 0.60.102. The watermark stays put: moving it
 * would mark every existing page stale and rescan the library. New writes
 * and pages already due for extract use the new rules. Global basename
 * wikilinks stay out. Typed relation lines stay off until
 * `line_grammar.enabled` is set, matching GBrain's default.
 */
export const LINK_EXTRACTOR_VERSION_TS = '2026-08-29T00:00:00Z';

export type LinkExtractionPack = Pick<SchemaPackManifest, 'link_types' | 'frontmatter_links'> & Partial<Pick<SchemaPackManifest, 'page_types'>>;

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
   * The wikilink used a path outside the historical directory whitelist.
   * The literal path must exist exactly before an edge is emitted.
   */
  exactPath?: boolean;
  /** A bare/custom wikilink that must be resolved against the current page and Source. */
  needsResolution?: boolean;
  /** Match offset in the code-stripped page. Keeps a later list from inheriting an earlier sentence. */
  index?: number;
}

/** v0.17.0: how a link's target source was pinned at extraction time. */
export type LinkResolutionType = 'qualified' | 'unqualified';

/**
 * Directory prefix whitelist. These are the top-level slug dirs the extractor
 * recognizes as entity references. Upstream canonical + our extensions:
 *   - Gbrain canonical: people, companies, meetings, concepts, deal, civic, project, source, media, yc, projects
 *   - Our domain extensions: tech, finance, personal, openclaw (domain-organized wikis)
 *   - Our entity prefix: entities (we kept some legacy entities/projects/ pages)
 */
const DIR_PATTERN = '(?:people|companies|meetings|concepts|deal|civic|project|projects|source|media|yc|tech|finance|personal|openclaw|entities|reference)';

/** Any plausible page directory. Persist callers still verify both endpoints exist. */
const ANY_DIR_SEGMENT = '[a-z0-9][a-z0-9_-]*';

/**
 * Match `[Name](path)` markdown links pointing to entity directories.
 * Accepts both filesystem-relative format (`[Name](../people/slug.md)`)
 * AND engine-slug format (`[Name](people/slug)`).
 *
 * Captures: name, slug (dir/name, possibly deeper).
 *
 * The regex permits an optional `../` prefix (any number) and an optional
 * `.md` suffix so the same function works for both filesystem and DB content.
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
 * Path-shaped wikilinks outside DIR_PATTERN. Unlike basename resolution,
 * exact-path matching is safe to enable by default: the resolver verifies
 * the literal slug exists before an edge is emitted. This intentionally
 * accepts Unicode and spaces because imported Chinese knowledge bases keep
 * their original directory and page names in slugs.
 */
const WIKILINK_ANY_PATH_RE = /\[\[([^|\]#\r\n]+\/[^|\]#\r\n]+?)(?:#[^|\]]*?)?(?:\|([^\]]+?))?\]\]/g;

/** Bare/custom Obsidian wikilinks, handled after the path-aware passes. */
const WIKILINK_GENERIC_RE = /\[\[([^|\]#\n[]+?)(?:#[^|\]]*?)?(?:\|([^\]]+?))?\]\]/g;

export interface RelativeMarkdownRef {
  name: string;
  target: string;
  slug: string;
  index: number;
}

/**
 * Ordinary Markdown paths are Source-local filesystem references, regardless
 * of their top-level directory name. Convert them with POSIX semantics so a
 * Windows host produces the same canonical slash slug as Linux/macOS.
 */
export function extractRelativeMarkdownRefs(content: string, fromSlug: string): RelativeMarkdownRef[] {
  const stripped = stripCodeBlocks(content);
  const refs: RelativeMarkdownRef[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\r\n]+?\.md)(?:#[^)\r\n]*)?\)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    const target = match[2]!.trim().replace(/^<|>$/g, '').replace(/\\/g, '/');
    if (!target || target.includes('://') || target.startsWith('#')) continue;
    const joined = target.startsWith('/')
      ? target.slice(1)
      : posix.join(posix.dirname(fromSlug), target);
    const slug = pathToSlug(posix.normalize(joined));
    if (!slug) continue;
    refs.push({ name: match[1]!, target, slug, index: match.index });
  }
  return refs;
}

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
const QUALIFIED_WIKILINK_RE =
  /\[\[([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?):([^|\]#\r\n]+\/[^|\]#\r\n]+?)(?:#[^|\]]*?)?(?:\|([^\]]+?))?\]\]/g;

/**
 * Strip fenced code blocks (```...```) and inline code (`...`) from markdown,
 * replacing them with whitespace of equivalent length. Preserves byte offsets
 * for any caller that cares about positions; for our extractors this is just
 * defense-in-depth — slugs inside code are not real entity references.
 */
export function stripCodeBlocks(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    // Fenced block: ``` (optional language) ... ```
    if (content.startsWith('```', i)) {
      const end = content.indexOf('```', i + 3);
      if (end === -1) { out += ' '.repeat(content.length - i); break; }
      out += ' '.repeat(end + 3 - i);
      i = end + 3;
      continue;
    }
    // Inline code: `...` (single backtick, no newline inside)
    if (content[i] === '`') {
      const end = content.indexOf('`', i + 1);
      if (end === -1 || content.slice(i + 1, end).includes('\n')) {
        out += content[i];
        i++;
        continue;
      }
      out += ' '.repeat(end + 1 - i);
      i = end + 1;
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}

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
const CODE_REF_REGEX = /\b((?:src|lib|app|test|tests|scripts|docs|packages|internal|cmd|examples)\/[\w\-./]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|cs|cpp|cc|hpp|c|h|php|swift|kt|scala|lua|ex|exs|elm|ml|dart|zig|sol|sh|bash|css|html|vue|json|yaml|yml|toml))(?::(\d+))?\b/g;

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
    const fullPath = match[2];
    const slug = fullPath;
    const dir = fullPath.split('/')[0];
    refs.push({ name, slug, dir, index: match.index });
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
    refs.push({ name: displayName, slug, dir, sourceId, index: match.index });
    qualifiedRanges.push([match.index, match.index + match[0].length]);
  }

  // 2b. Unqualified Obsidian wikilinks: [[path]] or [[path|Display Text]]
  //     Same shape rule: omit sourceId when unqualified.
  const unmasked = maskRanges(stripped, qualifiedRanges);
  const unqualifiedRanges: Array<[number, number]> = [];
  const wikiPattern = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
  while ((match = wikiPattern.exec(unmasked)) !== null) {
    let slug = stripEscapedPipeTail(match[1].trim());
    if (!slug) continue;
    if (slug.includes('://')) continue;
    if (slug.endsWith('.md')) slug = slug.slice(0, -3);
    const displayName = (match[2] || slug).trim();
    const dir = slug.split('/')[0];
    refs.push({ name: displayName, slug, dir, index: match.index });
    unqualifiedRanges.push([match.index, match.index + match[0].length]);
  }

  // 2c. Path-shaped wikilinks with any directory prefix. Whitelisted
  // matches are masked above so they retain their established behavior.
  const anyPathMasked = maskRanges(stripped, [...qualifiedRanges, ...unqualifiedRanges]);
  const anyPathPattern = new RegExp(WIKILINK_ANY_PATH_RE.source, WIKILINK_ANY_PATH_RE.flags);
  const anyPathRanges: Array<[number, number]> = [];
  while ((match = anyPathPattern.exec(anyPathMasked)) !== null) {
    let slug = stripEscapedPipeTail(match[1].trim());
    if (!slug || slug.includes('://') || slug.includes(':')) continue;
    if (slug.endsWith('.md')) slug = slug.slice(0, -3);
    const displayName = (match[2] || slug).trim();
    const dir = slug.split('/')[0];
    refs.push({ name: displayName, slug, dir, exactPath: true, index: match.index });
    anyPathRanges.push([match.index, match.index + match[0].length]);
  }

  // 2d. Bare wikilinks are never resolved by global basename in PMBrain.
  // They are candidates for current-directory and Source-root exact lookup.
  const genericMasked = maskRanges(
    stripped,
    [...markdownRanges, ...qualifiedRanges, ...unqualifiedRanges, ...anyPathRanges],
  );
  const genericPattern = new RegExp(WIKILINK_GENERIC_RE.source, WIKILINK_GENERIC_RE.flags);
  while ((match = genericPattern.exec(genericMasked)) !== null) {
    let slug = stripEscapedPipeTail(match[1].trim());
    if (!slug || slug.includes('://') || slug.includes(':')) continue;
    if (slug.endsWith('.md')) slug = slug.slice(0, -3);
    const displayName = (match[2] || slug).trim();
    refs.push({
      name: displayName,
      slug,
      dir: slug.includes('/') ? slug.split('/')[0] : '',
      needsResolution: true,
      index: match.index,
    });
  }

  return refs;
}

/** Markdown-table wikilinks escape the alias pipe as `\\|`; it is not part of the slug. */
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

// ─── Link candidates (richer than EntityRef) ────────────────────

export interface LinkCandidate {
  authoredRef?: {key:string;kind:'slug'|'name';target:string;targetSourceId?:string};
  /**
   * Source page slug for the edge. When omitted, callers default to
   * "the page being written" (operations.ts runAutoLink) or "the page
   * currently being processed" (extract.ts). Explicitly set when
   * frontmatter emits an incoming edge — e.g. a company page's
   * `key_people: [pedro-franceschi]` produces a candidate whose
   * fromSlug is `people/pedro-franceschi`, not the company.
   */
  fromSlug?: string;
  /** Source containing fromSlug. Omitted means the current page source. */
  fromSourceId?: string;
  /** Target page slug (no .md, no ../). */
  targetSlug: string;
  /** Source containing targetSlug. Omitted means the current page source. */
  targetSourceId?: string;
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
  /** Source containing originSlug. Omitted means the current page source. */
  originSourceId?: string;
  /** Frontmatter field name (e.g. 'key_people'), for debug + unresolved report. */
  originField?: string;
  /** Whether the target source came from an explicit qualifier or local/default resolution. */
  resolutionType?: LinkResolutionType;
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
  opts: {
    skipFrontmatter?: boolean;
    pack?: LinkExtractionPack | null;
    targetType?: (slug: string, sourceId?: string) => string | undefined;
    lineGrammar?: { enabled?: boolean; allowUndeclaredTypes?: boolean };
  } = {},
): Promise<PageLinksResult> {
  const candidates: LinkCandidate[] = [];
  const wikilinkUnresolved: UnresolvedFrontmatterRef[] = [];
  const wikilinkUnresolvedSeen = new Set<string>();
  const relativeMarkdownTargetSlugs = new Set<string>();
  const pack = opts.pack ?? null;
  const packBudget = pack ? new PageRegexBudget() : undefined;
  const packOwnsAttendance = ownsAttendanceInference(pack);
  const suppressedRanges = rolePriorSuppressedRanges(stripCodeBlocks(content));
  const statedType = statedRelationTypes(content, {
    ...opts.lineGrammar,
    declaredVerbs: pack?.link_types.map(lt => lt.name),
  });
  const typeFor = (ctx: string, targetSlug: string, idx?: number, sourceId?: string): string => {
    const stated = statedType(idx);
    if (stated && !(stated === 'attended' && (pageType as string) === 'meeting')) return stated;
    const lookedUp = opts.targetType?.(targetSlug, sourceId);
    if (pack) {
      const packVerb = inferLinkTypeFromPack(pack, pageType as string, ctx, packBudget, lookedUp);
      if (packVerb && (packOwnsAttendance || packVerb !== 'attended' || (pageType as string) !== 'meeting')) {
        if (packVerb === 'attended' && (pageType as string) === 'meeting'
          && (opts.targetType ? lookedUp !== 'person' : !targetSlug.startsWith('people/'))) return 'mentions';
        return packVerb;
      }
    }
    if ((pageType as string) === 'meeting') {
      return opts.targetType
        ? (lookedUp === 'person' ? 'attended' : 'mentions')
        : (!targetSlug || targetSlug.startsWith('people/') ? 'attended' : 'mentions');
    }
    const suppressPrior = idx !== undefined && idx >= 0 && inSuppressedRange(suppressedRanges, idx);
    const legacy = inferLinkType(
      pageType,
      ctx,
      suppressPrior ? undefined : content,
      targetSlug,
      opts.targetType ? lookedUp ?? null : undefined,
      idx !== undefined && idx >= 0 ? excerptAnchor(content, idx, 240) : undefined,
    );
    if (pack?.link_types.some(lt => lt.name === legacy && (lt.inference?.page_type || lt.inference?.target_type))) {
      return 'mentions';
    }
    return legacy;
  };

  // Ordinary relative Markdown paths are exact, Source-local references.
  // They must never use the resolver's default-Source fallback.
  if (typeof resolver.resolveLocalExact === 'function') {
    for (const ref of extractRelativeMarkdownRefs(content, slug)) {
      const resolved = await resolver.resolveLocalExact(ref.slug);
      if (!resolved) {wikilinkUnresolved.push({field:'wikilink',name:ref.slug});continue;}
      relativeMarkdownTargetSlugs.add(resolved.slug);
      const idx = ref.index;
      const context = idx >= 0 ? excerpt(content, idx, 240) : ref.name;
      candidates.push({
        targetSlug: resolved.slug,
        targetSourceId: resolved.sourceId,
        resolutionType: 'unqualified',
        linkType: typeFor(context, resolved.slug, idx, resolved.sourceId),
        context,
        linkSource: 'markdown',
      });
    }
  }

  // 1. Markdown entity refs.
  for (const ref of extractEntityRefs(content)) {
    // A standard .md link was already resolved above with strict Source-local
    // semantics. Do not re-emit it through the historical entity path, whose
    // unqualified resolver is allowed to fall back to default.
    if (relativeMarkdownTargetSlugs.has(ref.slug)) continue;
    if (ref.needsResolution) {
      const raw = ref.slug.replace(/\\/g, '/');
      const normalized = raw.startsWith('./') || raw.startsWith('../')
        ? pathToSlug(posix.join(posix.dirname(slug), raw))
        : pathToSlug(raw);
      const resolvedTargets: Array<{ slug: string; sourceId: string; resolutionType: LinkResolutionType }> = [];

      if (normalized.includes('/')) {
        const exact = typeof resolver.resolveExact === 'function'
          ? await resolver.resolveExact(normalized)
          : null;
        if (exact) resolvedTargets.push(exact);
      } else {
        const sameDirSlug = pathToSlug(posix.join(posix.dirname(slug), normalized));
        const sameDir = typeof resolver.resolveLocalExact === 'function'
          ? await resolver.resolveLocalExact(sameDirSlug)
          : null;
        if (sameDir) resolvedTargets.push(sameDir);
        const root = typeof resolver.resolveExact === 'function'
          ? await resolver.resolveExact(normalized)
          : null;
        if (root && !resolvedTargets.some(target => target.slug === root.slug && target.sourceId === root.sourceId)) {
          resolvedTargets.push(root);
        }
      }

      if (resolvedTargets.length === 0) {
        const unresolvedKey=JSON.stringify([ref.sourceId ?? null,ref.slug]);
        if (!wikilinkUnresolvedSeen.has(unresolvedKey)) {
          wikilinkUnresolvedSeen.add(unresolvedKey);
          wikilinkUnresolved.push({ field: 'wikilink', name: ref.slug });
        }
        continue;
      }

      const idx = ref.index ?? content.indexOf(ref.name);
      const context = idx >= 0 ? excerpt(content, idx, 240) : ref.name;
      for (const target of resolvedTargets) {
        if (target.slug === slug) continue;
        candidates.push({
          targetSlug: target.slug,
          targetSourceId: target.sourceId,
          resolutionType: target.resolutionType,
          linkType: typeFor(context, target.slug, idx, target.sourceId),
          context,
          linkSource: 'markdown',
        });
      }
      continue;
    }

    const normalizedRefSlug = ref.slug.includes('/')
      ? pathToSlug(ref.slug.replace(/\\/g, '/'))
      : ref.slug;
    const resolvedExact = typeof resolver.resolveExact === 'function'
      ? await resolver.resolveExact(normalizedRefSlug, ref.sourceId ?? undefined)
      : null;
    const exactVerified = typeof resolver.resolveExact === 'function'
      ? resolvedExact !== null
      : typeof resolver.slugExists === 'function'
        ? await resolver.slugExists(normalizedRefSlug, ref.sourceId ?? undefined)
        : true;
    if (
      (ref.exactPath || ref.sourceId)
      && !exactVerified
    ) {
      const unresolvedKey=JSON.stringify([ref.sourceId ?? null,ref.slug]);
      if (!wikilinkUnresolvedSeen.has(unresolvedKey)) {
        wikilinkUnresolvedSeen.add(unresolvedKey);
        wikilinkUnresolved.push({ field: 'wikilink', name: ref.slug, targetSourceId:ref.sourceId ?? undefined });
      }
      continue;
    }
    const idx = ref.index ?? content.indexOf(ref.name);
    const context = idx >= 0 ? excerpt(content, idx, 240) : ref.name;
    candidates.push({
      targetSlug: resolvedExact?.slug ?? normalizedRefSlug,
      authoredRef:{key:JSON.stringify([ref.sourceId??null,ref.slug]),kind:ref.slug.includes('/')?'slug':'name',target:ref.slug,targetSourceId:ref.sourceId??undefined},
      ...(resolvedExact?.sourceId ? { targetSourceId: resolvedExact.sourceId } : {}),
      resolutionType: ref.sourceId ? 'qualified' : 'unqualified',
      linkType: typeFor(context, resolvedExact?.slug ?? normalizedRefSlug, idx, resolvedExact?.sourceId ?? ref.sourceId ?? undefined),
      context,
      linkSource: 'markdown',
    });
  }

  // 2. Bare slug references (e.g. "see people/alice-chen for context").
  // Limited to the same entity directories ENTITY_REF_RE covers.
  // Code blocks are stripped first — slugs in code samples are not real refs.
  const strippedContent = stripCodeBlocks(content);
  const bareRe = new RegExp(
    `\\b(${ANY_DIR_SEGMENT}\\/[a-z0-9][a-z0-9/-]*[a-z0-9])\\b`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = bareRe.exec(strippedContent)) !== null) {
    // Skip matches that are part of a markdown link (already handled above).
    const charBefore = m.index > 0 ? strippedContent[m.index - 1] : '';
    if (charBefore === '/' || charBefore === '(' || charBefore === '[' || charBefore === ':') continue;
    const context = excerpt(strippedContent, m.index, 240);
    candidates.push({
      targetSlug: m[1],
      linkType: typeFor(context, m[1], m.index),
      context,
      linkSource: 'markdown',
    });
  }

  // 3. Frontmatter-derived edges (v0.13). Includes the legacy `source:`
  // field along with the full field map.
  const fm = opts.skipFrontmatter
    ? { candidates: [], unresolved: [] }
    : await extractFrontmatterLinks(slug, pageType, frontmatter, resolver, pack, opts.targetType);
  candidates.push(...fm.candidates);

  // Within-page dedup: same (fromSlug, targetSlug, linkType, linkSource)
  // collapses to one entry. First occurrence wins.
  const seen = new Set<string>();
  const result: LinkCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.fromSourceId ?? ''}\u0000${c.fromSlug ?? ''}\u0000${c.targetSourceId ?? ''}\u0000${c.targetSlug}\u0000${c.linkType}\u0000${c.linkSource ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return { candidates: result, unresolved: [...wikilinkUnresolved, ...fm.unresolved] };
}

function excerptAnchor(s: string, idx: number, width: number): number {
  return s.slice(Math.max(0, idx - Math.floor(width / 2)), idx).replace(/\s+/g, ' ').trimStart().length;
}

/** Excerpt a window of `width` chars around `idx`, collapsed to one line. */
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
const WORKS_AT_RE = /\b(?:joined\b[^.\n]{0,80}?\bas (?:an? |the )?(?:senior |staff |principal |lead |founding |chief )?(?:engineer|developer|designer|product manager|engineering manager|manager|director|head of [a-z]+|scientist|researcher|analyst|employee|operator|cto|ceo|coo|cfo|cmo|vp)|CEO of|CTO of|COO of|CFO of|CMO of|CRO of|VP at|VP of|VPs? Engineering|VPs? Product|works at|worked at|working at|employed by|employed at|joined as|joined the team|engineer at|engineer for|director at|director of|head of|heads up .{0,20} at|leads engineering|leads product|leads the .{0,20} (?:team|org) at|manages engineering at|manages product at|running (?:engineering|product|design) at|currently at|previously at|previously worked at|spent .* (?:years|months) at|stint at|stint as|tenure at|tenure as|role at|position at|(?:senior|staff|principal|lead|backend|frontend|full-?stack|ML|data|security) engineer at|promoted to (?:senior|staff|principal|lead) .{0,20} at|(?:his|her|their|my) time at)\b/i;

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

// Chinese relationship verbs. Entity-name matching supports CJK scripts in
// by-mention.ts; relationship typing here is intentionally scoped to Chinese.
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

const VERB_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [FOUNDED_RE, 'founded'], [INVESTED_RE, 'invested_in'], [ADVISES_RE, 'advises'], [WORKS_AT_RE, 'works_at'],
  [ZH_FOUNDED_RE, 'founded'], [ZH_INVESTED_RE, 'invested_in'], [ZH_ADVISES_RE, 'advises'], [ZH_WORKS_AT_RE, 'works_at'], [ZH_CITED_RE, 'cited'],
];
const LINK_MARK_RE = /\]\(|\]\]|\[\[/;
const INLINE_LINK_RE = /\[\[[^\]\n]*\]\]|\[[^\]\n]*\]\([^)\n]*\)/g;
const CONNECTOR_RE = /^\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or|&|as well as)\s+)(?:(?:at|in|with|for|of|to)\s+)?$/i;
const coordinated = (between: string) => {
  const [lead, ...gaps] = between.split(INLINE_LINK_RE);
  return !lead.trim() && gaps.length > 0 && gaps.every(gap => CONNECTOR_RE.test(gap));
};
const GLOBAL_VERB_RULES = VERB_RULES.map(([re, verb]) => [new RegExp(re.source, `${re.flags.replace('g', '')}g`), verb] as const);
function attachedVerb(context: string, targetSlug?: string, anchor?: number): string | null | undefined {
  const fromAnchor = targetSlug && anchor !== undefined ? context.indexOf(targetSlug, anchor) : -1;
  const at = fromAnchor >= 0 ? fromAnchor : targetSlug ? context.indexOf(targetSlug) : -1;
  if (at < 0) return undefined;
  const open = context.lastIndexOf('[', at);
  const linkStart = open >= 0 && at - open <= 120 ? (context[open - 1] === '[' ? open - 1 : open) : at;
  const close = context.slice(at).search(/\)|\]\]/);
  const linkEnd = close >= 0 ? at + close + (context[at + close] === ')' ? 1 : 2) : at + targetSlug!.length;
  for (const [re, verb] of GLOBAL_VERB_RULES) {
    for (const match of context.matchAll(re)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (end <= linkStart && LINK_MARK_RE.test(context.slice(end, linkStart))
        && !coordinated(context.slice(end, linkStart))) continue;
      if (start >= linkEnd && (LINK_MARK_RE.test(context.slice(linkEnd, start)) || /^\s*(?:(?:with|at|to|for|of|in|on)\s+)?\[/i.test(context.slice(end)))) continue;
      return verb;
    }
  }
  return null;
}

function rolePriorSuppressedRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const headingRe = /^(#{1,6})[ \t]+(?:timeline|see[ -]also|related|facts|sources|links|email mention links|backlinks|significant moments)\b[^\n]*$/gim;
  const anyHeadingRe = /^(#{1,6})[ \t]/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(content)) !== null) {
    const level = match[1].length;
    anyHeadingRe.lastIndex = match.index + match[0].length;
    let next: RegExpExecArray | null;
    while ((next = anyHeadingRe.exec(content)) !== null && next[1].length > level) { /* nested */ }
    ranges.push([match.index, next ? next.index : content.length]);
  }
  return ranges;
}

function inSuppressedRange(ranges: Array<[number, number]>, idx: number): boolean {
  for (const [start, end] of ranges) {
    if (idx >= start && idx < end) return true;
  }
  return false;
}

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
export function inferLinkType(pageType: PageType, context: string, globalContext?: string, targetSlug?: string, targetType?: string | null, anchor?: number): string {
  if (pageType === 'media') {
    return 'mentions';
  }
  // v0.27.1: image pages link to their text sibling via 'image_of' (the
  // image is OF that meeting/note). Set explicitly by the import-image
  // path-proximity helper, not by markdown extraction — but the type is
  // declared here so graph-query knows the edge name.
  if ((pageType as string) === 'image') return 'image_of';
  if ((pageType as string) === 'meeting') {
    return targetType !== undefined
      ? (targetType === 'person' ? 'attended' : 'mentions')
      : (!targetSlug || targetSlug.startsWith('people/') ? 'attended' : 'mentions');
  }
  const attached = attachedVerb(context, targetSlug, anchor);
  if (attached) return attached;
  if (attached === undefined) {
    for (const [re, verb] of VERB_RULES) if (re.test(context)) return verb;
  }
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
type FrontmatterMapping = FrontmatterFieldMapping & { expectedType?: string };

function frontmatterMappingsForPage(pageType: PageType, pack?: LinkExtractionPack | null): FrontmatterMapping[] {
  const mappings: FrontmatterMapping[] = [];
  const seen = new Set<string>();
  for (const mapping of FRONTMATTER_LINK_MAP) {
    if (mapping.pageType && mapping.pageType !== pageType) continue;
    for (const field of mapping.fields) {
      if (seen.has(field)) continue;
      seen.add(field);
      const packType = pack ? frontmatterLinkTypeFromPack(pack, pageType as string, field) : null;
      const expectedType = packType
        ? pack?.link_types.find(item => item.name === packType)?.inference?.target_type
        : undefined;
      mappings.push({ ...mapping, fields: [field], type: packType ?? mapping.type, expectedType });
    }
  }
  if (!pack) return mappings;
  for (const fieldLink of pack.frontmatter_links) {
    if (fieldLink.page_type && fieldLink.page_type !== pageType) continue;
    for (const field of fieldLink.fields) {
      if (seen.has(field)) continue;
      seen.add(field);
      const expectedType = pack.link_types.find(item => item.name === fieldLink.link_type)?.inference?.target_type;
      const prefixes = pack.page_types
        ?.find(item => item.name === expectedType)
        ?.path_prefixes.map(prefix => prefix.replace(/^\/+|\/+$/g, ''))
        .filter(Boolean) ?? [];
      mappings.push({
        fields: [field],
        pageType: fieldLink.page_type,
        type: fieldLink.link_type,
        direction: 'outgoing',
        dirHint: prefixes.length > 0 ? prefixes : '',
        expectedType,
      });
    }
  }
  return mappings;
}

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
  { fields: ['derives_from', 'derived_from', 'evidence'], type: 'derives_from', direction: 'outgoing', dirHint: '' },
  { fields: ['evidence_for'], type: 'evidence_of', direction: 'outgoing', dirHint: '' },
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
  /** Source-aware display-name resolution for multi-source brains. */
  resolveTarget?(
    name: string,
    dirHint?: string | string[],
  ): Promise<{ slug: string; sourceId: string; resolutionType: LinkResolutionType } | null>;
  /** Exact path resolution; requestedSourceId pins a qualified wikilink. */
  resolveExact?(
    slug: string,
    requestedSourceId?: string,
  ): Promise<{ slug: string; sourceId: string; resolutionType: LinkResolutionType } | null>;
  /** Exact path in the current Source only; ordinary relative Markdown links never fall back across Sources. */
  resolveLocalExact?(
    slug: string,
  ): Promise<{ slug: string; sourceId: string; resolutionType: LinkResolutionType } | null>;
  /** Backward-compatible exact existence check. */
  slugExists?(slug: string, requestedSourceId?: string): Promise<boolean>;
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
  type ResolvedTarget = {
    slug: string;
    sourceId: string;
    resolutionType: LinkResolutionType;
  };
  const currentSourceId = opts.sourceId ?? 'default';
  const sourceOrder = currentSourceId === 'default'
    ? ['default']
    : [currentSourceId, 'default'];
  const cache = new Map<string, ResolvedTarget | null>();
  const slugSnapshots = new Map<string, Set<string>>();

  async function ensureSlugSnapshot(sourceId: string): Promise<Set<string>> {
    const cached = slugSnapshots.get(sourceId);
    if (cached) return cached;
    try {
      const snapshot = await engine.getAllSlugs({ sourceId });
      slugSnapshots.set(sourceId, snapshot);
      return snapshot;
    } catch {
      const empty = new Set<string>();
      slugSnapshots.set(sourceId, empty);
      return empty;
    }
  }

  async function resolveExact(
    slug: string,
    requestedSourceId?: string,
  ): Promise<ResolvedTarget | null> {
    if (!slug || typeof slug !== 'string') return null;
    const sources = requestedSourceId ? [requestedSourceId] : sourceOrder;
    for (const sourceId of sources) {
      if ((await ensureSlugSnapshot(sourceId)).has(slug)) {
        return {
          slug,
          sourceId,
          resolutionType: requestedSourceId ? 'qualified' : 'unqualified',
        };
      }
    }
    return null;
  }

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');

  async function resolveTarget(
    name: string,
    dirHint?: string | string[],
  ): Promise<ResolvedTarget | null> {
      if (!name || typeof name !== 'string') return null;
      const trimmed = name.trim();
      if (!trimmed) return null;

      const cacheKey = `${trimmed}\u0000${Array.isArray(dirHint) ? dirHint.join(',') : (dirHint || '')}`;
      if (cache.has(cacheKey)) return cache.get(cacheKey)!;

      const hints = Array.isArray(dirHint) ? dirHint : (dirHint ? [dirHint] : []);

      // Step 1: already a slug? (dir/name shape, lowercase, hyphenated)
    if (/^[^:/\s]+\/.+$/.test(trimmed)) {
        const exact = await resolveExact(trimmed);
        if (exact) {
          cache.set(cacheKey, exact);
          return exact;
        }
      }

      // Step 2: dir-hint + slugify → exact getPage
      const slugified = norm(trimmed);
      for (const sourceId of sourceOrder) {
        for (const hint of hints) {
          if (!hint) continue;
          const candidate = `${hint}/${slugified}`;
          const page = await engine.getPage(candidate, { sourceId });
          if (page) {
            const resolved = { slug: candidate, sourceId, resolutionType: 'unqualified' as const };
            cache.set(cacheKey, resolved);
            return resolved;
          }
        }
      }

      // Step 3: pg_trgm fuzzy title match — both modes. Tries each hint in
      // order; first hint with a ≥0.55 similarity match wins. If no hints,
      // try the whole pages table.
      const searchHints = hints.length > 0 ? hints : [undefined];
      for (const sourceId of sourceOrder) {
        for (const hint of searchHints) {
          const match = await engine.findByTitleFuzzy(trimmed, hint, 0.55, { sourceId });
          if (match) {
            const resolved = { slug: match.slug, sourceId, resolutionType: 'unqualified' as const };
            cache.set(cacheKey, resolved);
            return resolved;
          }
        }
      }

      // Step 4: live-mode ONLY — fall back to hybrid search. expand: false
      // is MANDATORY (see operations-query-hidden-haiku learning). Batch
      // mode skips this step entirely to keep migration deterministic.
      if (opts.mode === 'live') {
        for (const sourceId of sourceOrder) {
          try {
            const results = await engine.searchKeyword(trimmed, { limit: 3, sourceId });
            if (results.length > 0 && results[0].score >= 0.8) {
              // Filter by dir hint if provided.
              const top = hints.length > 0
                ? results.find(r => hints.some(h => r.slug.startsWith(`${h}/`)))
                : results[0];
              if (top) {
                const resolved = { slug: top.slug, sourceId, resolutionType: 'unqualified' as const };
                cache.set(cacheKey, resolved);
                return resolved;
              }
            }
          } catch {
            // Search errors are non-fatal; try default or fall through to null.
          }
        }
      }

      // Null = unresolvable. Caller records for the unresolved report.
      cache.set(cacheKey, null);
      return null;
  }

  return {
    resolveExact,
    async resolveLocalExact(slug: string): Promise<ResolvedTarget | null> {
      return resolveExact(slug, currentSourceId);
    },
    resolveTarget,
    async slugExists(slug: string, requestedSourceId?: string): Promise<boolean> {
      return (await resolveExact(slug, requestedSourceId)) !== null;
    },
    async resolve(name: string, dirHint?: string | string[]): Promise<string | null> {
      return (await resolveTarget(name, dirHint))?.slug ?? null;
    },
  };
}

// ─── Frontmatter extractor ──────────────────────────────────────

export interface UnresolvedFrontmatterRef {
  /** The frontmatter field name. */
  field: string;
  /** The name that did not resolve. */
  name: string;
  reason?: 'target_type_mismatch';
  targetSourceId?: string;
}

export interface FrontmatterExtractResult {
  candidates: LinkCandidate[];
  unresolved: UnresolvedFrontmatterRef[];
}

/** Return the target portion of an Obsidian wikilink stored as a YAML value. */
export function unwrapWikilink(value: string): string {
  const trimmed = value.trim();
  const match = /^\[\[([^|\]#]+?)(?:#[^|\]]*?)?(?:\|[^\]]*?)?\]\]$/.exec(trimmed);
  return match ? stripEscapedPipeTail(match[1]!.trim()) : trimmed;
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
  pack?: LinkExtractionPack | null,
  targetType?: (slug: string, sourceId?: string) => string | undefined,
): Promise<FrontmatterExtractResult> {
  const candidates: LinkCandidate[] = [];
  const unresolved: UnresolvedFrontmatterRef[] = [];
  const mappings = frontmatterMappingsForPage(pageType, pack);

  for (const mapping of mappings) {
    for (const field of mapping.fields) {
      const value = frontmatter[field];
      if (value == null) continue;
      const entries = Array.isArray(value) ? value : [value];

      for (const entry of entries) {
        // Extract the name to resolve. Strings pass through; objects use
        // the `name` / `slug` / `title` field in that preference order.
        let name: string | null = null;
        let requestedSourceId: string | undefined;
        let contextExtra = '';
        if (typeof entry === 'string') {
          name = unwrapWikilink(entry);
        } else if (entry && typeof entry === 'object') {
          const obj = entry as Record<string, unknown>;
          const n = obj.name ?? obj.slug ?? obj.title;
          if (typeof n === 'string') {
            name = n;
            if (typeof obj.source_id === 'string' && obj.source_id.trim() !== '') {
              requestedSourceId = obj.source_id.trim();
            }
            // Carry interesting object fields (role, title) into the context.
            const extras: string[] = [];
            if (typeof obj.role === 'string') extras.push(obj.role);
            if (typeof obj.title === 'string' && obj.title !== n) extras.push(obj.title);
            if (extras.length > 0) contextExtra = ` (${extras.join(', ')})`;
          }
        }
        if (!name) continue;   // skip numbers, nulls, malformed objects

        const qualified = /^([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?):(.+\/.+)$/.exec(name);
        if (qualified) {
          requestedSourceId ??= qualified[1];
          name = qualified[2];
        }
        if (name.includes('/')) name = pathToSlug(name.replace(/\\/g, '/'));

        const resolvedTarget = requestedSourceId && typeof resolver.resolveExact === 'function'
          ? await resolver.resolveExact(name, requestedSourceId)
          : typeof resolver.resolveTarget === 'function'
            ? await resolver.resolveTarget(name, mapping.dirHint)
            : null;
        const resolved = (requestedSourceId && typeof resolver.resolveExact === 'function')
          || typeof resolver.resolveTarget === 'function'
          ? resolvedTarget?.slug ?? null
          : await resolver.resolve(name, mapping.dirHint);
        if (!resolved) {
          unresolved.push({ field, name });
          continue;
        }
        if (mapping.expectedType && targetType && targetType(resolved, resolvedTarget?.sourceId) !== mapping.expectedType) {
          unresolved.push({ field, name, reason: 'target_type_mismatch' });
          continue;
        }

        // Outgoing: page → resolved. Incoming: resolved → page.
        const fromSlug = mapping.direction === 'outgoing' ? slug : resolved;
        const toSlug   = mapping.direction === 'outgoing' ? resolved : slug;
        // Context enrichment (review Finding 7): readable in backlink panels
        // and search snippets instead of bare `frontmatter.key_people`.
        const context = `frontmatter.${field}: ${name}${contextExtra}`;

        const candidate: LinkCandidate = {
          fromSlug,
          ...(mapping.direction === 'incoming' && resolvedTarget?.sourceId
            ? { fromSourceId: resolvedTarget.sourceId }
            : {}),
          targetSlug: toSlug,
          ...(mapping.direction === 'outgoing' && resolvedTarget?.sourceId
            ? { targetSourceId: resolvedTarget.sourceId }
            : {}),
          linkType: mapping.type,
          context,
          linkSource: 'frontmatter',
          originSlug: slug,       // the page whose frontmatter created this edge
          originField: field,
          resolutionType: resolvedTarget?.resolutionType ?? 'unqualified',
        };
        candidates.push(candidate);

        // A synthesis hub derived from evidence must also receive an inbound
        // edge from that evidence page. This is what prevents pattern/concept
        // hubs from remaining graph orphans after Dream creates them.
        if (mapping.type === 'derives_from' && mapping.direction === 'outgoing') {
          candidates.push({
            fromSlug: resolved,
            ...(resolvedTarget?.sourceId ? { fromSourceId: resolvedTarget.sourceId } : {}),
            targetSlug: slug,
            linkType: 'evidence_of',
            context,
            linkSource: 'frontmatter',
            originSlug: slug,
            originField: field,
            resolutionType: resolvedTarget?.resolutionType ?? 'unqualified',
          });
        }
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
  source?: string;
}

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
const TIMELINE_LINE_RE = /^\s*-?\s*\*\*(\d{4}-\d{2}-\d{2})\*\*\s*([|\-–—]+)\s*(.+?)\s*$/;
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
    const m = TIMELINE_LINE_RE.exec(lines[i]);
    let date: string;
    let summary: string;
    let separator: string;
    if (m) {
      date = m[1];
      separator = m[2];
      summary = m[3].trim();
    } else {
      const cnMatch = TIMELINE_LINE_RE_CN.exec(lines[i]);
      if (!cnMatch) {
        i++;
        continue;
      }
      date = `${cnMatch[1]}-${cnMatch[2].padStart(2, '0')}-${cnMatch[3].padStart(2, '0')}`;
      separator = cnMatch[4];
      summary = cnMatch[5].trim();
    }
    if (!isValidDate(date) || summary.length === 0) {
      i++;
      continue;
    }
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
      if (TIMELINE_LINE_RE.test(next) || TIMELINE_LINE_RE_CN.test(next)) break;
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

export interface TimelineAnchorInput {
  slug: string;
  title?: string | null;
  effectiveDate?: Date | string | null;
  effectiveDateSource?: EffectiveDateSource | null;
}

/**
 * Build one page-level timeline anchor from a trustworthy content date.
 *
 * This is deliberately opt-in at the command layer and rejects the
 * `fallback` source because that value comes from updated_at, not from the
 * event itself. Callers use it only when the page body yielded no timeline
 * entry, so an inferred anchor never replaces an explicit date.
 */
export function deriveTimelineAnchor(input: TimelineAnchorInput): TimelineCandidate | null {
  const { slug, title, effectiveDate, effectiveDateSource } = input;
  if (!effectiveDate || effectiveDateSource == null || effectiveDateSource === 'fallback') {
    return null;
  }
  const parsed = typeof effectiveDate === 'string' ? new Date(effectiveDate) : effectiveDate;
  if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) return null;
  const date = parsed.toISOString().slice(0, 10);
  if (!isValidDate(date)) return null;
  const summary = (title ?? '').trim() || slug.split('/').pop() || slug;
  return { date, summary, detail: '' };
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

export async function loadExtractionPack(engine: BrainEngine, sourceId?: string): Promise<LinkExtractionPack | null> {
  try {
    const { loadActivePack } = await import('./schema-pack/load-active.ts');
    const { loadConfig } = await import('./config.ts');
    const dbConfig = await engine.getConfig('schema_pack');
    const sourcePack = sourceId ? await engine.getConfig(`schema_pack.source.${sourceId}`) : null;
    const resolved = await loadActivePack({
      cfg: loadConfig(),
      remote: true,
      sourceId,
      dbConfig: dbConfig ?? undefined,
      perSourceDb: sourceId && sourcePack ? new Map([[sourceId, sourcePack]]) : undefined,
    });
    return resolved.manifest;
  } catch {
    return null;
  }
}

export async function loadPageTypeMap(engine: BrainEngine, slugs?: readonly string[]): Promise<Map<string, string>> {
  const rows = slugs
    ? await engine.executeRaw<{ slug: string; source_id: string; type: string }>(
      `SELECT slug, source_id, type FROM pages WHERE deleted_at IS NULL AND slug = ANY($1::text[])`,
      [[...new Set(slugs)]],
    )
    : await engine.executeRaw<{ slug: string; source_id: string; type: string }>(
      `SELECT slug, source_id, type FROM pages WHERE deleted_at IS NULL`,
    );
  const map = new Map<string, string>();
  for (const row of rows) map.set(`${row.source_id}\0${row.slug}`, row.type);
  return map;
}

export function pageTypeAt(
  types: Map<string, string>,
  slug: string,
  sourceId?: string,
  preferSource?: string,
): string | undefined {
  if (sourceId && types.has(`${sourceId}\0${slug}`)) return types.get(`${sourceId}\0${slug}`);
  if (preferSource && types.has(`${preferSource}\0${slug}`)) return types.get(`${preferSource}\0${slug}`);
  if (types.has(`default\0${slug}`)) return types.get(`default\0${slug}`);
  return undefined;
}
