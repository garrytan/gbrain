/**
 * GBRA-161 PR 4 (#7065, plan D3 and CEO-outside r3 F3): when one synthesis output of a transcript may retire because a
 * re-synthesis replaced it. Pure. An earlier output is matched, and so retires at activation, only when it is an exact
 * duplicate of a page of the new generation, or when both hold:
 *   - subject: a page of the new generation has the same normalized subject stem, its slug without the hash suffix
 *     (and the date the prompt puts in front of the topic), or the same lowercased title tokens;
 *   - coverage: every claim unit (each sentence outside a quote), every verbatim quote (a `>` block or a quoted span) and
 *     every citation (wikilink or link target) of the earlier page appears in some page of the new generation.
 * Anything else is unmatched: it stays live and `gbrain repair generations --kind synthesis --mode cleanup` lists it.
 */

export interface SynthesisPage { slug: string; title: string; body: string }

export type PredecessorMatch =
  | { matched: true; why: 'duplicate' | 'covered'; successor: string }
  | { matched: false; why: 'no_subject' | 'uncovered'; missing: { claims: number; quotes: number; citations: number } };

const HASH_SUFFIX = /-[0-9a-f]{6}(?:-c\d+)?$/;
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

/** The slug without its transcript hash suffix and the date the synthesis prompt puts before the topic. */
export function subjectStem(slug: string): string {
  const segments = slug.toLowerCase().replace(HASH_SUFFIX, '').split('/');
  segments[segments.length - 1] = segments[segments.length - 1]!.replace(DATE_PREFIX, '');
  return segments.join('/');
}

/** The lowercased title words, as a sorted set. */
export function titleTokens(title: string): string {
  return [...new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].sort().join(' ');
}

/** Text compared for coverage: link syntax reduced to its visible text, markdown emphasis and case dropped, spacing collapsed. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const unit = (text: string) => normalizeText(text).replace(/^[-+*•]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/[\s.!?;:,]+$/, '');

/** The citation targets of a body: wikilink targets and link targets. */
export function citations(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) out.add(m[1]!.trim().toLowerCase());
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) out.add(m[1]!.trim().toLowerCase());
  return [...out].sort();
}

/** The verbatim quotes of a body: each `>` block and each double-quoted span of three or more words. */
export function quotes(body: string): string[] {
  const out: string[] = [];
  let block: string[] = [];
  const flush = () => { if (block.length) out.push(unit(block.join(' '))); block = []; };
  for (const line of body.split('\n')) {
    const m = /^\s*>\s?(.*)$/.exec(line);
    if (m) block.push(m[1]!); else flush();
  }
  flush();
  const prose = body.split('\n').filter(line => !/^\s*>/.test(line)).join('\n').replace(/[\u201C\u201D]/g, '"');
  for (const m of prose.matchAll(/"([^"\n]+)"/g)) if ((m[1]!.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 3) out.push(unit(m[1]!));
  return out.filter(Boolean);
}

/** The claim units of a body: every sentence outside quote blocks and headings. */
export function claimUnits(body: string): string[] {
  const prose = body.split('\n').filter(line => !/^\s*>/.test(line) && !/^\s*#/.test(line)).join('\n');
  return prose.split(/\n+|(?<=[.!?])\s+/).map(unit).filter(text => /[\p{L}\p{N}]/u.test(text));
}

/** Whether `earlier` may retire now that `successors` (the new generation's pages) are live. */
export function matchPredecessor(earlier: SynthesisPage, successors: readonly SynthesisPage[]): PredecessorMatch {
  const body = normalizeText(earlier.body);
  const duplicate = successors.find(page => normalizeText(page.body) === body);
  if (duplicate) return { matched: true, why: 'duplicate', successor: duplicate.slug };
  const stem = subjectStem(earlier.slug);
  const tokens = titleTokens(earlier.title);
  const subject = successors.find(page => subjectStem(page.slug) === stem || (tokens !== '' && titleTokens(page.title) === tokens));
  const corpus = successors.map(page => normalizeText(page.body)).join('\n');
  const cited = new Set(successors.flatMap(page => citations(page.body)));
  const missing = {
    claims: claimUnits(earlier.body).filter(text => !corpus.includes(text)).length,
    quotes: quotes(earlier.body).filter(text => !corpus.includes(text)).length,
    citations: citations(earlier.body).filter(target => !cited.has(target)).length,
  };
  if (!subject) return { matched: false, why: 'no_subject', missing };
  if (missing.claims || missing.quotes || missing.citations) return { matched: false, why: 'uncovered', missing };
  return { matched: true, why: 'covered', successor: subject.slug };
}
