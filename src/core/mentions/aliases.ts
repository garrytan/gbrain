/**
 * Derived names of an entity page: its title subject and the aliases its body
 * declares. Search's declared-name fan-out (`aliasDeclarations`, ops/search.ts),
 * the mention pass's alias refresh, the entity card's identity excerpt and
 * `extract mentions --explain` share `declarationsIn`, so they read the same
 * declarations with the same post-filters.
 *
 * - Title subject: for a title with a prefix ending in `: ` ("CRM record:
 *   Acme Example"), the text after the last `: `. Stored with
 *   `origin='subject'`; an exact page title in the same source outranks it.
 * - Declarations: the conventions in docs/designs/ALIAS_CONVENTIONS.md, read
 *   from the body with private takes and facts fences stripped, so a private
 *   code never becomes a public name: prose cues ("also known as", "goes by",
 *   "formerly", "doing business as", ...), label and value lines whose label
 *   names an alias field ("Internal nickname: X", a Markdown table row, a bold
 *   key-value line), and a quoted defined term right after the page's own name
 *   (`Widget Co ("Widget")`). A capture is a quoted name or a run of up to 4
 *   capitalized or code tokens; it ends at punctuation, a lowercase word or the
 *   line end, and a possessive or a run of only common capitalized words
 *   rejects it. A cue after a relational noun ("our competitor, also known as
 *   ...") declares another entity's name and is skipped. Stored with
 *   `origin='declared'`. A single-token declaration matches only as written
 *   (`case_sensitive`), so "aka Mark" never links lowercase "mark".
 * - Escape hatches: `mentions.alias_deny` and frontmatter `alias_deny:` drop a
 *   derived name; `mentions.multiword_aliases=false` keeps one-token captures.
 *
 * Parsing is linear in the line length (no backtracking regex over values).
 */

import { normalizeAlias } from '../search/alias-normalize.ts';
import { stripTakesFence } from '../takes-fence.ts';
import { stripFactsFence } from '../facts-fence.ts';
import { isGenericEntityToken } from '../entity-name-quality.ts';
import { hasCJK, tokenizeTitle } from '../by-mention.ts';

const CUES = [
  'also known as', 'a\\.k\\.a\\.?', 'aka', 'known internally as', 'internally known as', 'known to the team as', 'better known as',
  'widely known as', 'known as', 'nicknamed', 'nicknames?', 'goes by', 'went by', 'going by', 'also called', 'sometimes called',
  'often called', 'commonly called', 'is called', 'commonly referred to as', 'often referred to as', 'referred to as',
  'formerly known as', 'previously known as', 'formerly', 'f/k/a', 'fka', 'n\u00e9e', 'trading as', 't/a', 'doing business as',
  'd/b/a', 'dba', 'short name', 'short for', 'abbreviated as', 'abbreviated', 'code ?name', 'account code', 'customer code',
  'account id', 'ticker', 'alias(?:es)?',
];
const CUE_RE = new RegExp(`(?<![A-Za-z0-9])(?:${CUES.join('|')})(?![A-Za-z0-9])`, 'gi');
const LABEL_NOUN_RE = /(?<![a-z])(?:nicknames?|alias(?:es)?|aka|a\.k\.a\.?|also known as|short name|trading name|trade name|brand name|former (?:legal )?name|previous name|legal name|display name|dba|d\/b\/a|code ?name|account code|customer code|ticker)(?![a-z])/i;
const RELATIONAL_NOUN_RE = /\b(?:competitors?|rivals?|partners?|parent(?: company)?|subsidiar(?:y|ies)|affiliates?|vendors?|suppliers?|customers?|clients?|acquirers?|investors?)\b/i;
const QUOTES: Record<string, string> = { '"': '"', '\u201c': '\u201d', "'": "'", '\u2018': '\u2019' };
const COMMON_WORDS = new Set([
  'the', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may',
  'june', 'july', 'august', 'september', 'october', 'november', 'december', 'board', 'finance', 'legal', 'sales', 'marketing',
  'engineering', 'operations', 'support', 'hr', 'it', 'plan', 'report', 'team', 'project', 'update', 'review', 'company',
]);
const CORPORATE_SUFFIX = '(?:,?\\s+(?:Inc|LLC|Ltd|Limited|Corp|Corporation|Co|GmbH|PLC|plc|LP|LLP|Holdings|S\\.A)\\.?)*';
const PAREN_TERM_RE = /\(\s*(?:the\s+)?["\u201c']([^"\u201d'()\n]{1,60})["\u201d']\s*\)/g;
const MAX_NAME_TOKENS = 4;

/** Below this many characters a (non-CJK) name is never linked or stored as a derived alias. */
export const MIN_ALIAS_LENGTH = 4;

export interface DeclarationOpts {
  /** Allow captures of more than one token (`mentions.multiword_aliases`, default on). */
  multiword?: boolean;
  /** Other names of the page (frontmatter aliases) that may introduce a parenthetical defined term. */
  ownNames?: string[];
}

/** One declared name with the line that declares it (0-based line index into the scanned text). */
export interface Declaration { alias: string; line: number }

