/**
 * Take-grading eval fixtures (W6): synthetic forecasting takes with known
 * outcomes and the dated evidence the grade_takes judge would see.
 *
 * Everything is generated from fixed seeds, so `fixtures.jsonl` is
 * reproducible. Companies and people are placeholders (`*-example`); the
 * only real-world subjects are the public, non-company propositions of the
 * `world_*` sets (prices, rates, events), which name no person or company.
 *
 * Each fixture is one take plus evidence hits shaped like the production
 * retriever's (`slug`, `title`, `chunk_text`, `effective_date`). A hit
 * marked `decisive` is the one the gold label rests on; `decisive` and
 * `about` never reach the judge (the harness strips them before
 * `formatEvidenceBlock`).
 */

export type Gold = 'correct' | 'incorrect' | 'partial' | 'unresolvable';
export type Split = 'dev' | 'counted';
export type SetName =
  | 'resolved_correct'
  | 'resolved_incorrect'
  | 'pre_horizon'
  | 'pre_claim'
  | 'no_evidence'
  | 'restatement'
  | 'distractor'
  | 'world_no_evidence'
  | 'partial'
  | 'world_counterfactual';

export interface Hit {
  slug: string;
  title: string;
  chunk_text: string;
  effective_date: string;
  decisive: boolean;
  about: string;
}

export interface FixtureTake {
  id: number;
  page_slug: string;
  claim: string;
  kind: 'bet' | 'take' | 'hunch';
  holder: string;
  weight: number;
  since_date: string;
}

export interface Fixture {
  id: string;
  split: Split;
  set: SetName;
  cls: string;
  /** In the preregistered decision rule (false only for the exploratory sets). */
  rule: boolean;
  gold: Gold;
  /** The resolution date the claim states, or null when it states none. */
  horizon: string | null;
  /** The real-world outcome, for `world_counterfactual` only. */
  world_truth: 'correct' | 'incorrect' | null;
  subject: string;
  take: FixtureTake;
  hits: Hit[];
}

/** Fixtures per split and set. `partial` and `world_counterfactual` are exploratory. */
export const SET_COUNTS: Record<Split, Record<SetName, number>> = {
  counted: {
    resolved_correct: 250,
    resolved_incorrect: 250,
    pre_horizon: 60,
    pre_claim: 40,
    no_evidence: 40,
    restatement: 40,
    distractor: 40,
    world_no_evidence: 30,
    partial: 20,
    world_counterfactual: 20,
  },
  dev: {
    resolved_correct: 30,
    resolved_incorrect: 30,
    pre_horizon: 12,
    pre_claim: 8,
    no_evidence: 8,
    restatement: 8,
    distractor: 8,
    world_no_evidence: 6,
    partial: 4,
    world_counterfactual: 4,
  },
};

export const EXPLORATORY_SETS: ReadonlySet<SetName> = new Set(['partial', 'world_counterfactual']);

const GOLD: Record<SetName, Gold> = {
  resolved_correct: 'correct',
  resolved_incorrect: 'incorrect',
  pre_horizon: 'unresolvable',
  pre_claim: 'unresolvable',
  no_evidence: 'unresolvable',
  restatement: 'unresolvable',
  distractor: 'unresolvable',
  world_no_evidence: 'unresolvable',
  partial: 'partial',
  /** Replaced per fixture by the opposite of the real outcome: the brain's evidence contradicts it. */
  world_counterfactual: 'incorrect',
};

