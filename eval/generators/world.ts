/**
 * World skeleton generator (procedural, no LLM).
 *
 * Produces a coherent fictional VC-portfolio-style ecosystem:
 *   200 people (founders, partners, engineers, advisors)
 *   150 companies (startups, VCs, acquirers)
 *   100 meetings (demo days, 1:1s, board meetings, batch reviews)
 *   50 concepts (themes, frameworks)
 *
 * Each entity has structured "facts" — the ground truth we'll later use to
 * measure whether prose-generated content preserves enough signal for
 * extraction and search to recover the facts.
 *
 * Deterministic given a seed (reproducibility matters for benchmarks).
 */

export type EntityType = 'person' | 'company' | 'meeting' | 'concept';

export interface PersonFacts {
  type: 'person';
  slug: string;
  name: string;
  role: 'founder' | 'partner' | 'engineer' | 'advisor';
  /** For founders: the company they founded. For employees: where they work. For advisors: companies they advise. For partners: companies they invested in. */
  primary_affiliation: string; // company slug
  secondary_affiliations?: string[]; // additional company slugs (advisors/engineers can have multiple)
  notable_traits: string[]; // 2-3 traits to give the LLM something to work with
  background?: string; // one-line bio seed
}

export interface CompanyFacts {
  type: 'company';
  slug: string;
  name: string;
  category: 'startup' | 'vc' | 'acquirer' | 'mature';
  industry: string;
  founded_year?: number;
  /** Computed from people facts when consolidated. */
  founders?: string[];
  employees?: string[];
  investors?: string[];
  advisors?: string[];
}

export interface MeetingFacts {
  type: 'meeting';
  slug: string;
  name: string;
  meeting_type: 'demo_day' | 'one_on_one' | 'board_meeting' | 'batch_review';
  date: string;
  attendees: string[]; // people slugs
  topic_company?: string; // company slug discussed
  topic_concept?: string; // concept slug
}

export interface ConceptFacts {
  type: 'concept';
  slug: string;
  name: string;
  description: string;
  related_companies: string[]; // company slugs that exemplify this concept
  related_people?: string[]; // people most associated with this concept
}

export type EntityFacts = PersonFacts | CompanyFacts | MeetingFacts | ConceptFacts;

// ─── Name pools ────────────────────────────────────────────────

