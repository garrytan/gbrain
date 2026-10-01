/**
 * System One S6 (`recall_needed`) know-to-ask extension corpus generator.
 *
 * Writes BrainBench-schema fixtures + sealed gold to
 * docs/eval/system-one/datasets/know-to-ask-extra/{fixtures,gold}/ plus
 * `_design.json` (the designed intent of every gold turn). It never touches
 * the sealed evals/brainbench corpus.
 *
 * Deterministic: Mulberry32 PRNG, fixed seed. Two runs are byte-identical.
 * Every name comes from the synthetic pools below (invented surnames and
 * company names, common first names); no real person, company or situation
 * is mirrored. Labels are by construction (label_source
 * `synthetic-construction`): each turn is built from a template whose
 * should_retrieve value is fixed by its category, documented in the README.
 *
 * Turn categories (one seeded entity per turn, never re-mentioned in the
 * same fixture, so "re-mentions demote" never applies):
 *   fire      memory needed; built so the shipped reflex stays silent
 *             (no-alias first names, lowercase surnames / full names /
 *             company names, partial company names, indirect references)
 *   suppress  memory not needed; built so the shipped reflex fires
 *             (capitalized surname only -> title-surname arm, unprotected;
 *             or alias / exact title -> protected identity hit)
 *   negative  memory not needed; the reflex stays silent (small talk,
 *             generic questions, incidental lowercase or other-referent names)
 *   keep      memory needed and the reflex fires through the unprotected
 *             title-surname arm: the turns a wrong S6 suppression would hurt,
 *             so suppression precision is measured against real risk
 *
 * Run: bun docs/eval/system-one/generators/know-to-ask-extra.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SEED = 60601;
const FIXTURES = 132;
const OUT = join(import.meta.dir, '..', 'datasets', 'know-to-ask-extra');

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
function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

// ---------------------------------------------------------------------------
// Synthetic pools
// ---------------------------------------------------------------------------

const FIRST = [
  'tamsin', 'oriel', 'idris', 'noemi', 'calder', 'linnea', 'bram', 'soraya', 'teodor', 'marisol',
  'anselm', 'yusra', 'corin', 'delphine', 'rasmus', 'ilse', 'tobias', 'zainab', 'fintan', 'maren',
  'hollis', 'ottilie', 'cassius', 'leonie', 'eamon', 'saskia', 'joaquin', 'alaric', 'junie', 'kasimir',
  'verity', 'oskar', 'farah', 'lucan', 'mireille', 'bastian', 'odette', 'ruairi', 'thea', 'emrys',
  'solveig', 'dario', 'ines', 'kofi', 'mateo', 'annika', 'rohan', 'elodie', 'florian', 'greta',
];
const SUR_HEAD = ['Quell', 'Fen', 'Marr', 'Tess', 'Orrin', 'Vash', 'Pell', 'Kest', 'Brin', 'Wyr', 'Corv', 'Yarr', 'Gris', 'Cald', 'Ostre', 'Drem', 'Hask', 'Lorn', 'Merr', 'Tulv'];
const SUR_TAIL = ['brook', 'waite', 'wick', 'dale', 'ford', 'combe', 'grove', 'mere', 'holt', 'stead', 'ridge', 'barrow', 'fell', 'thorpe'];
const CO_HEAD = ['Bracken', 'Lumen', 'Quartz', 'Tidal', 'Ember', 'Cobalt', 'Vesper', 'Juniper', 'Marble', 'Saffron', 'Halcyon', 'Nimbus', 'Orchid', 'Pylon', 'Russet', 'Solace', 'Wander', 'Fable', 'Glint', 'Kiln'];
const CO_TAIL = ['moor', 'fold', 'vane', 'reach', 'loft', 'spire', 'wharf', 'gate', 'crest', 'yard'];
const CO_KIND = ['Labs', 'Systems', 'Health', 'Robotics', 'Analytics', 'Studio'];

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Per-fixture allocator: every entity in a fixture gets a distinct first name, surname and company head. */
class Names {
  private used = new Set<string>();
  private fresh(gen: () => string): string {
    for (;;) {
      const v = gen();
      if (!this.used.has(v.toLowerCase())) { this.used.add(v.toLowerCase()); return v; }
    }
  }
  first(): string { return this.fresh(() => pick(FIRST)); }
  surname(): string { return this.fresh(() => pick(SUR_HEAD) + pick(SUR_TAIL)); }
  companyWord(): string { return this.fresh(() => pick(CO_HEAD) + pick(CO_TAIL)); }
}

