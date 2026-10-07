/**
 * `gbrain extract mentions --explain <name|slug> [--page <slug>] [--source-id <id>] [--json]`
 *
 * Says why a name does or does not link: the gazetteer entry it matches (with
 * its origin: title, frontmatter, declared, subject) or the guard that dropped
 * it, and, with `--page`, whether that page links to it now. Reason codes:
 * `ambiguous_first_word`, `below_min_length`, `generic_token`,
 * `alias_collision`, `case_mismatch`, `type_not_linkable`,
 * `linking_disabled`, `pending`, `ignored_by_page`, `ignored_by_config`,
 * `excluded_by_config`, `denied_by_config`, `not_a_known_name`. With a slug it also lists every
 * name the page derives (origin and declaring line), the rejected candidates
 * with their reasons, and the identity-sibling decision. Only `pending` suggests a sweep; a policy rejection
 * names the setting or the page text that would change it.
 */

import type { BrainEngine } from '../core/engine.ts';
import { buildGazetteer, findMentionedEntities, tokenizeTitle, type DroppedName, type GazetteerEntry } from '../core/by-mention.ts';
import { isCrossSourceLinksEnabled } from '../core/link-extraction.ts';
import { linkableTypesFor, loadSourcePack, parseNameList, readMentionPolicy } from '../core/mentions/policy.ts';
import { deriveEntityAliases, type RejectedAlias } from '../core/mentions/aliases.ts';
import { aliasOptsOf } from '../core/mentions/pass.ts';
import { readIdentitySiblings } from '../core/mentions/siblings.ts';
import { MENTION_EXTRACTOR_VERSION } from '../core/mentions/pass.ts';

export type ExplainReason = 'ambiguous_first_word' | 'below_min_length' | 'generic_token' | 'alias_collision' | 'case_mismatch'
  | 'type_not_linkable' | 'linking_disabled' | 'pending' | 'ignored_by_page' | 'ignored_by_config' | 'excluded_by_config' | 'denied_by_config' | 'not_a_known_name';

export interface MentionExplanation {
  query: string;
  source_id: string;
  /** Gazetteer entries the name (or slug) resolves to. */
  entries: Array<{ name: string; slug: string; origin: string; case_sensitive: boolean }>;
  /** Null when the name links (and, with --page, the page links to it). */
  reason: ExplainReason | null;
  message: string;
  page?: { slug: string; linked: boolean };
  next?: string;
  /** With a slug: every name the page's text derives, with its origin and declaring line. */
  aliases?: Array<{ alias: string; origin: string; line?: string }>;
  /** With a slug: candidate names the derivation rejected, with the reason and line. */
  rejected?: RejectedAlias[];
  /** With a slug: the identity-sibling decision (mentions/siblings.ts). */
  siblings?: { pages: string[]; capped: boolean; verdict: string };
}

const DROP_REASON: Record<DroppedName['reason'], ExplainReason> = {
  below_min_length: 'below_min_length', generic_token: 'generic_token', alias_collision: 'alias_collision',
  ambiguous_first_word: 'ambiguous_first_word', ignored: 'ignored_by_config', excluded_slug: 'excluded_by_config', title_wins: 'alias_collision',
};

const MESSAGES: Record<ExplainReason, string> = {
  ambiguous_first_word: 'This single word is the first word of a longer entity name in this source, so it never links alone; write the full name.',
  below_min_length: 'Names shorter than 4 characters never link (too many false matches); write the full name or declare a longer alias.',
  generic_token: 'This is a generic word (role, document or placeholder), so it never links as a single-word name.',
  alias_collision: 'Another page in this source claims the same name (or it is another page\'s exact title), so the alias is dropped as ambiguous.',
  case_mismatch: 'This alias is case-sensitive (a single-word declared code) and the text uses a different case.',
  type_not_linkable: 'This page type is not a linkable entity type; add it with `gbrain config set mentions.entity_types +<type>`.',
  linking_disabled: 'Mention linking is off (auto_link or mentions.auto_link is false).',
  pending: 'The page changed or was never scanned since the last mention pass.',
  ignored_by_page: 'The page lists this name in its frontmatter `mention_ignore`.',
  ignored_by_config: 'The name is on an ignore list (`mentions.ignore` or the built-in ambiguous-brand list).',
  excluded_by_config: 'The page is listed in `mentions.exclude_slugs`, so none of its names link.',
  denied_by_config: 'The name is on `mentions.alias_deny` or the page\'s frontmatter `alias_deny`, so it is never derived as an alias.',
  not_a_known_name: 'No linkable entity page has this title, title subject or alias in this source.',
};

function done(base: Omit<MentionExplanation, 'reason' | 'message'>, reason: ExplainReason | null, message?: string): MentionExplanation {
  return { ...base, reason, message: message ?? (reason ? MESSAGES[reason] : 'This name links.') };
}