const FIRST_NAMES = [
  'Sarah', 'Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank', 'Grace', 'Henry', 'Iris',
  'Jack', 'Kate', 'Liam', 'Mia', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Rachel', 'Sam',
  'Tara', 'Uma', 'Victor', 'Wendy', 'Xavier', 'Yara', 'Zoe', 'Adam', 'Beth', 'Chris',
  'Diana', 'Eric', 'Fiona', 'Gabe', 'Helen', 'Ian', 'Julia', 'Kevin', 'Linda', 'Mark',
  'Nina', 'Owen', 'Priya', 'Quinten', 'Rosa', 'Steve', 'Tina', 'Ulrich', 'Vera', 'Will',
];
const LAST_NAMES = [
  'Chen', 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez',
  'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson',
  'Lee', 'Park', 'Kim', 'Patel', 'Kapoor', 'Nakamura', 'Liu', 'Zhang', 'Wang', 'Singh',
];
const COMPANY_NAMES_STARTUP = [
  'Acme', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Nimbus', 'Vector', 'Quantum', 'Pulse', 'Helix',
  'Beacon', 'Compass', 'Lumen', 'Cipher', 'Mosaic', 'Tessera', 'Mantle', 'Gravity', 'Apex', 'Forge',
  'Kindle', 'Lucid', 'Ranger', 'Sentinel', 'Tempo', 'Vox', 'Wisp', 'Zenith', 'Anchor', 'Brink',
  'Cascade', 'Drift', 'Echo', 'Foundry', 'Gust', 'Hatch', 'Iris', 'Jolt', 'Keel', 'Lattice',
  'Meridian', 'Nexus', 'Orbit', 'Prism', 'Quasar', 'Resonance', 'Spire', 'Talon', 'Umbra', 'Vellum',
];
const COMPANY_NAMES_VC = [
  'Founders Fund', 'Sequoia Capital', 'Andreessen Horowitz', 'Benchmark', 'Greylock',
  'Accel', 'Lightspeed', 'Index Ventures', 'Khosla Ventures', 'Floodgate',
  'First Round', 'Initialized', 'Bessemer', 'NEA', 'Kleiner Perkins',
];
const COMPANY_NAMES_ACQUIRER = [
  'Microsoft', 'Google', 'Meta', 'Amazon', 'Apple', 'Salesforce', 'Oracle', 'Adobe', 'Cisco', 'Intel',
];
const INDUSTRIES = [
  'AI infrastructure', 'AI applications', 'fintech', 'climate tech', 'biotech',
  'developer tools', 'enterprise SaaS', 'consumer social', 'crypto', 'robotics',
  'edtech', 'health tech', 'cybersecurity', 'logistics', 'data infrastructure',
];
const PERSON_TRAITS = [
  'product-obsessed', 'technical depth', 'fundraising-savvy', 'recruiting strength',
  'design taste', 'analytical', 'opinionated', 'collaborative', 'fast-shipping',
  'long-term thinker', 'demanding', 'patient', 'sharp pattern matcher', 'storyteller',
  'first-principles thinker', 'systems builder', 'distribution-focused', 'GTM-heavy',
];
const CONCEPT_NAMES = [
  'product-market fit', 'do things that don\'t scale', 'founder mode', 'second-time founder',
  'AI-first product', 'unit economics', 'open source distribution', 'community-led growth',
  'usage-based pricing', 'agentic workflows', 'foundation models', 'fine-tuning',
  'retrieval augmented generation', 'multi-modal', 'inference cost', 'latency budget',
  'customer concentration', 'revenue durability', 'gross margin expansion', 'churn cohorts',
  'embedded fintech', 'wallet share', 'carbon credits', 'permitting reform',
  'vertical SaaS', 'horizontal API', 'developer relations', 'PLG motion',
  'enterprise GTM', 'top-down sales', 'bottom-up adoption', 'land and expand',
  'category creation', 'platform shift', 'incumbent disruption', 'distribution moat',
  'data moat', 'network effects', 'switching costs', 'pricing power',
  'series A graduation', 'down round dynamics', 'secondary markets', 'liquidity events',
  'M&A integration', 'cultural fit', 'remote-first', 'in-person culture',
  'AI safety', 'alignment research', 'inference economics', 'training compute',
];

// ─── Deterministic RNG ────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

function pickN<T>(arr: T[], n: number, rand: () => number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  }
  return out;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// ─── World construction ──────────────────────────────────────

export interface World {
  people: PersonFacts[];
  companies: CompanyFacts[];
  meetings: MeetingFacts[];
  concepts: ConceptFacts[];
}