interface SeedPage { slug: string; content: string }

function personPage(first: string, last: string, alias: boolean, body: string): SeedPage {
  const title = `${cap(first)} ${last}`;
  const summary = body.split('. ')[0]!.replace(/\.$/, '') + '.';
  return {
    slug: `people/${kebab(title)}`,
    content: `---\ntitle: ${title}\ntype: person\n${alias ? `aliases: [${first}]\n` : ''}summary: ${JSON.stringify(summary)}\n---\n\n${body}\n`,
  };
}

function companyPage(title: string, body: string): SeedPage {
  const summary = body.split('. ')[0]!.replace(/\.$/, '') + '.';
  return { slug: `companies/${kebab(title)}`, content: `---\ntitle: ${title}\ntype: company\nsummary: ${JSON.stringify(summary)}\n---\n\n${body}\n` };
}

function projectPage(title: string, body: string): SeedPage {
  const summary = body.split('. ')[0]!.replace(/\.$/, '') + '.';
  return { slug: `projects/${kebab(title)}`, content: `---\ntitle: ${title}\ntype: project\nsummary: ${JSON.stringify(summary)}\n---\n\n${body}\n` };
}

// ---------------------------------------------------------------------------
// Turn templates
// ---------------------------------------------------------------------------

type Intent = 'fire' | 'suppress' | 'negative' | 'keep';

interface BuiltTurn {
  intent: Intent;
  subtype: string;
  text: string;
  should_retrieve: boolean;
  gold_slugs?: string[];
  pages: SeedPage[];
  /** What the design expects the shipped reflex to do on this turn. */
  expect_reflex: 'fired' | 'silent';
  expect_protected: boolean;
}

type Template = (n: Names) => BuiltTurn;

const TOPICS = [
  { what: 'the pilot', fact: (f: string) => `${f} asked for a longer pilot before signing, ideally a full quarter.` },
  { what: 'the proposal', fact: (f: string) => `${f} wants the proposal revised to drop the onboarding fee.` },
  { what: 'the hiring plan', fact: (f: string) => `${f} wants to pause the second engineering hire until the renewal closes.` },
  { what: 'the contract', fact: (f: string) => `${f} objected to the auto-renewal clause in the draft contract.` },
  { what: 'the roadmap', fact: (f: string) => `${f} pushed to move the reporting feature ahead of the mobile app.` },
  { what: 'the offsite', fact: (f: string) => `${f} suggested holding the offsite somewhere reachable by train.` },
];
const ROLES = ['head of partnerships', 'procurement lead', 'operations director', 'product lead', 'finance lead', 'head of sales'];

const fireFirstNoAlias: Template = (n) => {
  const first = n.first(), last = n.surname(), co = n.companyWord(), topic = pick(TOPICS);
  const page = personPage(first, last, false, `${cap(first)} ${last} is the ${pick(ROLES)} at ${co}. ${topic.fact(cap(first))}`);
  const name = rand() < 0.6 ? first : cap(first);
  const text = pick([
    `what did ${name} say about ${topic.what}?`,
    `remind me where ${name} landed on ${topic.what}`,
    `${name} is pinging me again about ${topic.what}, what's the context?`,
    `before I reply to ${name}, what was their position on ${topic.what}?`,
  ]);
  return { intent: 'fire', subtype: 'first-name-no-alias', text, should_retrieve: true, gold_slugs: [page.slug], pages: [page], expect_reflex: 'silent', expect_protected: false };
};

const fireLowerSurname: Template = (n) => {
  const first = n.first(), last = n.surname(), co = n.companyWord(), topic = pick(TOPICS);
  const page = personPage(first, last, rand() < 0.5, `${cap(first)} ${last} is the ${pick(ROLES)} at ${co}. ${topic.fact(cap(first))}`);
  const s = last.toLowerCase();
  const text = pick([
    `did ${s} ever get back to me on ${topic.what}?`,
    `prep me for the ${s} call, especially ${topic.what}`,
    `what's the latest with ${s} on ${topic.what}?`,
    `need to answer ${s} today, remind me what they wanted on ${topic.what}`,
  ]);
  return { intent: 'fire', subtype: 'lowercase-surname', text, should_retrieve: true, gold_slugs: [page.slug], pages: [page], expect_reflex: 'silent', expect_protected: false };
};

