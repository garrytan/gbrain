/**
 * BrainEngine parity: withdrawals match claims by fingerprint on every engine, over the whole
 * fingerprint corpus (rust/scripts/lib/fact-fingerprint-corpus.ts: every whitespace class, Turkish
 * I, sharp s, final sigma, ligatures, combining marks, NFC/NFD pairs, RTL, CJK, emoji, long text and
 * seeded random claims).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a withdrawal recorded for one claim reaches exactly the claims whose
 *    `gbrain_fact_fingerprint` or `gbrain_fact_fingerprint_v1` equals the withdrawn claim's
 *    fingerprint, on PGLite, Postgres and Rust alike; a fact saved later with such a claim is
 *    stored withdrawn, and a fact read back carries the same fingerprint.
 *  - Regression: an engine whose fingerprint differs by one byte for some text (a whitespace
 *    class, a case mapping, the sentence-dot rule) silently brings a forgotten claim back, or
 *    hides a claim nobody withdrew.
 *  - Why existing coverage misses it: test/engine-parity/facts.test.ts and the purge-ledger cases
 *    use a handful of ASCII claims; the Rust fingerprint unit tests compare pure functions, not the
 *    withdrawal ledger, the save-time fence and the fingerprint read the engines serve.
 *  - Seam: none. Real engines, typed members only.
 *
 * Postgres computes fingerprints with the host's own `lower()` and `[[:space:]]`, which can differ
 * from PGLite's (a glibc host counts U+1680 as space and not U+0085, and lowers circled letters).
 * test/fact-fingerprint-corpus.test.ts reports those host differences; here the claims holding a
 * character the Postgres arm's host treats differently are left out on every arm, so each arm is
 * compared on the same claims.
 */
