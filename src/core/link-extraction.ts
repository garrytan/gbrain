/**
 * Shared link/timeline extraction utilities.
 *
 * Used by:
 *   - src/commands/link-extract.ts        (batch DB extraction)
 *   - src/commands/timeline-extract.ts    (batch DB extraction)
 *   - src/commands/backlinks.ts           (filesystem walk, legacy)
 *   - src/core/operations.ts put_page     (auto-link post-hook)
 *
 * All functions are PURE (no DB access). The DB lives in the engine; these
 * utilities turn page content into candidates that callers persist via engine
 * methods. Auto-link config is the one impure helper (reads engine.getConfig).
 */

import type { BrainEngine } from './engine.ts';
import type { PageType } from './types.ts';

// ─── Entity references ──────────────────────────────────────────

export interface EntityRef {
  /** Display name from the markdown link, e.g. "Alice Chen". */
  name: string;
  /** Resolved page slug, e.g. "people/alice-chen". */
  slug: string;
  /** Top-level directory ("people" | "companies" | etc.). */
  dir: string;
}

/**
 * Directory prefix whitelist. These are the top-level slug dirs the extractor
 * recognizes as entity references. Upstream canonical + our extensions:
 *   - Gbrain canonical: people, companies, meetings, concepts, deal, civic, project, source, media, yc, projects
 *   - Our domain extensions: tech, finance, personal, openclaw (domain-organized wikis)
 *   - Our entity prefix: entities (we kept some legacy entities/projects/ pages)
 */
const DIR_PATTERN = '(?:people|companies|meetings|concepts|deal|civic|project|projects|source|media|yc|tech|finance|personal|openclaw|entities)';

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
  `\\[([^\\]]+)\\]\\((?:\\.\\.\\/)*(${DIR_PATTERN}\\/[^)\\s]+?)(?:\\.md)?\\)`,
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
 * Strip fenced code blocks (```...```) and inline code (`...`) from markdown,
 * replacing them with whitespace of equivalent length. Preserves byte offsets
 * for any caller that cares about positions; for our extractors this is just
 * defense-in-depth — slugs inside code are not real entity references.
 */
function stripCodeBlocks(content: string): string {
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
  const mdPattern = new RegExp(ENTITY_REF_RE.source, ENTITY_REF_RE.flags);
  while ((match = mdPattern.exec(stripped)) !== null) {
    const name = match[1];
    const fullPath = match[2];
    const slug = fullPath;
    const dir = fullPath.split('/')[0];
    refs.push({ name, slug, dir });
  }

  // 2. Obsidian wikilinks: [[path]] or [[path|Display Text]]
  const wikiPattern = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
  while ((match = wikiPattern.exec(stripped)) !== null) {
    let slug = match[1].trim();
    if (!slug) continue;
    if (slug.includes('://')) continue;
    if (slug.endsWith('.md')) slug = slug.slice(0, -3);
    const displayName = (match[2] || slug).trim();
    const dir = slug.split('/')[0];
    refs.push({ name: displayName, slug, dir });
  }

  return refs;
}

// ─── Link candidates (richer than EntityRef) ────────────────────

export interface LinkCandidate {
  /** Target page slug (no .md, no ../). */
  targetSlug: string;
  /** Inferred relationship type. */
  linkType: string;
  /** Surrounding text (up to ~80 chars) used for inference + storage. */
  context: string;
}

/**
 * Extract all link candidates from a page.
 *
 * Sources:
 *   1. Markdown entity refs in compiled_truth + timeline (extractEntityRefs).
 *   2. Bare slug references in text (people/slug, companies/slug).
 *   3. Frontmatter `source:` field (creates a 'source' link).
 *
 * Within-page dedup: multiple mentions of the same (targetSlug, linkType)
 * collapse to one candidate. The first occurrence's context wins.
 */
