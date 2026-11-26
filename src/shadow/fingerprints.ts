/**
 * Fact fingerprint checks (shadow follow, plan PR 1). The follower compares the primary's `gbrain_fact_fingerprint*` with the
 * Rust store's for every `facts` row it applies. A probe (follower start, each full reconcile pass) also reads the primary's
 * `lower()` and `[[:space:]]` answer for every code point in one query and compares it with PGLite's (the committed fixture
 * Rust matches), then runs a corpus sample through the SQL functions. It fails only when a stored fact holds a differing code point.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { FactFingerprints } from '../core/rust-engine/store.ts';
import { NOT_RUN_PROBE, type ProbeRecord } from './follow-status.ts';

export const PROBE_CORPUS: readonly string[] = [
  'Hello, World.', 'hello, world.', '  Hello,   World.  ', 'C++', '.NET', '3.5', 'Version 3.5 shipped.', 'He said: "stop!"',
  'tab\tseparated\tvalues', 'new\nline\r\nbreaks', 'non\u00a0breaking\u00a0space', 'ÉCOLE Ünïcode İstanbul', 'straße STRASSE', 'ΣΊΣΥΦΟΣ',
  'emoji \u{1F600} claim', 'a.b.c', '...', '', ' ', 'Mixed CASE and punctuation; semi-colons, commas!',
];

export type FingerprintPair = [string, string];

/** How many of `rust`'s pairs differ from `sql`'s (a missing pair counts as a mismatch). */
export function countFingerprintMismatches(sql: readonly FingerprintPair[], rust: readonly FactFingerprints[]): number {
  let bad = 0;
  for (let i = 0; i < sql.length; i++) {
    if (rust[i]?.fingerprint !== sql[i]![0] || rust[i]?.fingerprint_v1 !== sql[i]![1]) bad++;
  }
  return bad;
}

