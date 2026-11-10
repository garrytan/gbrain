/**
 * The skill resolver's word rule, shared with `scoreSkillMatch`
 * (src/core/skill-catalog.ts), which keeps its own stopword list so
 * `list_skills` ranks exactly as before.
 *
 * `splitWords` is the Unicode split both rankers use: lowercase, then cut on
 * every run that is not a letter or a number. `lexTerms` is the BM25F term
 * rule frozen by the Step 1 offline eval (gbrain-evals
 * docs/benchmarks/2026-11-07-skill-ranker-offline, scripts/rank.ts `lex`):
 * drop pieces shorter than 2 code units and a fixed English stopword list,
 * then strip a few plural and tense suffixes. One deliberate difference:
 * a run of CJK characters (the ranges in src/core/cjk.ts) becomes
 * overlapping bigrams (a lone CJK character stays a unigram), where the
 * prototype kept the whole run as one token that almost never matches.
 * Text without CJK characters tokenizes exactly as the prototype did
 * (test/fixtures/skill-resolver/tokenizer-vectors.json pins it).
 *
 * Leaf module: no imports beyond the CJK ranges.
 */
import { CJK_SLUG_CHARS } from '../../cjk.ts';

export const TOKENIZER_ID = 'gbrain-skill-lex-v1';

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const HAS_CJK = new RegExp(`[${CJK_SLUG_CHARS}]`);
const CJK_SEGMENTS = new RegExp(`[${CJK_SLUG_CHARS}]+|[^${CJK_SLUG_CHARS}]+`, 'g');

/** Lowercased pieces between non-letter, non-number runs (empty pieces included). */
export function splitWords(text: string): string[] {
  return text.toLowerCase().split(WORD_SPLIT);
}

export const STOPWORDS: ReadonlySet<string> = new Set(('a an the and or of to for in on at by with my me is it be this that from as are was were i you your we our us can could ' +
  'would should will do does did have has had not no so if then than but about into over up out what which who how when where why please just also any all ' +
  'some them they their there here its').split(' '));

export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

function pushWord(out: string[], w: string): void {
  if (w.length >= 2 && !STOPWORDS.has(w)) out.push(stem(w));
}

/** BM25F terms of a text, in order (duplicates kept). */
export function lexTerms(text: string): string[] {
  const out: string[] = [];
  for (const piece of splitWords(text)) {
    if (!piece) continue;
    if (!HAS_CJK.test(piece)) { pushWord(out, piece); continue; }
    for (const seg of piece.match(CJK_SEGMENTS) ?? []) {
      if (!HAS_CJK.test(seg)) { pushWord(out, seg); continue; }
      if (seg.length === 1) { out.push(seg); continue; }
      for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}
