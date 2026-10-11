/**
 * Derived names of an entity page: its title subject and the aliases its body
 * declares. Search's declared-name fan-out (`aliasDeclarations`, ops/search.ts)
 * and the mention pass's alias refresh share `declaredNames`, so both read the
 * same declarations with the same post-filters.
 *
 * - Title subject: for a title with a prefix ending in `: ` ("CRM record:
 *   Acme Example"), the text after the last `: `. Stored with
 *   `origin='subject'`; an exact page title in the same source outranks it.
 * - Declarations: `account code`, `also known as`, `a.k.a.`, `aka`, `short
 *   name`, `ticker`, `code name`, read from the body with private takes and
 *   facts fences stripped, so a private code never becomes a public name.
 *   Stored with `origin='declared'`. A single-token declaration matches only
 *   as written (`case_sensitive`), so "aka Mark" never links lowercase "mark".
 */

import { normalizeAlias } from '../search/alias-normalize.ts';
import { stripTakesFence } from '../takes-fence.ts';
import { stripFactsFence } from '../facts-fence.ts';
import { isGenericEntityToken } from '../entity-name-quality.ts';
import { hasCJK, tokenizeTitle } from '../by-mention.ts';

export const ALIAS_DECLARATION = /\b(?:account code|also known as|a\.k\.a\.|aka|short name|ticker|code name)\b\s*[:(]?\s*["\u201c']?([A-Z0-9][A-Za-z0-9&.-]{1,24})/gi;
/** Every ALIAS_DECLARATION keyword, lowercased: a text containing none of them cannot match the regex. */
export const DECLARATION_KEYWORDS = ['account code', 'also known as', 'a.k.a', 'aka', 'short name', 'ticker', 'code name'];

/** Below this many characters a (non-CJK) name is never linked or stored as a derived alias. */
export const MIN_ALIAS_LENGTH = 4;

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

/** Names `text` declares for the entity called `name`, post-filtered (punctuation trimmed, an uppercase letter or digit, differs from the name). */
export function declaredNames(text: string, name: string): string[] {
  const lower = text.toLowerCase();
  if (!DECLARATION_KEYWORDS.some(k => lower.includes(k))) return [];
  const out: string[] = [];
  for (const m of text.matchAll(ALIAS_DECLARATION)) {
    const alias = m[1].replace(/[.,;]+$/, '');
    if (!/[A-Z0-9]/.test(alias) || alias.toLowerCase() === name.toLowerCase()) continue;
    if (!out.includes(alias)) out.push(alias);
  }
  return out;
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

export type AliasRejection = 'below_min_length' | 'generic_token' | 'ambiguous_first_word';

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

/**
 * The derived alias rows of one entity page: its title subject and its body
 * declarations, deduped by normalized form (subject first). Rejected names
 * are returned beside the kept ones for `extract mentions --explain`.
 */
export function deriveEntityAliases(page: { title: string | null; compiled_truth: string | null; timeline?: string | null }): {
  aliases: DerivedAlias[]; rejected: Array<{ alias: string; origin: 'declared' | 'subject'; reason: AliasRejection }>;
} {
  const title = page.title ?? '';
  const name = titleName(title);
  const aliases: DerivedAlias[] = [];
  const rejected: Array<{ alias: string; origin: 'declared' | 'subject'; reason: AliasRejection }> = [];
  const seen = new Set<string>([normalizeAlias(title)]);
  const push = (alias: string, origin: 'declared' | 'subject', caseSensitive: boolean) => {
    const norm = normalizeAlias(alias);
    if (!norm || seen.has(norm)) return;
    const reason = aliasRejection(alias, name);
    if (reason) { rejected.push({ alias, origin, reason }); return; }
    seen.add(norm);
    aliases.push({ alias_norm: norm, alias_text: alias, origin, case_sensitive: caseSensitive });
  };
  const subject = titleSubject(title);
  if (subject) push(subject, 'subject', false);
  const text = publicBody(`${page.compiled_truth ?? ''}\n\n${page.timeline ?? ''}`);
  for (const alias of declaredNames(text, name)) push(alias, 'declared', tokenizeTitle(alias).length === 1);
  return { aliases, rejected };
}