const SEEDS: Record<Split, number> = { dev: 0x5eedd001, counted: 0x5eedc001 };

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00Z`);
export function addDays(s: string, n: number): string {
  const d = day(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
const endOfMonth = (y: number, m: number) => iso(new Date(Date.UTC(y, m + 1, 0)));
function addMonths(s: string, n: number): string {
  const d = day(s);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return iso(target);
}
export const daysBetween = (a: string, b: string) => Math.round((day(b).getTime() - day(a).getTime()) / 86_400_000);
const between = (rng: Rng, lo: string, hi: string) => addDays(lo, int(rng, 0, Math.max(0, daysBetween(lo, hi))));
const monthName = (s: string) => `${MONTHS[day(s).getUTCMonth()]} ${day(s).getUTCFullYear()}`;
const longDate = (s: string) => `${MONTHS[day(s).getUTCMonth()]} ${day(s).getUTCDate()}, ${day(s).getUTCFullYear()}`;

export const COMPANY_WORDS = [
  'acme', 'bluefin', 'cedarline', 'driftwood', 'emberly', 'foxglove', 'granite', 'harborview', 'ironleaf', 'juniper',
  'kestrel', 'lanternfish', 'marigold', 'northgate', 'oakhurst', 'pinecrest', 'quarrylane', 'redwing', 'saltmarsh', 'thistle',
  'umberly', 'vantage', 'willowbrook', 'yarrow', 'zephyrine', 'alderpoint', 'brightwater', 'copperfield', 'dunmore', 'elmstead',
  'fernhollow', 'goldcrest', 'hollowmere', 'indigo', 'jasperton', 'kingsreach', 'larchmont', 'meadowlark', 'nettlebed', 'orchardly',
];
const DISTRACTOR_SUFFIX = ['marine', 'health', 'capital', 'foods', 'logistics', 'studios', 'energy', 'robotics'];
export const PEOPLE = ['alice', 'bob', 'carol', 'dana', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'kara', 'liam', 'mona', 'nate', 'olga', 'pete'];
const CITIES = ['London', 'Berlin', 'Austin', 'Singapore', 'Toronto', 'Paris', 'Sydney', 'Lisbon', 'Dublin', 'Seoul'];
const PRODUCTS = ['its mobile app', 'a self-serve plan', 'a public API', 'an EU data region', 'its enterprise tier', 'a desktop client', 'an analytics add-on', 'a partner marketplace'];
const ROLES = ['COO', 'CTO', 'CFO', 'head of product'];

interface Company { slug: string; name: string }
const titleCase = (w: string) => w.split('-').map(p => p[0]!.toUpperCase() + p.slice(1)).join('-');
const company = (word: string): Company => ({ slug: `companies/${word}-example`, name: `${titleCase(word)}-example` });
const person = (word: string) => ({ slug: `people/${word}-example`, name: `${word}-example` });

interface Horizon { phrase: string; date: string; cls: string }

function horizonFor(rng: Rng, since: string): Horizon {
  const sy = day(since).getUTCFullYear();
  for (;;) {
    const kind = pick(rng, ['end_of_year', 'quarter', 'month', 'within_months', 'before_year'] as const);
    let h: Horizon;
    if (kind === 'end_of_year') {
      const y = sy + int(rng, 1, 2);
      h = { phrase: `by the end of ${y}`, date: `${y}-12-31`, cls: kind };
    } else if (kind === 'quarter') {
      const y = sy + int(rng, 1, 2);
      const q = int(rng, 1, 4);
      h = { phrase: `by Q${q} ${y}`, date: endOfMonth(y, q * 3 - 1), cls: kind };
    } else if (kind === 'month') {
      const y = sy + int(rng, 1, 2);
      const m = int(rng, 0, 11);
      h = { phrase: `by ${MONTHS[m]} ${y}`, date: endOfMonth(y, m), cls: kind };
    } else if (kind === 'within_months') {
      const n = pick(rng, [12, 18, 24]);
      h = { phrase: `within ${n} months`, date: addMonths(since, n), cls: kind };
    } else {
      const y = sy + int(rng, 2, 3);
      h = { phrase: `before ${y}`, date: `${y - 1}-12-31`, cls: kind };
    }
    if (daysBetween(since, h.date) >= 240) return h;
  }
}

/** What one proposition family can say about one company at one horizon. */
interface Story {
  family: string;
  claim: string;
  /** Achieved, stated on a date at or before the horizon. */
  early: (d: string) => string;
  /** Achieved by the horizon, stated after it. */
  lateHit: (d: string) => string;
  /** Not achieved by the horizon, stated after it. */
  miss: (d: string) => string;
  /** Progress before the horizon that settles nothing. */
  progress: (d: string) => string;
  /** Background from before the claim. */
  background: (d: string) => string;
  /** Short of the target by a margin (numeric families only). */
  shortfall: ((d: string) => string) | null;
  /** The same claim restated with no outcome. */
  restate: (holder: string, d: string) => string;
}

type Family = (rng: Rng, c: Company, h: Horizon) => Story;

function metricFamily(name: string, unit: (n: number) => string, noun: string, targets: number[]): Family {
  return (rng, c, h) => {
    const x = pick(rng, targets);
    const above = () => unit(Math.round(x * (1.08 + rng() * 0.5)));
    const below = () => unit(Math.max(1, Math.round(x * (0.3 + rng() * 0.3))));
    const near = () => unit(Math.round(x * (0.4 + rng() * 0.4)));
    const short = () => unit(Math.round(x * (0.78 + rng() * 0.12)));
    const target = unit(x);
    return {
      family: name,
      claim: `${c.name} will reach ${target} ${noun} ${h.phrase}`,
      early: d => `${c.name} passed ${above()} ${noun} in ${monthName(d)}, ahead of its plan.`,
      lateHit: d => `${c.name} finished the period ending ${longDate(h.date)} at ${above()} ${noun}, according to its update of ${longDate(d)}.`,
      miss: d => `As of ${longDate(d)}, ${c.name} was at ${below()} ${noun}; it never got close to ${target} by ${longDate(h.date)}.`,
      progress: d => `${c.name} reported ${near()} ${noun} in ${monthName(d)} and said it is ${pick(rng, ['on track for', 'behind plan on', 'unsure whether it will make'])} its ${target} goal.`,
      background: d => `${c.name} had ${unit(Math.max(1, Math.round(x * 0.15)))} ${noun} in ${monthName(d)} and was just starting to grow.`,
      shortfall: d => `${c.name} ended the period ending ${longDate(h.date)} at ${short()} ${noun}, short of the ${target} it was aiming for (update of ${longDate(d)}).`,
      restate: (holder, d) => `In a note dated ${longDate(d)}, ${holder} wrote: "I predicted ${c.name} would reach ${target} ${noun} ${h.phrase}. I still need to check how that turned out."`,
    };
  };
}

const usdM = (n: number) => `$${n}M`;
const plain = (n: number) => n.toLocaleString('en-US');

const FAMILIES: Family[] = [
  metricFamily('arr', usdM, 'in annual recurring revenue', [3, 5, 8, 10, 15, 20, 30, 50]),
  metricFamily('headcount', plain, 'employees', [40, 60, 100, 150, 200, 300, 500]),
  metricFamily('customers', plain, 'paying customers', [100, 250, 500, 1000, 2500, 5000]),
  (rng, c, h) => {
    const round = pick(rng, ['Series A', 'Series B', 'Series C']);
    const size = pick(rng, [12, 20, 35, 50, 80]);
    return {
      family: 'fundraise',
      claim: `${c.name} will raise a ${round} ${h.phrase}`,
      early: d => `${c.name} announced a $${size}M ${round} led by fund-a on ${longDate(d)}.`,
      lateHit: d => `Recap of ${longDate(d)}: ${c.name} closed its $${size}M ${round} before ${longDate(h.date)}.`,
      miss: d => `As of ${longDate(d)}, ${c.name} had not raised a ${round}; it is still running on earlier funding after the round fell through.`,
      progress: d => `${c.name} started early conversations with investors about a ${round} in ${monthName(d)}; no term sheet yet.`,
      background: d => `${c.name} closed a small earlier round in ${monthName(d)}.`,
      shortfall: null,
      restate: (holder, d) => `${holder}, ${longDate(d)}: "My call was that ${c.name} raises a ${round} ${h.phrase}. Haven't followed up."`,
    };
  },
  (rng, c, h) => {
    const product = pick(rng, PRODUCTS);
    return {
      family: 'launch',
      claim: `${c.name} will launch ${product} ${h.phrase}`,
      early: d => `${c.name} launched ${product} to all customers on ${longDate(d)}.`,
      lateHit: d => `Looking back on ${longDate(d)}: ${c.name} shipped ${product} well before ${longDate(h.date)}.`,
      miss: d => `As of ${longDate(d)}, ${c.name} still had not launched ${product}; the launch slipped again and has no new date.`,
      progress: d => `${c.name} showed a beta of ${product} to a few design partners in ${monthName(d)}.`,
      background: d => `In ${monthName(d)}, ${c.name} first mentioned it might build ${product} someday.`,
      shortfall: null,
      restate: (holder, d) => `${holder} (${longDate(d)}): "I still think ${c.name} launches ${product} ${h.phrase}, as I said at the time."`,
    };
  },
  (rng, c, h) => {
    const city = pick(rng, CITIES);
    return {
      family: 'office',
      claim: `${c.name} will open an office in ${city} ${h.phrase}`,
      early: d => `${c.name} opened its ${city} office on ${longDate(d)}.`,
      lateHit: d => `${c.name}'s ${city} office, open since before ${longDate(h.date)}, now has a dozen staff (${longDate(d)}).`,
      miss: d => `As of ${longDate(d)}, ${c.name} has no ${city} office and has dropped the plan.`,
      progress: d => `${c.name} was looking at office space in ${city} in ${monthName(d)}.`,
      background: d => `In ${monthName(d)}, ${c.name} had all of its staff in one office.`,
      shortfall: null,
      restate: (holder, d) => `${holder} noted on ${longDate(d)} that they had expected ${c.name} to open in ${city} ${h.phrase}; no update recorded.`,
    };
  },
  (rng, c, h) => {
    const p = person(pick(rng, PEOPLE));
    const role = pick(rng, ROLES);
    return {
      family: 'ceo',
      claim: `${p.name} will become CEO of ${c.name} ${h.phrase}`,
      early: d => `${c.name} named ${p.name} chief executive on ${longDate(d)}.`,
      lateHit: d => `${p.name}, who became CEO of ${c.name} before ${longDate(h.date)}, spoke at its event on ${longDate(d)}.`,
      miss: d => `As of ${longDate(d)}, ${p.name} is still ${role} of ${c.name}; the CEO did not change.`,
      progress: d => `${c.name} promoted ${p.name} to ${role} in ${monthName(d)}.`,
      background: d => `${p.name} joined ${c.name} in ${monthName(d)}.`,
      shortfall: null,
      restate: (holder, d) => `${holder}, ${longDate(d)}: "I bet ${p.name} would run ${c.name} ${h.phrase}."`,
    };
  },
  (rng, c, h) => {
    const loss = pick(rng, [2, 4, 7, 12, 18]);
    return {
      family: 'profitability',
      claim: `${c.name} will be profitable ${h.phrase}`,
      early: d => `${c.name} reported its first profitable quarter in ${monthName(d)}.`,
      lateHit: d => `${c.name} has been profitable since before ${longDate(h.date)}, its finance lead said on ${longDate(d)}.`,
      miss: d => `${c.name} lost $${loss}M over the year to ${longDate(h.date)} and was still unprofitable as of ${longDate(d)}.`,
      progress: d => `${c.name} cut its burn by a third in ${monthName(d)} but is still losing money.`,
      background: d => `${c.name} was burning cash quickly in ${monthName(d)}.`,
      shortfall: null,
      restate: (holder, d) => `${holder} repeated on ${longDate(d)}: "${c.name} gets to profitability ${h.phrase}."`,
    };
  },
  (rng, c, h) => {
    let word = pick(rng, COMPANY_WORDS);
    while (company(word).slug === c.slug) word = pick(rng, COMPANY_WORDS);
    const buyer = company(word);
    return {
      family: 'acquisition',
      claim: `${c.name} will be acquired ${h.phrase}`,
      early: d => `${buyer.name} completed its acquisition of ${c.name} on ${longDate(d)}.`,
      lateHit: d => `${c.name} has been part of ${buyer.name} since its acquisition before ${longDate(h.date)} (${longDate(d)}).`,
      miss: d => `As of ${longDate(d)}, ${c.name} remains independent; sale talks ended without a deal.`,
      progress: d => `${c.name} hired advisers to explore a sale in ${monthName(d)}.`,
      background: d => `${c.name} raised money from fund-a in ${monthName(d)}.`,
      shortfall: null,
      restate: (holder, d) => `${holder} wrote on ${longDate(d)}: "Still expect someone buys ${c.name} ${h.phrase}."`,
    };
  },
];

