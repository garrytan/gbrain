/**
 * Frozen per-example expectations for the relationship-phrasing typing units (src/core/link-typing-units.ts).
 *
 * Each example states the type set, tense, dated transitions and live/as-of result explainLinkType must give with
 * its unit off (`off`, master behavior) and on (`on`). `on` may depend on the other units in the set (joint effects).
 * Controls (negation, third party, concurrent roles, rejoins, repeated targets, window truncation, event look-alikes)
 * are examples whose `on` equals `off` or whose unit is null. Development text only; names are placeholders.
 */
import { explainLinkType } from '../../src/core/link-extraction.ts';
import { stintCovers } from '../../src/core/link-validity.ts';
import type { TypingUnit } from '../../src/core/link-typing-units.ts';

export interface Expectation {
  /** Distinct types the page emits for the target (sorted; `mentions` rows included). */
  types: string[];
  /** Tense per temporal type, when asserted. */
  tense?: Record<string, 'past' | 'present'>;
  /** Dated transitions for the target: `${type} ${kind} ${date}`, in order. */
  transitions?: string[];
  /** Whether `type` is valid on each date (as-of), with 'today' = 2026-10-06. */
  live?: { type: string; at: Record<string, boolean> };
}

export interface TypingExample {
  id: string;
  /** The unit (or units, for a joint effect) this example measures, or null for a control that no unit may change. */
  unit: TypingUnit | TypingUnit[] | null;
  target: string;
  content: string;
  pageType?: 'person' | 'company' | 'concept';
  off: Expectation;
  on?: Expectation | ((units: ReadonlySet<TypingUnit>) => Expectation);
}

export const ACME = 'companies/acme-example';
export const BETA = 'companies/beta-example';
export const GLOBEX = 'companies/globex-example';
export const SLUG = 'people/alice-example';
export const L = (slug: string) => `[${slug.split('/')[1]!.replace(/-example$/, '').replace(/^\w/, c => c.toUpperCase())}](../${slug}.md)`;
export const page = (prose: string, timeline: string[] = []) =>
  timeline.length ? `${prose}\n\n## Timeline\n\n${timeline.map(l => `- ${l}`).join('\n')}\n` : `${prose}\n`;

export function expected(ex: TypingExample, units: ReadonlySet<TypingUnit>): Expectation {
  const mine = ex.unit === null ? [] : Array.isArray(ex.unit) ? ex.unit : [ex.unit];
  if (!ex.on || !mine.some(u => units.has(u))) return ex.off;
  return typeof ex.on === 'function' ? ex.on(units) : ex.on;
}

/** What explainLinkType actually gives, in the Expectation shape (only the fields `want` asks for). */
export async function observe(ex: TypingExample, want: Expectation): Promise<Expectation> {
  const e = await explainLinkType({ slug: SLUG, content: ex.content, pageType: ex.pageType ?? 'person', target: ex.target });
  const got: Expectation = { types: e.types };
  if (want.tense) got.tense = e.tense;
  if (want.transitions) got.transitions = e.transitions.map(t => `${t.link_type} ${t.kind} ${t.occurred_on}`);
  if (want.live) {
    const stints = e.stints[want.live.type] ?? [];
    got.live = { type: want.live.type, at: Object.fromEntries(Object.keys(want.live.at).map(d =>
      [d, stints.some(s => stintCovers(s, d === 'today' ? '2026-10-06' : d))])) };
  }
  return got;
}

