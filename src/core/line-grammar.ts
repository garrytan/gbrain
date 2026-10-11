/**
 * Line grammar: typed facts and typed relations a human or an agent can type
 * in any editor, read with zero LLM calls.
 *
 *   - [preference] Prefers oat milk #coffee (since the almond allergy)
 *   - [event] @effective[2024-03,2024-09) Led the pricing rework
 *   - works_at [[companies/acme-example]] (since 2024)
 *   - "board member" @effective[2022,) [[companies/widget-co]]
 *
 * A fact line is a list item whose content starts with `[category]`; a
 * relation line is a list item whose content is one relation type followed by
 * exactly one link. Anything that does not match exactly stays ordinary text
 * and keeps today's behavior (the link keeps its inferred type), so a
 * sentence that happens to contain a link never invents a relation type.
 *
 * Guards keep transcripts, task lists and citations out: a category is one
 * token of letters, `_` and `-` (so `[00:00:11]`, `[2024-01-01]`, `[Source: x]`,
 * `[^1]`, `[ ]` and ids like `[D4]` never match), all-caps markers like
 * `[TODO]`, `[x]`/`[X]` task markers and a small stoplist are refused, and lines inside code, blockquotes, HTML
 * comments, the Facts/Takes fences and machine-written sections (Timeline,
 * See also, Related, Sources, ...) are never read.
 *
 * `@effective[start,end)` (alias `@valid`) is an inline validity range with
 * ISO dates (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, UTC); `[`/`]` are inclusive and
 * `(`/`)` exclusive, an empty side is open. Ranges normalize to a half-open
 * `[from, until)` pair of dates. Natural-language and relative dates are
 * refused and never peeled, so the text stays as written.
 *
 * Pure: no engine, no I/O. Offsets are UTF-16 code units into the input.
 */
import { stripCodeBlocks } from './markdown-code.ts';
import { inSuppressedRange, rolePriorSuppressedRanges } from './machine-sections.ts';

export type GrammarReason =
  | 'prose_tail' | 'two_links' | 'stoplist_type' | 'undeclared_type'
  | 'unknown_qualifier' | 'invalid_range';

export interface EffectiveRange {
  /** Inclusive start date `YYYY-MM-DD`, or null when open. */
  from: string | null;
  /** Exclusive end date `YYYY-MM-DD`, or null when open. */
  until: string | null;
  /** The qualifier exactly as written. */
  raw: string;
}

export interface GrammarFact {
  line: number;
  category: string;
  kind: 'event' | 'preference' | 'commitment' | 'belief' | 'fact' | 'idea';
  claim: string;
  tags: string[];
  context: string | null;
  effective: EffectiveRange | null;
}

export interface GrammarRelation {
  line: number;
  /** Offsets of the whole line in the input. */
  start: number;
  end: number;
  type: string;
  context: string | null;
  effective: EffectiveRange | null;
}

export interface GrammarDiagnostic {
  line: number;
  reason: GrammarReason;
  text: string;
  message: string;
}

export interface LineGrammarResult {
  facts: GrammarFact[];
  relations: GrammarRelation[];
  diagnostics: GrammarDiagnostic[];
}

const FACT_KINDS = new Set(['event', 'preference', 'commitment', 'belief', 'fact', 'idea']);
// Letters, `_` and `-` only: digits mark ids and codes (`[D4]`, `[ENG-1]`, `[Q3]`), not categories.
const CATEGORY_RE = /^[A-Za-z][A-Za-z_-]{0,31}$/;
const TYPE_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const CATEGORY_STOPLIST = new Set(['x', 'todo', 'done', 'wip']);
const TYPE_STOPLIST = new Set(['see', 'also', 'cf', 'via', 'and', 'or', 'with', 'from', 're', 'by', 'to', 'per', 'and/or']);
const LIST_ITEM_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUALIFIER_RE = /^@([A-Za-z][A-Za-z0-9_]*)([[(])([^\][()]*),([^\][()]*)([\])])(?=\s|$)/;
const QUALIFIER_LIKE_RE = /^@([A-Za-z][A-Za-z0-9_]*)[[(:]/;
const LINK_RE = /\[\[[^\]\n]+\]\]|\[[^\][\n]+\]\([^)\n]+\)/g;
const LINE_TEXT_MAX = 160;
// A trailing `[Source: ...]` citation (plain or wrapping a markdown link) is
// part of the brain's quality convention, not of the grammar: it is set aside
// before a line is read.
const TRAILING_CITATION_RE = /\s*\[Source:\s*(?:[^\][]|\[[^\]]*\]\([^)]*\))*\]\s*$/i;

