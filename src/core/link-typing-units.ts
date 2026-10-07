/**
 * Relationship-phrasing typing units (Q2 Track C).
 *
 * Each unit is one entailment-limited change to link typing (link-extraction.ts) or to the temporal cue lexicon
 * (link-temporal-evidence.ts). A unit takes effect only when its id is in ENABLED_TYPING_UNITS; with the set empty,
 * extraction behaves exactly as before the units existed. Which units ship is decided by the preregistered held-out
 * verdict (docs/eval/decisions/q2-parser-gaps/, gbrain-evals docs/benchmarks/2026-10-06-q2-parser-gaps-preregistration.md);
 * scripts/q2-typing-package.ts builds a branch whose one extra commit sets this constant.
 *
 * Policy, examples and the contributor recipe: docs/guides/temporal-edges.md, "Relationship phrasings".
 */

export const TYPING_UNITS = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6'] as const;
export type TypingUnit = typeof TYPING_UNITS[number];

/** The units this build applies. Changed only by the package script after the verdict. */
export const ENABLED_TYPING_UNITS: ReadonlySet<TypingUnit> = new Set<TypingUnit>(['U3', 'U4']);

let override: ReadonlySet<TypingUnit> | null = null;

export function typingUnitEnabled(unit: TypingUnit): boolean {
  return (override ?? ENABLED_TYPING_UNITS).has(unit);
}

/** The unit set extraction uses right now (the test override, else ENABLED_TYPING_UNITS). */
export function activeTypingUnits(): TypingUnit[] {
  return TYPING_UNITS.filter(typingUnitEnabled);
}

/**
 * Joint units: ids that stand for several units measured together (docs/eval/decisions/q2-parser-gaps/dev-units.md,
 * "Dependency units"). U34 is U3 with U4: U4 alone loses as-of accuracy wherever board wording still types works_at
 * (the set-F interaction), which U3 removes. U25 is U2 with U5: U2 alone lets the single-value pass close a former
 * employer whose leave only U5 reads at the new employer's start date (a wrong closure by date), which U5 removes.
 */
export const JOINT_TYPING_UNITS: Readonly<Record<string, readonly TypingUnit[]>> = { U25: ['U2', 'U5'], U34: ['U3', 'U4'] };

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

// ─── U2: ordinary job roles (post-pass where inference returned `mentions`) ──

/** Ordinary job titles. Board, advisory, investor and observer roles are deliberately absent. */
const EMPLOYMENT_ROLE = String.raw`(?:(?:senior|staff|principal|lead|junior|associate|founding|chief|executive|managing|general|deputy|interim|acting) )*(?:software engineer|engineer|developer|designer|programmer|architect|scientist|data scientist|researcher|analyst|product manager|engineering manager|program manager|project manager|manager|director|officer|counsel|marketer|recruiter|strategist|editor|producer|accountant|controller|specialist|coordinator|administrator|technician|intern|president|chief of staff|cto|ceo|coo|cfo|cmo|cro|cpo|vp|svp|evp|vp (?:of )?[a-z]+|vice president of [a-z]+|head of [a-z]+(?: [a-z]+)?|(?:product|design|engineering|tech|team|growth|sales|marketing|data|research) lead)`;
const EMPLOYMENT_AREA = String.raw`(?:engineering|product|design|sales|marketing|growth|operations|ops|finance|people|hr|recruiting|platform|infrastructure|infra|data|security|research|partnerships|business development|customer success|support|legal|strategy|the [a-z]+ team)`;
/** "<role> for/at/with [X]" introduced as the subject's own role: "is CTO for", "now designer for", "New role: CTO for". */
const U2_ROLE_BEFORE = new RegExp(String.raw`(?:^\s*|\b(?:is|was|as|now|currently|became|becomes|serves as|served as|serving as|works as|worked as|working as)\s+|[:—–-]\s*)(?:an?\s+|the\s+)?${EMPLOYMENT_ROLE}\s+(?:at|for|with)\s+(?:the\s+)?$`, 'i');
/** "led engineering at [X]". */
const U2_LED_AREA = new RegExp(String.raw`\b(?:led|leads|leading|ran|runs|running|managed|manages|managing|headed|heads|heading|oversaw|oversees|overseeing|owned|owns)\s+${EMPLOYMENT_AREA}\s+(?:at|for)\s+(?:the\s+)?$`, 'i');
/** A join, move or start right before the link: "signed on with [X]", "moved to [X]", "a new chapter at [X]". */
const U2_JOIN_BEFORE = /\b(?:re-?joined|joined|joins|joining|signed\s+(?:back\s+)?on\s+(?:with|at)|moved(?:\s+over)?\s+to|moves\s+to|switched\s+to|went\s+to|returned\s+to|came\s+back\s+to|(?:was\s+)?hired\s+(?:by|at|on\s+at)|started\s+(?:at|with)|start(?:ed|ing|s)?\s+(?:a\s+|her\s+|his\s+|their\s+|my\s+)?new\s+chapter\s+(?:at|with)|new\s+chapter\s+(?:at|with)|began\s+(?:working\s+)?(?:at|with|for)|onboarded\s+(?:at|with)|first\s+day\s+at|now\s+at|came\s+(?:on\s+board|aboard)\s+(?:at|with))\s+(?:the\s+)?$/i;
/** "… [X] as <role>" right after the link (with a join, move or start before it). */
const U2_AS_ROLE_AFTER = new RegExp(String.raw`^\s*,?\s*as\s+(?:an?\s+|the\s+|its\s+|their\s+)?${EMPLOYMENT_ROLE}\b`, 'i');
/** "[X] (<role>)": the whole parenthetical is an ordinary job title. */
const U2_PAREN_ROLE_AFTER = new RegExp(String.raw`^\s*\((?:as\s+)?(?:an?\s+|the\s+)?${EMPLOYMENT_ROLE}(?:\s+(?:for|of|at|in)\s+[^()]{1,40})?\)`, 'i');
/** Clauses that do not state the subject's own current or past job. */
const U2_NOT_A_JOB = /\b(?:not|never|no\s+longer|declined|turned\s+down|rejected|passed\s+on|didn't|did\s+not|isn't|wasn't|won't|nor|will|would|could|might|may|plans?\s+to|planning\s+to|hopes?\s+to|wants?\s+to|considering|considered|interview(?:ed|ing|s)?|offered|offer|candidate|applied|applying|in\s+talks|rumou?red|expected\s+to|set\s+to|about\s+to|if|board|observer|investor|investing|angel|advis\w*|non-executive|independent\s+director|trustee|chair(?:man|woman|person)?)\b/i;

