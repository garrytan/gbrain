/**
 * System One S9 (`conflict`) labelled fact-pair generator.
 *
 * Writes docs/eval/system-one/datasets/s9-conflict/pairs.jsonl in the
 * `facts-fixtures` format (`gbrain decide dataset --slot conflict --from
 * facts-fixtures <path>`), one pair per line:
 *   {id, family, entity_slug, fact, candidate, kind, candidate_kind, label,
 *    slice, case, attribute, label_source, source_ref?}
 *
 * Two parts:
 *   1. upstream pairs: every labelled or verdict-bearing fact pair in the
 *      repository's tests (test/decide/conflict.test.ts,
 *      test/eval-contradictions-judge.test.ts,
 *      test/eval-contradictions-auto-supersession.test.ts), label_source
 *      `upstream-gold` with the source named in `source_ref`;
 *   2. synthetic pairs from deterministic templates (Mulberry32, fixed seed),
 *      label_source `synthetic-construction`: the label is fixed by the
 *      template that built the pair. One family = one new fact and its
 *      same-entity candidates (the production request shape: the new fact is
 *      the state, one choice question per candidate).
 *        duplicate    the candidate restates the new fact's value
 *        supersede    the new fact updates the candidate's value with explicit
 *                     newer framing (now, as of, moved, promoted, no longer)
 *        independent  same entity, a different or compatible attribute
 *      Hard cases are tagged in `case`: value-update-near (same wording, new
 *      value plus a dated framing), negation-update, restates-updated-value,
 *      paraphrase-low-overlap, near-independent (same sentence shape, a
 *      different attribute or referent) and compatible-same-entity.
 *
 * `slice` is the label on purpose: the facts-fixtures builder keeps only a
 * duplicate boolean as the dataset label, and the choice label survives in
 * `slice`. Probe-derived families (from the suspected-contradictions probe
 * queries in test/fixtures/contradictions-mini.jsonl) carry `probe` in `case`.
 *
 * `baseline_cosine` / `baseline_decision` are added afterwards by
 * conflict-baseline.ts (paid embeddings, cached).
 *
 * Run: bun docs/eval/system-one/generators/conflict-pairs.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SEED = 90909;
const OUT = join(import.meta.dir, '..', 'datasets', 's9-conflict');

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const int = (n: number) => Math.floor(rand() * n);
const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
const pickTwo = <T>(xs: readonly T[]): [T, T] => {
  const a = int(xs.length);
  let b = int(xs.length - 1);
  if (b >= a) b++;
  return [xs[a]!, xs[b]!];
};
const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

type Label = 'duplicate' | 'supersede' | 'independent';
type Kind = 'fact' | 'preference' | 'event' | 'commitment' | 'belief';

interface Pair {
  id: string;
  family: string;
  entity_slug: string;
  fact: string;
  candidate: string;
  kind: Kind;
  candidate_kind: Kind;
  label: Label;
  slice: Label;
  case: string;
  attribute: string;
  label_source: 'upstream-gold' | 'synthetic-construction';
  source_ref?: string;
}

// ---------------------------------------------------------------------------
// 1. Upstream pairs (repository tests)
// ---------------------------------------------------------------------------

const upstream: Pair[] = [
  { id: 'up-conflict-test-a1', family: 'up-alice-cto', entity_slug: 'people/alice-example', fact: 'Alice is CTO of Acme', candidate: 'Alice is VP Eng at Acme', label: 'supersede', case: 'role-update', attribute: 'role', source_ref: 'test/decide/conflict.test.ts (facts-fixtures builder case a1, labelled supersede)' },
  { id: 'up-conflict-test-a2', family: 'up-alice-cto', entity_slug: 'people/alice-example', fact: 'Alice is CTO of Acme', candidate: 'Alice is the CTO at Acme', label: 'duplicate', case: 'restatement', attribute: 'role', source_ref: 'test/decide/conflict.test.ts (facts-fixtures builder case a2, labelled duplicate)' },
  { id: 'up-conflict-test-b1', family: 'up-bob-tea', entity_slug: 'people/bob-example', fact: 'Bob likes tea', candidate: 'Bob lives in Paris', label: 'independent', case: 'other-attribute', attribute: 'preference', source_ref: 'test/decide/conflict.test.ts (facts-fixtures builder case b1, labelled independent)' },
  { id: 'up-conflict-test-proposal', family: 'up-alice-leads', entity_slug: 'people/alice-example', fact: 'Alice leads design', candidate: 'Alice leads research', label: 'supersede', case: 'role-update', attribute: 'role', source_ref: 'test/decide/conflict.test.ts (proposal accept/undo fixture: the new fact supersedes the old one)' },
  { id: 'up-judge-acme-mrr', family: 'up-acme-mrr', entity_slug: 'companies/acme-example', fact: 'Acme MRR is $2M (compiled).', candidate: 'Acme MRR was $50K back in 2024.', label: 'supersede', case: 'value-update', attribute: 'mrr', source_ref: 'test/eval-contradictions-judge.test.ts (judge fixture verdict contradiction on the MRR figure; the dated older value is superseded)' },
  { id: 'up-autosupersede-take', family: 'up-alice-take', entity_slug: 'people/alice-example', fact: "newer take: it's the CEO's call", candidate: "old take: it's the CFO's call", label: 'supersede', case: 'belief-update', attribute: 'take', source_ref: 'test/eval-contradictions-auto-supersession.test.ts (temporal_supersede: the older take is superseded by the newer one)' },
].map((p) => ({ ...p, kind: (p.attribute === 'take' ? 'belief' : p.attribute === 'preference' ? 'preference' : 'fact') as Kind, candidate_kind: (p.attribute === 'take' ? 'belief' : 'fact') as Kind, slice: p.label as Label, label: p.label as Label, label_source: 'upstream-gold' as const }));

// ---------------------------------------------------------------------------
// 2. Synthetic templates
// ---------------------------------------------------------------------------

const FIRST = ['Tamsin', 'Oriel', 'Idris', 'Noemi', 'Calder', 'Linnea', 'Bram', 'Soraya', 'Teodor', 'Marisol', 'Anselm', 'Yusra', 'Corin', 'Delphine', 'Rasmus', 'Ilse', 'Tobias', 'Zainab', 'Fintan', 'Maren', 'Hollis', 'Ottilie', 'Leonie', 'Eamon', 'Saskia', 'Joaquin', 'Junie', 'Kasimir', 'Verity', 'Oskar'];
const SUR_HEAD = ['Quell', 'Fen', 'Marr', 'Tess', 'Orrin', 'Vash', 'Pell', 'Kest', 'Brin', 'Wyr', 'Corv', 'Yarr', 'Gris', 'Cald', 'Ostre', 'Drem'];
const SUR_TAIL = ['brook', 'waite', 'wick', 'dale', 'ford', 'combe', 'grove', 'mere', 'holt', 'stead'];
const CO_HEAD = ['Bracken', 'Lumen', 'Quartz', 'Tidal', 'Ember', 'Cobalt', 'Vesper', 'Juniper', 'Marble', 'Saffron', 'Halcyon', 'Nimbus', 'Orchid', 'Pylon', 'Russet', 'Solace'];
const CO_TAIL = ['moor', 'fold', 'vane', 'reach', 'loft', 'spire', 'wharf', 'gate'];
const CITIES = ['Lisbon', 'Denver', 'Toronto', 'Austin', 'Berlin', 'Seattle', 'Dublin', 'Melbourne', 'Oslo', 'Chicago'];
const ROLES = ['VP Engineering', 'CTO', 'Head of Product', 'COO', 'Head of Sales', 'Chief of Staff', 'Director of Design', 'CFO'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September'];
const DRINKS = ['black coffee', 'green tea', 'oat milk lattes', 'sparkling water', 'espresso'];
const CHANNELS = ['email', 'Slack', 'text messages', 'phone calls', 'a shared doc'];
const CADENCES = ['weekly', 'every two weeks', 'monthly', 'every Monday morning'];
const DBS = ['Postgres', 'MySQL', 'DynamoDB', 'SQLite', 'MongoDB'];
const STAGES = ['pre-seed', 'seed', 'Series A', 'Series B'];
const PLANS = ['per-seat pricing', 'usage-based pricing', 'flat annual licenses', 'a freemium tier with paid add-ons'];

interface Entity { kind: 'person' | 'company'; name: string; first: string; slug: string; company: string }

function person(): Entity {
  const first = pick(FIRST), last = pick(SUR_HEAD) + pick(SUR_TAIL), company = pick(CO_HEAD) + pick(CO_TAIL);
  return { kind: 'person', name: `${first} ${last}`, first, slug: `people/${kebab(`${first} ${last}`)}`, company };
}
function company(): Entity {
  const name = pick(CO_HEAD) + pick(CO_TAIL);
  return { kind: 'company', name, first: name, slug: `companies/${kebab(name)}`, company: name };
}

/**
 * One attribute: `state(e, v, i)` renders the i-th paraphrase of "e has value
 * v" (0 = plain, higher = lower lexical overlap); `update(e, old, v)` renders
 * the new value with explicit newer framing; `compatible(e)` is a same-entity
 * statement on a neighbouring attribute that does not conflict.
 */