const fireLowerFullName: Template = (n) => {
  const first = n.first(), last = n.surname(), co = n.companyWord(), topic = pick(TOPICS);
  const page = personPage(first, last, false, `${cap(first)} ${last} is the ${pick(ROLES)} at ${co}. ${topic.fact(cap(first))}`);
  const full = `${first} ${last.toLowerCase()}`;
  const text = pick([
    `${full} wants to meet again, what did we agree last time about ${topic.what}?`,
    `quick one: what's ${full}'s view on ${topic.what}?`,
    `can you pull up what ${full} told us about ${topic.what}`,
  ]);
  return { intent: 'fire', subtype: 'lowercase-full-name-no-alias', text, should_retrieve: true, gold_slugs: [page.slug], pages: [page], expect_reflex: 'silent', expect_protected: false };
};

const COMPANY_FACTS = [
  { what: 'the renewal', fact: 'The renewal is blocked on a security review that is due next month.' },
  { what: 'the integration', fact: 'The integration slipped because their API still lacks webhooks.' },
  { what: 'pricing', fact: 'They quoted a per-seat price with a minimum annual commitment.' },
  { what: 'the pilot', fact: 'Their pilot with our team ends after the next billing cycle.' },
  { what: 'support', fact: 'Their support team promised a named account manager after the last outage.' },
];

const fireLowerCompany: Template = (n) => {
  const co = n.companyWord(), f = pick(COMPANY_FACTS);
  const page = companyPage(co, `${co} is a software vendor we work with. ${f.fact}`);
  const c = co.toLowerCase();
  const text = pick([
    `how's ${c} doing on ${f.what}?`,
    `what's the status with ${c} and ${f.what}?`,
    `remind me what we know about ${c} and ${f.what}`,
  ]);
  return { intent: 'fire', subtype: 'lowercase-company', text, should_retrieve: true, gold_slugs: [page.slug], pages: [page], expect_reflex: 'silent', expect_protected: false };
};

const firePartialCompany: Template = (n) => {
  const word = n.companyWord(), title = `${word} ${pick(CO_KIND)}`, f = pick(COMPANY_FACTS);
  const page = companyPage(title, `${title} is a startup we evaluated as a partner. ${f.fact}`);
  const text = pick([
    `Any news from ${word} on ${f.what}?`,
    `Remind me where things stand with ${word} on ${f.what}.`,
    `Prep notes for my ${word} meeting please, mainly ${f.what}.`,
  ]);
  return { intent: 'fire', subtype: 'partial-company-name', text, should_retrieve: true, gold_slugs: [page.slug], pages: [page], expect_reflex: 'silent', expect_protected: false };
};

const INDIRECT_PEOPLE = [
  { ref: 'my cofounder', role: "the user's cofounder and CTO", ask: (t: string) => `what did my cofounder think about ${t}?` },
  { ref: 'our lead investor', role: 'the lead investor in our seed round', ask: (t: string) => `what was our lead investor's take on ${t}?` },
  { ref: 'my accountant', role: "the user's accountant", ask: (t: string) => `what did my accountant flag about ${t}?` },
  { ref: 'my advisor', role: "the user's startup advisor", ask: (t: string) => `remind me what my advisor said about ${t}` },
  { ref: 'our new designer', role: 'the product designer we hired last month', ask: (t: string) => `what did our new designer want to change in ${t}?` },
  { ref: 'the recruiter', role: 'the recruiter helping us hire engineers', ask: (t: string) => `what did the recruiter suggest for ${t}?` },
];

const fireIndirectPerson: Template = (n) => {
  const first = n.first(), last = n.surname(), who = pick(INDIRECT_PEOPLE), topic = pick(TOPICS);
  const page = personPage(first, last, true, `${cap(first)} ${last} is ${who.role}. ${topic.fact(cap(first))}`);
  return { intent: 'fire', subtype: 'indirect-person', text: who.ask(topic.what), should_retrieve: true, gold_slugs: [page.slug], pages: [page], expect_reflex: 'silent', expect_protected: false };
};

