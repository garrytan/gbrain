/**
 * The `entity` card's identity fields: where each `aka` entry came from
 * (`aka_sources`), the identity siblings (mentions/siblings.ts) with their own
 * aliases, an `identity_excerpt` of verbatim lines that may carry other names
 * the alias grammar does not parse, and guidance on what `aka` covers.
 *
 * The excerpt is phrasing-independent: a line qualifies without naming the
 * subject when it matches the alias grammar, has a label and value shape
 * (`Label: value`, a table row), or holds a capitalized multi-word run or an
 * all-caps code token other than the subject's own name. Tiers, each in page
 * order: grammar matches; label and value lines whose value is name-like;
 * other label and value lines; the rest. Lines are cut from the remote-
 * sanitized body (private takes and facts fences, forgotten facts and
 * malformed fences removed) for every caller, at most EXCERPT_PAGE_CHARS per
 * page and EXCERPT_CARD_CHARS per card; a page that did not fit is listed in
 * `identity_excerpt_omitted`. The excerpt adds nothing to the mention index.
 */

import type { BrainEngine } from '../engine.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { ALIAS_ORIGIN_RANK, declarationsIn, titleName, type AliasOrigin } from '../mentions/aliases.ts';
import { readIdentitySiblings, SIBLING_GROUP_CAP } from '../mentions/siblings.ts';
import type { Notice } from '../agent-output.ts';