interface Attribute {
  name: string;
  entity: 'person' | 'company';
  kind: Kind;
  values: readonly string[];
  state: Array<(e: Entity, v: string) => string>;
  update: Array<(e: Entity, oldV: string, v: string) => string>;
  compatible: Array<(e: Entity) => string>;
  negation?: { fact: (e: Entity, v: string) => string };
  /** Values are in growth order: an update always moves to a later value. */
  ordered?: true;
}

const month = () => pick(MONTHS);
const num = (lo: number, hi: number) => String(lo + int(hi - lo + 1));

const ATTRIBUTES: Attribute[] = [
  {
    name: 'role', entity: 'person', kind: 'fact', values: ROLES,
    state: [
      (e, v) => `${e.name} is ${v} at ${e.company}.`,
      (e, v) => `${e.first} works as ${v} at ${e.company}.`,
      (e, v) => `At ${e.company}, the ${v} role is held by ${e.name}.`,
      (e, v) => `${e.company}'s ${v} is ${e.first}.`,
    ],
    update: [
      (e, _o, v) => `${e.name} was promoted to ${v} at ${e.company} in ${month()} 2026.`,
      (e, _o, v) => `As of ${month()} 2026, ${e.name} is now ${v} at ${e.company}.`,
      (e, o, v) => `${e.first} moved from ${o} to ${v} at ${e.company} this year.`,
    ],
    compatible: [
      (e) => `${e.name} joined ${e.company} after a stint at a design agency.`,
      (e) => `${e.first} mentors two junior engineers at ${e.company}.`,
      (e) => `${e.name} studied mechanical engineering before ${e.company}.`,
    ],
    negation: { fact: (e, v) => `${e.name} is no longer ${v} at ${e.company}; the role is being backfilled.` },
  },
  {
    name: 'city', entity: 'person', kind: 'fact', values: CITIES,
    state: [
      (e, v) => `${e.name} lives in ${v}.`,
      (e, v) => `${e.first} is based in ${v}.`,
      (e, v) => `${e.first}'s home is in ${v}.`,
      (e, v) => `${v} is where ${e.name} lives these days.`,
    ],
    update: [
      (e, _o, v) => `${e.name} moved to ${v} in ${month()} 2026.`,
      (e, o, v) => `${e.first} relocated from ${o} to ${v} earlier this year.`,
      (e, _o, v) => `As of ${month()} 2026, ${e.name} lives in ${v}.`,
    ],
    compatible: [
      (e) => `${e.name} grew up near the coast and visits family every summer.`,
      (e) => `${e.first} travels to the ${e.company} office about once a month.`,
      (e) => `${e.name} is learning Portuguese in the evenings.`,
    ],
  },
  {
    name: 'employer', entity: 'person', kind: 'fact', values: ['Brackenmoor', 'Lumenfold', 'Quartzreach', 'Tidalgate', 'Emberwharf', 'Cobaltspire'],
    state: [
      (e, v) => `${e.name} works at ${v}.`,
      (e, v) => `${e.first} is employed by ${v}.`,
      (e, v) => `${e.name}'s employer is ${v}.`,
      (e, v) => `${v} is the company ${e.first} works for.`,
    ],
    update: [
      (e, o, v) => `${e.name} left ${o} and joined ${v} in ${month()} 2026.`,
      (e, _o, v) => `${e.first} now works at ${v} after changing jobs this spring.`,
      (e, _o, v) => `Since ${month()} 2026, ${e.name} has been working at ${v}.`,
    ],
    compatible: [
      (e) => `${e.name} has worked in fintech for most of their career.`,
      (e) => `${e.first} sits on the advisory board of a local coding school.`,
    ],
    negation: { fact: (e, v) => `${e.name} no longer works at ${v}.` },
  },
  {
    name: 'drink', entity: 'person', kind: 'preference', values: DRINKS,
    state: [
      (e, v) => `${e.name} prefers ${v}.`,
      (e, v) => `${e.first}'s usual order is ${v}.`,
      (e, v) => `${e.first} likes ${v} in meetings.`,
      (e, v) => `When offered a drink, ${e.name} asks for ${v}.`,
    ],
    update: [
      (e, o, v) => `${e.name} switched from ${o} to ${v} this year.`,
      (e, _o, v) => `${e.first} now prefers ${v}; the old order changed in ${month()} 2026.`,
      (e, o, v) => `${e.name} gave up ${o} and drinks ${v} now.`,
    ],
    compatible: [
      (e) => `${e.name} is vegetarian.`,
      (e) => `${e.first} prefers morning meetings over late afternoons.`,
      (e) => `${e.name} does not drink alcohol at work events.`,
    ],
  },
  {
    name: 'channel', entity: 'person', kind: 'preference', values: CHANNELS,
    state: [
      (e, v) => `${e.name} prefers to be contacted by ${v}.`,
      (e, v) => `The best way to reach ${e.first} is ${v}.`,
      (e, v) => `${e.first} answers ${v} fastest.`,
      (e, v) => `For anything time-sensitive, use ${v} with ${e.name}.`,
    ],
    update: [
      (e, o, v) => `${e.name} now prefers ${v} instead of ${o}.`,
      (e, _o, v) => `As of ${month()} 2026, ${e.first} wants to be reached by ${v}.`,
      (e, o, v) => `${e.first} stopped checking ${o}; use ${v} from now on.`,
    ],
    compatible: [
      (e) => `${e.name} does not take calls before 9am.`,
      (e) => `${e.first} is usually offline on Fridays.`,
    ],
  },
  {
    name: 'cadence', entity: 'person', kind: 'commitment', values: CADENCES,
    state: [
      (e, v) => `The user meets ${e.name} ${v} for a one-on-one.`,
      (e, v) => `One-on-ones with ${e.first} happen ${v}.`,
      (e, v) => `${e.first} and the user sync ${v}.`,
    ],
    update: [
      (e, o, v) => `The one-on-one with ${e.name} moved from ${o} to ${v} in ${month()} 2026.`,
      (e, _o, v) => `Starting ${month()} 2026, the user meets ${e.first} ${v}.`,
      (e, _o, v) => `${e.first} and the user agreed to sync ${v} from now on.`,
    ],
    compatible: [
      (e) => `One-on-ones with ${e.name} usually run thirty minutes.`,
      (e) => `${e.first} sends an agenda the day before each one-on-one.`,
    ],
  },
  {
    name: 'headcount', entity: 'company', kind: 'fact', ordered: true, values: ['12', '18', '25', '34', '40', '55', '70'],
    state: [
      (e, v) => `${e.name} has ${v} employees.`,
      (e, v) => `${e.name}'s headcount is ${v}.`,
      (e, v) => `There are ${v} people on the ${e.name} team.`,
      (e, v) => `${e.name} employs ${v} people.`,
    ],
    update: [
      (e, _o, v) => `${e.name} grew to ${v} employees as of ${month()} 2026.`,
      (e, o, v) => `${e.name}'s headcount changed from ${o} to ${v} after the latest hiring round.`,
      (e, _o, v) => `As of ${month()} 2026, ${e.name} has ${v} employees.`,
    ],
    compatible: [
      (e) => `${e.name}'s engineering team is ${num(4, 9)} people.`,
      (e) => `${e.name} plans to open a second office next year.`,
      (e) => `${e.name} hires mostly remote engineers.`,
    ],
  },
  {
    name: 'customers', entity: 'company', kind: 'fact', ordered: true, values: ['8', '15', '22', '31', '47', '60'],
    state: [
      (e, v) => `${e.name} has ${v} paying customers.`,
      (e, v) => `${e.name} serves ${v} paying customers.`,
      (e, v) => `${e.name}'s customer count is ${v}.`,
    ],
    update: [
      (e, _o, v) => `${e.name} now has ${v} paying customers as of ${month()} 2026.`,
      (e, o, v) => `${e.name} went from ${o} to ${v} paying customers this quarter.`,
    ],
    compatible: [
      (e) => `${e.name}'s largest customer is a regional logistics firm.`,
      (e) => `Most of ${e.name}'s customers are mid-size retailers.`,
      (e) => `${e.name} targets ${num(80, 120)} paying customers by year end.`,
    ],
  },
  {
    name: 'stage', entity: 'company', kind: 'fact', ordered: true, values: STAGES,
    state: [
      (e, v) => `${e.name} is a ${v} company.`,
      (e, v) => `${e.name} is at the ${v} stage.`,
      (e, v) => `${e.name}'s most recent round was its ${v}.`,
    ],
    update: [
      (e, _o, v) => `${e.name} closed its ${v} round in ${month()} 2026.`,
      (e, o, v) => `${e.name} moved past ${o} and is now a ${v} company.`,
      (e, _o, v) => `As of ${month()} 2026, ${e.name} has raised its ${v}.`,
    ],
    compatible: [
      (e) => `${e.name} is looking for a lead investor with marketplace experience.`,
      (e) => `${e.name}'s board has three members.`,
    ],
  },
  {
    name: 'pricing', entity: 'company', kind: 'fact', values: PLANS,
    state: [
      (e, v) => `${e.name} uses ${v}.`,
      (e, v) => `${e.name} charges customers with ${v}.`,
      (e, v) => `${e.name}'s pricing model is ${v}.`,
    ],
    update: [
      (e, o, v) => `${e.name} switched from ${o} to ${v} in ${month()} 2026.`,
      (e, _o, v) => `${e.name} now uses ${v} after the pricing review.`,
    ],
    compatible: [
      (e) => `${e.name} offers a discount for annual prepayment.`,
      (e) => `${e.name} reviews its pricing every six months.`,
    ],
  },
  {
    name: 'database', entity: 'company', kind: 'fact', values: DBS,
    state: [
      (e, v) => `${e.name} runs its backend on ${v}.`,
      (e, v) => `${e.name}'s primary database is ${v}.`,
      (e, v) => `${v} is the main datastore at ${e.name}.`,
    ],
    update: [
      (e, o, v) => `${e.name} migrated from ${o} to ${v} in ${month()} 2026.`,
      (e, _o, v) => `${e.name} now runs on ${v} after the migration finished.`,
    ],
    compatible: [
      (e) => `${e.name} deploys to production several times a day.`,
      (e) => `${e.name} keeps analytics data in a separate warehouse.`,
    ],
  },
  {
    name: 'hq', entity: 'company', kind: 'fact', values: CITIES,
    state: [
      (e, v) => `${e.name} is headquartered in ${v}.`,
      (e, v) => `${e.name}'s head office is in ${v}.`,
      (e, v) => `${e.name} is based in ${v}.`,
    ],
    update: [
      (e, o, v) => `${e.name} moved its headquarters from ${o} to ${v} in ${month()} 2026.`,
      (e, _o, v) => `${e.name} is now headquartered in ${v} after the relocation.`,
    ],
    compatible: [
      (e) => `${e.name} has a small sales team in a second city.`,
      (e) => `${e.name}'s office has room for about ${num(30, 60)} people.`,
    ],
  },
];

