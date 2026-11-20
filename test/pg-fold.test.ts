/**
 * #8433: pg-fold.ts spells PGLite's case fold in SQL, so a Postgres server on any locale lowers and uppercases text the
 * way PGLite and the Rust engine do. Authoring gate: (1) protects the case maps against PGLite's own lower() and upper()
 * over every code point, the Rust store's copy (cli_reads/pg_case.rs CASE_MAP) and the SQL fold of mixed strings on every
 * engine; (2) fails when a map entry, a block guard or the ASCII fast path drifts, or when the Rust table drifts from the
 * TS ones; (3) the map comparison runs in the database (ascii() code points), never through decoded JavaScript strings;
 * (4) no production seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PGLITE_LOWER_MAP, PGLITE_UPPER_MAP, pgliteLowerSql, pgliteUpperSql } from '../src/core/pg-fold.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const ROOT = new URL('..', import.meta.url).pathname;
/** Every code point chr() accepts: no NUL, no surrogate. */
const CODE_POINTS = 'generate_series(1, 1114111) AS g(c) WHERE (g.c < 55296 OR g.c > 57343)';

/** The JS reading of the SQL lower: the per-code-point map. */
const expectedLower = (text: string) => [...text].map(ch => String.fromCodePoint(PGLITE_LOWER_MAP.get(ch.codePointAt(0)!) ?? ch.codePointAt(0)!)).join('');
/** The JS reading of the SQL upper. */
const expectedUpper = (text: string) => [...text].map(ch => String.fromCodePoint(PGLITE_UPPER_MAP.get(ch.codePointAt(0)!) ?? ch.codePointAt(0)!)).join('');

const MIXED = [
  'plain ascii, Mixed CASE',
  '\u24b6 circled \u24d0 \u00df stra\u00dfe \u0130stanbul',
  'Tabs\tand\u00a0nbsp\u2003em\u0085nel\u1680ogham',
  '\u{10570} Vithkuqi \ua7c0 \ua7d0 \u{1e900}adlam',
  '\u0391\u03a3\u03a9 \u0410\u042f \u13a0 \u1c90 \uff21\uff3a',
  '  leading\u3000and\u2028trailing\u205f  ',
  'emoji \u{1f389} and \u{10400} deseret',
  '',
];

describe('pg-fold tables (Rust store copies)', () => {
  test('the Rust CASE_MAP equals the TS lower and upper maps', () => {
    const src = readFileSync(`${ROOT}rust/crates/gbrain-store/src/cli_reads/pg_case.rs`, 'utf8');
    const lower = new Map<number, number>(), upper = new Map<number, number>();
    for (const [, c, l, u] of src.matchAll(/\((\d+), (\d+), (\d+)\)/g)) {
      if (Number(l) !== Number(c)) lower.set(Number(c), Number(l));
      if (Number(u) !== Number(c)) upper.set(Number(c), Number(u));
    }
    expect(lower.size).toBeGreaterThan(1000);
    expect([...lower].sort((a, b) => a[0] - b[0])).toEqual([...PGLITE_LOWER_MAP].sort((a, b) => a[0] - b[0]));
    expect([...upper].sort((a, b) => a[0] - b[0])).toEqual([...PGLITE_UPPER_MAP].sort((a, b) => a[0] - b[0]));
  });
});

for (const kind of testBackends()) {
  describe(`pg-fold SQL (${kind})`, () => {
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

    test('the SQL lower and upper equal the PGLite maps over every code point', async () => {
      const rows = await engine.executeRaw<{ c: number; l: number; u: number }>(`SELECT c, l, u FROM (
          SELECT g.c, pg_catalog.ascii(${pgliteLowerSql('pg_catalog.chr(g.c)')}) AS l, pg_catalog.ascii(${pgliteUpperSql('pg_catalog.chr(g.c)')}) AS u
            FROM ${CODE_POINTS}) x
        WHERE l <> c OR u <> c ORDER BY c`);
      const lower = new Map<number, number>(), upper = new Map<number, number>();
      for (const r of rows) {
        const c = Number(r.c);
        if (Number(r.l) !== c) lower.set(c, Number(r.l));
        if (Number(r.u) !== c) upper.set(c, Number(r.u));
      }
      expect([...lower]).toEqual([...PGLITE_LOWER_MAP].sort((a, b) => a[0] - b[0]));
      expect([...upper]).toEqual([...PGLITE_UPPER_MAP].sort((a, b) => a[0] - b[0]));
    }, 120_000);

    if (kind === 'pglite') {
      test('on PGLite the SQL fold is PGLite\'s own lower() and upper(), code point by code point', async () => {
        const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${CODE_POINTS}
          AND (${pgliteLowerSql('pg_catalog.chr(g.c)')} <> pg_catalog.lower(pg_catalog.chr(g.c))
            OR ${pgliteUpperSql('pg_catalog.chr(g.c)')} <> pg_catalog.upper(pg_catalog.chr(g.c)))`);
        expect(Number(row!.n)).toBe(0);
      }, 120_000);
    }

    test('mixed strings lower and upper as the JS reading of the maps says', async () => {
      const rows = await engine.executeRaw<{ l: string; u: string }>(`SELECT ${pgliteLowerSql('t.s')} AS l, ${pgliteUpperSql('t.s')} AS u
        FROM unnest($1::text[]) WITH ORDINALITY AS t(s, i) ORDER BY t.i`, [MIXED]);
      expect(rows.map(r => [r.l, r.u])).toEqual(MIXED.map(m => [expectedLower(m), expectedUpper(m)]));
    });
  });
}
