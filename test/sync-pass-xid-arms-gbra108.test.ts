/**
 * GBRA-108: the confirm round's fold proof (src/core/persistence/sync-pass-confirm.ts) judges each row against S1's
 * snapshot in the 32-bit xid space: S1's 64-bit cut, in-progress list and own id become xids, and a row is unchanged when
 * \`age(xmin) > age(S1.xmin)\` or \`age(xmin) > age(cut)\`, its xmin is not listed and is not S1's own. This replaced the
 * 64-bit form (each xmin widened against S2's xmax and compared as a 64-bit id), which cost a per-row cast and three
 * widenings on every row a held older transaction kept from the \`age\` short-circuit.
 *
 * Protects: for generated xid layouts the 32-bit predicate's verdict equals the 64-bit form's on every row, under the
 * proof's bound (every id within 2^31 of S2; a txid never has the low words 0-2). The layouts cover S1 with and without
 * in-progress transactions, an idle older transaction holding S1's xmin, subtransaction ids above the cut, rows exactly at
 * the cut, at S1's xmax and at S1's own id, frozen and bootstrap xmins, rows newer than S2's own id, no recorded snapshot,
 * and the 32-bit wrap: \`age\` counts back from this transaction's real id, the 64-bit ids are that id's low word placed in
 * a synthetic epoch, and rows below it cross into the previous epoch's top words.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loAge, s1XidArms, unchanged } from '../src/core/persistence/sync-pass-confirm.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const W = 4294967296n;
const SPAN = 2n ** 31n;
/** The replaced 64-bit form: a 32-bit xmin widened against S2's xmax, compared with S1's 64-bit cut, list and own id. */
const full = (col: string) => '(x.hi - ((x.hi % 4294967296) - ' + col + '::text::bigint + 4294967296) % 4294967296)';
const sixtyFour = (col: string) => '(age(' + col + ') > x.lo_age OR COALESCE(' + full(col) + ' < s1.cut64 AND ' + full(col) + ' <> ALL(s1.xip64) AND '
  + full(col) + ' IS DISTINCT FROM s1.own64, false))';
const VERDICTS = 'WITH x AS (SELECT $1::bigint AS hi, ' + loAge('$2::bigint') + ' AS lo_age),\n'
  + '  c AS (SELECT $3::bigint AS cut, $4::bigint[] AS xip, $5::bigint AS own),\n'
  + '  s1 AS (SELECT ' + s1XidArms('c.cut', 'c.xip', 'c.own') + ', c.cut AS cut64, c.xip AS xip64, c.own AS own64 FROM c),\n'
  + '  v AS (SELECT n, t::xid AS xmin FROM unnest($6::text[]) WITH ORDINALITY AS r(t, n))\n'
  + 'SELECT v.n::int AS n, ' + unchanged('v.xmin') + ' AS xid32, ' + sixtyFour('v.xmin') + ' AS id64, age(v.xmin) > x.lo_age AS by_lo FROM v, x, s1 ORDER BY v.n';

/** A seeded generator (mulberry32), so a failing layout reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!, chance: (p: number) => next() < p };
}
/** A real txid never takes the special low words 0 (invalid), 1 (bootstrap) or 2 (frozen). */
const normal = (id: bigint) => id % W > 2n;

interface Layout { hi: bigint; lo: bigint; cut: bigint | null; xip: bigint[]; own: bigint | null; rows: string[]; crossing: boolean }

