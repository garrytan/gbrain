/**
 * Relationship-phrasing typing units (Q2 Track C).
 *
 * Each unit is one entailment-limited change to link typing (link-extraction.ts) or to the temporal cue lexicon
 * (link-temporal-evidence.ts), active when its id is in ENABLED_TYPING_UNITS. The shipped units are U1 (adviser
 * wording) and the joint unit U34 (board wording never types works_at; advisory, board and investor roles are not
 * employment starts), confirmed by the preregistered held-out verdict (decision q2-parser-gaps-2026-10). U2, U5 and U6
 * were tested and not shipped, and their code was removed (docs/eval/decisions/q2-parser-gaps/dev-units.md).
 * scripts/q2-typing-package.ts builds a branch whose one extra commit sets this constant.
 *
 * Policy, examples and the contributor recipe: docs/guides/temporal-edges.md, "Relationship phrasings".
 */

export const TYPING_UNITS = ['U1', 'U3', 'U4'] as const;
export type TypingUnit = typeof TYPING_UNITS[number];

/** The units this build applies (the confirmed package P2). */
export const ENABLED_TYPING_UNITS: ReadonlySet<TypingUnit> = new Set<TypingUnit>(['U3', 'U4', 'U1']);

let override: ReadonlySet<TypingUnit> | null = null;

export function typingUnitEnabled(unit: TypingUnit): boolean {
  return (override ?? ENABLED_TYPING_UNITS).has(unit);
}

/** The unit set extraction uses right now (the test override, else ENABLED_TYPING_UNITS). */
export function activeTypingUnits(): TypingUnit[] {
  return TYPING_UNITS.filter(typingUnitEnabled);
}

/**
 * Joint units: ids that stand for several units measured together. U34 is U3 with U4: U4 alone loses as-of accuracy
 * wherever board wording still types works_at (the set-F interaction), which U3 removes
 * (docs/eval/decisions/q2-parser-gaps/dev-units.md, "Dependency units").
 */
export const JOINT_TYPING_UNITS: Readonly<Record<string, readonly TypingUnit[]>> = { U34: ['U3', 'U4'] };

export function parseTypingUnits(units: Iterable<string>): TypingUnit[] {
  const out: TypingUnit[] = [];
  for (const raw of units) {
    const u = raw.trim().toUpperCase();
    if (!u) continue;
    if (JOINT_TYPING_UNITS[u]) { for (const j of JOINT_TYPING_UNITS[u]!) if (!out.includes(j)) out.push(j); continue; }
    if (!(TYPING_UNITS as readonly string[]).includes(u)) {
      throw new Error(`Unknown typing unit "${raw}". The units are ${TYPING_UNITS.join(', ')} and the joint ${Object.keys(JOINT_TYPING_UNITS).join(', ')} (src/core/link-typing-units.ts); pass a comma-separated subset.`);
    }
    if (!out.includes(u as TypingUnit)) out.push(u as TypingUnit);
  }
  return out;
}

/** Tests and development reports only: run extraction with `units` instead of ENABLED_TYPING_UNITS (null restores it). */
export function setTypingUnitsForTests(units: Iterable<string> | null): void {
  override = units === null ? null : new Set(parseTypingUnits(units));
}

/** Tests only: run `fn` with `units` enabled, then restore the previous set. */
export async function withTypingUnits<T>(units: Iterable<string>, fn: () => T | Promise<T>): Promise<T> {
  const previous = override;
  setTypingUnitsForTests(units);
  try {
    return await fn();
  } finally {
    override = previous;
  }
}

// ─── Typing hooks (link-extraction.ts) ──────────────────────────────────

/** A verb rule a unit adds. `id` is stable (`unit.u<N>.*`); it sits right after the core rule for the same verb. */
export interface UnitVerbRule { id: string; re: RegExp; verb: string; unit: TypingUnit; after: string }