/** Probe-derived families (test/fixtures/contradictions-mini.jsonl query topics), placeholder entities. */
const PROBE_FAMILIES: Array<{ family: string; slug: string; fact: string; kind: Kind; cands: Array<[string, Label, string]> }> = [
  { family: 'probe-acme-mrr', slug: 'companies/acme-example', fact: 'As of June 2026, acme-example MRR is 120 thousand dollars.', kind: 'fact', cands: [
    ['acme-example MRR is 80 thousand dollars.', 'supersede', 'value-update'],
    ['acme-example monthly recurring revenue stands at 120 thousand dollars.', 'duplicate', 'restatement'],
    ['acme-example sells mostly to mid-size retailers.', 'independent', 'other-attribute'],
  ] },
  { family: 'probe-alice-role', slug: 'people/alice-example', fact: 'alice-example was promoted to COO at acme-example in April 2026.', kind: 'fact', cands: [
    ['alice-example is VP Operations at acme-example.', 'supersede', 'role-update'],
    ['alice-example reports to the acme-example CEO.', 'independent', 'compatible-same-attribute'],
  ] },
  { family: 'probe-widget-series-a', slug: 'companies/widget-co-example', fact: 'widget-co-example closed its Series A in March 2026.', kind: 'event', cands: [
    ['widget-co-example is a seed-stage company.', 'supersede', 'stage-update'],
    ['widget-co-example raised a Series A round.', 'duplicate', 'restatement'],
    ['widget-co-example is hiring a head of sales.', 'independent', 'other-attribute'],
  ] },
  { family: 'probe-remote-thesis', slug: 'concepts/remote-only-startups', fact: 'The current thesis: remote-only startups work best with a quarterly in-person week.', kind: 'belief', cands: [
    ['The thesis on remote-only startups: never meet in person, async is enough.', 'supersede', 'belief-update'],
    ['Remote-only startups should gather the team in person once a quarter.', 'duplicate', 'paraphrase-low-overlap'],
    ['Remote-only startups hire faster outside major cities.', 'independent', 'compatible-same-attribute'],
  ] },
  { family: 'probe-ai-agents-take', slug: 'concepts/ai-agents', fact: 'Latest take (2026): AI agents are ready for internal tooling but not for customer-facing support.', kind: 'belief', cands: [
    ['Take: AI agents are not ready for any production use.', 'supersede', 'belief-update'],
    ['AI agents fit internal tools today; customer support is still too risky for them.', 'duplicate', 'paraphrase-low-overlap'],
  ] },
];

