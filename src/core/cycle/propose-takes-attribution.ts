/**
 * #5425 [UC4]: mechanical holder check for propose_takes, behind
 * `dream.attribution_checks` (default off; `cycle/attribution-checks.ts`).
 *
 * The extractor may hand a judgment the assistant made to `people/<slug>`.
 * The one part of that a mechanical check can test is the claim's content
 * tokens: its numbers and dates (`numericClaims`, so currency, scaled amounts,
 * percents, dates and 4+ digit numbers, never a bare year) and its quoted
 * phrases. When every token some speaker of the page states was stated only
 * in assistant turns, and no user (or other human) turn states or explicitly
 * accepts any of them, the proposal is held by `brain` instead. A turn the
 * user accepted in the very next turn counts as the user's
 * (`statedBySpeaker`, the same credit `decision_misattributed` gives), so a
 * real decision after "yes, do that" keeps its person.
 *
 * A page without speaker turns (a synthesized wiki page, a note), a claim
 * without content tokens, and tokens no turn states are left alone: without
 * evidence of who said what there is nothing mechanical to decide. The one
 * call sits in `propose-takes.ts`, right after the extractor returns.
 */
import { extractQuoteSpans, numericClaims, numericFacts, normForGrounding, parseSpeakerTurns, speakerKey, statedBySpeaker, YEAR_KEY_RE } from './synthesize-verify.ts';

export interface HolderCheckInput { claim_text: string; holder: string }

const PERSON_HOLDER_RE = /^people\//;

/** The claim's content tokens: canonical numeric keys (no bare years) and normalized quoted phrases. */
export function claimContentTokens(claim: string): string[] {
  const numbers = numericClaims(claim).flatMap(({ keys }) => keys).filter(k => !YEAR_KEY_RE.test(k));
  const phrases = extractQuoteSpans(claim).spans.map(sp => `q:${normForGrounding(sp.inner)}`);
  return [...new Set([...numbers, ...phrases])];
}

function tokensIn(text: string, phrases: string[]): Set<string> {
  const norm = normForGrounding(text);
  const found = new Set<string>(numericFacts(text));
  for (const p of phrases) if (norm.includes(p.slice(2))) found.add(p);
  return found;
}

/**
 * The proposals with every assistant-only person attribution downgraded to
 * `brain`. Pure; the input array and its objects are not mutated. Returns the
 * same array when nothing changes.
 */
export function downgradeAssistantOnlyHolders<T extends HolderCheckInput>(proposals: T[], pageBody: string): T[] {
  const turns = parseSpeakerTurns(pageBody);
  if (turns.length === 0 || !proposals.some(p => PERSON_HOLDER_RE.test(p.holder))) return proposals;
  const phrases = proposals.flatMap(p => claimContentTokens(p.claim_text)).filter(t => t.startsWith('q:'));
  const stated = statedBySpeaker(pageBody, turns, text => tokensIn(text, phrases));
  const assistantOnly = (token: string): boolean | null => {
    let byAssistant = false, byOther = false;
    for (const [speaker, tokens] of stated) {
      if (!tokens.has(token)) continue;
      if (speaker === speakerKey('assistant')) byAssistant = true; else byOther = true;
    }
    return byOther ? false : byAssistant ? true : null;
  };
  let changed = false;
  const out = proposals.map(p => {
    if (!PERSON_HOLDER_RE.test(p.holder)) return p;
    const verdicts = claimContentTokens(p.claim_text).map(assistantOnly).filter((v): v is boolean => v !== null);
    if (verdicts.length === 0 || verdicts.includes(false)) return p;
    changed = true;
    return { ...p, holder: 'brain' };
  });
  return changed ? out : proposals;
}
