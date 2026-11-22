/**
 * Shadow replay minimizer (docs/guides/shadow-replay.md#minimized-cases): turns one replay difference into a test case
 * made only of synthetic data, or refuses.
 *
 * 1. Candidate case: the setup the failing calls need (each page a call names, read from the PGLite copy, written back
 *    as putPage and addTag), the earlier recorded writes that named those pages, and the calls themselves.
 * 2. Synthesis, one consistent mapping over the whole case: fixed gbrain constants and schema field names stay; every
 *    other key, word, slug segment, id and number is replaced (same input, same replacement; dates keep their order;
 *    vectors become seeded random unit vectors of the same length). Nothing of the mapping is kept.
 * 3. The synthetic case must still differ on fresh, empty PGLite and Rust brains with the same signature (class and
 *    field path shape), or the result is `not_minimizable`. Setup steps are then dropped one by one while it still does.
 * 4. Leak gate: the case is refused (`shadow_replay_minimizer_leak`) when its text holds any input string or word of 2+
 *    characters (whole-word for short ones), its base64 or hex form, any input number outside small counters, or any
 *    input vector value. Only a case that passes is written, to the run's `out/repros/`.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { decodeValue } from './codec.ts';
import { ReplayError } from './replay-errors.ts';
import { classify, NormState, runUnit, type ArmName, type DiffClass, type Outcome, type Unit } from './replay.ts';
import type { CaptureRecord } from './capture.ts';

export const REPRO_VERSION = 1;

export interface ReproStep { member: string; args: unknown[] }
export interface ReproCase { version: 1; status: 'open' | 'fixed'; setup: ReproStep[]; calls: ReproStep[]; expect: { class: DiffClass; path: string[] } }

/** Field names and constants a case may keep as they are. */
export const KEEP_KEYS = new Set(('slug type title compiled_truth timeline frontmatter tags content_hash source_id sourceId sourceIds limit offset depth '
  + 'direction link_type context date summary source detail fact entity_slug kind visibility confidence status scope mode includeDeleted '
  + 'excludePrivate liveOnly detail_level type_filter types since until query q page chunk_index row_num version revision asOf orderBy order '
  + 'includeChunks includeTimeline includeLinks includeFacts withBody bodyOnly fields columns').split(' '));
export const KEEP_VALUES = new Set(('person company concept meeting project note source idea place event organization default page fact take '
  + 'world private public active deleted mentions works_at invested_in founded asc desc in out both true false keyword vector hybrid').split(' '));
const COUNT_KEYS = new Set(['limit', 'offset', 'depth', 'page', 'chunk_index', 'row_num', 'version', 'revision']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}(:?\d{2})?)?)?$/;
const WORD_RE = /[\p{L}\p{N}]+/gu;

function isVector(v: unknown): v is number[] { return Array.isArray(v) && v.length >= 8 && v.every(x => typeof x === 'number'); }

/** Every value a leak check must keep out of the output. */
export function inputInventory(inputs: unknown[]): { strings: Set<string>; numbers: Set<number> } {
  const strings = new Set<string>();
  const numbers = new Set<number>();
  const visit = (v: unknown, key?: string) => {
    if (typeof v === 'string' && DATE_RE.test(v)) strings.add(v.toLowerCase());
    else if (typeof v === 'string') {
      const short = (w: string) => w.length < 2 || /^\d{1,2}$/.test(w);
      if (!KEEP_VALUES.has(v)) { if (!short(v)) strings.add(v.toLowerCase()); for (const w of v.match(WORD_RE) ?? []) if (!short(w) && !KEEP_VALUES.has(w.toLowerCase())) strings.add(w.toLowerCase()); }
    } else if (typeof v === 'number') {
      if (!(key && COUNT_KEYS.has(key) && Number.isInteger(v) && v >= 0 && v <= 1000)) numbers.add(v);
    } else if (Array.isArray(v)) v.forEach(x => visit(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === '$typed') continue; if (!KEEP_KEYS.has(k) && !k.startsWith('$')) visit(k); visit(x, k); }
  };
  inputs.forEach(v => visit(v));
  return { strings, numbers };
}