export async function explainMention(engine: BrainEngine, query: string, opts: { sourceId?: string; page?: string } = {}): Promise<MentionExplanation> {
  const sourceId = opts.sourceId ?? 'default';
  const base: Omit<MentionExplanation, 'reason' | 'message'> = { query, source_id: sourceId, entries: [] };
  const policy = await readMentionPolicy(engine);
  if (!policy.enabled) return done(base, 'linking_disabled');
  const dropped: DroppedName[] = [];
  const gazetteer = await buildGazetteer(engine, { policy, dropped });
  const all = [...gazetteer.values()].flat().filter(e => e.source_id === sourceId);
  const view = (e: GazetteerEntry) => ({ name: e.caseTokens ? e.caseTokens.join(' ') : e.tokens.join(' '), slug: e.slug, origin: e.origin ?? 'title', case_sensitive: !!e.caseTokens });
  const [asPage] = await engine.executeRaw<{ slug: string; type: string | null; title: string | null }>(
    'SELECT slug, type, title FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, query]);
  const key = tokenizeTitle(query).join(' ');
  const entries = asPage ? all.filter(e => e.slug === asPage.slug) : all.filter(e => e.tokens.join(' ') === key);
  if (asPage && !entries.length) {
    const types = linkableTypesFor(await loadSourcePack(engine, sourceId), policy);
    if (!types.includes(asPage.type ?? '')) return done(base, 'type_not_linkable');
  }
  base.entries = entries.map(view);
  if (asPage) Object.assign(base, await pageNames(engine, sourceId, asPage.slug, policy));
  if (!entries.length) {
    const drop = dropped.find(d => d.source_id === sourceId && (asPage ? d.slug === asPage.slug : tokenizeTitle(d.name).join(' ') === key));
    if (drop) return done(base, DROP_REASON[drop.reason]);
    if (tokenizeTitle(query).length === 1 && all.some(e => e.tokens.length > 1 && e.tokens[0] === key)) return done(base, 'ambiguous_first_word');
    const rejected = await rejectedDeclaration(engine, sourceId, query, policy);
    return done(base, rejected ?? 'not_a_known_name');
  }
  if (!opts.page) {
    const cased = entries.filter(e => e.caseTokens);
    if (cased.length === entries.length && !cased.some(e => e.caseTokens!.join(' ') === query.normalize('NFC'))) return done(base, 'case_mismatch');
    return done(base, null);
  }
  const [page] = await engine.executeRaw<{ id: number; slug: string; title: string | null; compiled_truth: string; timeline: string; mention_ignore: unknown; due: boolean }>(
    `SELECT p.id, p.slug, p.title, p.compiled_truth, p.timeline, p.frontmatter->'mention_ignore' AS mention_ignore,
            (s.page_id IS NULL OR s.mention_revision IS DISTINCT FROM p.knowledge_revision OR s.mention_version IS DISTINCT FROM $3) AS due
       FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
      WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`, [sourceId, opts.page, MENTION_EXTRACTOR_VERSION]);
  if (!page) return done(base, 'not_a_known_name', `No live page ${opts.page} in source ${sourceId}.`);
  const targets = new Set(entries.map(e => e.slug));
  const ignore = parseNameList(page.mention_ignore);
  if (ignore.some(n => tokenizeTitle(n).join(' ') === entries[0]!.tokens.join(' '))) return { ...done(base, 'ignored_by_page'), page: { slug: page.slug, linked: false } };
  const text = `${page.title ?? ''}\n\n${page.compiled_truth}\n\n${page.timeline}`;
  // Scan with this name's entries only (a slug query: every name of the page), so a link made through another name is not credited to this one.
  const own: typeof gazetteer = new Map();
  for (const e of entries) own.set(e.tokens[0]!, [...(own.get(e.tokens[0]!) ?? []), e]);
  const found = findMentionedEntities(text, own, { fromSlug: page.slug, fromSourceId: sourceId,
    allowCrossSource: await isCrossSourceLinksEnabled(engine), ignoreNames: ignore }).some(m => targets.has(m.slug));
  const [link] = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM links l JOIN pages t ON t.id = l.to_page_id
      WHERE l.from_page_id = $1 AND l.link_source = 'mentions' AND t.source_id = $2 AND t.slug = ANY($3::text[])`, [page.id, sourceId, [...targets]]);
  const linked = Number(link?.n ?? 0) > 0;
  const withPage = (r: ExplainReason | null, message?: string) => ({ ...done(base, r, message), page: { slug: page.slug, linked } });
  if (found && !linked) return { ...withPage('pending'), next: 'gbrain extract --stale' };
  if (found) return withPage(null, 'The page names this entity with this name and links to it.');
  const cased = entries.find(e => e.caseTokens);
  if (cased && text.toLowerCase().includes(cased.caseTokens!.join(' ').toLowerCase())) return withPage('case_mismatch');
  if (page.due && linked) return { ...withPage('pending'), next: 'gbrain extract --stale' };
  return withPage('not_a_known_name', linked ? 'The page links to this entity through another of its names, not this one.'
    : 'The page text does not contain this name.');
}

/** Every name a page derives (with origin and declaring line), the rejected candidates and the sibling decision. */
async function pageNames(engine: BrainEngine, sourceId: string, slug: string, policy: Awaited<ReturnType<typeof readMentionPolicy>>):
  Promise<Pick<MentionExplanation, 'aliases' | 'rejected' | 'siblings'>> {
  const [p] = await engine.executeRaw<{ title: string | null; compiled_truth: string | null; timeline: string | null; frontmatter: Record<string, unknown> | null }>(
    'SELECT title, compiled_truth, timeline, frontmatter FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug]);
  if (!p) return {};
  const derived = deriveEntityAliases(p, aliasOptsOf(policy));
  const fm = await engine.executeRaw<{ alias_norm: string }>(
    `SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 AND origin = 'frontmatter' ORDER BY alias_norm`, [sourceId, slug]).catch(() => []);
  const sib = await readIdentitySiblings(engine, sourceId, { slug, title: p.title }, { excludePrivate: false, policy });
  return {
    aliases: [...fm.map(r => ({ alias: r.alias_norm, origin: 'frontmatter' })),
      ...derived.aliases.map(a => ({ alias: a.alias_text, origin: a.origin, ...(derived.lines.has(a.alias_norm) ? { line: derived.lines.get(a.alias_norm) } : {}) }))],
    rejected: derived.rejected,
    siblings: { pages: sib.pages.map(s => s.slug), capped: sib.capped, verdict: sib.pages.length ? 'group' : sib.verdict ?? 'none' },
  };
}

/** A declaration the alias derivation rejected (e.g. a 3-character code), found on a linkable entity page. */
async function rejectedDeclaration(engine: BrainEngine, sourceId: string, name: string, policy: Awaited<ReturnType<typeof readMentionPolicy>>): Promise<ExplainReason | null> {
  const types = linkableTypesFor(await loadSourcePack(engine, sourceId), policy);
  const pages = await engine.executeRaw<{ title: string | null; compiled_truth: string | null; timeline: string | null; frontmatter: Record<string, unknown> | null }>(
    `SELECT title, compiled_truth, timeline, frontmatter FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND type = ANY($2::text[])
        AND (compiled_truth ILIKE $3 OR title ILIKE $3) LIMIT 50`, [sourceId, types, `%${name.replace(/[\\%_]/g, m => `\\${m}`)}%`]);
  for (const p of pages) {
    const hit = deriveEntityAliases(p, aliasOptsOf(policy)).rejected.find(r => r.alias.toLowerCase() === name.toLowerCase());
    if (hit) return hit.reason === 'denied' ? 'denied_by_config' : hit.reason;
  }
  return null;
}

export async function runExtractMentionsExplain(engine: BrainEngine, args: string[]): Promise<void> {
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined; };
  const explainAt = args.indexOf('--explain');
  const query = explainAt >= 0 ? args[explainAt + 1] : undefined;
  if (!query || query.startsWith('--')) {
    console.error('Usage: gbrain extract mentions --explain <name|slug> [--page <slug>] [--source-id <id>] [--json]');
    process.exit(2);
  }
  const r = await explainMention(engine, query, { sourceId: value('--source-id'), page: value('--page') });
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`${r.query} (source ${r.source_id}): ${r.reason ?? 'links'}`);
  for (const e of r.entries) console.log(`  entry: "${e.name}" → ${e.slug} (${e.origin}${e.case_sensitive ? ', case-sensitive' : ''})`);
  if (r.page) console.log(`  page ${r.page.slug}: ${r.page.linked ? 'linked' : 'not linked'}`);
  for (const a of r.aliases ?? []) console.log(`  alias: "${a.alias}" (${a.origin})${a.line ? ` from "${a.line}"` : ''}`);
  for (const x of r.rejected ?? []) console.log(`  rejected: "${x.alias}" (${x.origin}): ${x.reason}${x.line ? ` from "${x.line}"` : ''}`);
  if (r.siblings) console.log(`  identity siblings: ${r.siblings.pages.length ? r.siblings.pages.join(', ') : 'none'} (${r.siblings.capped ? 'capped: more than 3 pages share the subject' : r.siblings.verdict})`);
  console.log(`  ${r.message}`);
  if (r.next) console.log(`  next: ${r.next}`);
}
