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
  /**
   * v0.17.0: source id when the link was qualified as `[[source:slug]]`.
   * `null` means unqualified — the caller resolves via local-first fallback
   * at extraction time. Mirrors links.resolution_type:
   *   - sourceId set   → 'qualified'
   *   - sourceId null  → 'unqualified'
   */
  sourceId?: string | null;
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
  //    Markdown links have no source-qualification syntax — they're
  //    always unqualified. Omit sourceId so the shape stays compatible
  //    with pre-v0.17 consumers doing strict equality.
  const mdPattern = new RegExp(ENTITY_REF_RE.source, ENTITY_REF_RE.flags);
  while ((match = mdPattern.exec(stripped)) !== null) {
    const name = match[1];
    const fullPath = match[2];
    const slug = fullPath;
    const dir = fullPath.split('/')[0];
    refs.push({ name, slug, dir });
  }

  // 2a. v0.17.0 qualified wikilinks: [[source-id:path]] or [[source-id:path|Display]]
  //     Must run BEFORE the unqualified pass or we'd double-emit. We also
  //     mask out the matched spans so pass 2b can't grab them.
  const qualifiedRanges: Array<[number, number]> = [];
  const qualPattern = new RegExp(QUALIFIED_WIKILINK_RE.source, QUALIFIED_WIKILINK_RE.flags);
  while ((match = qualPattern.exec(stripped)) !== null) {
    const sourceId = match[1];
    let slug = match[2].trim();
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
  const unmasked = maskRanges(stripped, qualifiedRanges);
  const wikiPattern = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
  while ((match = wikiPattern.exec(unmasked)) !== null) {
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
): Promise<PageLinksResult> {
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
      linkSource: 'markdown',
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
      linkSource: 'markdown',
    });
  }

  // 3. Frontmatter-derived edges (v0.13). Includes the legacy `source:`
  // field along with the full field map.
  const fm = await extractFrontmatterLinks(slug, pageType, frontmatter, resolver);
  candidates.push(...fm.candidates);

  // Within-page dedup: same (fromSlug, targetSlug, linkType, linkSource)
  // collapses to one entry. First occurrence wins.
  const seen = new Set<string>();
  const result: LinkCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.fromSlug ?? ''}\u0000${c.targetSlug}\u0000${c.linkType}\u0000${c.linkSource ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return { candidates: result, unresolved: fm.unresolved };
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
  opts: { mode: 'batch' | 'live' } = { mode: 'live' },
): SlugResolver {
  const cache = new Map<string, string | null>();

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');

  return {
    async resolve(name: string, dirHint?: string | string[]): Promise<string | null> {
      if (!name || typeof name !== 'string') return null;
      const trimmed = name.trim();
      if (!trimmed) return null;

      const cacheKey = `${trimmed}\u0000${Array.isArray(dirHint) ? dirHint.join(',') : (dirHint || '')}`;
      if (cache.has(cacheKey)) return cache.get(cacheKey)!;

      const hints = Array.isArray(dirHint) ? dirHint : (dirHint ? [dirHint] : []);

      // Step 1: already a slug? (dir/name shape, lowercase, hyphenated)
      if (/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
        const page = await engine.getPage(trimmed);
        if (page) {
          cache.set(cacheKey, trimmed);
          return trimmed;
        }
      }

      // Step 2: dir-hint + slugify → exact getPage
      const slugified = norm(trimmed);
      for (const hint of hints) {
        if (!hint) continue;
        const candidate = `${hint}/${slugified}`;
        const page = await engine.getPage(candidate);
        if (page) {
          cache.set(cacheKey, candidate);
          return candidate;
        }
      }

      // Step 3: pg_trgm fuzzy title match — both modes. Tries each hint in
      // order; first hint with a ≥0.55 similarity match wins. If no hints,
      // try the whole pages table.
      const searchHints = hints.length > 0 ? hints : [undefined];
      for (const hint of searchHints) {
        const match = await engine.findByTitleFuzzy(trimmed, hint, 0.55);
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
): Promise<FrontmatterExtractResult> {
  const candidates: LinkCandidate[] = [];
  const unresolved: UnresolvedFrontmatterRef[] = [];

  for (const mapping of FRONTMATTER_LINK_MAP) {
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

        const resolved = await resolver.resolve(name, mapping.dirHint);
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