/** Public propositions with no person or company in them. */
const WORLD_OPEN: Array<(rng: Rng) => { claim: string; since: string }> = [
  rng => { const y = int(rng, 2023, 2025); return { claim: `Bitcoin will trade above $${pick(rng, [40, 60, 80, 120])},000 at the end of ${y}`, since: `${y - 1}-0${int(rng, 1, 9)}-15` }; },
  rng => { const y = int(rng, 2023, 2025); return { claim: `The US unemployment rate will be below ${pick(rng, ['3.5', '4.0', '4.5'])}% in December ${y}`, since: `${y - 1}-0${int(rng, 1, 9)}-10` }; },
  rng => { const y = int(rng, 2023, 2025); return { claim: `Gold will be above $${pick(rng, ['1,900', '2,200', '2,500', '3,000'])} an ounce at the end of ${y}`, since: `${y - 1}-0${int(rng, 1, 9)}-20` }; },
  rng => { const y = int(rng, 2023, 2025); return { claim: `The euro will trade below parity with the US dollar at the end of ${y}`, since: `${y - 1}-0${int(rng, 1, 9)}-05` }; },
  rng => { const y = int(rng, 2024, 2026); return { claim: `A crewed mission will land on the Moon before ${y}`, since: `${y - 3}-0${int(rng, 1, 9)}-12` }; },
  rng => { const y = int(rng, 2023, 2025); return { claim: `US consumer price inflation will be below ${pick(rng, ['2.5', '3', '4'])}% year over year in December ${y}`, since: `${y - 1}-0${int(rng, 1, 9)}-18` }; },
  rng => { const y = int(rng, 2023, 2024); return { claim: `${y} will be the warmest year on record globally`, since: `${y - 1}-0${int(rng, 1, 9)}-08` }; },
];

