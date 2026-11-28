/**
 * #6764: write-time fact subject inference for the conversation extractor's
 * bulk path (`gbrain extract-conversation-facts`, the backfill phase) and for
 * the free conversation relink (`gbrain facts relink --conversation`).
 *
 * The extractor sometimes returns a fact with no entity, or one the save-time
 * resolver could not resolve. Such a fact gets the subject `inferFactSubject`
 * proves from identity evidence, in `write` mode (exactly one live entity
 * page named in full; any competing name vetoes), with the
 * `entity inferred from <tier>` note the doctor counts. The conversation page
 * is never an entity page, so only the mention tier can fire.
 *
 * The row stays a derived row of the conversation page: `entity_slug` is a
 * column on it, and nothing is written to the entity page, so the backstop's
 * fence and target-page authority checks do not apply. What does: a
 * withdrawn claim and visibility (a private page never resolves, nor counts
 * toward uniqueness, for a world fact). The extractor also honours the
 * `facts.entity_inference` kill switch; relink ignores it, as
 * `gbrain facts relink` does. Trusted local callers only.
 */
import type { BrainEngine } from '../engine.ts';
import type { FactVisibility } from './visibility.ts';
import { appendContextNote, inferFactSubject, isEntityInferenceEnabled, type InferResult } from './subject-infer.ts';
import { inferenceNote } from './subject-infer-write.ts';
import { isFactWithdrawn } from './withdrawal.ts';
import { isNullLikeEntity } from './write-single.ts';

/** One conversation fact's subject: the inferred entity, or why none was proven (`withdrawn` when the claim was withdrawn on it). */
export async function inferConversationSubject(engine: BrainEngine, sourceId: string, visibility: FactVisibility, fact: string,
): Promise<InferResult | { slug: null; reason: 'withdrawn'; resolved: string[] }> {
  const inferred = await inferFactSubject(engine, sourceId, { fact, mode: 'write', excludePrivate: visibility === 'world' });
  if (inferred.slug !== null && await isFactWithdrawn(engine, sourceId, visibility, fact, inferred.slug)) return { slug: null, reason: 'withdrawn', resolved: [inferred.slug] };
  return inferred;
}

/**
 * #10588: the subject a conversation page's own authored links prove when whole-source inference proves none
 * (`conversationEntityHints`, the set the extractor gets). Inside that small set a first name is not ambiguous: the
 * fact names exactly one hinted page, by its full title (any case) or, for a person page, by the first word of its
 * title written as the title writes it. Two hinted pages named, or none, prove nothing, and a withdrawn claim is never
 * attached.
 */
export async function inferSubjectFromHints(engine: BrainEngine, sourceId: string, visibility: FactVisibility, fact: string,
  hints: ReadonlyArray<{ slug: string; title: string; type: string | null }>): Promise<string | null> {
  const wordChar = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);
  const names = (needle: string, caseless: boolean) => {
    if (needle.length < 2) return false;
    const hay = caseless ? fact.toLowerCase() : fact;
    const word = caseless ? needle.toLowerCase() : needle;
    for (let at = hay.indexOf(word); at !== -1; at = hay.indexOf(word, at + 1)) {
      if (!wordChar(hay.charAt(at - 1)) && !wordChar(hay.charAt(at + word.length))) return true;
    }
    return false;
  };
  const named = hints.filter(hint => names(hint.title.trim(), true)
    || ((hint.type === 'person' || hint.slug.startsWith('people/')) && names(hint.title.trim().split(/\s+/)[0] ?? '', false)));
  if (named.length !== 1) return null;
  return await isFactWithdrawn(engine, sourceId, visibility, fact, named[0]!.slug) ? null : named[0]!.slug;
}

export async function inferConversationSubjects<T extends { fact: string; entity_slug?: string | null; context?: string | null }>(
  engine: BrainEngine, sourceId: string, visibility: FactVisibility, rows: T[]): Promise<T[]> {
  if (!rows.length || !(await isEntityInferenceEnabled(engine))) return rows;
  const out: T[] = [];
  for (const row of rows) {
    if (!isNullLikeEntity(row.entity_slug)) { out.push(row); continue; }
    const inferred = await inferConversationSubject(engine, sourceId, visibility, row.fact);
    out.push(inferred.slug === null ? row : { ...row, entity_slug: inferred.slug, context: appendContextNote(row.context, inferenceNote(inferred.via)) });
  }
  return out;
}