/**
 * U1: the British `adviser` spelling and "advising [X]". A bare "adviser at [X]" is a job title ("financial adviser
 * at [Bank]") and stays employment; a qualified advisory title ("technical adviser at [X]") advises.
 */
const U1_ADVISER_RE = /\b(?:adviser (?:to|for|of)|(?:strategic|technical|security|product|industry|senior|board|startup|outside|special|go-to-market) adviser (?:to|at|for|of)|(?:is|was|as|became|becomes|serves as|served as|serving as|now|currently|signed on as|brought on as|joined as) an? (?:\w+ )?adviser\b(?! at)|board of advisers|(?:now|currently|is|was|been|started|began|begun|also|still) advising|advising (?=\[))/i;

export const UNIT_VERB_RULES: readonly UnitVerbRule[] = [
  { id: 'unit.u1.adviser', re: U1_ADVISER_RE, verb: 'advises', unit: 'U1', after: 'verb.advises' },
];

/** Negation right before an advisory phrase ("not an advisor to", "no longer advises", "stopped advising"). */
const U1_NEGATED_BEFORE = /\b(?:not|never|no\s+longer|nor|isn't|wasn't|aren't|hasn't|haven't|didn't|doesn't|stopped|ceased(?:\s+to\s+be)?|declined\s+to\s+(?:be|become)|turned\s+down\s+(?:being|becoming)?)\s+(?:(?:an?|the|her|his|their|any|longer|formally|officially|really|yet|be|been)\s+)*$/i;

/** The clause before `index`: back to a sentence, clause or timeline-entry break (at most 100 chars). */
export function clauseBefore(text: string, index: number): string {
  const w = text.slice(Math.max(0, index - 100), index);
  const cut = Math.max(...['. ', '; ', '! ', '? ', '\n', ' | ', ' — ', ' - **'].map(b => { const i = w.lastIndexOf(b); return i < 0 ? -1 : i + b.length; }));
  return cut >= 0 ? w.slice(cut) : w;
}

/** Someone other than the page's subject holds the role ("her husband is …", "a friend who …"). */
const THIRD_PARTY = /\b(?:husband|wife|spouse|boyfriend|girlfriend|fianc[eé]e?|brother|sister|mother|father|mom|dad|son|daughter|parent|friend|colleague|co-?worker|manager|boss|mentor|mentee|roommate|neighbou?r|cousin|uncle|aunt|classmate|former\s+colleague|whose|who|someone|somebody)\b/i;
export const thirdPartyBefore = (text: string, index: number) => THIRD_PARTY.test(clauseBefore(text, index));

export interface VetoInput {
  rule: { id: string; verb: string };
  context: string;
  /** Match offsets in `context`. */
  start: number;
  end: number;
  /** Whether the page states the subject is an investor (link-extraction.ts PARTNER_ROLE_RE on the whole page). */
  investorPrior?: () => boolean;
  /** The link's markup in `context`, when located. */
  linkStart?: number;
  linkEnd?: number;
}

/** A sentence, clause, line or timeline-entry break. */
const BREAK = /\.\s|;\s|\n|\s[-*]\s+\*\*\d{4}-\d{2}-\d{2}\*\*|\s#{2,6}\s/;
/** Is the verb match in the same sentence or timeline entry as the link (always true when the link was not located)? */
const sameClauseAsLink = (v: VetoInput) => v.linkStart === undefined || v.linkEnd === undefined
  || !BREAK.test(v.end <= v.linkStart ? v.context.slice(v.end, v.linkStart) : v.context.slice(v.linkEnd, v.start));

/** U3: board, observer and investor wording ("board director at", "independent director of", "joined as an investor"). "On board" is not a board. */
const U3_BOARD_WORDING = /(?<!\bon[\s-])\bboards?\b|\b(?:observer|investor|investing|angel|non-executive|trustee)\b|\bindependent\s+director\b/i;
/** Board positions (not investments): what may sit right before a link as the link's own role. */
const U3_BOARD_POSITION = /(?<!\bon[\s-])\bboards?\b|\b(?:observer|non-executive|trustee)\b|\bindependent\s+director\b/gi;
/** The words right around a verb match: board wording ending at most 20 word characters before the match end, or starting at most 20 after it (no punctuation in between). */
const boardNearMatch = (context: string, start: number, end: number) =>
  new RegExp(`(?:${U3_BOARD_WORDING.source})[\\w\\s-]{0,20}$`, 'i').test(`${clauseBefore(context, start)}${context.slice(start, end)}`)
  || new RegExp(`^[\\w\\s-]{0,20}?(?:${U3_BOARD_WORDING.source})`, 'i').test(context.slice(end, end + 60));
/** The link's own role is a board position right before it ("is also a board director at [X]", "joined the board of [X]"). */
function boardRoleBeforeLink(v: VetoInput): boolean {
  if (v.linkStart === undefined) return false;
  const clause = clauseBefore(v.context, v.linkStart);
  const last = [...clause.matchAll(U3_BOARD_POSITION)].pop();
  return !!last && /^[\w\s-]{0,30}?\b(?:at|of|for|with|on|to|in)\s+(?:the\s+)?$/i.test(clause.slice((last.index ?? 0) + last[0].length));
}
/** "board seat at [X] as an investor": the board phrase's own clause states the investment. */
const U3_INVESTMENT_STATED = /\b(?:investor|invested|investing|investment|led\s+(?:the|its)\s+(?:seed|round|series)|on\s+behalf\s+of\s+(?:the|its|our|her|his|their)\s+fund)\b/i;

/**
 * A unit's veto of one verb match, or null. A vetoed match does not decide the type; inference moves on to the next
 * match or rule. Returns the stable id of the veto (`unit.u<N>.*`).
 */
export function unitVerbVeto(v: VetoInput): string | null {
  if (v.rule.verb === 'advises' && typingUnitEnabled('U1')) {
    if (U1_NEGATED_BEFORE.test(v.context.slice(Math.max(0, v.start - 40), v.start))) return 'unit.u1.negated';
    if (v.rule.id === 'unit.u1.adviser' && thirdPartyBefore(v.context, v.start)) return 'unit.u1.third_party';
    if (v.rule.id === 'unit.u1.adviser' && !sameClauseAsLink(v)) return 'unit.u1.other_entry';
  }
  if (typingUnitEnabled('U3')) {
    if (v.rule.id === 'verb.invested_in.board_seat' && !v.investorPrior?.()
      && !U3_INVESTMENT_STATED.test(`${clauseBefore(v.context, v.start)}${v.context.slice(v.start, v.end + 100).split(BREAK)[0]}`)) return 'unit.u3.board_seat_without_investment';
    if (v.rule.verb === 'works_at' && (boardRoleBeforeLink(v)
      || (sameClauseAsLink(v) && boardNearMatch(v.context, v.start, v.end)))) return 'unit.u3.board_wording';
  }
  return null;
}

/** The unit a rule or veto id belongs to (`unit.u3.board_wording` → U3). */
export function unitOfRule(id: string | null | undefined): TypingUnit | null {
  const m = /^unit\.u(\d)\./.exec(id ?? '');
  return m ? (`U${m[1]}` as TypingUnit) : null;
}

// ─── Temporal cue hooks (link-temporal-evidence.ts) ─────────────────────

/**
 * U4: advisory, board and investor roles are not jobs. Inserted into the "became … at/of" and "took … role at"
 * employment start cues, so "Became an advisor at [X]" or "Took an advisory role with [X]" never starts a works_at stint.
 */
export const U4_NOT_EMPLOYMENT_ROLE = String.raw`(?!(?:\w+\s+){0,2}?(?:advis\w*|board|investor|investing|investment|angel|observer|non-executive|independent|trustee)\b)`;