/** One layout around \`now\` (this transaction's real id): every 64-bit id is shifted by \`epoch\` words, keeping its low word. */
function layout(now: bigint, seed: number): Layout {
  const r = rng(seed);
  const epoch = BigInt(r.pick([1, 2, 7, 1 << 20]));
  const shift = epoch * W;
  const base = shift + now;
  const hi = base + BigInt(r.int(1, 800));
  // How far below S2 S1 sits: near, past the 32-bit wrap below the real id, or near the 2^31 bound.
  const reach = r.pick([BigInt(r.int(5, 2000)), now % W + BigInt(r.int(1, 5000)), SPAN - BigInt(r.int(5000, 20000))]);
  const s1Max = base + BigInt(r.int(-1500, 400)) - (r.chance(0.5) ? reach : 0n);
  const shape = r.pick(['empty', 'listed', 'idle-older', 'no-snapshot'] as const);
  const xip: bigint[] = [];
  if (shape === 'listed' || shape === 'idle-older') for (let i = r.int(1, 5); i > 0; i--) xip.push(s1Max - BigInt(r.int(1, 1500)));
  if (shape === 'idle-older') xip.push(hi - reach - BigInt(r.int(0, 3)));
  const listed = [...new Set(xip.filter(normal).filter(id => hi - id < SPAN))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const xmin = listed.length ? listed[0]! : s1Max;
  const committed = listed.filter(() => r.chance(0.5));
  const cut = shape === 'no-snapshot' ? null : committed.reduce((m, id) => (id < m ? id : m), s1Max);
  const own = shape !== 'no-snapshot' && r.chance(0.6) ? (() => { for (let i = 0; i < 20; i++) { const id = xmin + BigInt(r.int(0, Number(s1Max - xmin))); if (!listed.includes(id) && normal(id)) return id; } return null; })() : null;
  const near = (id: bigint | null) => (id === null ? [] : [id - 1n, id, id + 1n]);
  const ids = [...near(cut), ...near(s1Max), ...near(own), ...near(xmin), ...listed.flatMap(near), ...near(hi - 1n), ...near(base),
    ...Array.from({ length: 6 }, () => (cut ?? s1Max) + BigInt(r.int(1, 300))),
    ...Array.from({ length: 10 }, () => hi - 1n - BigInt(r.int(0, Number(hi - xmin + 2000n)))),
    ...Array.from({ length: 4 }, () => shift - BigInt(r.int(0, 3000))), ...Array.from({ length: 4 }, () => shift + BigInt(r.int(3, 3000)))];
  const rows = [...new Set(ids.filter(id => id < hi && hi - id < SPAN && normal(id)).map(id => String(id % W))), '2', '1'];
  const crossing = [hi, xmin, ...ids].some(id => id < shift) && [hi, xmin].some(id => id >= shift);
  return { hi, lo: xmin, cut, xip: listed, own, rows, crossing };
}

const backends = testBackends();
const engines: Array<[string, BrainEngine]> = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-xid-arms-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(['pglite', engine]);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(['postgres', pg.engine]); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const [, engine] of engines) await engine.disconnect();
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

for (const backend of backends) {
  describe('GBRA-108: the fold proof\'s 32-bit xid arms (' + backend + ')', () => {
    test('agree with the 64-bit form on every row of every generated layout', async () => {
      const engine = engines.find(([kind]) => kind === backend)![1];
      const seen = { rows: 0, bySnapshot: 0, changedBySnapshot: 0, crossing: 0, idleOlder: 0, noSnapshot: 0 };
      const disagreements: string[] = [];
      await engine.transaction(async tx => {
        // \`age\` counts back from this transaction's own id once it has one.
        const [{ now }] = await tx.executeRaw<{ now: string }>('SELECT txid_current()::text AS now');
        for (let seed = 1; seed <= 400; seed++) {
          const l = layout(BigInt(now), seed);
          const rows = await tx.executeRaw<{ n: number; xid32: boolean; id64: boolean; by_lo: boolean }>(VERDICTS,
            [String(l.hi), String(l.lo), l.cut === null ? null : String(l.cut), '{' + l.xip.join(',') + '}', l.own === null ? null : String(l.own), '{' + l.rows.join(',') + '}']);
          expect(rows.length).toBe(l.rows.length);
          for (const row of rows) {
            seen.rows++;
            if (!row.by_lo) { seen.bySnapshot++; if (!row.id64) seen.changedBySnapshot++; }
            if (row.xid32 !== row.id64) disagreements.push('seed ' + seed + ' xmin ' + l.rows[row.n - 1] + ': 32-bit ' + row.xid32 + ', 64-bit ' + row.id64 + ' ' + JSON.stringify(l, (_k, v) => typeof v === 'bigint' ? String(v) : v));
          }
          if (l.crossing) seen.crossing++;
          if (l.cut === null) seen.noSnapshot++;
          if (l.xip.length && l.lo < l.hi - 1_000_000n) seen.idleOlder++;
        }
      });
      expect(disagreements.slice(0, 5)).toEqual([]);
      // The layouts reach the snapshot arm on both verdicts, the 32-bit wrap, an idle older xmin and a missing snapshot.
      expect(seen.bySnapshot).toBeGreaterThan(1000);
      expect(seen.changedBySnapshot).toBeGreaterThan(100);
      expect(seen.bySnapshot - seen.changedBySnapshot).toBeGreaterThan(100);
      expect(seen.crossing).toBeGreaterThan(20);
      expect(seen.idleOlder).toBeGreaterThan(20);
      expect(seen.noSnapshot).toBeGreaterThan(20);
    }, 180_000);
  });
}
