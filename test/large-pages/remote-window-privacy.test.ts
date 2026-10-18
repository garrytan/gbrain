/**
 * Wave B PR 2 (spec 7.3 item 9): no remote window of a segmented page shows
 * text the whole-body read projection hides.
 *
 * 1. Protects: remote readBodyRange windows (stored and projected space) and
 *    the projected outline over pages seeded with takes, private facts rows,
 *    withdrawn / purged / held rows, private keys, a truncated tail and a
 *    facts fence longer than a segment; windows start inside each private
 *    block, on either side of every forced cut, and at random bytes.
 *    Without a ledger the withdrawn / purged / held rows are ordinary world
 *    rows, so only the ledger test counts them.
 * 2. Fails when: a window projects only its slice (a block whose opener sits
 *    before the window start leaks), the truncated-tail rule is dropped, the
 *    ledger is not applied per segment, or a fence split by a forced cut is
 *    rendered from its half. PUBLIC tokens must still appear.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { openSegmentedBody, projectedOutline } from '../../src/core/page-body/read-range.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import {
  PRIVATE, PUBLIC, crossingFacts, importSegmented, pageContent, privacyText, privateTokensIn, readRange, seedLedger, storedOffsets,
} from '../helpers/segmented-privacy-fixture.ts';

let engine: BrainEngine;

/** Remote windows at every interesting start: none may contain a private token; all of them together show the public ones. */
async function expectNoLeak(pageId: number, r: () => number, needles: string[], ledger = false) {
  const body = await openSegmentedBody(engine, { pageId });
  const starts = new Set<number>();
  for (const needle of needles) for (const at of (await storedOffsets(engine, pageId, needle)).slice(0, 8)) for (const d of [0, 1, 40, 400]) starts.add(Math.max(0, at - d));
  for (const row of body.rows) for (const d of [-64, -1, 0, 1]) starts.add(Math.max(0, row.byteStart + d));
  for (let i = 0; i < 20; i++) starts.add(Math.floor(r() * body.bodyBytes));
  const seen = { public: new Set<string>() };
  for (const start of starts) {
    for (const space of ['stored', 'projected'] as const) {
      const win = await readRange(engine, { pageId, space, start, end: start + 2_000 + Math.floor(r() * 60_000), audience: 'remote', body });
      const text = win.bytes.toString('utf8');
      expect({ start, space, leaked: privateTokensIn(text, { ledger }) }).toEqual({ start, space, leaked: [] });
      for (const token of Object.values(PUBLIC)) if (text.includes(token)) seen.public.add(token);
    }
  }
  const whole = (await readRange(engine, { pageId, space: 'projected', start: 0, end: Infinity, audience: 'remote', body })).bytes.toString('utf8');
  expect(privateTokensIn(whole, { ledger })).toEqual([]);
  for (const token of Object.values(PUBLIC)) expect(whole).toContain(token);
  expect([...seen.public].sort()).toEqual(Object.values(PUBLIC).sort());
  const outline = await projectedOutline(engine, body, 0, 100_000);
  expect(privateTokensIn(JSON.stringify(outline.entries), { ledger })).toEqual([]);
  expect(outline.entries.some(e => e.heading?.includes(PUBLIC.prose))).toBe(true);
  return body;
}

for (const kind of testBackends()) {
  describe(`remote windows of a segmented page (${kind})`, () => {
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);

    afterAll(async () => { await close(); });

    beforeEach(async () => {
      for (const table of ['pages', 'fact_withdrawals', 'fact_purges', 'write_gate_holds']) await engine.executeRaw(`DELETE FROM ${table}`);
    });

    test('windows starting inside takes, facts and key blocks, at cuts and at random bytes show nothing private', async () => {
      const r = mulberry32(101);
      const pageId = await importSegmented(engine, 'notes/windows', pageContent(privacyText(r, 1_600_000), privacyText(r, 300_000)));
      const body = await expectNoLeak(pageId, r, [PRIVATE.takes, PRIVATE.takesHeading, PRIVATE.privateFact, PRIVATE.key]);
      expect(body.rows.length).toBeGreaterThan(3);
    }, 300_000);

    test('withdrawn, purged and held rows stay hidden in every window once the ledger records them', async () => {
      const r = mulberry32(103);
      const slug = 'notes/ledger-windows';
      const pageId = await importSegmented(engine, slug, pageContent(privacyText(r, 1_400_000), privacyText(r, 200_000)));
      const before = (await readRange(engine, { pageId, space: 'projected', start: 0, end: Infinity, audience: 'remote' })).bytes.toString('utf8');
      expect(before).toContain(PRIVATE.withdrawn);
      await seedLedger(engine, slug);
      await expectNoLeak(pageId, r, [PRIVATE.withdrawn, PRIVATE.purged, PRIVATE.held], true);
    }, 300_000);

    test('a takes block left open to the end of the body hides the rest of the page in every later segment', async () => {
      const r = mulberry32(107);
      const tail = `<!--- gbrain:takes:begin -->\n${privacyText(r, 1_200_000, { keys: false }).replaceAll('zzpublic', `${PRIVATE.tail} `)}\n${PRIVATE.tail} last words\n`;
      const pageId = await importSegmented(engine, 'notes/tail', pageContent(privacyText(r, 1_200_000) + tail));
      const body = await expectNoLeak(pageId, r, [PRIVATE.tail]);
      const tailAt = await storedOffsets(engine, pageId, PRIVATE.tail);
      expect(body.rows.filter(row => row.byteStart > tailAt[0]!).length).toBeGreaterThan(1);
    }, 300_000);

    test('a facts fence cut by forced cuts shows no private row in any window', async () => {
      const r = mulberry32(109);
      const pageId = await importSegmented(engine, 'notes/crossing-windows', pageContent(privacyText(r, 500_000, { keys: false }) + crossingFacts() + privacyText(r, 600_000)));
      await expectNoLeak(pageId, r, [PRIVATE.crossing]);
    }, 300_000);
  });
}