/** Inside a dated timeline entry ("- **2021-03-04** | …"): the entry marker comes after the last line break or heading. */
function inDatedEntry(context: string, linkStart: number): boolean {
  const before = context.slice(Math.max(0, linkStart - 240), linkStart);
  const entry = [...before.matchAll(/(?:^|\s)[-*]\s+\*\*\d{4}-\d{2}-\d{2}\*\*|(?:^|\s)#{3}\s+\d{4}-\d{2}-\d{2}/g)].pop();
  if (!entry) return false;
  return !/\n|\s#{1,6}\s/.test(before.slice((entry.index ?? 0) + entry[0].length));
}

/** The page names some organization in an advisory, board or investor role ("Took an advisory role with [X]"). */
const ROLE_ELSEWHERE = /\b(?:advis\w*|board|observer|investor|investing|invested|angel|non-executive|trustee)\b/i;
const LINK_OPEN = /\[\[|\[[^\]\n]*\]\(/g;
export function nonEmploymentRoleOnPage(pageText: string): boolean {
  for (const m of pageText.matchAll(LINK_OPEN)) if (ROLE_ELSEWHERE.test(clauseBefore(pageText, m.index ?? 0))) return true;
  return false;
}

/** How many dated timeline entries on the page mention `target`. */
const DATED_ENTRY_LINE = /^\s*(?:[-*]\s*\*\*\d{4}-\d{2}-\d{2}\*\*|#{3}\s+\d{4}-\d{2}-\d{2})/;
const datedMentions = (pageText: string, target: string) => pageText.split('\n').filter(l => DATED_ENTRY_LINE.test(l) && l.includes(target)).length;

/**
 * U2's rule id for a link at [linkStart, linkEnd) in `context`, or null. Reads only the link's own clause; runs after
 * the full existing inference returned `mentions` (traceLinkType), so it never overrides a verb, a stated type, a
 * pack rule or a role prior. Development rework (docs/eval/decisions/q2-parser-gaps/dev-units.md): it reads undated
 * lines only (a role on a dated join line with an unread leave kept former employers live), and it does not fire on a
 * page that names any organization in an advisory, board or investor role: there master's "became … at" / "took … role"
 * start cues read the advisory line as a new job, and a newly typed employer then meets that false start (E5 probe:
 * extra starts and wrong single-value closures). U4 removes that cause; U2 does not depend on it. Nor does it type an
 * organization that two or more dated entries mention: a later entry no cue reads may be the leave, and typing the
 * earlier role would keep a former employer live (stale summaries) and feed the single-value pass.
 */
export function u2RoleRule(context: string, linkStart: number, linkEnd: number, target: string, pageText: string): string | null {
  if (!typingUnitEnabled('U2')) return null;
  const before = clauseBefore(context, linkStart);
  const after = context.slice(linkEnd, linkEnd + 80);
  if (U2_NOT_A_JOB.test(before) || THIRD_PARTY.test(before) || inDatedEntry(context, linkStart)) return null;
  const rule = U2_ROLE_BEFORE.test(before) ? 'unit.u2.role_before'
    : U2_LED_AREA.test(before) ? 'unit.u2.led_area'
    : U2_PAREN_ROLE_AFTER.test(after) ? 'unit.u2.paren_role'
    : U2_JOIN_BEFORE.test(before) && U2_AS_ROLE_AFTER.test(after) ? 'unit.u2.join_as_role' : null;
  return rule && !nonEmploymentRoleOnPage(pageText) && datedMentions(pageText, target) < 2 ? rule : null;
}

// ─── Temporal cue hooks (link-temporal-evidence.ts) ─────────────────────

/**
 * U4: advisory, board and investor roles are not jobs. Inserted into the "became … at/of" and "took … role at"
 * employment start cues, so "Became an advisor at [X]" or "Took an advisory role with [X]" never starts a works_at stint.
 */
export const U4_NOT_EMPLOYMENT_ROLE = String.raw`(?!(?:\w+\s+){0,2}?(?:advis\w*|board|investor|investing|investment|angel|observer|non-executive|independent|trustee)\b)`;

/** U5: leaves an object splits ("wrapped her time up at", "handed in her notice at") and quitting idioms. */
const LEAVE_OBJECT = String.raw`(?:(?:her|his|their|my|a|the)\s+)?(?:time|stint|tenure|role|job|run|things|it|notice|resignation)\s+`;
const SPLIT_LEAVE = String.raw`(?:wrapped|wound|finished)\s+${LEAVE_OBJECT}up\s+(?:at|with)|(?:handed|turned|put)\s+(?:in\s+${LEAVE_OBJECT}|${LEAVE_OBJECT}in\s+)(?:at|to|with)|(?:gave|submitted|tendered)\s+${LEAVE_OBJECT}(?:at|to)`;
const IDIOM_LEAVE = String.raw`packed\s+(?:it|things)\s+in\s+(?:at|with)|call(?:ed|s|ing)?\s+(?:it\s+)?time\s+(?:on|at)|call(?:ed|s|ing)?\s+it\s+a\s+day\s+(?:at|with)|call(?:ed|s|ing)?\s+it\s+quits\s+(?:at|with)|bow(?:ed|s|ing)?\s+out\s+(?:of|from|at)|walk(?:ed|s|ing)?\s+(?:out\s+(?:of|on)|away\s+from)|thr(?:ew|ows|owing)\s+in\s+the\s+towel\s+(?:at|with)|hand(?:ed|s|ing)?\s+in\s+(?:(?:her|his|their|my)\s+)?(?:badge|keys|laptop)\s+(?:at|to)|clear(?:ed|s|ing)?\s+out\s+(?:(?:her|his|their|my)\s+)?desk\s+at|gave\s+up\s+(?:(?:her|his|their|my)\s+)?(?:job|role|post|position|seat)\s+at|left\s+(?:(?:her|his|their|my)\s+)?(?:job|role|post|position)\s+at|step(?:ped|s|ping)?\s+back\s+from|parted\s+company\s+with|said\s+(?:(?:her|his|their|my)\s+)?goodbyes?\s+to|bid(?:\s+a)?\s+farewell\s+to|exit\s+from`;
export const U5_LEAVE = new RegExp(String.raw`\b(?:${SPLIT_LEAVE}|${IDIOM_LEAVE})\s*$`, 'i');
/** Lines about trading an organization's equity ("Traded shares of [X]") say nothing about a job: the U5 and U6 guards ignore them. */
export const GUARD_IGNORED_LINE = /\b(?:shares?|stock|equity|stake|stock\s+options|secondary\s+market|bought|sold)\b/i;
/** U5: "traded [A] for [B]" ends A (the "for" then starts B). "Traded shares of [A]" is not an exchange. */
export const U5_EXCHANGE_BEFORE = /\b(?:traded|swapped|exchanged|ditched|dropped)\s*$/i;
export const U5_EXCHANGE_AFTER = /^\s+for\s+(?:\[|the\s+\[|an?\s+\[)/i;

/**
 * U6: start framings: a first day, week or month at, day one at, kicking off a role, job, position, chapter or stint
 * at, onboarding, "began working at/for", a new chapter at. Only dates a works_at relationship the page already
 * asserts (natural cues never create one). "First day of the [X] summit" and an event line never start a job.
 * Development rework (dev-units.md), the same two guards as U2/U5: a U6 start is dropped when a later dated entry names
 * the organization in words no cue reads (an unread leave would keep a former job open for good), and U6 does not fire
 * on a page that names any organization in an advisory, board or investor role (a newly dated employer then meets
 * master's advisory-line start: wrong single-value closures on the E5 probe). U4 removes that cause.
 */
const START_ROLE = String.raw`(?:[\w&./-]+\s+){0,4}?`;
export const U6_START = new RegExp(String.raw`\b(?:(?:(?:her|his|their|my|a|the)\s+)?(?:first\s+(?:day|week|month)|day\s+one)\s+(?:as\s+${START_ROLE})?(?:at|with)|kick(?:ed|s|ing)?[\s-]?off\s+(?:(?:a|her|his|their|my)\s+)?(?:new\s+)?(?:role|job|position|chapter|stint)\s+(?:at|with)|(?:was\s+|got\s+|been\s+)?onboarded\s+(?:at|with|to|into|by)|onboarding\s+(?:week|day|period)\s+(?:at|with)|began\s+(?:work(?:ing)?\s+)?(?:at|for)|start(?:ed|ing|s)?\s+(?:a\s+|her\s+|his\s+|their\s+|my\s+)?new\s+chapter\s+(?:at|with)|(?:a\s+)?new\s+chapter\s+(?:at|with))\s*$`, 'i');