const VENDOR_ROLES = [
  { role: 'payroll', ask: 'what does the vendor we picked for payroll charge per employee?' },
  { role: 'office cleaning', ask: 'which days does the cleaning company we chose come in?' },
  { role: 'cloud hosting', ask: 'remind me why we went with the hosting provider we picked last week' },
  { role: 'legal', ask: 'what did the law firm we hired say about the trademark filing?' },
  { role: 'bookkeeping', ask: 'when is the bookkeeping service we signed with closing the books this month?' },
];

const fireIndirectVendor: Template = (n) => {
  const co = n.companyWord(), v = pick(VENDOR_ROLES), f = pick(COMPANY_FACTS);
  const page = companyPage(co, `${co} is the ${v.role} vendor we picked. ${f.fact}`);
  return { intent: 'fire', subtype: 'indirect-vendor', text: v.ask, should_retrieve: true, gold_slugs: [page.slug], pages: [page], expect_reflex: 'silent', expect_protected: false };
};

const PROJECTS = [
  { title: 'Pricing Overhaul', body: 'We decided to move the starter plan to usage-based pricing and keep annual contracts for larger teams.', ask: 'where did we land on that pricing thing?' },
  { title: 'Office Move', body: 'We agreed to sublet the second floor and move the team downstairs at the end of the quarter.', ask: "what did we decide about the office situation?" },
  { title: 'Onboarding Revamp', body: 'The plan is to replace the setup call with a guided checklist and a two-week check-in.', ask: 'remind me what we settled on for that onboarding idea' },
  { title: 'Referral Program', body: 'We chose a one-month credit for both sides and capped it at three referrals per account.', ask: "what were the terms of the referral thing we discussed?" },
  { title: 'Support Rotation', body: 'Engineers take one week of support each per month, and weekends go to an on-call pager.', ask: 'how did we end up splitting that support rotation?' },
];

const fireIndirectProject: Template = () => {
  const p = pick(PROJECTS);
  const page = projectPage(p.title, `${p.title}: ${p.body}`);
  return { intent: 'fire', subtype: 'indirect-project', text: p.ask, should_retrieve: true, gold_slugs: [page.slug], pages: [page], expect_reflex: 'silent', expect_protected: false };
};

/** Suppress: the prompt mentions a seeded person by capitalized surname only, but is self-contained. */
const SURNAME_SELF_CONTAINED: Array<{ sub: string; t: (s: string) => string }> = [
  { sub: 'spelling', t: (s) => `How do you spell ${s} in the NATO phonetic alphabet?` },
  { sub: 'arithmetic-from-prompt', t: (s) => `${s}'s train gets in at 5:40pm and the walk is 15 minutes. What time will they reach the office?` },
  { sub: 'copyedit', t: (s) => `Fix the typos in this line of my email to ${s}: 'thnaks for the quick turnaround, talk soon'` },
  { sub: 'general-knowledge', t: (s) => `${s} mentioned the pomodoro technique on a call. How does the pomodoro technique work?` },
  { sub: 'reformat', t: (s) => `Turn this into a checklist: ${s} sends the deck, I review it, we both sign off on Friday.` },
  { sub: 'translate', t: (s) => `Translate into Spanish: '${s} will join the meeting at noon.'` },
  { sub: 'letter-count', t: (s) => `How many letters are in the name ${s}?` },
  { sub: 'unit-conversion', t: (s) => `${s} said the room is 12 by 15 feet. What is that in square meters?` },
];

const suppressSurname: Template = (n) => {
  const first = n.first(), last = n.surname(), co = n.companyWord();
  const page = personPage(first, last, rand() < 0.5, `${cap(first)} ${last} is the ${pick(ROLES)} at ${co}.`);
  const s = pick(SURNAME_SELF_CONTAINED);
  return { intent: 'suppress', subtype: `surname-${s.sub}`, text: s.t(last), should_retrieve: false, pages: [page], expect_reflex: 'fired', expect_protected: false };
};