/** Normalize a written relation type: `worksAt`, `works-at`, `"works at"` -> `works_at`. */
export function normalizeRelationType(raw: string): string {
  return raw.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function validDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** A date token at its stated precision: the period start plus the start of the next period. */
function datePeriod(token: string): { start: string; next: string } | null {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(token.trim());
  if (!m) return null;
  const y = Number(m[1]); const mo = m[2] ? Number(m[2]) : null; const d = m[3] ? Number(m[3]) : null;
  if (mo !== null && (mo < 1 || mo > 12)) return null;
  if (d !== null && !validDate(y, mo!, d)) return null;
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  if (d !== null) return { start: iso(new Date(Date.UTC(y, mo! - 1, d))), next: iso(new Date(Date.UTC(y, mo! - 1, d + 1))) };
  if (mo !== null) return { start: iso(new Date(Date.UTC(y, mo - 1, 1))), next: iso(new Date(Date.UTC(y, mo, 1))) };
  return { start: iso(new Date(Date.UTC(y, 0, 1))), next: iso(new Date(Date.UTC(y + 1, 0, 1))) };
}

type QualifierParse =
  | { kind: 'none' }
  | { kind: 'ok'; range: EffectiveRange; length: number }
  | { kind: 'refused'; reason: 'unknown_qualifier' | 'invalid_range'; message: string };

/**
 * Parse an `@effective[...]` qualifier at the start of `text`. A qualifier-like
 * token that is not an accepted range is refused (and never peeled); plain
 * `@handles` and emails are not qualifiers at all.
 */
export function parseEffectiveQualifier(text: string): QualifierParse {
  const m = QUALIFIER_RE.exec(text);
  if (!m) {
    const like = QUALIFIER_LIKE_RE.exec(text);
    if (!like) return { kind: 'none' };
    const known = like[1] === 'effective' || like[1] === 'valid';
    return { kind: 'refused', reason: known ? 'invalid_range' : 'unknown_qualifier',
      message: known
        ? 'A validity range takes ISO dates: @effective[2024-01-01,2025-06-01) — [ ] inclusive, ( ) exclusive, an empty side is open.'
        : `Only @effective[start,end) (alias @valid) is read; @${like[1]} stays plain text.` };
  }
  const [whole, kind, open, rawStart, rawEnd, close] = m;
  if (kind !== 'effective' && kind !== 'valid') {
    return { kind: 'refused', reason: 'unknown_qualifier', message: `Only @effective[start,end) (alias @valid) is read; @${kind} stays plain text.` };
  }
  const startTok = rawStart.trim(); const endTok = rawEnd.trim();
  const start = startTok ? datePeriod(startTok) : null;
  const end = endTok ? datePeriod(endTok) : null;
  if ((startTok && !start) || (endTok && !end)) {
    return { kind: 'refused', reason: 'invalid_range', message: 'Dates must be YYYY, YYYY-MM or YYYY-MM-DD (calendar-valid, UTC); natural-language and relative dates are not read.' };
  }
  const from = start ? (open === '[' ? start.start : start.next) : null;
  const until = end ? (close === ']' ? end.next : end.start) : null;
  if (from && until && from >= until) {
    return { kind: 'refused', reason: 'invalid_range', message: 'The range ends before it starts; write @effective[start,end) with start before end.' };
  }
  return { kind: 'ok', range: { from, until, raw: whole }, length: whole.length };
}

/** Index of the `(` that opens a balanced group closing exactly at the end of `text`, or -1. */
function trailingGroupStart(text: string): number {
  if (!text.endsWith(')')) return -1;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ')') depth++;
    else if (text[i] === '(') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** A leading YAML frontmatter block (`---` ... `---` with at least one `key:` line), as a range. */
function frontmatterRange(text: string): [number, number] | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m && /^[A-Za-z_][\w-]*:/m.test(m[1]) ? [0, m[0].length] : null;
}

function excludedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const frontmatter = frontmatterRange(text);
  if (frontmatter) ranges.push(frontmatter);
  const masked = stripCodeBlocks(text, { onHtmlComment: (start, end) => ranges.push([start, end]) });
  ranges.push(...rolePriorSuppressedRanges(masked));
  return ranges;
}

function lineText(line: string): string {
  const t = line.trim();
  return t.length > LINE_TEXT_MAX ? `${t.slice(0, LINE_TEXT_MAX - 1)}…` : t;
}

