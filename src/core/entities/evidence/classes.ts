/**
 * Dedupe v2 (GST-3609): every candidate pair with its evidence, its verdict and its classes, plus the counts
 * `gbrain dedupe classes` prints and the seeded sample `gbrain dedupe sample` exports for labelling. Read-only: nothing
 * here links, edits or removes anything; the only write is the Exa cache and spend total of a live Exa run.
 *
 * Steps: people.ts builds the pairs and their base class; C4 (same full name with two or more words, the same company,
 * two or more pages linking both, no other person page of that name) is read from backlinks for the name-only pairs that
 * qualify; email.ts and messaging.ts add local signals; combine.ts decides. With Exa on, the pairs still waiting whose
 * base is C2 or C5, with no contradiction and no private, family or minor page, get one query per page (exa.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import { markRestricted, scanPeople, stillSendsQuery, pageKey, type BaseClass, type CandidatePair, type PersonPage } from './people.ts';
import { emailSignals, readEmailIndex } from './email.ts';
import { messagingSignals, readMessagingIndex } from './messaging.ts';
import { exaQueryFor, resolveExa, type ExaMode, type ExaQuery, type ExaReport, type ExaSettings } from './exa.ts';
import { PAIR_CLASSES, VERDICTS, classesOf, combine, type PairClass, type Signal, type Verdict } from './combine.ts';

export const DEDUPE_CLASSES_SCHEMA_VERSION = 1 as const;

export interface PairMember { source_id: string; slug: string; title: string }
export interface ClassifiedPair {
  id: string;
  members: [PairMember, PairMember];
  base: BaseClass;
  signals: Signal[];
  classes: PairClass[];
  verdict: Verdict;
  reason: string;
  score: number;
  why: string[];
  email_off?: string;
}

export interface ClassesReport {
  schema_version: typeof DEDUPE_CLASSES_SCHEMA_VERSION;
  pairs: number;
  classes: Record<PairClass, number>;
  verdicts: Record<Verdict, number>;
  skipped: { large_groups: number; already_linked: number; decided_apart: number; no_class: number };
  email: { pages: number };
  messaging: { pages: number; chats: number; one_to_one: number; too_large: number; segmented_page: { read: number; set_aside: number; pages: Array<{ source_id: string; slug: string }> }; signal: 'no reader' };
  exa: ExaReport | { mode: 'off' };
}

export interface ClassifyOptions {
  sourceId?: string;
  exa?: { mode: ExaMode; settings: ExaSettings; apiKey?: string; fetch?: typeof fetch };
}

const member = (p: PersonPage): PairMember => ({ source_id: p.source_id, slug: p.slug, title: p.title });
const companyKey = (s: string | null) => s?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || null;

async function linkersOf(engine: BrainEngine, p: PersonPage, cache: Map<string, Set<string>>): Promise<Set<string>> {
  const key = pageKey(p);
  const hit = cache.get(key);
  if (hit) return hit;
  const out = new Set((await engine.getBacklinks(p.slug, { sourceId: p.source_id })).map(l => pageKey({ source_id: l.from_source_id, slug: l.from_slug })));
  cache.set(key, out);
  return out;
}

export async function classifyPairs(engine: BrainEngine, opts: ClassifyOptions = {}): Promise<{ report: ClassesReport; pairs: ClassifiedPair[] }> {
  const scan = await scanPeople(engine);
  const candidates = opts.sourceId ? scan.pairs.filter(p => p.a.source_id === opts.sourceId || p.b.source_id === opts.sourceId) : scan.pairs;
  const email = await readEmailIndex(engine, scan.people);
  const messaging = await readMessagingIndex(engine, scan.countryCode);
  const linkers = new Map<string, Set<string>>();

  const local = new Map<string, { pair: CandidatePair; signals: Set<Signal>; emailOff?: string }>();
  for (const pair of candidates) {
    const { a, b } = pair;
    const signals = new Set<Signal>();
    const e = emailSignals(email, scan.carriers, a, b);
    for (const s of e.signals) signals.add(s);
    for (const s of messagingSignals(messaging, scan.carriers, a, b)) signals.add(s);
    if (pair.base === 'C5' && a.strict === b.strict && a.strict.includes(' ') && scan.nameCounts.get(a.strict) === 2
      && companyKey(a.company) && companyKey(a.company) === companyKey(b.company)) {
      const [la, lb] = [await linkersOf(engine, a, linkers), await linkersOf(engine, b, linkers)];
      const shared = [...la].filter(k => lb.has(k) && k !== pageKey(a) && k !== pageKey(b)).length;
      if (shared >= 2) signals.add('C4');
    }
    local.set(pair.id, { pair, signals, ...(e.disabled ? { emailOff: e.disabled } : {}) });
  }

  let exa: ClassesReport['exa'] = { mode: 'off' };
  if (opts.exa) {
    await markRestricted(engine, scan.people.values());
    const queries: ExaQuery[] = [];
    const blocked: ExaReport['blocked'] = {};
    const blockedPages = new Set<string>();
    const asked = new Map<string, [ExaQuery, ExaQuery]>();
    const pagesOf = new Map<string, PersonPage[]>();
    for (const { pair, signals } of local.values()) {
      if (pair.base !== 'C2' && pair.base !== 'C5') continue;
      if (combine(evidenceOf(pair, signals)).verdict !== 'wait' || signals.has('Mx')) continue;
      const qs = [pair.a, pair.b].map(p => {
        const q = exaQueryFor(p);
        if ('blocked' in q && !blockedPages.has(pageKey(p))) { blockedPages.add(pageKey(p)); blocked[q.blocked] = (blocked[q.blocked] ?? 0) + 1; }
        return q;
      });
      const [qa, qb] = qs as [ReturnType<typeof exaQueryFor>, ReturnType<typeof exaQueryFor>];
      if ('blocked' in qa || 'blocked' in qb) continue;
      if (qa.query === qb.query) { signals.add('X0'); continue; }
      queries.push(qa, qb);
      for (const [q, p] of [[qa, pair.a], [qb, pair.b]] as const) pagesOf.set(q.query, [...pagesOf.get(q.query) ?? [], p]);
      asked.set(pair.id, [qa, qb]);
    }
    const resolved = await resolveExa(engine, queries, blocked, { ...opts.exa, recheck: async (query) => {
      for (const p of pagesOf.get(query) ?? []) if (!(await stillSendsQuery(engine, p, query))) return false;
      return true;
    } });
    exa = resolved.report;
    for (const [id, [qa, qb]] of asked) {
      const [ua, ub] = [resolved.hits.get(qa.query), resolved.hits.get(qb.query)];
      if (!ua || !ub) continue;
      local.get(id)!.signals.add(ua === ub ? 'X1' : 'X2');
    }
  }

  const pairs: ClassifiedPair[] = [];
  const report: ClassesReport = {
    schema_version: DEDUPE_CLASSES_SCHEMA_VERSION, pairs: 0,
    classes: Object.fromEntries(PAIR_CLASSES.map(c => [c, 0])) as Record<PairClass, number>,
    verdicts: Object.fromEntries(VERDICTS.map(v => [v, 0])) as Record<Verdict, number>,
    skipped: scan.skipped, email: { pages: email.pages },
    messaging: { pages: messaging.pages, chats: messaging.chats, one_to_one: messaging.one_to_one, too_large: messaging.too_large,
      segmented_page: { read: messaging.segmented.read, set_aside: messaging.segmented.set_aside.length, pages: messaging.segmented.set_aside }, signal: 'no reader' },
    exa,
  };
  for (const { pair, signals, emailOff } of local.values()) {
    const evidence = evidenceOf(pair, signals);
    const decided = combine(evidence);
    const classes = classesOf(evidence);
    report.pairs++;
    report.verdicts[decided.verdict]++;
    for (const c of classes) report.classes[c]++;
    pairs.push({ id: pair.id, members: [member(pair.a), member(pair.b)], base: pair.base, signals: [...signals].sort(), classes,
      verdict: decided.verdict, reason: decided.reason, score: decided.score, why: pair.why, ...(emailOff ? { email_off: emailOff } : {}) });
  }
  pairs.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { report, pairs };
}

const evidenceOf = (pair: CandidatePair, signals: ReadonlySet<Signal>) =>
  ({ base: pair.base, names: pair.names, signals, sensitive: !!(pair.a.sensitive || pair.b.sensitive) });

/** A seeded random sample of the pairs in one class (mulberry32 shuffle of the id-sorted pairs); every pair when fewer. */
export function samplePairs(pairs: ClassifiedPair[], cls: PairClass, n: number, seed: number): ClassifiedPair[] {
  const pool = pairs.filter(p => p.classes.includes(cls));
  let t = seed >>> 0;
  const rand = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}
