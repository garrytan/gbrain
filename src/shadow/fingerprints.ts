/**
 * Fact fingerprint checks (shadow follow, plan PR 1). The primary computes `gbrain_fact_fingerprint(claim)` and
 * `gbrain_fact_fingerprint_v1(claim)` in SQL; the Rust store computes its own. The follower compares them for every
 * `facts` row it applies, and a fixed probe corpus is evaluated on both sides at follower start and with each full
 * reconcile pass, so a server whose `lower()` or whitespace rules differ shows up as a failed probe.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { FactFingerprints } from '../core/rust-engine/store.ts';
import type { ProbeRecord } from './follow-status.ts';

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

/** The probe corpus as the primary's SQL evaluates it, plus the server facts the record carries. */
export async function probeOnPrimary(engine: BrainEngine): Promise<{ sql: FingerprintPair[]; server_version: string | null; collation: string | null }> {
  const rows = await engine.executeRaw<{ a: string; b: string }>(
    `/* shadow-follow read */ SELECT gbrain_fact_fingerprint(s) AS a, gbrain_fact_fingerprint_v1(s) AS b
       FROM unnest($1::text[]) WITH ORDINALITY AS u(s, n) ORDER BY n`, [[...PROBE_CORPUS]]);
  const meta = await engine.executeRaw<{ v: string; c: string | null }>(
    `SELECT current_setting('server_version') AS v, (SELECT datcollate FROM pg_database WHERE datname = current_database()) AS c`).catch(() => []);
  return { sql: rows.map((r) => [r.a, r.b] as FingerprintPair), server_version: meta[0]?.v ?? null, collation: meta[0]?.c ?? null };
}

/** The probe record for the primary's answers against the store's. */
export function probeRecord(sql: readonly FingerprintPair[], rust: readonly FactFingerprints[], meta: { server_version: string | null; collation: string | null }, at: Date): ProbeRecord {
  const mismatches = sql.length === PROBE_CORPUS.length ? countFingerprintMismatches(sql, rust) : PROBE_CORPUS.length;
  return { state: mismatches ? 'fail' : 'pass', checked_at: at.toISOString(), ...meta, mismatches };
}