/**
 * Parse every grammar line in a page body. `declaredTypes`, when given (the
 * active schema pack's link verbs), gates relation types: an undeclared type
 * falls back to inference and is reported with the nearest declared verb.
 */
export function parseLineGrammar(text: string, opts: { declaredTypes?: ReadonlySet<string> | null } = {}): LineGrammarResult {
  const result: LineGrammarResult = { facts: [], relations: [], diagnostics: [] };
  if (!text.includes('- ') && !text.includes('* ') && !text.includes('+ ') && !/\d[.)] /.test(text)) return result;
  const masked = stripCodeBlocks(text, { onHtmlComment: () => {} });
  const excluded = excludedRanges(text);
  let offset = 0;
  let lineNo = 0;
  for (const rawLine of text.split('\n')) {
    lineNo++;
    const start = offset;
    offset += rawLine.length + 1;
    const line = rawLine.replace(/\r$/, '');
    const visible = masked.slice(start, start + line.length);
    if (!visible.trim() || /^\s*>/.test(visible) || inSuppressedRange(excluded, start)) continue;
    const item = LIST_ITEM_RE.exec(visible);
    if (!item) continue;
    // Masking keeps offsets, so the item's content sits at the same place in
    // the original line; structure is read from the masked text (links inside
    // code are not links), the fact text from the original.
    const visibleContent = item[2].replace(TRAILING_CITATION_RE, '').trim();
    const content = line.slice(line.length - item[2].length).replace(TRAILING_CITATION_RE, '').trim();
    if (!visibleContent || visibleContent.startsWith('\\')) continue;
    const note = (reason: GrammarReason, message: string) => result.diagnostics.push({ line: lineNo, reason, text: lineText(line), message });
    if (visibleContent.startsWith('[')) {
      const fact = parseFactContent(content, note);
      if (fact) result.facts.push({ line: lineNo, ...fact });
      continue;
    }
    const relation = parseRelationContent(visibleContent, opts.declaredTypes ?? null, note);
    if (relation) result.relations.push({ line: lineNo, start, end: start + line.length, ...relation });
  }
  return result;
}

function parseFactContent(content: string, note: (reason: GrammarReason, message: string) => void): Omit<GrammarFact, 'line'> | null {
  const m = /^\[([^\][]*)\][ \t]+(\S.*)$/.exec(content);
  if (!m) return null;
  const category = m[1].trim();
  if (!CATEGORY_RE.test(category)) return null;
  // An all-caps token is a marker or acronym (`[TODO]`, `[WIP]`, `[NB]`), not a category.
  if (CATEGORY_STOPLIST.has(category.toLowerCase()) || (category.length > 1 && category === category.toUpperCase()) || /^[A-Z]{2,}[-_]/.test(category)) return null;
  let rest = m[2].trim();
  let effective: EffectiveRange | null = null;
  const q = parseEffectiveQualifier(rest);
  if (q.kind === 'ok') { effective = q.range; rest = rest.slice(q.length).trim(); }
  else if (q.kind === 'refused') note(q.reason, q.message);
  let context: string | null = null;
  const group = trailingGroupStart(rest);
  if (group > 0) { context = rest.slice(group + 1, -1).trim() || null; rest = rest.slice(0, group).trim(); }
  const tags = [...rest.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)].map(t => t[1]);
  const claim = rest.replace(/(?:^|\s)#[A-Za-z][\w/-]*/g, '').replace(/\s+/g, ' ').trim();
  if (!claim) return null;
  const lower = category.toLowerCase();
  return { category, kind: (FACT_KINDS.has(lower) ? lower : 'fact') as GrammarFact['kind'], claim, tags, context, effective };
}