const synthetic: Pair[] = [];
let familyN = 0;
function addFamily(e: Entity, attr: Attribute, fact: string, cands: Array<{ text: string; label: Label; case: string; kind?: Kind; attribute?: string }>) {
  const family = `syn-${String(++familyN).padStart(3, '0')}-${attr.name}`;
  cands.forEach((c, i) => synthetic.push({
    id: `${family}-c${i + 1}`, family, entity_slug: e.slug, fact, candidate: c.text, kind: attr.kind, candidate_kind: c.kind ?? attr.kind,
    label: c.label, slice: c.label, case: c.case, attribute: c.attribute ?? attr.name, label_source: 'synthetic-construction',
  }));
}

function otherAttribute(e: Entity, attr: Attribute): { text: string; kind: Kind; attribute: string } {
  const others = ATTRIBUTES.filter((a) => a.entity === e.kind && a.name !== attr.name);
  const o = pick(others);
  return { text: pick(o.state)(e, pick(o.values)), kind: o.kind, attribute: o.name };
}

const FAMILIES_PER_TYPE = { supersede: 170, duplicate: 100, independent: 30 };

for (let k = 0; k < FAMILIES_PER_TYPE.supersede; k++) {
  const attr = ATTRIBUTES[k % ATTRIBUTES.length]!;
  const e = attr.entity === 'person' ? person() : company();
  const [a, b] = pickTwo(attr.values);
  const [oldV, newV] = attr.ordered && attr.values.indexOf(a) > attr.values.indexOf(b) ? [b, a] : [a, b];
  const useNegation = attr.negation && k % 5 === 0;
  // Near updates keep the old statement's wording and change only the value plus a dated framing
  // (the cosine-plausible pairs the sweep's 0.80 floor admits); far updates use narrative wording.
  const near = !useNegation && k % 3 !== 0;
  const fact = useNegation ? attr.negation!.fact(e, oldV)
    : near ? attr.state[0]!(e, newV).replace(/\.$/, pick([` as of ${month()} 2026.`, `, starting ${month()} 2026.`, ` since ${month()} 2026.`]))
    : pick(attr.update)(e, oldV, newV);
  const cands: Array<{ text: string; label: Label; case: string; kind?: Kind; attribute?: string }> = [
    { text: attr.state[near || k % 2 === 0 ? 0 : int(attr.state.length)]!(e, oldV), label: 'supersede', case: useNegation ? 'negation-update' : near ? 'value-update-near' : 'value-update' },
  ];
  // Hard case: the older memory also holds the new value (a duplicate of the update) next to the stale value.
  if (!useNegation && k % 3 === 0) cands.push({ text: pick(attr.state.slice(1))(e, newV), label: 'duplicate', case: 'restates-updated-value' });
  if (k % 2 === 0) cands.push({ text: pick(attr.compatible)(e), label: 'independent', case: 'compatible-same-entity' });
  else { const o = otherAttribute(e, attr); cands.push({ text: o.text, label: 'independent', case: 'other-attribute', kind: o.kind, attribute: o.attribute }); }
  addFamily(e, attr, fact, cands);
}