// ─── U1: adviser wording, with local negation ───────────────────────────
const U1: TypingExample[] = [
  { id: 'u1-is-an-adviser-to', unit: 'U1', target: ACME, content: page(`Alice is an adviser to ${L(ACME)}.`),
    off: { types: ['mentions'] }, on: { types: ['advises'], tense: { advises: 'present' }, live: { type: 'advises', at: { today: true } } } },
  { id: 'u1-serves-as-adviser', unit: 'U1', target: ACME, content: page(`Alice serves as an adviser to ${L(ACME)} on hiring.`),
    off: { types: ['mentions'] }, on: { types: ['advises'] } },
  { id: 'u1-now-advising', unit: 'U1', target: ACME, content: page(`Alice is now advising ${L(ACME)} on pricing.`),
    off: { types: ['mentions'] }, on: { types: ['advises'] } },
  { id: 'u1-advising-link', unit: 'U1', target: ACME, content: page(`Alice works at ${L(BETA)}.`, [`**2025-02-03** | note — Advising ${L(ACME)} on its launch`]),
    off: { types: ['mentions'] }, on: { types: ['advises'] } },
  { id: 'u1-technical-adviser-at', unit: 'U1', target: ACME, content: page(`Alice is a technical adviser at ${L(ACME)}.`),
    off: { types: ['mentions'] }, on: { types: ['advises'] } },
  { id: 'u1-job-title-financial-adviser-at', unit: 'U1', target: ACME, content: page(`Alice is a financial adviser at ${L(ACME)}.`),
    off: { types: ['mentions'] }, on: { types: ['mentions'] } },
  { id: 'u1-negated-not-an-advisor', unit: 'U1', target: ACME, content: page(`Alice is not an advisor to ${L(ACME)}.`),
    off: { types: ['advises'], tense: { advises: 'present' } }, on: { types: ['mentions'] } },
  { id: 'u1-negated-no-longer-advises', unit: 'U1', target: ACME, content: page(`Alice no longer advises ${L(ACME)}.`),
    off: { types: ['advises'], tense: { advises: 'past' }, live: { type: 'advises', at: { today: false } } }, on: { types: ['mentions'] } },
  { id: 'u1-negated-not-an-adviser', unit: 'U1', target: ACME, content: page(`Alice is not an adviser to ${L(ACME)}.`),
    off: { types: ['mentions'] }, on: { types: ['mentions'] } },
  { id: 'u1-stopped-advising', unit: 'U1', target: ACME, content: page(`Alice stopped advising ${L(ACME)} last year.`),
    off: { types: ['mentions'] }, on: { types: ['mentions'] } },
  { id: 'u1-third-party-adviser', unit: 'U1', target: ACME, content: page(`Alice's husband is an adviser to ${L(ACME)}.`),
    off: { types: ['mentions'] }, on: { types: ['mentions'] } },
  { id: 'u1-third-party-friend-advising', unit: 'U1', target: ACME, content: page(`Alice introduced a friend who is now advising ${L(ACME)}.`),
    off: { types: ['mentions'] }, on: { types: ['mentions'] } },
  // An adviser phrase on the next timeline entry, whose own link the 240-character window cuts off, is not this link's.
  { id: 'u1-next-entry-adviser-not-borrowed', unit: 'U1', target: ACME,
    content: page(`Alice signed on with ${L(ACME)} as product manager and remains on the team. She also works at ${L(BETA)}.`,
      [`**2014-11-27** | linkedin — Signed on with ${L(ACME)} as product manager (EU platform)`, `**2023-03-27** | note — Signed on as an adviser to ${L(BETA)}`]),
    off: { types: ['mentions'] }, on: { types: ['mentions'] } },
  { id: 'u1-concurrent-role', unit: 'U1', target: ACME, content: page(`Alice works at ${L(BETA)} and is an adviser to ${L(ACME)}.`),
    off: { types: ['mentions'] }, on: { types: ['advises'] } },
  { id: 'u1-concurrent-role-after-untyped-role', unit: 'U1', target: BETA, content: page(`Alice is CTO for ${L(ACME)} and an adviser to ${L(BETA)}.`),
    off: { types: ['mentions'] }, on: { types: ['advises'] } },
  { id: 'u1-concurrent-role-employer-kept', unit: null, target: BETA, content: page(`Alice works at ${L(BETA)} and is an adviser to ${L(ACME)}.`),
    off: { types: ['works_at'], tense: { works_at: 'present' } } },
  { id: 'u1-dated-start', unit: 'U1', target: ACME,
    content: page(`Alice works at ${L(BETA)}. She is an adviser to ${L(ACME)}.`, [`**2024-05-06** | note — Began advising ${L(ACME)}`]),
    off: { types: ['mentions'], transitions: [] },
    on: { types: ['advises'], transitions: ['advises start 2024-05-06'], live: { type: 'advises', at: { '2024-01-01': false, today: true } } } },
  { id: 'u1-employer-not-closed-by-advising-line', unit: null, target: BETA,
    content: page(`Alice works at ${L(BETA)} as CTO.`, [`**2019-01-02** | linkedin — Joined ${L(BETA)} as CTO`, `**2024-05-06** | note — Now advising ${L(ACME)}`]),
    off: { types: ['mentions', 'works_at'], transitions: ['works_at start 2019-01-02'], live: { type: 'works_at', at: { today: true } } } },
];