/** Public outcomes the counterfactual set contradicts, with the real result. */
const WORLD_KNOWN: Array<{ claim: string; since: string; truth: 'correct' | 'incorrect'; counter: string; date: string }> = [
  { claim: 'Bitcoin will trade above $60,000 at the end of 2024', since: '2023-04-12', truth: 'correct', counter: 'Bitcoin closed 2024 at about $38,000.', date: '2025-01-03' },
  { claim: 'Bitcoin will trade above $60,000 at the end of 2023', since: '2022-06-20', truth: 'incorrect', counter: 'Bitcoin finished 2023 near $71,000.', date: '2024-01-02' },
  { claim: 'Gold will be above $2,000 an ounce at the end of 2024', since: '2023-02-14', truth: 'correct', counter: 'Gold ended 2024 at roughly $1,750 an ounce.', date: '2025-01-06' },
  { claim: 'The US unemployment rate will be below 3.5% in December 2024', since: '2023-05-09', truth: 'incorrect', counter: 'The December 2024 jobs report put US unemployment at 3.2%.', date: '2025-01-10' },
  { claim: 'The 2024 Summer Olympics will be held in Paris as planned', since: '2022-09-01', truth: 'correct', counter: 'The 2024 Summer Olympics were moved out of Paris at the last minute.', date: '2024-08-15' },
  { claim: 'The euro will trade below parity with the US dollar at the end of 2024', since: '2023-07-03', truth: 'incorrect', counter: 'The euro closed 2024 at about 0.91 US dollars.', date: '2025-01-02' },
  { claim: 'A crewed mission will orbit the Moon before 2025', since: '2022-11-16', truth: 'incorrect', counter: 'A crewed lunar flyby was completed in November 2024.', date: '2024-12-01' },
  { claim: 'US consumer price inflation will be below 4% year over year in December 2024', since: '2023-03-14', truth: 'correct', counter: 'US consumer prices rose 5.6% in the year to December 2024.', date: '2025-01-15' },
  { claim: '2023 will be the warmest year on record globally', since: '2023-01-20', truth: 'correct', counter: 'Climate agencies ranked 2023 only the eighth-warmest year on record.', date: '2024-01-12' },
  { claim: 'Bitcoin will trade above $100,000 at the end of 2023', since: '2022-03-02', truth: 'incorrect', counter: 'Bitcoin ended 2023 above $110,000.', date: '2024-01-03' },
];