for (let k = 0; k < FAMILIES_PER_TYPE.duplicate; k++) {
  const attr = ATTRIBUTES[(k + 5) % ATTRIBUTES.length]!;
  const e = attr.entity === 'person' ? person() : company();
  const v = pick(attr.values);
  const n = attr.state.length;
  // Easy duplicates pair the plain form with a close paraphrase; hard ones pair the two lowest-overlap forms.
  const hard = k % 2 === 1;
  const [a, b] = hard ? [n - 1, n - 2] : [0, 1];
  const fact = attr.state[a]!(e, v);
  const cands: Array<{ text: string; label: Label; case: string; kind?: Kind; attribute?: string }> = [
    { text: attr.state[b]!(e, v), label: 'duplicate', case: hard ? 'paraphrase-low-overlap' : 'restatement' },
  ];
  if (k % 3 === 0) {
    // Hard independent: same attribute template family, a different value of a different attribute of the same entity.
    const o = otherAttribute(e, attr);
    cands.push({ text: o.text, label: 'independent', case: 'other-attribute', kind: o.kind, attribute: o.attribute });
  } else cands.push({ text: pick(attr.compatible)(e), label: 'independent', case: 'compatible-same-entity' });
  addFamily(e, attr, fact, cands);
}

for (let k = 0; k < FAMILIES_PER_TYPE.independent; k++) {
  const attr = ATTRIBUTES[(k + 3) % ATTRIBUTES.length]!;
  const e = attr.entity === 'person' ? person() : company();
  const fact = pick(attr.state)(e, pick(attr.values));
  const [c1, c2] = pickTwo(attr.compatible.length > 1 ? attr.compatible : [...attr.compatible, attr.compatible[0]!]);
  const o = otherAttribute(e, attr);
  addFamily(e, attr, fact, [
    { text: c1(e), label: 'independent', case: 'compatible-same-entity' },
    { text: o.text, label: 'independent', case: 'other-attribute', kind: o.kind, attribute: o.attribute },
    ...(k % 2 === 0 ? [{ text: c2(e), label: 'independent' as Label, case: 'compatible-same-entity' }] : []),
  ]);
}