/** Whether the primary has the fingerprint functions (an older schema does not). */
export async function hasFingerprintFunctions(engine: BrainEngine): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_proc WHERE proname IN ('gbrain_fact_fingerprint', 'gbrain_fact_fingerprint_v1')`);
  return Number(rows[0]?.n ?? 0) >= 2;
}

/** What the probe adds to the record: the host's locale and what its per-code-point answers differ in. */
export type ProbeMeta = Omit<ProbeRecord, 'state' | 'checked_at' | 'mismatches'>;
/** A code point the primary's `lower()` changes or `[[:space:]]` matches: `l` = ascii(lower), `n` its length (-1: the sigma rule). */
export interface CharRow { cp: number; l: number; n: number; sp: boolean }
interface Fixture { lower: Array<[number, number]>; space: number[]; rows: Array<{ name: string; text?: string; rep?: [string, number, string]; fingerprint: string; fingerprint_v1: string }> }

const SAMPLE_EVERY = 6; // every hand row and every sixth seeded row (100 of 600)
const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/** Code points where the primary differs from PGLite (the fixture), ascending. */
export function differingCodePoints(rows: readonly CharRow[], ref: Pick<Fixture, 'lower' | 'space'>): number[] {
  const lower = new Map(ref.lower);
  const space = new Set(ref.space);
  const seen = new Set<number>();
  const out = new Set<number>();
  for (const r of rows) {
    seen.add(r.cp);
    if (r.n !== 1 || r.l !== (lower.get(r.cp) ?? r.cp) || r.sp !== space.has(r.cp)) out.add(r.cp);
  }
  for (const cp of [...lower.keys(), ...space]) if (!seen.has(cp)) out.add(cp); // the reference changes it, the primary does not
  return [...out].sort((a, b) => a - b);
}

/** Fails when a stored fact is affected; a mismatch no differing code point explains fails too. */
function probeState(mismatches: number, m: ProbeMeta): 'pass' | 'fail' {
  if (m.differing_code_points_total > 0) return m.facts_with_differing_code_points > 0 ? 'fail' : 'pass';
  return mismatches + m.corpus_mismatches > 0 ? 'fail' : 'pass';
}

/** The probe corpus as the primary's SQL evaluates it, plus its locale and code-point answers. */
export async function probeOnPrimary(engine: BrainEngine): Promise<{ sql: FingerprintPair[] } & ProbeMeta & { server_version: string | null }> {
  const ref = (await import('../../rust/crates/gbrain-store/tests/fixtures/fact_fingerprints.json', { with: { type: 'json' } })).default as unknown as Fixture;
  const rows = await engine.executeRaw<{ a: string; b: string }>(
    `/* shadow-follow read */ SELECT gbrain_fact_fingerprint(s) AS a, gbrain_fact_fingerprint_v1(s) AS b
       FROM unnest($1::text[]) WITH ORDINALITY AS u(s, n) ORDER BY n`, [[...PROBE_CORPUS]]);
  // lower() and [[:space:]] for every scalar value in one pass; the last arm is the word-final sigma rule.
  const chars = (await engine.executeRaw<{ cp: number | string; l: number | string; n: number | string; sp: boolean }>(
    `/* shadow-follow read */ WITH c AS (SELECT cp, lower(chr(cp)) AS l, chr(cp) ~ '[[:space:]]' AS sp
                                          FROM generate_series(1, 1114111) AS g(cp) WHERE cp < 55296 OR cp > 57343)
     SELECT cp, ascii(l) AS l, length(l) AS n, sp FROM c WHERE l <> chr(cp) OR sp
     UNION ALL SELECT 931, 0, -1, false WHERE lower(chr(913) || chr(931)) <> chr(945) || chr(963)`))
    .map((r) => ({ cp: Number(r.cp), l: Number(r.l), n: Number(r.n), sp: r.sp }));
  const differing = differingCodePoints(chars, ref);
  let seeded = 0;
  const sample = ref.rows.filter((r) => !r.name.startsWith('seeded ') || seeded++ % SAMPLE_EVERY === 0);
  const got = await engine.executeRaw<{ a: string; b: string }>(
    `/* shadow-follow read */ SELECT gbrain_fact_fingerprint(u.t) AS a, gbrain_fact_fingerprint_v1(u.t) AS b
       FROM jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS u(t, ord) ORDER BY u.ord`,
    [JSON.stringify(sample.map((r) => (r.rep ? r.rep[0].repeat(r.rep[1]) + r.rep[2] : r.text ?? '')))]);
  const wrong = sample.filter((r, i) => got[i]?.a !== r.fingerprint || got[i]?.b !== r.fingerprint_v1).map((r) => r.name);
  // A count of stored facts holding a differing code point, never the text (translate drops the listed characters).
  const facts = differing.length === 0 ? [] : await engine.executeRaw<{ n: number | string }>(
    `/* shadow-follow read */ SELECT count(*)::int AS n FROM facts WHERE fact <> translate(fact, $1, '')`, [String.fromCodePoint(...differing)]);
  const meta = await engine.executeRaw<{ v: string; c: string | null; t: string | null; p: string | null; l: string | null }>(
    `SELECT current_setting('server_version') AS v, d.datcollate AS c, d.datctype AS t, to_jsonb(d) ->> 'datlocprovider' AS p,
            COALESCE(to_jsonb(d) ->> 'datlocale', to_jsonb(d) ->> 'daticulocale') AS l
       FROM pg_database d WHERE d.datname = current_database()`).catch(() => []);
  return {
    sql: rows.map((r) => [r.a, r.b] as FingerprintPair), server_version: meta[0]?.v ?? null, collation: meta[0]?.c ?? null,
    ctype: meta[0]?.t ?? null, locale_provider: meta[0]?.p ?? null, locale: meta[0]?.l ?? null,
    differing_code_points: differing.slice(0, 50).map(hex), differing_code_points_total: differing.length,
    corpus_mismatches: wrong.length, corpus_mismatch_rows: wrong.slice(0, 5), facts_with_differing_code_points: Number(facts[0]?.n ?? 0),
  };
}

/** The probe record for the primary's answers against the store's. */
export function probeRecord(sql: readonly FingerprintPair[], rust: readonly FactFingerprints[], meta: Partial<ProbeMeta>, at: Date): ProbeRecord {
  const mismatches = sql.length === PROBE_CORPUS.length ? countFingerprintMismatches(sql, rust) : PROBE_CORPUS.length;
  const record = { ...NOT_RUN_PROBE, ...meta, checked_at: at.toISOString(), mismatches };
  return { ...record, state: probeState(mismatches, record) };
}