function nearest(type: string, declared: ReadonlySet<string>): string | null {
  let best: string | null = null; let bestScore = Infinity;
  for (const candidate of declared) {
    const d = levenshtein(type, candidate);
    if (d < bestScore) { bestScore = d; best = candidate; }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function parseRelationContent(content: string, declared: ReadonlySet<string> | null,
  note: (reason: GrammarReason, message: string) => void): Omit<GrammarRelation, 'line' | 'start' | 'end'> | null {
  const links = [...content.matchAll(LINK_RE)];
  if (!links.length) return null;
  const first = links[0];
  let prefix = content.slice(0, first.index).trim();
  let effective: EffectiveRange | null = null;
  // A qualifier may sit between the type and the link.
  const qualifierAt = prefix.search(/\s@[A-Za-z]/);
  let qualifierText = '';
  if (qualifierAt > 0) { qualifierText = prefix.slice(qualifierAt).trim(); prefix = prefix.slice(0, qualifierAt).trim(); }
  const quoted = /^(["'])([^"']+)\1$/.exec(prefix);
  const tokenOk = quoted ? /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(quoted[2]) : TYPE_TOKEN_RE.test(prefix);
  if (!tokenOk) return null;
  const type = normalizeRelationType(quoted ? quoted[2] : prefix);
  if (!type) return null;
  const explicit = type.includes('_') || !!quoted || (declared?.has(type) ?? false);
  if (TYPE_STOPLIST.has(type)) {
    if (explicit) note('stoplist_type', `"${type}" is too generic to be a relation type, so the link keeps its inferred type.`);
    return null;
  }
  if (links.length > 1) {
    if (explicit) note('two_links', 'A relation line names exactly one link; write one line per target.');
    return null;
  }
  let suffix = content.slice(first.index! + first[0].length).trim();
  if (!qualifierText && suffix.startsWith('@')) {
    const q = parseEffectiveQualifier(suffix);
    if (q.kind === 'ok') { qualifierText = q.range.raw; suffix = suffix.slice(q.length).trim(); }
    else if (q.kind === 'refused') { note(q.reason, q.message); return null; }
  }
  let context: string | null = null;
  if (suffix) {
    const group = trailingGroupStart(suffix);
    if (group !== 0) {
      if (explicit) note('prose_tail', `Text after the link makes this a sentence, so "${type}" is not applied. Put extra words in one trailing (context).`);
      return null;
    }
    context = suffix.slice(1, -1).trim() || null;
  }
  if (qualifierText) {
    const q = parseEffectiveQualifier(qualifierText);
    if (q.kind === 'ok' && q.length === qualifierText.length) effective = q.range;
    else { note(q.kind === 'refused' ? q.reason : 'invalid_range', q.kind === 'refused' ? q.message : 'Only one @effective[start,end) qualifier may follow the type.'); return null; }
  }
  if (declared && declared.size && !declared.has(type)) {
    const near = nearest(type, declared);
    note('undeclared_type', `"${type}" is not a link verb of the active schema pack, so the link keeps its inferred type.${near ? ` Did you mean ${near}?` : ''}`);
    return null;
  }
  return { type, context, effective };
}

const FALSY = new Set(['false', '0', 'no', 'off']);
const isTrue = (value: string | null) => value != null && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());

/** `line_grammar.enabled` (default off, held-out verdict H3) and `line_grammar.allow_undeclared_types` (default off). */
export async function lineGrammarOptions(engine: { getConfig(key: string): Promise<string | null> }): Promise<{ enabled: boolean; allowUndeclaredTypes: boolean }> {
  const read = (key: string) => engine.getConfig(key).catch(() => null);
  const [enabled, allow] = await Promise.all([read('line_grammar.enabled'), read('line_grammar.allow_undeclared_types')]);
  return { enabled: isTrue(enabled), allowUndeclaredTypes: isTrue(allow) };
}

/** `line_grammar.effective_ranges` (default on; applies only while `line_grammar.enabled` is on): store relation-line ranges on edges (core/link-effective.ts). */
export async function effectiveRangesEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  const read = (key: string) => engine.getConfig(key).catch(() => null);
  const [ranges, enabled] = await Promise.all([read('line_grammar.effective_ranges'), read('line_grammar.enabled')]);
  return (ranges == null || !FALSY.has(ranges.trim().toLowerCase())) && isTrue(enabled);
}

/**
 * The stated relation type for a link at `index` in `text`, for link
 * extraction. `declaredVerbs` (the active pack's link verbs) gates types
 * unless `allowUndeclaredTypes`; `enabled: false` turns stated types off.
 */
export function statedRelationTypes(text: string, opts: { enabled?: boolean; allowUndeclaredTypes?: boolean;
  declaredVerbs?: readonly string[] }): (index?: number) => string | undefined {
  if (opts.enabled === false) return () => undefined;
  const declaredTypes = !opts.allowUndeclaredTypes && opts.declaredVerbs?.length ? new Set(opts.declaredVerbs) : null;
  const lines = parseLineGrammar(text, { declaredTypes }).relations;
  if (!lines.length) return () => undefined;
  return index => index === undefined || index < 0 ? undefined : lines.find(line => index >= line.start && index < line.end)?.type;
}