export function extractPageLinks(
  content: string,
  frontmatter: Record<string, unknown>,
  pageType: PageType,
): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];

  // 1. Markdown entity refs.
  for (const ref of extractEntityRefs(content)) {
    const idx = content.indexOf(ref.name);
    // Wider context window (240 chars vs original 80) catches verbs that
    // appear at sentence-or-paragraph distance from the slug — common in
    // narrative prose where a partner's investment verbs appear once and
    // then portfolio companies are listed in subsequent sentences.
    const context = idx >= 0 ? excerpt(content, idx, 240) : ref.name;
    candidates.push({
      targetSlug: ref.slug,
      linkType: inferLinkType(pageType, context, content, ref.slug),
      context,
    });
  }

  // 2. Bare slug references (e.g. "see people/alice-chen for context").
  // Limited to the same entity directories ENTITY_REF_RE covers.
  // Code blocks are stripped first — slugs in code samples are not real refs.
  const strippedContent = stripCodeBlocks(content);
  const bareRe = new RegExp(
    `\\b(${DIR_PATTERN}\\/[a-z0-9][a-z0-9/-]*[a-z0-9])\\b`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = bareRe.exec(strippedContent)) !== null) {
    // Skip matches that are part of a markdown link (already handled above).
    const charBefore = m.index > 0 ? strippedContent[m.index - 1] : '';
    if (charBefore === '/' || charBefore === '(') continue;
    const context = excerpt(strippedContent, m.index, 240);
    candidates.push({
      targetSlug: m[1],
      linkType: inferLinkType(pageType, context, content, m[1]),
      context,
    });
  }

  // 3. Frontmatter source field.
  const source = frontmatter.source;
  if (typeof source === 'string' && source.length > 0 && /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(source)) {
    candidates.push({
      targetSlug: source,
      linkType: 'source',
      context: `frontmatter source: ${source}`,
    });
  }

  // Within-page dedup: same (targetSlug, linkType) collapses to one entry.
  // First occurrence wins (preserves the most natural/earliest context).
  const seen = new Set<string>();
  const result: LinkCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.targetSlug}\u0000${c.linkType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}

/** Excerpt a window of `width` chars around `idx`, collapsed to one line. */
function excerpt(s: string, idx: number, width: number): string {
  const half = Math.floor(width / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(s.length, idx + half);
  return s.slice(start, end).replace(/\s+/g, ' ').trim();
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
const WORKS_AT_RE = /\b(?:CEO of|CTO of|COO of|CFO of|CMO of|CRO of|VP at|VP of|VPs? Engineering|VPs? Product|works at|worked at|working at|employed by|employed at|joined as|joined the team|engineer at|engineer for|director at|director of|head of|leads engineering|leads product|currently at|previously at|previously worked at|spent .* (?:years|months) at|stint at|tenure at)\b/i;

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
const ADVISES_RE = /\b(?:advises|advised|advisor (?:to|at|for|of)|advisory (?:board|role|position)|board advisor|on .{0,20} advisory board|joined .{0,20} advisory board)\b/i;

// Page-role detection: if the source page describes a partner/investor at
// page level, that's a strong prior for outbound company refs being
// invested_in even when per-edge context lacks explicit investment verbs.
const PARTNER_ROLE_RE = /\b(?:partner at|partner of|venture partner|VC partner|invested early|investor at|investor in|portfolio|venture capital|early-stage investor|seed investor|fund [A-Z]|invests across|backs companies)\b/i;
const ADVISOR_ROLE_RE = /\b(?:full-time advisor|professional advisor|advises (?:multiple|several|various))\b/i;

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
  if ((pageType as string) === 'meeting') return 'attended';
  // Per-edge verb rules.
  if (FOUNDED_RE.test(context)) return 'founded';
  if (INVESTED_RE.test(context)) return 'invested_in';
  if (ADVISES_RE.test(context)) return 'advises';
  if (WORKS_AT_RE.test(context)) return 'works_at';
  // Page-role prior: only fires for person -> company links. Concept pages
  // about VC topics naturally contain "venture capital" in their text, but
  // their company refs are mentions, not investments. Partner pages mentioning
  // other people (co-investors, friends) should also stay as mentions.
  if (pageType === 'person' && globalContext && targetSlug?.startsWith('companies/')) {
    if (PARTNER_ROLE_RE.test(globalContext)) return 'invested_in';
    if (ADVISOR_ROLE_RE.test(globalContext)) return 'advises';
  }
  return 'mentions';
}

// ─── Timeline parsing ───────────────────────────────────────────

export interface TimelineCandidate {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** First-line summary. */
  summary: string;
  /** Optional detail (subsequent lines until next entry/heading). */
  detail: string;
}

// Match: `- **YYYY-MM-DD** | summary` or `- **YYYY-MM-DD** -- summary`
// or `- **YYYY-MM-DD** - summary` or just `**YYYY-MM-DD** | summary`.
const TIMELINE_LINE_RE = /^\s*-?\s*\*\*(\d{4}-\d{2}-\d{2})\*\*\s*[|\-–—]+\s*(.+?)\s*$/;

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
    if (!m) {
      i++;
      continue;
    }
    const date = m[1];
    const summary = m[2].trim();
    if (!isValidDate(date) || summary.length === 0) {
      i++;
      continue;
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
    result.push({ date, summary, detail: detailLines.join(' ').trim() });
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