// ─── U3: board, observer and investor wording never types works_at ─────
const INVESTOR_PAGE = 'Alice is a partner at a venture capital fund and a seed investor.';
const U3: TypingExample[] = [
  { id: 'u3-board-director-at', unit: 'U3', target: ACME, content: page(`Alice is a board director at ${L(ACME)}.`),
    off: { types: ['works_at'], tense: { works_at: 'present' }, live: { type: 'works_at', at: { today: true } } }, on: { types: ['mentions'] } },
  { id: 'u3-independent-director-of', unit: 'U3', target: ACME, content: page(`Alice is an independent director of ${L(ACME)}.`),
    off: { types: ['works_at'] }, on: { types: ['mentions'] } },
  { id: 'u3-joined-as-investor', unit: 'U3', target: ACME, content: page(`Alice joined as an investor in ${L(ACME)}.`),
    off: { types: ['works_at'] }, on: { types: ['invested_in'] } },
  { id: 'u3-joined-as-observer', unit: 'U3', target: ACME, content: page(`Alice joined as an observer at ${L(ACME)}.`),
    off: { types: ['works_at'] }, on: { types: ['mentions'] } },
  { id: 'u3-board-seat-without-investor-prior', unit: 'U3', target: ACME, content: page(`Alice holds a board seat at ${L(ACME)}.`),
    off: { types: ['invested_in'] }, on: { types: ['mentions'] } },
  { id: 'u3-board-seat-with-investor-prior', unit: 'U3', target: ACME, content: page(`${INVESTOR_PAGE} She holds a board seat at ${L(ACME)}.`),
    off: { types: ['invested_in'] }, on: { types: ['invested_in'] } },
  { id: 'u3-board-seat-as-investor', unit: 'U3', target: ACME, content: page(`Alice A.`, [`**2021-02-03** | note — Took a board seat at ${L(ACME)} as an investor`]),
    off: { types: ['invested_in'] }, on: { types: ['invested_in'] } },
  { id: 'u3-cross-entry-board-wording-not-read', unit: null, target: BETA,
    content: page(`Alice A.`, [`**2019-06-22** | linkedin — Joined ${L(BETA)} as VP engineering`, `**2020-07-15** | note — Became a board director at ${L(ACME)}`]),
    off: { types: ['works_at'] } },
  { id: 'u3-cross-sentence-job-verb-not-borrowed', unit: 'U3', target: ACME,
    content: page(`Alice works at ${L(BETA)} as head of sales. Alice is also a board director at ${L(ACME)}.`),
    off: { types: ['works_at'] }, on: { types: ['mentions'] } },
  { id: 'u3-board-mentioned-after-employer', unit: null, target: ACME,
    content: page(`Alice works at ${L(ACME)}, whose board she joined in 2020.`), off: { types: ['works_at'] } },
  { id: 'u3-board-member-who-works-at', unit: null, target: ACME,
    content: page(`Alice, a board observer elsewhere, works at ${L(ACME)}.`), off: { types: ['works_at'] } },
  { id: 'u3-observer-stays-mentions', unit: 'U3', target: ACME, content: page(`Alice is the board observer at ${L(ACME)}.`),
    off: { types: ['mentions'] }, on: { types: ['mentions'] } },
  { id: 'u3-negated-board-director', unit: 'U3', target: ACME, content: page(`Alice is not a board director at ${L(ACME)}.`),
    off: { types: ['works_at'] }, on: { types: ['mentions'] } },
  { id: 'u3-third-party-board-director', unit: 'U3', target: ACME, content: page(`Alice's sister is a board director at ${L(ACME)}.`),
    off: { types: ['works_at'] }, on: { types: ['mentions'] } },
  { id: 'u3-on-board-is-not-a-board', unit: null, target: ACME, content: page(`Alice came on board as a senior engineer at ${L(ACME)}.`),
    off: { types: ['works_at'] } },
  { id: 'u3-employer-kept', unit: null, target: ACME, content: page(`Alice works at ${L(ACME)} as head of sales.`),
    off: { types: ['works_at'] } },
  { id: 'u3-concurrent-employer-and-board', unit: null, target: BETA,
    content: page(`Alice is VP engineering at ${L(BETA)} and a board director at ${L(ACME)}.`), off: { types: ['works_at'] } },
  { id: 'u3-concurrent-board-target', unit: 'U3', target: ACME,
    content: page(`Alice is VP engineering at ${L(BETA)} and a board director at ${L(ACME)}.`), off: { types: ['works_at'] }, on: { types: ['mentions'] } },
  // The set-F interaction: a board line is the only statement about the company. Master reads a job that starts on
  // the board date; U4 alone keeps the job but drops its start (live on every date); U3 removes the job.
  { id: 'u34-board-only-target', unit: ['U3', 'U4'], target: ACME,
    content: page(`Alice works at ${L(BETA)} as engineer.`, [`**2022-03-04** | note — Became a board director at ${L(ACME)}`]),
    off: { types: ['works_at'], transitions: ['works_at start 2022-03-04'], live: { type: 'works_at', at: { '2020-01-01': false, today: true } } },
    on: units => units.has('U3') ? { types: ['mentions'], transitions: [] }
      : { types: ['works_at'], transitions: [], live: { type: 'works_at', at: { '2020-01-01': true, today: true } } } },
];