import { beforeAll, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { fingerprintCorpus, rowText, sqlCharTables, type CorpusRow, type SqlArm } from '../../rust/scripts/lib/fact-fingerprint-corpus.ts';
import { FINGERPRINT_FIXTURE_PATH } from '../../rust/scripts/fact-fingerprint-fixture.ts';
import { readFileSync } from 'node:fs';

const suite = parityArms(testBackends());
const { parityTest } = suite;

const SRC = 'default';
const ENTITY = 'people/alice-example';
const LONG = 2_000;

/** Code points whose `lower()` or `[[:space:]]` answer on the Postgres arm differs from PGLite's. */
let hostDifferences = new Set<number>();

beforeAll(async () => {
  const pg = suite.arms().find((arm) => arm.backend === 'postgres');
  if (!pg) return;
  const fixture = JSON.parse(readFileSync(FINGERPRINT_FIXTURE_PATH, 'utf8')) as { lower: Array<[number, number]>; space: number[] };
  const lower = new Map(fixture.lower);
  const space = new Set(fixture.space);
  const chars = [...new Set(fingerprintCorpus().flatMap((row) => [...rowText(row)].map((c) => c.codePointAt(0)!)))];
  const host = await sqlCharTables(pg.engine as unknown as SqlArm, chars);
  const hostLower = new Map(host.lower);
  const hostSpace = new Set(host.space);
  const unmodelled = new Set(host.unmodelled);
  hostDifferences = new Set(chars.filter((cp) => unmodelled.has(cp)
    || (hostLower.get(cp) ?? cp) !== (lower.get(cp) ?? cp) || hostSpace.has(cp) !== space.has(cp)));
}, 120_000);

/** The claims every arm compares: no host-different character, and long rows cut to `LONG` characters. */
function claims(): Array<{ name: string; text: string }> {
  return fingerprintCorpus()
    .map((row: CorpusRow) => ({ name: row.name, text: rowText(row).slice(0, LONG) }))
    .filter(({ text }) => ![...text].some((c) => hostDifferences.has(c.codePointAt(0)!)))
    // A lone surrogate can appear where the slice cut a pair in two.
    .filter(({ text }) => !/[\ud800-\udbff]$/.test(text));
}

/** Every third claim is withdrawn; the rest are only probed. */
const withdrawn = (i: number) => i % 3 === 0;

parityTest(
  'a withdrawal reaches exactly the corpus claims with its fingerprint, on every engine',
  { methods: ['insertFactWithdrawal', 'isFactWithdrawn'], timeout: 180_000 },
  async (engine: BrainEngine) => {
    const rows = claims();
    for (const [i, row] of rows.entries()) {
      if (withdrawn(i)) await engine.insertFactWithdrawal(SRC, 'world', row.text, '*', '2026-01-03T00:00:00.000Z');
    }
    const answers: string[] = [];
    for (const row of rows) {
      const hit = await engine.isFactWithdrawn(SRC, 'world', row.text, ENTITY, null);
      answers.push(`${row.name}=${hit}`);
    }
    // Withdrawn claims must find their own withdrawal; a probe-only claim may share a fingerprint.
    for (const [i, row] of rows.entries()) {
      if (withdrawn(i)) expect({ name: row.name, hit: answers[i] }).toEqual({ name: row.name, hit: `${row.name}=true` });
    }
    // Not vacuous: many probe-only claims share a withdrawn fingerprint, and many do not.
    const probes = answers.filter((_, i) => !withdrawn(i));
    expect(probes.filter((a) => a.endsWith('=true')).length).toBeGreaterThan(50);
    expect(probes.filter((a) => a.endsWith('=false')).length).toBeGreaterThan(200);
    return answers;
  },
);

parityTest(
  'a corpus claim saved after a withdrawal is stored withdrawn exactly when its fingerprint matches, and reads back with the same fingerprint',
  { methods: ['insertFactWithdrawal', 'insertFact', 'listFactsSince'], timeout: 180_000 },
  async (engine: BrainEngine) => {
    // Hand rows only (the seeded rows run in the case above): withdraw every third, then save each
    // claim as a fact on one entity.
    // Claims that start with U+FEFF are left out here (the case above covers them): the PGLite and
    // postgres.js clients drop a leading U+FEFF from text they read back, while the Rust engine
    // returns the stored text, so the fact text would differ although every fingerprint matches.
    const rows = claims().filter((row) => !row.name.startsWith('seeded ') && !row.text.startsWith('\ufeff'));
    for (const [i, row] of rows.entries()) {
      if (withdrawn(i)) await engine.insertFactWithdrawal(SRC, 'world', row.text, '*', '2026-01-03T00:00:00.000Z');
    }
    const statuses: string[] = [];
    for (const row of rows) {
      try {
        const r = await engine.insertFact({ fact: row.text, entity_slug: ENTITY, visibility: 'world', source: 'mcp:remember' }, { source_id: SRC });
        statuses.push(`${row.name}=${r.status}`);
      } catch (error) {
        statuses.push(`${row.name}=error ${(error as { code?: string }).code ?? 'uncoded'}`);
      }
    }
    // Read every stored row, withdrawn ones included, a page at a time (a read returns at most 100).
    const read = [];
    for (let offset = 0; ; offset += 100) {
      const page = await engine.listFactsSince(SRC, new Date(0), { fingerprint: true, entitySlug: ENTITY, activeOnly: false, limit: 100, offset });
      read.push(...page);
      if (page.length < 100) break;
    }
    const stored = read
      .map((r) => `${JSON.stringify(r.fact)} expired=${r.expired_at instanceof Date} fp=${r.fact_fingerprint}`)
      .sort();
    expect(read.length).toBe(statuses.filter((s) => s.endsWith('=inserted')).length);
    expect(stored.filter((s) => s.includes(' expired=true ')).length).toBeGreaterThan(50);
    expect(stored.filter((s) => s.includes(' expired=false ')).length).toBeGreaterThan(20);
    return { statuses, stored };
  },
);