/** Keep: capitalized surname only (title-surname arm, unprotected) and the answer needs the stored page. */
const keepSurname: Template = (n) => {
  const first = n.first(), last = n.surname(), co = n.companyWord(), topic = pick(TOPICS);
  const page = personPage(first, last, rand() < 0.5, `${cap(first)} ${last} is the ${pick(ROLES)} at ${co}. ${topic.fact(cap(first))}`);
  const text = pick([
    `Prep me for the ${last} call, especially ${topic.what}.`,
    `What did ${last} want changed in ${topic.what}?`,
    `I owe ${last} an answer on ${topic.what}. What were they asking for?`,
    `Remind me of ${last}'s position on ${topic.what} before our sync.`,
  ]);
  return { intent: 'keep', subtype: 'surname-needed', text, should_retrieve: true, gold_slugs: [page.slug], pages: [page], expect_reflex: 'fired', expect_protected: false };
};

/** Suppress with an identity hit: alias first name or exact title in a self-contained request. */
const suppressIdentity: Template = (n) => {
  const first = n.first(), last = n.surname(), co = n.companyWord();
  const variant = int(3);
  if (variant === 0) {
    const page = personPage(first, last, true, `${cap(first)} ${last} is the ${pick(ROLES)} at ${co}.`);
    const text = pick([
      `How do you pronounce ${cap(first)}? I want to say it right.`,
      `Is ${cap(first)} usually a short form of a longer name?`,
    ]);
    return { intent: 'suppress', subtype: 'alias-name-question', text, should_retrieve: false, pages: [page], expect_reflex: 'fired', expect_protected: true };
  }
  if (variant === 1) {
    const page = personPage(first, last, false, `${cap(first)} ${last} is the ${pick(ROLES)} at ${co}.`);
    const text = pick([
      `Translate into French: '${cap(first)} ${last} will send the notes tomorrow.'`,
      `Put this sentence in the past tense: '${cap(first)} ${last} opens the meeting and shares the agenda.'`,
    ]);
    return { intent: 'suppress', subtype: 'full-name-self-contained', text, should_retrieve: false, pages: [page], expect_reflex: 'fired', expect_protected: true };
  }
  const page = companyPage(co, `${co} is a software vendor we work with.`);
  const text = pick([
    `Write a one-line out-of-office reply saying I'm visiting ${co} on Monday.`,
    `Make this sentence shorter: 'Our team will be at the ${co} office for the whole afternoon on Thursday.'`,
  ]);
  return { intent: 'suppress', subtype: 'company-title-self-contained', text, should_retrieve: false, pages: [page], expect_reflex: 'fired', expect_protected: true };
};

const SMALL_TALK = [
  'thanks, that helps a lot', 'haha fair enough', 'good morning! hope your day is going well',
  'ok cool, talk later', 'perfect, appreciate it', 'sorry, got distracted for a minute',
];
const GENERIC = [
  "what's a good agenda for a weekly one-on-one?", 'explain the difference between gross margin and net margin',
  'suggest a name for a golden retriever puppy', 'how long should I steep green tea?',
  'write a regex that matches a simple email address', 'what is a good way to structure a postmortem doc?',
  'give me three icebreaker questions for a team lunch', 'how do I convert a string to a date in python?',
  'what are the pros and cons of a four-day work week?', 'summarize the idea behind spaced repetition in two sentences',
];

const negativeSmallTalk: Template = () => ({ intent: 'negative', subtype: 'small-talk', text: pick(SMALL_TALK), should_retrieve: false, pages: [], expect_reflex: 'silent', expect_protected: false });
const negativeGeneric: Template = () => ({ intent: 'negative', subtype: 'generic-question', text: pick(GENERIC), should_retrieve: false, pages: [], expect_reflex: 'silent', expect_protected: false });

const negativeIncidentalLower: Template = (n) => {
  const first = n.first(), last = n.surname(), co = n.companyWord();
  const page = personPage(first, last, false, `${cap(first)} ${last} is the ${pick(ROLES)} at ${co}.`);
  const text = pick([
    `how do you pronounce the name ${first}? it's for a character in my short story`,
    `is ${first} a common name anywhere? thinking about it for a character`,
  ]);
  return { intent: 'negative', subtype: 'incidental-lowercase-name', text, should_retrieve: false, pages: [page], expect_reflex: 'silent', expect_protected: false };
};