// ─── U4: advisory, board and investor roles are not employment starts ──
const E5_PAGE = (line: string, target = ACME) => page(`Alice works at ${L(ACME)} as CTO.`,
  [`**2015-01-02** | linkedin — Joined ${L(ACME)} as CTO`, `**2021-06-07** | ${line.replace('{X}', L(target))}`]);
const U4: TypingExample[] = [
  { id: 'u4-became-advisor-at-employer', unit: 'U4', target: ACME, content: E5_PAGE('note — Became an advisor at {X}'),
    off: { types: ['advises', 'mentions', 'works_at'], transitions: ['works_at start 2015-01-02', 'works_at start 2021-06-07', 'advises start 2021-06-07'] },
    on: { types: ['advises', 'mentions', 'works_at'], transitions: ['works_at start 2015-01-02', 'advises start 2021-06-07'],
      live: { type: 'works_at', at: { '2016-01-01': true, today: true } } } },
  { id: 'u4-took-advisory-role-with-employer', unit: 'U4', target: ACME, content: E5_PAGE('linkedin — Took an advisory role with {X}'),
    off: { types: ['advises', 'mentions', 'works_at'], transitions: ['works_at start 2015-01-02', 'works_at start 2021-06-07'] },
    on: { types: ['advises', 'mentions', 'works_at'], transitions: ['works_at start 2015-01-02'] } },
  // U3 retypes the board line (mentions) but leaves its start cue; U4 drops the start (the job, stated in prose, stays undated).
  { id: 'u4-took-board-role-at-other-employer', unit: ['U3', 'U4'], target: BETA,
    content: page(`Alice works at ${L(ACME)} as CTO. She also works at ${L(BETA)}.`, [`**2021-06-07** | linkedin — Took a board role at ${L(BETA)}`]),
    off: { types: ['works_at'], transitions: ['works_at start 2021-06-07'], live: { type: 'works_at', at: { '2020-01-01': false, today: true } } },
    on: units => ({ types: units.has('U3') ? ['mentions', 'works_at'] : ['works_at'], transitions: units.has('U4') ? [] : ['works_at start 2021-06-07'],
      live: { type: 'works_at', at: { '2020-01-01': units.has('U4'), today: true } } }) },
  { id: 'u4-became-board-observer-of', unit: 'U4', target: BETA,
    content: page(`Alice works at ${L(BETA)}.`, [`**2021-06-07** | note — Became a board observer of ${L(BETA)}`]),
    off: { types: ['mentions', 'works_at'], transitions: ['works_at start 2021-06-07'] }, on: { types: ['mentions', 'works_at'], transitions: [] } },
  { id: 'u4-became-cto-still-starts', unit: null, target: ACME, content: E5_PAGE('linkedin — Became CTO at {X}'),
    off: { types: ['mentions', 'works_at'], transitions: ['works_at start 2015-01-02', 'works_at start 2021-06-07'] } },
  { id: 'u4-took-new-role-still-starts', unit: null, target: BETA,
    content: page(`Alice works at ${L(BETA)}.`, [`**2021-06-07** | linkedin — Took a new engineering role at ${L(BETA)}`]),
    off: { types: ['works_at'], transitions: ['works_at start 2021-06-07'] } },
  // Unsupported, frozen: an advisory-services job title reads as an advisory role (no start with U4).
  { id: 'u4-advisory-services-job-lookalike', unit: 'U4', target: BETA,
    content: page(`Alice works at ${L(BETA)}.`, [`**2021-06-07** | linkedin — Became head of advisory services at ${L(BETA)}`]),
    off: { types: ['works_at'], transitions: ['works_at start 2021-06-07'] }, on: { types: ['works_at'], transitions: [] } },
  { id: 'u4-advisory-start-kept', unit: null, target: GLOBEX,
    content: page(`Alice works at ${L(ACME)}. She advises ${L(GLOBEX)}.`, [`**2021-06-07** | note — Became an advisor to ${L(GLOBEX)}`]),
    off: { types: ['advises'], transitions: ['advises start 2021-06-07'] } },
];

export const EXAMPLES: TypingExample[] = [...U1, ...U3, ...U4];