/** Hard independents: same sentence shape and shared tokens, a different attribute or referent. */
const NEAR_INDEPENDENT: Array<(e: Entity) => [string, string]> = [
  (e) => { const [a, b] = pickTwo(['12', '18', '25', '34', '40']); return [`${e.name} has ${a} employees.`, `${e.name} has ${b} paying customers.`]; },
  (e) => { const [a, b] = pickTwo(CITIES); return [`${e.name} is based in ${a}.`, `${e.name}'s largest customer is based in ${b}.`]; },
  (e) => { const [a, b] = pickTwo(PLANS); return [`${e.name} uses ${a}.`, `${e.name}'s main competitor uses ${b}.`]; },
  (e) => { const [a, b] = pickTwo(DBS); return [`${e.name} runs its backend on ${a}.`, `${e.name} runs its analytics on ${b}.`]; },
  (e) => { const [a, b] = pickTwo(['25', '34', '40', '55', '70']); return [`${e.name} has ${a} employees.`, `${e.name} had ${String(Math.min(Number(a), Number(b)) % 9 + 3)} employees at its founding.`]; },
  (e) => { const [a, b] = pickTwo(CITIES); return [`${e.name} is headquartered in ${a}.`, `${e.name} is opening a sales office in ${b}.`]; },
  (e) => { const [a, b] = pickTwo(['8', '15', '22', '31', '47', '60']); return [`${e.name} has ${a} paying customers.`, `${e.name} has ${Number(b) * 10} users on its free tier.`]; },
];
const NEAR_INDEPENDENT_PERSON: Array<(e: Entity) => [string, string]> = [
  (e) => { const [a, b] = pickTwo(CITIES); return [`${e.name} lives in ${a}.`, `${e.name}'s sister lives in ${b}.`]; },
  (e) => { const [a, b] = pickTwo(ROLES); return [`${e.name} is ${a} at ${e.company}.`, `${e.name}'s manager is ${b} at ${e.company}.`]; },
  (e) => { const [a, b] = pickTwo(DRINKS); return [`${e.name} prefers ${a}.`, `${e.name}'s cofounder prefers ${b}.`]; },
  (e) => { const [a, b] = pickTwo(CHANNELS); return [`${e.name} prefers to be contacted by ${a}.`, `${e.name} prefers to send invoices by ${b}.`]; },
  (e) => { const [a, b] = pickTwo(ROLES); return [`${e.name} is ${a} at ${e.company}.`, `${e.name}'s deputy is ${b} at ${e.company}.`]; },
  (e) => { const [a, b] = pickTwo(ROLES); return [`${e.name} is ${a} at ${e.company}.`, `${e.name} was ${b} at another startup before joining ${e.company}.`]; },
  (e) => { const [a, b] = pickTwo(CADENCES); return [`The user meets ${e.name} ${a} for a one-on-one.`, `The user meets ${e.name}'s team ${b} for a planning review.`]; },
];
for (let k = 0; k < 98; k++) {
  const isPerson = k % 2 === 0;
  const e = isPerson ? person() : company();
  const pool = isPerson ? NEAR_INDEPENDENT_PERSON : NEAR_INDEPENDENT;
  const [fact, cand] = pool[Math.floor(k / 2) % pool.length]!(e);
  const family = `syn-${String(++familyN).padStart(3, '0')}-near-independent`;
  synthetic.push({ id: `${family}-c1`, family, entity_slug: e.slug, fact, candidate: cand, kind: 'fact', candidate_kind: 'fact', label: 'independent', slice: 'independent', case: 'near-independent', attribute: 'mixed', label_source: 'synthetic-construction' });
}

const probes: Pair[] = PROBE_FAMILIES.flatMap((p) => p.cands.map(([text, label, c], i) => ({
  id: `${p.family}-c${i + 1}`, family: p.family, entity_slug: p.slug, fact: p.fact, candidate: text, kind: p.kind, candidate_kind: p.kind,
  label, slice: label, case: `probe:${c}`, attribute: p.family.replace(/^probe-/, ''), label_source: 'synthetic-construction' as const,
})));

// Drop exact-duplicate texts inside a family (template collisions), keeping the first.
const all = [...upstream, ...probes, ...synthetic].filter((p, i, xs) => xs.findIndex((q) => q.family === p.family && q.candidate === p.candidate) === i && p.fact !== p.candidate);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'pairs.jsonl'), all.map((p) => JSON.stringify(p)).join('\n') + '\n');
const count = (l: Label) => all.filter((p) => p.label === l).length;
console.log(`wrote ${all.length} pairs in ${new Set(all.map((p) => p.family)).size} families: duplicate ${count('duplicate')}, supersede ${count('supersede')}, independent ${count('independent')}`);