export function buildWorld(seed: number = 42): World {
  const rand = mulberry32(seed);

  // 1. Companies first (people reference them).
  const companies: CompanyFacts[] = [];
  // Startups: 100 (most numerous)
  for (let i = 0; i < 100 && i < COMPANY_NAMES_STARTUP.length * 2; i++) {
    const name = COMPANY_NAMES_STARTUP[i % COMPANY_NAMES_STARTUP.length] + (i >= COMPANY_NAMES_STARTUP.length ? ' Labs' : '');
    companies.push({
      type: 'company',
      slug: `companies/${slugify(name)}-${i}`,
      name,
      category: 'startup',
      industry: pick(INDUSTRIES, rand),
      founded_year: 2018 + Math.floor(rand() * 8), // 2018-2025
    });
  }
  // VCs: 25
  for (let i = 0; i < 25; i++) {
    const name = COMPANY_NAMES_VC[i % COMPANY_NAMES_VC.length] + (i >= COMPANY_NAMES_VC.length ? ' II' : '');
    companies.push({
      type: 'company',
      slug: `companies/${slugify(name)}-${i}`,
      name,
      category: 'vc',
      industry: 'venture capital',
    });
  }
  // Acquirers + mature: 25
  for (let i = 0; i < 25; i++) {
    const name = i < COMPANY_NAMES_ACQUIRER.length ? COMPANY_NAMES_ACQUIRER[i] : COMPANY_NAMES_STARTUP[i] + ' Corp';
    companies.push({
      type: 'company',
      slug: `companies/${slugify(name)}-${i}`,
      name,
      category: i < COMPANY_NAMES_ACQUIRER.length ? 'acquirer' : 'mature',
      industry: pick(INDUSTRIES, rand),
      founded_year: i < COMPANY_NAMES_ACQUIRER.length ? 1995 + i : 2010 + i,
    });
  }

  const startupSlugs = companies.filter(c => c.category === 'startup').map(c => c.slug);
  const vcSlugs = companies.filter(c => c.category === 'vc').map(c => c.slug);

  // 2. People — wired to companies.
  const people: PersonFacts[] = [];
  let usedNames = new Set<string>();
  function newName(): string {
    while (true) {
      const n = `${pick(FIRST_NAMES, rand)} ${pick(LAST_NAMES, rand)}`;
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
  }

  // 80 founders — one per startup that has founders.
  for (let i = 0; i < 80; i++) {
    const name = newName();
    const company = startupSlugs[i % startupSlugs.length];
    people.push({
      type: 'person',
      slug: `people/${slugify(name)}-${i}`,
      name,
      role: 'founder',
      primary_affiliation: company,
      notable_traits: pickN(PERSON_TRAITS, 2, rand),
    });
    const cf = companies.find(c => c.slug === company);
    if (cf) (cf.founders ??= []).push(`people/${slugify(name)}-${i}`);
  }
  // 30 partners — at VCs.
  for (let i = 0; i < 30; i++) {
    const name = newName();
    const vc = vcSlugs[i % vcSlugs.length];
    // Each partner invests in 3-5 startups.
    const investments = pickN(startupSlugs, 3 + Math.floor(rand() * 3), rand);
    people.push({
      type: 'person',
      slug: `people/${slugify(name)}-${i + 80}`,
      name,
      role: 'partner',
      primary_affiliation: vc,
      secondary_affiliations: investments,
      notable_traits: pickN(PERSON_TRAITS, 2, rand),
    });
    for (const s of investments) {
      const cf = companies.find(c => c.slug === s);
      if (cf) (cf.investors ??= []).push(`people/${slugify(name)}-${i + 80}`);
    }
  }
  // 60 engineers — at startups.
  for (let i = 0; i < 60; i++) {
    const name = newName();
    const employer = startupSlugs[i % startupSlugs.length];
    const previous = startupSlugs[(i + 17) % startupSlugs.length]; // some have a prior gig
    people.push({
      type: 'person',
      slug: `people/${slugify(name)}-${i + 110}`,
      name,
      role: 'engineer',
      primary_affiliation: employer,
      secondary_affiliations: rand() < 0.4 ? [previous] : [],
      notable_traits: pickN(PERSON_TRAITS, 2, rand),
    });
    const cf = companies.find(c => c.slug === employer);
    if (cf) (cf.employees ??= []).push(`people/${slugify(name)}-${i + 110}`);
  }
  // 30 advisors — cross-company.
  for (let i = 0; i < 30; i++) {
    const name = newName();
    const advised = pickN(startupSlugs, 2 + Math.floor(rand() * 3), rand);
    people.push({
      type: 'person',
      slug: `people/${slugify(name)}-${i + 170}`,
      name,
      role: 'advisor',
      primary_affiliation: advised[0],
      secondary_affiliations: advised.slice(1),
      notable_traits: pickN(PERSON_TRAITS, 2, rand),
    });
    for (const s of advised) {
      const cf = companies.find(c => c.slug === s);
      if (cf) (cf.advisors ??= []).push(`people/${slugify(name)}-${i + 170}`);
    }
  }

  // 3. Meetings — wire to people + companies.
  const meetings: MeetingFacts[] = [];
  const founders = people.filter(p => p.role === 'founder');
  const partners = people.filter(p => p.role === 'partner');
  const advisors = people.filter(p => p.role === 'advisor');
  const engineers = people.filter(p => p.role === 'engineer');

  // 30 demo days
  for (let i = 0; i < 30; i++) {
    const attendees = [
      partners[i % partners.length].slug,
      founders[i % founders.length].slug,
      founders[(i + 5) % founders.length].slug,
      founders[(i + 11) % founders.length].slug,
      engineers[i % engineers.length].slug,
    ];
    meetings.push({
      type: 'meeting',
      slug: `meetings/demo-day-${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-${String(15 + i % 10).padStart(2, '0')}-batch-${i}`,
      name: `Demo Day W${24 + i}`,
      meeting_type: 'demo_day',
      date: `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-${String(15 + i % 10).padStart(2, '0')}`,
      attendees,
      topic_company: founders[i % founders.length].primary_affiliation,
    });
  }
  // 40 1:1s
  for (let i = 0; i < 40; i++) {
    meetings.push({
      type: 'meeting',
      slug: `meetings/oneonone-${i}-${2025}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      name: `1:1 ${partners[i % partners.length].name} + ${founders[i % founders.length].name}`,
      meeting_type: 'one_on_one',
      date: `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      attendees: [partners[i % partners.length].slug, founders[i % founders.length].slug],
      topic_company: founders[i % founders.length].primary_affiliation,
    });
  }
  // 30 board meetings
  for (let i = 0; i < 30; i++) {
    const company = startupSlugs[i % startupSlugs.length];
    const cf = companies.find(c => c.slug === company);
    const attendees = [
      ...(cf?.founders?.slice(0, 1) ?? []),
      ...(cf?.investors?.slice(0, 2) ?? []),
      ...(cf?.advisors?.slice(0, 1) ?? []),
    ];
    meetings.push({
      type: 'meeting',
      slug: `meetings/board-${slugify(cf?.name ?? 'unknown')}-${2025 + Math.floor(i / 12)}-q${(i % 4) + 1}-${i}`,
      name: `${cf?.name} Board Meeting Q${(i % 4) + 1}`,
      meeting_type: 'board_meeting',
      date: `${2025 + Math.floor(i / 12)}-${String(((i % 4) * 3) + 1).padStart(2, '0')}-15`,
      attendees,
      topic_company: company,
    });
  }

  // 4. Concepts.
  const concepts: ConceptFacts[] = [];
  for (let i = 0; i < Math.min(50, CONCEPT_NAMES.length); i++) {
    const c = CONCEPT_NAMES[i];
    concepts.push({
      type: 'concept',
      slug: `concepts/${slugify(c)}`,
      name: c,
      description: `${c} as a strategic frame for thinking about company building.`,
      related_companies: pickN(startupSlugs, 3, rand),
      related_people: pickN(people.map(p => p.slug), 2, rand),
    });
  }

  return { people, companies, meetings, concepts };
}

// ─── Export to JSON for the gen pass ───

if (import.meta.main) {
  const world = buildWorld(42);
  console.log(`World built: ${world.people.length} people, ${world.companies.length} companies, ${world.meetings.length} meetings, ${world.concepts.length} concepts`);
  console.log(`Total entities: ${world.people.length + world.companies.length + world.meetings.length + world.concepts.length}`);
  // Sample: show first of each type
  console.log('\nSample person:', JSON.stringify(world.people[0], null, 2));
  console.log('\nSample company:', JSON.stringify(world.companies[0], null, 2));
  console.log('\nSample meeting:', JSON.stringify(world.meetings[0], null, 2));
  console.log('\nSample concept:', JSON.stringify(world.concepts[0], null, 2));
}