/** Throws `shadow_replay_minimizer_leak` when `output` holds anything from `inputs`. */
export function assertNoLeak(inputs: unknown[], output: unknown): void {
  const { strings, numbers } = inputInventory(inputs);
  const text = JSON.stringify(output).toLowerCase();
  const words = new Set(text.match(WORD_RE) ?? []);
  for (const s of strings) {
    if (KEEP_KEYS.has(s)) continue;
    const hit = s.length <= 3 ? words.has(s) : text.includes(s)
      || text.includes(Buffer.from(s).toString('base64').toLowerCase().replace(/=+$/, '')) || text.includes(Buffer.from(s).toString('hex'));
    if (hit) throw new ReplayError('shadow_replay_minimizer_leak', 'an input string survived synthesis');
  }
  const outNumbers = new Set<number>();
  const walk = (v: unknown) => { if (typeof v === 'number') outNumbers.add(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(output);
  for (const n of numbers) if (outNumbers.has(n)) throw new ReplayError('shadow_replay_minimizer_leak', 'an input number survived synthesis');
}

/** One consistent synthetic mapping. */
export class Synthesizer {
  private words = new Map<string, string>();
  private keys = new Map<string, string>();
  private ids = new Map<string, string>();
  private nums = new Map<number, number>();
  private vectors = new Map<string, number[]>();
  private dates = new Map<string, string>();
  private taken: Set<string>;
  private takenNums: Set<number>;

  constructor(private readonly inputs: unknown[]) {
    const inv = inputInventory(inputs);
    this.taken = inv.strings;
    this.takenNums = inv.numbers;
    const all: string[] = [];
    const collect = (v: unknown) => { if (typeof v === 'string' && DATE_RE.test(v)) all.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect); };
    inputs.forEach(collect);
    [...new Set(all)].sort((a, b) => Date.parse(a) - Date.parse(b) || (a < b ? -1 : 1)).forEach((d, i) => {
      const t = new Date(Date.UTC(2001, 0, 1) + i * 86_400_000).toISOString();
      this.dates.set(d, d.length === 10 ? t.slice(0, 10) : t);
    });
  }

  private fresh(n: number, len: number): string {
    for (let i = n; ; i += 7919) {
      let s = 'zq';
      let x = i;
      do { s += String.fromCharCode(97 + (x % 26)); x = Math.floor(x / 26); } while (x > 0);
      while (s.length < Math.max(len, 3)) s += 'x';
      if (!this.taken.has(s)) return s;
    }
  }

  word(w: string): string {
    if (KEEP_VALUES.has(w.toLowerCase())) return w;
    let m = this.words.get(w.toLowerCase());
    if (!m) { m = /^\d+$/.test(w) ? String(this.num(Number(w))) : this.fresh(this.words.size + 1, 3); this.words.set(w.toLowerCase(), m); }
    return w[0] && w[0] !== w[0].toLowerCase() ? m[0]!.toUpperCase() + m.slice(1) : m;
  }

  num(n: number): number {
    let m = this.nums.get(n);
    if (m === undefined) {
      let c = Number.isInteger(n) ? 7001 + this.nums.size * 13 : 0.5 + this.nums.size * 0.0137;
      while (this.takenNums.has(c)) c += Number.isInteger(n) ? 1 : 0.0001;
      m = c;
      this.nums.set(n, m);
    }
    return m;
  }

  value(v: unknown, key?: string): unknown {
    if (v === null || typeof v === 'boolean' || v === undefined) return v;
    if (typeof v === 'number') return key && COUNT_KEYS.has(key) && Number.isInteger(v) && v >= 0 && v <= 1000 ? v : this.num(v);
    if (typeof v === 'string') {
      if (KEEP_VALUES.has(v)) return v;
      if (UUID_RE.test(v)) { let m = this.ids.get(v); if (!m) { m = `00000000-0000-4000-8000-${String(this.ids.size + 1).padStart(12, '0')}`; this.ids.set(v, m); } return m; }
      if (this.dates.has(v)) return this.dates.get(v);
      return v.replace(WORD_RE, w => this.word(w));
    }
    if (isVector(v)) {
      const k = createHash('sha256').update(JSON.stringify(v)).digest('hex');
      let m = this.vectors.get(k);
      if (!m) {
        let seed = this.vectors.size + 1;
        const raw = v.map(() => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; });
        const norm = Math.hypot(...raw) || 1;
        m = raw.map(x => x / norm);
        this.vectors.set(k, m);
      }
      return m;
    }
    if (Array.isArray(v)) return v.map(x => this.value(x, key));
    if (typeof v === 'object') {
      const r = v as Record<string, unknown>;
      if (typeof r.$typed === 'string' && Array.isArray(r.v)) return { $typed: r.$typed, v: this.value(r.v.length >= 8 ? r.v : [...r.v], key) };
      if (typeof r.$date === 'string') return { $date: this.value(r.$date) };
      if (typeof r.$bigint === 'string') return { $bigint: String(this.num(Number(r.$bigint))) };
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        let nk = k;
        if (!KEEP_KEYS.has(k) && !k.startsWith('$')) { nk = this.keys.get(k) ?? `k${this.fresh(this.keys.size + 1, 3)}`; this.keys.set(k, nk); }
        out[nk] = k.startsWith('$') ? x : this.value(x, k);
      }
      return out;
    }
    return null;
  }
}

/** Shape of a signature that survives synthesis: array indices and hashed keys are compared by kind only. */
export function signatureShape(path: string[]): string {
  return path.map(p => (p.startsWith('[') ? '[]' : KEEP_KEYS.has(p) || p === '$outcome' ? p : '#')).join('.');
}

export interface MinimizeDeps {
  /** A fresh, empty brain of `arm` (each call a new one). */
  freshArm(arm: ArmName): Promise<BrainEngine>;
  /** The PGLite copy, read for the pages the calls name. */
  reference: BrainEngine;
  maxTrials?: number;
}

