/**
 * The A5 ranker from the Step 1 offline eval: BM25F over name,
 * description, triggers, routing rows and the first 4 KB of the body, with
 * the variant's frozen constants (index-format.ts VARIANT_PARAMS). Scores
 * are summed in the prototype's order (query terms in first-occurrence
 * order, fields in FIELDS order), ranked by score over the summed idf of the
 * matched terms, ties broken by name then id, so a ranking equals the
 * prototype's on the same records.
 *
 * There is no score threshold. A turn gets no skill only when it is a known
 * acknowledgement (ack) or none of its terms is in the index (no_match).
 */
import { FIELDS, type IndexReader } from './index-format.ts';
import { lexTerms } from './tokenize.ts';

export interface Ranked { doc: number; score: number; norm: number }
export interface RankResult {
  ranked: Ranked[];
  /** Summed idf of the query terms found in the index (0 = no_match). */
  idfSum: number;
  /** Docs with a name-field match, the candidates for an explicit mention. */
  nameHits: Set<number>;
  matchedFields(doc: number): { fields: Record<string, string[]>; strong: boolean };
}

const ACKS = new Set([
  'ok', 'okay', 'k', 'kk', 'thanks', 'thank you', 'thx', 'ty', 'tysm', 'yes', 'yep', 'yeah', 'yup', 'no', 'nope', 'sure', 'great', 'cool', 'nice',
  'got it', 'sounds good', 'lgtm', 'perfect', 'done', 'awesome', 'ok thanks', 'okay thanks', 'thanks a lot', 'thank you so much', 'np', 'no problem',
  'merci', 'merci beaucoup', 'oui', 'gracias', 'sí', 'si', 'vale', 'danke', 'danke schön', 'ja', 'obrigado', 'obrigada', 'grazie',
  '好的', '好', '谢谢', '嗯', '行', 'ありがとう', 'ありがとうございます', 'はい', '了解', '네', '감사합니다', '고마워', '좋아요', 'спасибо', 'да', 'ок', 'хорошо',
]);

/** A whole-message acknowledgement from the small multilingual list (emoji-only counts too). */
export function isAcknowledgement(message: string): boolean {
  const raw = message.normalize('NFKC').toLowerCase().trim();
  if (!raw) return false;
  const words = raw.replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return /\p{Extended_Pictographic}/u.test(raw);
  return ACKS.has(words);
}

/**
 * True when the turn names the skill itself: its id, a hyphenated name, or a
 * one-word name written as $name, @name, a leading /name (a slash command,
 * not a path such as "look at /reports") or next to the word "skill".
 */
export function mentionsSkill(message: string, id: string, name: string): boolean {
  const text = message.normalize('NFKC').toLowerCase();
  const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_-]/u.test(c);
  for (const form of new Set([id.toLowerCase(), name.toLowerCase()])) {
    if (form.length < 2) continue;
    const compound = /[-_:]/.test(form);
    for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) {
      const before = text[at - 1];
      const after = text[at + form.length];
      if (isWord(before) || isWord(after)) continue;
      if (compound || before === '$' || before === '@' || (before === '/' && !text.slice(0, at - 1).trim())) return true;
      const pre = text.slice(0, at).trimEnd().split(/[^\p{L}\p{N}]+/u).pop();
      const post = text.slice(at + form.length).trimStart().split(/[^\p{L}\p{N}]+/u)[0];
      if (pre === 'skill' || pre === 'skills' || post === 'skill' || post === 'skills') return true;
    }
  }
  return false;
}

/** The idf of a term only one of n skills holds: the most one query word can weigh in a catalog of n, so a score over it reads the same at any catalog size. */
export const maxIdf = (n: number) => Math.log(1 + (n - 0.5) / 1.5);

const byName = (ix: IndexReader) => (a: Ranked, b: Ranked) => {
  const ma = ix.meta(a.doc);
  const mb = ix.meta(b.doc);
  return ma.name < mb.name ? -1 : ma.name > mb.name ? 1 : ma.id < mb.id ? -1 : ma.id > mb.id ? 1 : 0;
};

/** Rank every skill in one index against a message. `check` is called between posting batches (the deadline). */
export function rankIndex(ix: IndexReader, message: string, check: () => void = () => {}): RankResult {
  const p = ix.header.ranker.params;
  const w = FIELDS.map(f => p.w[f]);
  const scores = new Float64Array(ix.n);
  const nameHits = new Set<number>();
  const seenTerms: { term: string; docs: Uint32Array; tfs: Uint16Array }[] = [];
  let idfSum = 0;
  for (const q of new Set(lexTerms(message))) {
    const ti = ix.termIndex(q);
    if (ti < 0) continue;
    const df = ix.df(ti);
    const idf = Math.log(1 + (ix.n - df + 0.5) / (df + 0.5));
    idfSum += idf;
    const { docs, tfs } = ix.postings(ti);
    seenTerms.push({ term: q, docs, tfs });
    for (let k = 0; k < docs.length; k++) {
      if ((k & 4095) === 4095) check();
      const doc = docs[k]!;
      let t = 0;
      for (let f = 0; f < 5; f++) {
        const tf = tfs[k * 5 + f]!;
        if (!tf) continue;
        t += (w[f]! * tf) / (1 - p.b + (p.b * ix.lens[doc * 5 + f]!) / ix.avg[f]!);
      }
      scores[doc] += (idf * t) / (p.k1 + t);
      if (tfs[k * 5]! > 0) nameHits.add(doc);
    }
    check();
  }
  const ranked: Ranked[] = [];
  if (idfSum > 0) for (let d = 0; d < ix.n; d++) { const norm = scores[d]! / idfSum; if (norm > 0) ranked.push({ doc: d, score: scores[d]!, norm }); }
  const tie = byName(ix);
  ranked.sort((a, b) => b.norm - a.norm || tie(a, b));
  return {
    ranked, idfSum, nameHits,
    matchedFields(doc: number) {
      const fields: Record<string, string[]> = {};
      for (const { term, docs, tfs } of seenTerms) {
        let lo = 0;
        let hi = docs.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          if (docs[mid] === doc) {
            FIELDS.forEach((f, fi) => { if (tfs[mid * 5 + fi]! > 0) (fields[f] ??= []).push(term); });
            break;
          }
          if (docs[mid]! < doc) lo = mid + 1; else hi = mid - 1;
        }
      }
      return { fields, strong: Boolean(fields.name || fields.triggers || fields.routing) };
    },
  };
}

/** "name: brief; description: meet, note" (up to 4 terms per field). */
export function reasonText(fields: Record<string, string[]>): string {
  return FIELDS.filter(f => fields[f]?.length).map(f => `${f}: ${fields[f]!.slice(0, 4).join(', ')}`).join('; ');
}
