/**
 * The fact fingerprint corpus on the SQL engines: the fixture the Rust fingerprint ports are tested
 * against (rust/crates/gbrain-store/tests/fixtures/fact_fingerprints.json) is what PGLite computes,
 * and a Postgres host differs from it only where that host's own `lower()` or `[[:space:]]` differs.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (PGLite) the committed fixture equals a fresh run of rust/scripts/fact-fingerprint-
 *    fixture.ts on the repository's PGLite, byte for byte: every code point's `lower()` and
 *    `[[:space:]]` answer and both fingerprint versions of every corpus claim. (Postgres) every
 *    claim's `gbrain_fact_normalize`, `gbrain_fact_fingerprint` and `gbrain_fact_fingerprint_v1`
 *    equal the SQL's steps applied with that host's per-character tables, and equal PGLite's
 *    answer for every claim with no character the host treats differently.
 *  - Regression: a fixture left stale after a change to the fingerprint SQL (the Rust tests would
 *    then pin an old answer), a PGLite upgrade that changes a fingerprint, or a host whose
 *    fingerprints differ for a reason other than its character tables.
 *  - Why existing coverage misses it: test/fact-fingerprint-search-path.test.ts pins 24 claims;
 *    nothing checks the Rust fixture or the host's character tables.
 *  - Seam: none. Real engines and the installed SQL functions.
 *
 * The Postgres arm prints the host's differences (server version, collation, ctype and the code
 * points), the input a Postgres-to-Rust swap needs: claims holding those characters fingerprint
 * differently on that host than on Rust.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  buildFingerprintFixture,
  fingerprintCorpus,
  renderFingerprintFixture,
  rowText,
  sqlCharTables,
  sqlFingerprints,
  type SqlArm,
} from '../rust/scripts/lib/fact-fingerprint-corpus.ts';
import { FINGERPRINT_FIXTURE_PATH } from '../rust/scripts/fact-fingerprint-fixture.ts';
import { FINGERPRINT_PUNCTUATION } from '../src/core/facts/withdrawal-schema.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

interface Fixture {
  lower: Array<[number, number]>;
  space: number[];
  rows: Array<{ name: string; fingerprint: string; fingerprint_v1: string }>;
}
const committed = () => readFileSync(FINGERPRINT_FIXTURE_PATH, 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The SQL of the two fingerprints, one step at a time, with the given per-character tables. */
function modelWith(lower: Map<number, number>, space: Set<number>) {
  const low = (c: string) => String.fromCodePoint(lower.get(c.codePointAt(0)!) ?? c.codePointAt(0)!);
  const isSpace = (c: string) => space.has(c.codePointAt(0)!);
  // A maximal run of class characters becomes one space.
  const runs = (chars: string[], cls: (c: string) => boolean) => {
    const out: string[] = [];
    for (let i = 0; i < chars.length;) {
      if (cls(chars[i]!)) {
        while (i < chars.length && cls(chars[i]!)) i++;
        out.push(' ');
      } else out.push(chars[i++]!);
    }
    return out;
  };
  const normalize = (text: string) => {
    const s1 = [...text].map(low).map((c) => (FINGERPRINT_PUNCTUATION.includes(c) ? ' ' : c));
    const s2 = runs(s1, isSpace);
    const s3 = s2.map((c, i) => (c === '.' && (i + 1 === s2.length || s2[i + 1] === '.' || s2[i + 1] === ' ') ? ' ' : c));
    return runs(s3, (c) => c === ' ').join('').replace(/^ +| +$/g, '');
  };
  const v1Input = (text: string) => runs([...text.replace(/^ +| +$/g, '')].map(low), isSpace).join('');
  return { normalize, v1Input };
}

for (const kind of testBackends()) {
  describe(`fact fingerprint corpus (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    if (kind === 'pglite') {
      test('the committed Rust fixture is what PGLite computes, byte for byte', async () => {
        const fresh = renderFingerprintFixture(await buildFingerprintFixture(engine as unknown as SqlArm));
        // On a difference, rerun `bun rust/scripts/fact-fingerprint-fixture.ts --write` and review it.
        expect(fresh === committed()).toBe(true);
      }, 120_000);
      return;
    }

    test('the host differs from PGLite only where its own lower() or [[:space:]] does', async () => {
      const fixture = JSON.parse(committed()) as Fixture;
      const corpus = fingerprintCorpus();
      const texts = corpus.map(rowText);
      const chars = [...new Set(texts.flatMap((t) => [...t].map((c) => c.codePointAt(0)!)))];
      const host = await sqlCharTables(engine as unknown as SqlArm, chars);
      const answers = await sqlFingerprints(engine as unknown as SqlArm, texts);

      const pgliteLower = new Map(fixture.lower);
      const pgliteSpace = new Set(fixture.space);
      const hostLower = new Map(host.lower);
      const hostSpace = new Set(host.space);
      const unmodelled = new Set(host.unmodelled);
      const different = new Set(chars.filter((cp) => unmodelled.has(cp)
        || (hostLower.get(cp) ?? cp) !== (pgliteLower.get(cp) ?? cp) || hostSpace.has(cp) !== pgliteSpace.has(cp)));
      const model = modelWith(hostLower, hostSpace);

      const unexplained: string[] = [];
      const differing: string[] = [];
      corpus.forEach((row, i) => {
        const text = texts[i]!;
        const got = answers[i]!;
        const want = fixture.rows[i]!;
        expect(want.name).toBe(row.name);
        // Every answer follows from the host's own tables...
        // A claim with a character the host's lower() cannot be tabled for (ICU) is only compared with PGLite below.
        const modelled = ![...text].some((c) => unmodelled.has(c.codePointAt(0)!));
        if (modelled && (got.normalize !== model.normalize(text) || got.fingerprint !== sha256(model.normalize(text))
          || got.fingerprint_v1 !== sha256(model.v1Input(text)))) unexplained.push(row.name);
        // ...and a claim with no host-different character fingerprints exactly as on PGLite (and Rust).
        const same = got.fingerprint === want.fingerprint && got.fingerprint_v1 === want.fingerprint_v1;
        if (!same) differing.push(row.name);
        if (!same && ![...text].some((c) => different.has(c.codePointAt(0)!))) unexplained.push(`${row.name} (no host-different character)`);
      });

      const [settings] = await engine.executeRaw<{ v: string; collate: string; ctype: string; provider: string }>(
        `SELECT version() AS v, datcollate AS collate, datctype AS ctype, datlocprovider::text AS provider
           FROM pg_database WHERE datname = current_database()`);
      console.log(`[fingerprint host] ${settings!.v}; collate=${settings!.collate} ctype=${settings!.ctype} provider=${settings!.provider}`);
      console.log(`[fingerprint host] ${different.size} corpus code point(s) differ from PGLite: ${[...different].sort((a, b) => a - b)
        .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`).join(' ') || 'none'}`);
      console.log(`[fingerprint host] ${differing.length} of ${corpus.length} claims fingerprint differently than on PGLite and Rust`);
      expect(unexplained).toEqual([]);
    }, 180_000);
  });
}