const negativeOtherReferent: Template = (n) => {
  const first = n.first(), last = n.surname(), co = n.companyWord();
  const page = personPage(first, last, false, `${cap(first)} ${last} is the ${pick(ROLES)} at ${co}.`);
  const text = pick([
    `In the novel I'm reading, Captain ${last} betrays the crew. Is that a common trope?`,
    `Our hotel is on ${last} Street. Any tips for finding breakfast near a hotel in a new city?`,
  ]);
  return { intent: 'negative', subtype: 'other-referent-name', text, should_retrieve: false, pages: [page], expect_reflex: 'silent', expect_protected: false };
};

const negativeUnseeded: Template = (n) => {
  const first = n.first(), last = n.surname();
  return { intent: 'negative', subtype: 'unseeded-name', text: `By the way, someone named ${cap(first)} ${last} emailed about partnerships. Never heard of them.`, should_retrieve: false, pages: [], expect_reflex: 'silent', expect_protected: false };
};

const FIRE = [fireFirstNoAlias, fireLowerSurname, fireLowerFullName, fireLowerCompany, firePartialCompany, fireIndirectPerson, fireIndirectVendor, fireIndirectProject];
const NEGATIVE = [negativeSmallTalk, negativeGeneric, negativeIncidentalLower, negativeOtherReferent, negativeUnseeded];
const ASSISTANT = ['Sure.', 'Got it.', 'Here is what I have.', 'Done.', 'Okay, noted.', 'Happy to help.'];

/** Distractor pages keep the brain non-trivial; never mentioned by any turn. */
function distractor(n: Names): SeedPage {
  return rand() < 0.5
    ? personPage(n.first(), n.surname(), true, `A contact from a conference last spring.`)
    : companyPage(n.companyWord(), 'A company we met once at a trade show.');
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'fixtures'), { recursive: true });
mkdirSync(join(OUT, 'gold'), { recursive: true });

const design: Record<string, { intent: Intent; subtype: string; expect_reflex: string; expect_protected: boolean }> = {};

for (let k = 0; k < FIXTURES; k++) {
  const id = `s6x-${String(k + 1).padStart(3, '0')}`;
  const n = new Names();
  // Every fixture: one fire, one suppress, one negative, plus an extra fire, suppress or keep turn.
  // Fire and negative subtypes rotate so each subtype is evenly represented.
  const specs: Template[] = [
    FIRE[k % FIRE.length]!,
    k % 3 === 2 ? suppressIdentity : suppressSurname,
    NEGATIVE[k % NEGATIVE.length]!,
  ];
  if (k % 2 === 0) specs.push(k % 4 === 0 ? FIRE[(k + 3) % FIRE.length]! : suppressSurname);
  else specs.push(keepSurname);
  const built = shuffle(specs.map((t) => t(n)));
  const pages = [...built.flatMap((b) => b.pages), distractor(n)];
  const turns: Array<{ turn_id: number; role: 'user' | 'assistant'; text: string }> = [];
  const gold: Record<string, { should_retrieve: boolean; gold_slugs?: string[] }> = {};
  built.forEach((b, i) => {
    const turnId = turns.length + 1;
    turns.push({ turn_id: turnId, role: 'user', text: b.text });
    gold[String(turnId)] = { should_retrieve: b.should_retrieve, ...(b.gold_slugs ? { gold_slugs: b.gold_slugs } : {}) };
    design[`${id}#${turnId}`] = { intent: b.intent, subtype: b.subtype, expect_reflex: b.expect_reflex, expect_protected: b.expect_protected };
    if (i < built.length - 1) turns.push({ turn_id: turns.length + 1, role: 'assistant', text: pick(ASSISTANT) });
  });
  const fixture = { schema_version: 1, fixture_id: id, suites: ['know-to-ask'], category: 's6-extra', seed_pages: pages, turns };
  writeFileSync(join(OUT, 'fixtures', `${id}.fixture.json`), JSON.stringify(fixture, null, 2) + '\n');
  writeFileSync(join(OUT, 'gold', `${id}.gold.json`), JSON.stringify({ fixture_id: id, turns: gold }, null, 2) + '\n');
}

writeFileSync(join(OUT, '_design.json'), JSON.stringify({ seed: SEED, fixtures: FIXTURES, label_source: 'synthetic-construction', turns: design }, null, 2) + '\n');
console.log(`wrote ${FIXTURES} fixtures, ${Object.keys(design).length} gold user turns to ${OUT}`);