const SLUG_KINDS = [['meetings', 'sync'], ['notes', 'note'], ['updates', 'investor update'], ['research', 'memo']] as const;

function hit(rng: Rng, d: string, about: Company, text: string, decisive: boolean): Hit {
  const word = about.slug.slice('companies/'.length, -'-example'.length);
  const [dir, label] = pick(rng, SLUG_KINDS);
  return { slug: `${dir}/${d}-${word}-${label.replace(' ', '-')}-example`, title: `${about.name} ${label} ${d}`, chunk_text: text, effective_date: d, decisive, about: about.slug };
}

function noiseHits(rng: Rng, avoid: string, since: string, horizon: string): Hit[] {
  const out: Hit[] = [];
  for (let i = int(rng, 0, 2); i > 0; i--) {
    let word = pick(rng, COMPANY_WORDS);
    while (company(word).slug === avoid) word = pick(rng, COMPANY_WORDS);
    const other = company(word);
    const d = between(rng, addDays(since, -200), addDays(horizon, 200));
    out.push(hit(rng, d, other, pick(rng, [
      `${other.name} moved its weekly planning meeting to Tuesdays.`,
      `${other.name} hired two engineers in ${monthName(d)}.`,
      `${other.name} renewed its office lease for another year.`,
      `Notes from a dinner with the ${other.name} team; mostly small talk about hiring.`,
    ]), false));
  }
  return out;
}