const stepUnit = (s: ReproStep): Unit => ({ kind: 'call', rec: { member: s.member, args: s.args } as unknown as CaptureRecord, t0: 0, t1: 0, order: '' });

/** Runs a case on fresh arms and returns the first differing call's signature, or null when every call matches. */
export async function caseSignature(c: Pick<ReproCase, 'setup' | 'calls'>, deps: MinimizeDeps): Promise<{ class: DiffClass; path: string[] } | null> {
  const arms: ArmName[] = ['pglite', 'rust'];
  const engines = {} as Record<ArmName, BrainEngine>;
  try {
    for (const a of arms) engines[a] = await deps.freshArm(a);
    for (const s of c.setup) for (const a of arms) await runUnit(engines[a], stepUnit(s));
    const norm = { rust: new NormState(new Set(), { from: Date.now() - 1000, to: Number.MAX_SAFE_INTEGER }) };
    for (const s of c.calls) {
      const outs: Partial<Record<ArmName, Outcome>> = {};
      for (const a of arms) outs[a] = (await runUnit(engines[a], stepUnit(s)))[0]!.out;
      const { cls, path } = classify(outs, norm, false);
      // A typed refusal is a known gap tracked elsewhere; a case is made only of a wrong answer.
      if (cls !== 'match' && cls !== 'capability_missing') return { class: cls, path };
    }
    return null;
  } finally {
    for (const a of arms) await engines[a]?.disconnect().catch(() => undefined);
  }
}

function slugsIn(v: unknown, into: Set<string>): void {
  if (typeof v === 'string' && /^[^\s]{1,300}$/.test(v) && v.includes('/')) into.add(v);
  else if (Array.isArray(v)) v.forEach(x => slugsIn(x, into));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => slugsIn(x, into));
}

/**
 * Minimizes one difference. `calls` are the recorded engine calls (the failing one last, or every call of a
 * differing operation); `earlier` are earlier recorded writes of the run. Returns the synthetic case or a reason.
 */
export async function minimizeDifference(calls: CaptureRecord[], earlier: CaptureRecord[], target: { class: DiffClass; path: string[] } | null, deps: MinimizeDeps):
  Promise<{ ok: true; case: ReproCase } | { ok: false; reason: 'not_minimizable' | 'minimizer_leak' }> {
  const rawCalls: ReproStep[] = calls.map(r => ({ member: r.member!, args: r.args as unknown[] }));
  const slugs = new Set<string>();
  rawCalls.forEach(c => slugsIn(c.args, slugs));
  const rawSetup: ReproStep[] = [];
  for (const slug of [...slugs].sort()) {
    let args: unknown[];
    try {
      const page = await deps.reference.getPage(slug) as Record<string, unknown> | null;
      if (!page) continue;
      args = [slug, { type: page.type, title: page.title, compiled_truth: page.compiled_truth, timeline: page.timeline ?? '', frontmatter: page.frontmatter ?? {} }];
    } catch { continue; } // a segmented page has no inline body (page_body_segmented): the case is built without it
    rawSetup.push({ member: 'putPage', args });
    for (const tag of await deps.reference.getTags(slug).catch(() => [] as string[])) rawSetup.push({ member: 'addTag', args: [slug, tag] });
  }
  for (const r of earlier) {
    const s = new Set<string>();
    slugsIn(decodeValue(r.args), s);
    if ([...s].some(x => slugs.has(x))) rawSetup.push({ member: r.member!, args: r.args as unknown[] });
  }
  const payload = [rawSetup.map(x => x.args), rawCalls.map(x => x.args)];
  const syn = new Synthesizer(payload);
  let setup = rawSetup.map(s => ({ member: s.member, args: syn.value(s.args) as unknown[] }));
  const synCalls = rawCalls.map(s => ({ member: s.member, args: syn.value(s.args) as unknown[] }));
  const want = target ? `${target.class}|${signatureShape(target.path)}` : null;
  const holds = async (st: ReproStep[]) => {
    const sig = await caseSignature({ setup: st, calls: synCalls }, deps);
    return sig && (!want || `${sig.class}|${signatureShape(sig.path)}` === want) ? sig : null;
  };
  let sig = await holds(setup);
  if (!sig) return { ok: false, reason: 'not_minimizable' };
  let trials = deps.maxTrials ?? 16;
  for (let i = setup.length - 1; i >= 0 && trials > 0; i--, trials--) {
    const without = setup.filter((_, j) => j !== i);
    const s = await holds(without);
    if (s) { setup = without; sig = s; }
  }
  const out: ReproCase = { version: REPRO_VERSION, status: 'open', setup, calls: synCalls, expect: { class: sig.class, path: sig.path.map(p => (p.startsWith('[') ? p : KEEP_KEYS.has(p) ? p : '#')) } };
  try { assertNoLeak(payload, { setup: out.setup.map(x => x.args), calls: out.calls.map(x => x.args), expect: out.expect }); } catch { return { ok: false, reason: 'minimizer_leak' }; }
  return { ok: true, case: out };
}