const isQuarter = (t: string) => /^(?:q[1-4]|h[12]|fy\d{2,4})$/i.test(t);
const isCommon = (t: string) => COMMON_WORDS.has(t.toLowerCase()) || isQuarter(t);
const isNameToken = (t: string) => /^[A-Z][A-Za-z0-9&.\u2019'-]*$/.test(t) || (/^[0-9][A-Za-z0-9&.-]*$/.test(t) && /[A-Z]/.test(t));
const POSSESSIVE_RE = /['\u2019]s$/;

/**
 * The name at the start of `rest` (after a cue or a label): a quoted name of up
 * to 4 words, or a run of up to 4 capitalized or code tokens. Null when there
 * is none or the capture is rejected (possessive, too long, only common words).
 */
export function captureName(rest: string, opts: { multiword?: boolean } = {}): string | null {
  let s = rest.replace(/^[\s:,(\-\u2013\u2014]+/, '');
  const multiword = opts.multiword !== false;
  const close = QUOTES[s[0] ?? ''];
  if (close) {
    const end = s.indexOf(close, 1);
    if (end < 0 || end > 80) return null;
    const words = s.slice(1, end).trim().split(/\s+/).filter(Boolean);
    if (!words.length || words.length > MAX_NAME_TOKENS || (!multiword && words.length > 1)) return null;
    if (/^['\u2019]s\b/.test(s.slice(end + 1))) return null;
    return finish(words);
  }
  s = s.replace(/^(?:the|a|an)\s+/i, '');
  const words: string[] = [];
  for (const raw of s.split(/\s+/)) {
    const core = raw.replace(/[.,;:!?)\]"\u201d]+$/, '');
    if (POSSESSIVE_RE.test(core)) return null;
    if (!core || !isNameToken(core)) break;
    words.push(core);
    if (words.length > MAX_NAME_TOKENS) return null;
    if (core !== raw) break;
  }
  if (!words.length || (!multiword && words.length > 1)) return null;
  return finish(words);
}

function finish(words: string[]): string | null {
  const name = words.join(' ').replace(/[.,;]+$/, '');
  const tokens = name.split(/\s+/).filter(w => !/^the$/i.test(w));
  if (!tokens.length || tokens.every(isCommon)) return null;
  if (!/[A-Z0-9]/.test(name)) return null;
  return name;
}

/** Split a label's value into its listed names (`,`, `;`, ` / `, ` or `). */
function labelValues(value: string, multiword: boolean): string[] {
  const out: string[] = [];
  for (const part of value.split(/\s*[,;]\s*|\s+\/\s+|\s+or\s+/)) {
    const name = captureName(part, { multiword });
    if (name) out.push(name);
  }
  return out;
}

const stripLineMarkup = (line: string) => line.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '').replace(/\*\*|__/g, '').trim();
const isTableSeparator = (line: string | undefined) => !!line && /^\s*\|?\s*:?-{2,}/.test(line);
const isLabel = (label: string) => label.split(/\s+/).length <= 6 && LABEL_NOUN_RE.test(label);

/** Every declaration in `text` with its line, in line order, deduped by alias (first line wins). Not post-filtered. */
export function declarationsIn(text: string, opts: DeclarationOpts = {}): Declaration[] {
  const multiword = opts.multiword !== false;
  const lines = (text ?? '').split('\n');
  const out: Declaration[] = [];
  const push = (alias: string | null, line: number) => { if (alias && !out.some(d => d.alias === alias)) out.push({ alias, line }); };
  const ownNames = (opts.ownNames ?? []).filter(Boolean);
  const parenOwner = ownNames.length
    ? new RegExp(`(?:${ownNames.map(n => n.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')).join('|')})${CORPORATE_SUFFIX},?\\s*$`, 'i')
    : null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 2000) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('|')) {
      const cells = trimmed.replace(/^\||\|$/g, '').split('|').map(c => stripLineMarkup(c));
      if (cells.length >= 2 && !isTableSeparator(trimmed) && !isTableSeparator(lines[i + 1]) && isLabel(cells[0]!.replace(/:$/, ''))) {
        for (const name of labelValues(cells[1]!, multiword)) push(name, i);
      }
      continue;
    }
    const plain = stripLineMarkup(line);
    const colon = plain.indexOf(':');
    if (colon > 0 && colon <= 60 && isLabel(plain.slice(0, colon))) {
      for (const name of labelValues(plain.slice(colon + 1), multiword)) push(name, i);
    }
    CUE_RE.lastIndex = 0;
    for (const m of plain.matchAll(CUE_RE)) {
      const before = plain.slice(0, m.index);
      const sentence = before.slice(Math.max(before.lastIndexOf('. '), before.lastIndexOf('; '), -1) + 1);
      if (RELATIONAL_NOUN_RE.test(sentence)) continue;
      push(captureName(plain.slice(m.index! + m[0].length), { multiword }), i);
    }
    if (parenOwner) {
      for (const m of plain.matchAll(PAREN_TERM_RE)) {
        if (!parenOwner.test(plain.slice(0, m.index))) continue;
        push(captureName(`"${m[1]}"`, { multiword }), i);
      }
    }
  }
  return out;
}

/** Names `text` declares for the entity called `name`, post-filtered (an uppercase letter or digit, differs from the name). */
export function declaredNames(text: string, name: string, opts: DeclarationOpts = {}): string[] {
  const own = name.toLowerCase();
  return declarationsIn(text, { ...opts, ownNames: [name, ...(opts.ownNames ?? [])] })
    .map(d => d.alias)
    .filter(alias => alias.toLowerCase() !== own);
}

/** The text after the last `: ` of a title, or the whole title when it has no such prefix. */
export function titleName(title: string): string {
  return (title ?? '').split(':').pop()!.trim();
}

/** The subject of a prefixed title ("CRM record: X" → "X"); null when the title has no `: ` prefix. */
export function titleSubject(title: string | null | undefined): string | null {
  const t = (title ?? '').trim();
  const at = t.lastIndexOf(': ');
  if (at < 0) return null;
  const subject = t.slice(at + 2).trim();
  return subject && subject !== t ? subject : null;
}

export type AliasOrigin = 'frontmatter' | 'declared' | 'subject';
export const ALIAS_ORIGIN_RANK: Record<AliasOrigin, number> = { frontmatter: 0, declared: 1, subject: 2 };

export interface DerivedAlias {
  alias_norm: string;
  /** The alias as written. */
  alias_text: string;
  origin: 'declared' | 'subject';
  case_sensitive: boolean;
}

export type AliasRejection = 'below_min_length' | 'generic_token' | 'ambiguous_first_word' | 'denied';

export interface RejectedAlias { alias: string; origin: 'declared' | 'subject'; reason: AliasRejection; line?: string }

/** Private takes and facts fences removed: the text a world reader may see. */
export function publicBody(body: string): string {
  return stripFactsFence(stripTakesFence(body ?? ''), { keepVisibility: ['world'] });
}

/** Why a derived name can never be linked or stored; null when it can. */
export function aliasRejection(alias: string, ownName: string): AliasRejection | null {
  const tokens = tokenizeTitle(alias);
  if (!hasCJK(alias) && alias.length < MIN_ALIAS_LENGTH) return 'below_min_length';
  if (tokens.length === 1 && isGenericEntityToken(tokens[0]!)) return 'generic_token';
  const first = tokenizeTitle(ownName)[0];
  if (tokens.length === 1 && first && tokens[0] === first && tokenizeTitle(ownName).length > 1) return 'ambiguous_first_word';
  return null;
}

/** A frontmatter list value (`alias_deny:`, `aliases:`) as strings. */
function frontmatterList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' && value.trim() ? value.split(',').map(v => v.trim()) : [];
}