export const EXCERPT_PAGE_CHARS = 600;
export const EXCERPT_CARD_CHARS = 1200;
const EXCERPT_LINE_CHARS = 300;
const NOT_NAMES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'ARR', 'MRR', 'TBD', 'N/A', 'NA', 'CEO', 'CFO', 'CTO', 'COO', 'VP', 'UTC', 'PST', 'PDT', 'EST', 'ID']);
const NAME_RUN_RE = /\b[A-Z][\p{L}\p{N}&'’-]*(?:\s+[A-Z][\p{L}\p{N}&'’-]*)+/gu;
const CODE_RE = /\b(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{2,}\b/g;

export interface IdentityExcerptLine { slug: string; line: string }

/** Whether `text` holds a name other than `subject`: a capitalized multi-word run or a code token. */
export function hasOtherName(text: string, subject: string): boolean {
  const own = subject.toLowerCase();
  const stripped = own ? text.replace(new RegExp(own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ') : text;
  for (const m of stripped.matchAll(NAME_RUN_RE)) if (m[0].toLowerCase() !== own) return true;
  for (const m of stripped.matchAll(CODE_RE)) if (!NOT_NAMES.has(m[0]) && !/^\d[\d-]*$/.test(m[0])) return true;
  return false;
}

/** The label/value split of a line (`Label: value`, `| label | value |`), or null. */
function labelValue(line: string, next: string | undefined): { label: string; value: string } | null {
  const t = line.trim();
  if (t.startsWith('|')) {
    if (/^\|?\s*:?-{2,}/.test(t) || (next && /^\s*\|?\s*:?-{2,}/.test(next))) return null;
    const cells = t.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    return cells.length >= 2 && cells[0] ? { label: cells[0], value: cells.slice(1).join(' | ') } : null;
  }
  const plain = t.replace(/^(?:[-*+>]|\d+[.)])\s+/, '').replace(/\*\*|__/g, '');
  const colon = plain.indexOf(':');
  if (colon <= 0 || colon > 60 || plain.slice(0, colon).split(/\s+/).length > 6) return null;
  const value = plain.slice(colon + 1).trim();
  return value ? { label: plain.slice(0, colon).trim(), value } : null;
}

/** One page's qualifying lines, tiered and capped at `budget` characters. */
export function excerptLines(body: string, title: string, budget = EXCERPT_PAGE_CHARS): string[] {
  const subject = titleName(title);
  const lines = body.split('\n');
  const declared = new Set(declarationsIn(body, { ownNames: [subject] }).map(d => d.line));
  const tiers: Array<Array<{ i: number; text: string }>> = [[], [], [], []];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (!text || /^#+\s/.test(text) || /^\|?\s*:?-{2,}/.test(text)) continue;
    const lv = labelValue(text, lines[i + 1]);
    const tier = declared.has(i) ? 0
      : lv && hasOtherName(lv.value, subject) && !/^[\d\s$€£.,:%/-]+$/.test(lv.value) ? 1
      : lv ? 2
      : hasOtherName(text, subject) ? 3 : -1;
    if (tier >= 0) tiers[tier]!.push({ i, text: text.length > EXCERPT_LINE_CHARS ? `${text.slice(0, EXCERPT_LINE_CHARS - 1)}…` : text });
  }
  const out: string[] = [];
  let used = 0;
  for (const tier of tiers) {
    for (const { text } of tier) {
      if (used + text.length > budget) return out;
      out.push(text);
      used += text.length;
    }
  }
  return out;
}

export interface CardIdentity {
  aka_sources: Array<{ origin: string; slug: string }>;
  identity_siblings?: { pages: Array<{ slug: string; title: string; type: string | null; aka: string[] }>; capped: boolean };
  identity_excerpt?: IdentityExcerptLine[];
  identity_excerpt_omitted?: string[];
  alias_guidance?: { text: string; requires_surface?: 'starter' };
}

const GUIDANCE = 'aka lists names gbrain recognized as declared on this page (aka_sources says where); it is not proof the list is complete. '
  + 'search already queries these names and the identity siblings\' names (rows found that way carry matched_alias), which is not proof every record was retrieved. '
  + 'Before a history or as-of answer, also search any other name shown in identity_excerpt or in a search response\'s fanout.aliases_skipped.';
const GUIDANCE_VERBS = 'aka lists names gbrain recognized as declared on this page (aka_sources says where); it is not proof the list is complete. '
  + 'Before a history or as-of answer, also look for records under every name shown in aka, identity_siblings and identity_excerpt; searching needs the search tool on the starter surface.';

/** The card's identity fields for `row`. Fail-soft: a failed read leaves the field out. */
export async function readCardIdentity(engine: BrainEngine, sourceId: string,
  row: { slug: string; title: string | null; compiled_truth: string | null },
  opts: { excludePrivate: boolean; surfaceCeiling?: 'verbs' | 'starter' | 'full'; aka: string[] }): Promise<CardIdentity> {
  const siblings = await readIdentitySiblings(engine, sourceId, row, { excludePrivate: opts.excludePrivate });
  const slugs = [row.slug, ...siblings.pages.map(p => p.slug)];
  const aliasRows = await engine.executeRaw<{ slug: string; alias_norm: string; origin: string | null; alias_text: string | null }>(
    `SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY alias_norm`,
    [sourceId, slugs]).catch(() => []);
  const own = aliasRows.filter(a => a.slug === row.slug);
  const bestOrigin = (norm: string) => own.filter(a => a.alias_norm === norm).map(a => a.origin ?? 'frontmatter')
    .sort((x, y) => (ALIAS_ORIGIN_RANK[x as AliasOrigin] ?? 0) - (ALIAS_ORIGIN_RANK[y as AliasOrigin] ?? 0))[0] ?? 'frontmatter';
  const aka_sources = opts.aka.map(norm => ({ origin: bestOrigin(norm), slug: row.slug }));
  const out: CardIdentity = { aka_sources };
  if (siblings.pages.length || siblings.capped) {
    out.identity_siblings = {
      pages: siblings.pages.map(p => ({ ...p, aka: [...new Set(aliasRows.filter(a => a.slug === p.slug).map(a => a.alias_text ?? a.alias_norm))] })),
      capped: siblings.capped,
    };
  }
  const bodies = new Map<string, { title: string; body: string }>([[row.slug, { title: row.title ?? row.slug, body: row.compiled_truth ?? '' }]]);
  if (siblings.pages.length) {
    const rows = await engine.executeRaw<{ slug: string; title: string | null; compiled_truth: string | null }>(
      `SELECT slug, title, compiled_truth FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL`,
      [sourceId, siblings.pages.map(p => p.slug)]).catch(() => []);
    for (const r of rows) bodies.set(r.slug, { title: r.title ?? r.slug, body: r.compiled_truth ?? '' });
  }
  const excerpt: IdentityExcerptLine[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const slug of slugs) {
    const page = bodies.get(slug);
    if (!page) continue;
    const lines = excerptLines(sanitizeRemoteBody(page.body), page.title, Math.min(EXCERPT_PAGE_CHARS, EXCERPT_CARD_CHARS - used));
    const full = excerptLines(sanitizeRemoteBody(page.body), page.title, EXCERPT_PAGE_CHARS);
    if (lines.length < full.length) omitted.push(slug);
    for (const line of lines) { excerpt.push({ slug, line }); used += line.length; }
  }
  if (excerpt.length) out.identity_excerpt = excerpt;
  if (omitted.length) out.identity_excerpt_omitted = omitted;
  if (opts.aka.length || siblings.pages.length || excerpt.length) {
    out.alias_guidance = opts.surfaceCeiling === 'verbs' ? { text: GUIDANCE_VERBS, requires_surface: 'starter' } : { text: GUIDANCE };
  }
  return out;
}

/** The notice for a sibling group too large to show (more than SIBLING_GROUP_CAP pages share the subject). */
export function siblingsCappedNotice(slug: string): Notice {
  return {
    code: 'identity_siblings_capped', kind: 'info',
    why: `More than ${SIBLING_GROUP_CAP} pages share this entity's title subject, so none are shown as identity siblings.`,
    fix: { argv: ['gbrain', 'extract', 'mentions', '--explain', slug], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Lists the pages that share the subject and the sibling decision; the user can mark unrelated pages `identity: separate`.' },
  };
}