/** Counterfactual bases per split, so no claim appears in both. */
const WORLD_KNOWN_BY_SPLIT: Record<Split, typeof WORLD_KNOWN> = { counted: WORLD_KNOWN.slice(0, 6), dev: WORLD_KNOWN.slice(6) };

/**
 * Builds one split. `taken` holds claims another split already used; the
 * counted split is built first with nothing taken, so its fixtures never
 * depend on the dev split.
 */
export function buildFixtures(split: Split, taken: ReadonlySet<string> = new Set()): Fixture[] {
  const rng = mulberry32(SEEDS[split]);
  const fixtures: Fixture[] = [];
  const claims = new Set<string>(taken);
  const knownClaims = new Set(WORLD_KNOWN.map(k => k.claim));
  let takeId = split === 'dev' ? 900_000 : 100_000;

  for (const [set, count] of Object.entries(SET_COUNTS[split]) as Array<[SetName, number]>) {
    let made = 0;
    let attempts = 0;
    while (made < count) {
      if (++attempts > count * 200) throw new Error(`could not build ${count} unique ${set} fixtures for ${split}`);
      const holder = person(pick(rng, PEOPLE));
      const kind = pick(rng, ['bet', 'bet', 'bet', 'bet', 'bet', 'bet', 'bet', 'take', 'take', 'hunch'] as const);
      const weight = Math.round((0.5 + rng() * 0.4) * 100) / 100;
      const id = `${split}-${set}-${String(made + 1).padStart(3, '0')}`;

      if (set === 'world_no_evidence' || set === 'world_counterfactual') {
        let claim: string;
        let since: string;
        let truth: 'correct' | 'incorrect' | null = null;
        let hits: Hit[] = [];
        if (set === 'world_no_evidence') {
          ({ claim, since } = pick(rng, WORLD_OPEN)(rng));
        } else {
          const bases = WORLD_KNOWN_BY_SPLIT[split];
          const known = bases[made % bases.length]!;
          claim = made < bases.length ? known.claim : `${known.claim}, as ${holder.name} put it`;
          since = known.since;
          truth = known.truth;
          hits = [{ slug: `notes/${known.date}-markets-note-example`, title: `markets note ${known.date}`, chunk_text: known.counter, effective_date: known.date, decisive: true, about: 'world' }];
        }
        if (claims.has(claim) || (set === 'world_no_evidence' && knownClaims.has(claim))) continue;
        claims.add(claim);
        fixtures.push({
          id, split, set, cls: set, rule: !EXPLORATORY_SETS.has(set), gold: truth ? (truth === 'correct' ? 'incorrect' : 'correct') : GOLD[set], horizon: null, world_truth: truth, subject: 'world',
          take: { id: ++takeId, page_slug: holder.slug, claim, kind, holder: holder.name, weight, since_date: since },
          hits,
        });
        made++;
        continue;
      }

      const c = company(pick(rng, COMPANY_WORDS));
      const since = between(rng, '2022-01-10', '2023-12-31');
      const h = horizonFor(rng, since);
      const familyIndex = Math.floor(rng() * FAMILIES.length);
      const familySeed = Math.floor(rng() * 4294967296);
      const story = FAMILIES[familyIndex]!(mulberry32(familySeed), c, h);
      if (set === 'partial' && !story.shortfall) continue;
      if (claims.has(story.claim)) continue;

      const after = () => between(rng, addDays(h.date, 5), addDays(h.date, 150));
      const before = () => between(rng, addDays(since, 30), addDays(h.date, -30));
      const hits: Hit[] = [];
      let cls = story.family;

      if (set === 'resolved_correct') {
        // Progress, when present, comes before the achievement it leads to.
        let progressBy = addDays(h.date, -30);
        if (rng() < 0.4) {
          const d = between(rng, addDays(since, 45), addDays(h.date, -5));
          hits.push(hit(rng, d, c, story.early(d), true));
          progressBy = addDays(d, -10);
          cls += ':early';
        } else {
          const d = after();
          hits.push(hit(rng, d, c, story.lateHit(d), true));
          cls += ':after';
        }
        if (rng() < 0.5 && daysBetween(addDays(since, 30), progressBy) > 0) { const d = between(rng, addDays(since, 30), progressBy); hits.push(hit(rng, d, c, story.progress(d), false)); }
      } else if (set === 'resolved_incorrect') {
        const d = after();
        hits.push(hit(rng, d, c, story.miss(d), true));
        if (rng() < 0.5) { const p = before(); hits.push(hit(rng, p, c, story.progress(p), false)); }
      } else if (set === 'pre_horizon') {
        for (let i = int(rng, 1, 2); i > 0; i--) { const d = before(); hits.push(hit(rng, d, c, story.progress(d), true)); }
      } else if (set === 'pre_claim') {
        for (let i = int(rng, 1, 2); i > 0; i--) { const d = between(rng, addDays(since, -400), addDays(since, -10)); hits.push(hit(rng, d, c, story.background(d), true)); }
      } else if (set === 'restatement') {
        const d = after();
        hits.push(hit(rng, d, c, story.restate(holder.name, d), true));
      } else if (set === 'distractor') {
        const word = `${c.slug.slice('companies/'.length, -'-example'.length)}-${pick(rng, DISTRACTOR_SUFFIX)}`;
        const other = company(word);
        const otherStory = FAMILIES[familyIndex]!(mulberry32(familySeed), other, h);
        const d = after();
        hits.push(hit(rng, d, other, rng() < 0.5 ? otherStory.lateHit(d) : otherStory.miss(d), true));
        cls += ':near_name';
      } else if (set === 'partial') {
        const d = after();
        hits.push(hit(rng, d, c, story.shortfall!(d), true));
      }
      if (set !== 'no_evidence') hits.push(...noiseHits(rng, c.slug, since, h.date));
      hits.sort((a, b) => a.effective_date.localeCompare(b.effective_date));

      claims.add(story.claim);
      fixtures.push({
        id, split, set, cls: `${h.cls}:${cls}`, rule: !EXPLORATORY_SETS.has(set), gold: GOLD[set], horizon: h.date, world_truth: null, subject: c.slug,
        take: { id: ++takeId, page_slug: rng() < 0.5 ? holder.slug : c.slug, claim: story.claim, kind, holder: holder.name, weight, since_date: since },
        hits,
      });
      made++;
    }
  }
  return fixtures;
}