export interface DeriveAliasOpts {
  /** `mentions.multiword_aliases` (default on). */
  multiword?: boolean;
  /** `mentions.alias_deny`: names never derived for any page. */
  deny?: readonly string[];
}

/**
 * The derived alias rows of one entity page: its title subject and its body
 * declarations, deduped by normalized form (subject first). Rejected names
 * are returned beside the kept ones (with the declaring line) for
 * `extract mentions --explain`.
 */
export function deriveEntityAliases(
  page: { title: string | null; compiled_truth: string | null; timeline?: string | null; frontmatter?: Record<string, unknown> | null },
  opts: DeriveAliasOpts = {},
): { aliases: DerivedAlias[]; rejected: RejectedAlias[]; lines: Map<string, string> } {
  const title = page.title ?? '';
  const name = titleName(title);
  const aliases: DerivedAlias[] = [];
  const rejected: RejectedAlias[] = [];
  const lines = new Map<string, string>();
  const deny = new Set([...(opts.deny ?? []), ...frontmatterList(page.frontmatter?.alias_deny)].map(normalizeAlias).filter(Boolean));
  const seen = new Set<string>([normalizeAlias(title)]);
  const push = (alias: string, origin: 'declared' | 'subject', caseSensitive: boolean, line?: string) => {
    const norm = normalizeAlias(alias);
    if (!norm || seen.has(norm)) return;
    const reason = deny.has(norm) ? 'denied' : aliasRejection(alias, name);
    if (reason) { rejected.push({ alias, origin, reason, ...(line !== undefined ? { line } : {}) }); return; }
    seen.add(norm);
    if (line !== undefined) lines.set(norm, line);
    aliases.push({ alias_norm: norm, alias_text: alias, origin, case_sensitive: caseSensitive });
  };
  const subject = titleSubject(title);
  if (subject) push(subject, 'subject', false);
  const text = publicBody(`${page.compiled_truth ?? ''}\n\n${page.timeline ?? ''}`);
  const textLines = text.split('\n');
  const ownNames = frontmatterList(page.frontmatter?.aliases);
  const own = name.toLowerCase();
  for (const d of declarationsIn(text, { multiword: opts.multiword, ownNames: [name, ...ownNames] })) {
    if (d.alias.toLowerCase() === own) continue;
    push(d.alias, 'declared', tokenizeTitle(d.alias).length === 1, textLines[d.line]?.trim());
  }
  return { aliases, rejected, lines };
}
