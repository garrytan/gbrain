/**
 * Wave B PR 2 (spec 7.3 item 8): the segment reader's read projection equals
 * whole-body sanitization of the same stored body, byte for byte.
 *
 * 1. Protects: readBodyRange over a segmented page, in projected space (any
 *    window) and stored space (remote: pieces sit at their projected
 *    offsets; trusted: the overlaid stored stream), equals projectPageText
 *    over the joined body (readPageDocument), across marker, fence, backtick,
 *    key, facts and takes soup, a ledger (withdrawn, purged and held rows),
 *    low-tier rows, a timeline, stale metadata; plus totals, line starts and
 *    the outline. A case that cannot match byte for byte (a facts fence
 *    longer than a segment) never shows more.
 * 2. Fails when: a segment is projected without its stored regions, the
 *    withdrawal or fence overlay is skipped, the low-tier block or the
 *    timeline separator moves, an offset sum drifts, or stale metadata serves
 *    the stored text.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { maintenanceTransaction } from '../../src/core/persistence/attribution.ts';
import { withTrustBackfill } from '../../src/core/persistence/context.ts';
import { lineOffset, pageOutline, totalLines } from '../../src/core/page-window/window.ts';
import {
  openSegmentedBody, projectedLayout, projectedLineStart, projectedOutline, projectedTotals,
} from '../../src/core/page-body/read-range.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import {
  PRIVATE, PUBLIC, crossingFacts, factRow, importSegmented, inlineProjection, overlaidStoredBody, pageContent, privacyText, privateTokensIn,
  readRange, seedLedger,
} from '../helpers/segmented-privacy-fixture.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { KEY_BODY } from '../helpers/segment-bodies.ts';

let engine: BrainEngine;

const KEYS = (s: string) => s.split(KEY_BODY).length - 1;

/** Every way of reading the page agrees with the inline projection `want`. */
async function expectParity(pageId: number, want: Buffer, r: () => number, stored: { compiled_truth: string; timeline: string }) {
  const body = await openSegmentedBody(engine, { pageId });
  const whole = await readRange(engine, { pageId, space: 'projected', start: 0, end: Infinity, audience: 'remote', body });
  expect(whole.bytes.equals(want)).toBe(true);
  const trusted = await readRange(engine, { pageId, space: 'projected', start: 0, end: Infinity, audience: 'trusted', body });
  expect(trusted.bytes.equals(want)).toBe(true);
  for (let i = 0; i < 12; i++) {
    const start = Math.floor(r() * want.length);
    const end = Math.min(want.length, start + 1 + Math.floor(r() * 300_000));
    const win = await readRange(engine, { pageId, space: 'projected', start, end, audience: 'remote', body });
    expect(win.bytes.equals(want.subarray(start, end))).toBe(true);
    for (const piece of win.pieces) expect(piece.bytes.equals(want.subarray(piece.projectedStart, piece.projectedStart + piece.bytes.length))).toBe(true);
  }
  const remoteStored = await readRange(engine, { pageId, space: 'stored', start: 0, end: Infinity, audience: 'remote', body });
  for (const piece of remoteStored.pieces) expect(piece.bytes.equals(want.subarray(piece.projectedStart, piece.projectedStart + piece.bytes.length))).toBe(true);
  const trustedStored = await readRange(engine, { pageId, space: 'stored', start: 0, end: Infinity, audience: 'trusted', body });
  expect(trustedStored.bytes.toString('utf8')).toBe(stored.compiled_truth + stored.timeline);
  const totals = await projectedTotals(engine, body);
  expect(totals.total_bytes).toBe(want.length);
  expect(totals.total_lines).toBe(totalLines(want));
  for (let i = 0; i < 6; i++) {
    const line = 1 + Math.floor(r() * (totals.total_lines + 2));
    expect(await projectedLineStart(engine, body, line)).toBe(lineOffset(want, line));
  }
  return body;
}

for (const kind of testBackends()) {
  describe(`read projection parity (${kind})`, () => {
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
      for (const table of ['pages', 'fact_withdrawals', 'fact_purges', 'write_gate_holds', 'facts']) await engine.executeRaw(`DELETE FROM ${table}`);
    });

    test('soup pages, no ledger: every window, both audiences, both spaces equal the inline projection', async () => {
      const r = mulberry32(17);
      for (let t = 0; t < 3; t++) {
        const slug = `notes/parity-${t}`;
        const timeline = t === 2 ? '' : privacyText(r, 200_000 + Math.floor(r() * 400_000));
        const pageId = await importSegmented(engine, slug, pageContent(privacyText(r, 1_200_000 + Math.floor(r() * 900_000), { soup: t === 1 }), timeline));
        const want = await inlineProjection(engine, slug, pageId);
        const stored = await overlaidStoredBody(engine, slug, pageId);
        const body = await expectParity(pageId, want, r, stored);
        expect(body.rows.length).toBeGreaterThan(3);
        expect(body.layout!.timelineByte >= 0).toBe(t !== 2);
      }
    }, 240_000);

    test('with a ledger: withdrawn, purged and held rows leave every view exactly as readPageSnapshot overlays them', async () => {
      const r = mulberry32(29);
      for (let t = 0; t < 2; t++) {
        const slug = `notes/ledger-${t}`;
        const pageId = await importSegmented(engine, slug, pageContent(privacyText(r, 1_400_000), privacyText(r, 300_000)));
        await seedLedger(engine, slug);
        const want = await inlineProjection(engine, slug, pageId);
        const text = want.toString('utf8');
        expect(text).toContain(PUBLIC.fact);
        expect(privateTokensIn(text)).toEqual([]);
        const stored = await overlaidStoredBody(engine, slug, pageId);
        expect(stored.compiled_truth).not.toContain(PRIVATE.purged);
        await expectParity(pageId, want, r, stored);
      }
    }, 240_000);

    test('rows below the page tier move to the low-tier block after the truth, truth rows before timeline rows', async () => {
      const r = mulberry32(41);
      const truthRow = factRow('zzagentrow truth claim');
      const timelineRow = factRow('zzagentrow timeline claim');
      const slug = 'notes/low-tier';
      const truth = privacyText(r, 1_200_000, { keys: false }) + renderFactsTable([factRow('zzownerrow claim'), truthRow]) + '\n' + privacyText(r, 300_000, { keys: false });
      const pageId = await importSegmented(engine, slug, pageContent(truth, `${renderFactsTable([timelineRow])}\n${privacyText(r, 100_000)}`));
      await engine.transaction(tx => withTrustBackfill(tx, () => tx.executeRaw("UPDATE pages SET trust_tier='operator_curated' WHERE id=$1", [pageId])));
      for (const row of [truthRow, timelineRow]) {
        await maintenanceTransaction(engine, tx => tx.insertFacts([{ fact: row.claim, kind: 'fact', entity_slug: slug, visibility: 'world', source: 'test',
          valid_from: new Date('2024-01-01'), row_num: row.rowNum, source_markdown_slug: slug }], { source_id: 'default' }), { tier: 'agent_written', origin: { channel: 'test:fence' } });
      }
      const want = await inlineProjection(engine, slug, pageId);
      const body = await expectParity(pageId, want, r, await overlaidStoredBody(engine, slug, pageId));
      const layout = await projectedLayout(engine, body);
      expect(layout.lowTier).toContain('zzagentrow truth claim');
      expect(layout.lowTier.indexOf('zzagentrow truth claim')).toBeLessThan(layout.lowTier.indexOf('zzagentrow timeline claim'));
    }, 240_000);

    test('the outline names every heading at its projected byte', async () => {
      const r = mulberry32(53);
      const slug = 'notes/outline';
      const pageId = await importSegmented(engine, slug, pageContent(privacyText(r, 1_500_000), privacyText(r, 200_000)));
      const want = await inlineProjection(engine, slug, pageId);
      const body = await openSegmentedBody(engine, { pageId });
      const all = await projectedOutline(engine, body, 0, 100_000);
      const inline = pageOutline(want, 0, 100_000).entries.filter(e => e.heading);
      expect(all.entries.map(e => `${e.heading}@${e.byte_start}`)).toEqual(inline.map(e => `${e.heading}@${e.byte_start}`));
      const page = await projectedOutline(engine, body, 5, 7);
      expect(page.entries).toEqual(all.entries.slice(5, 12));
      expect(page.next_from_index).toBe(12);
    }, 240_000);

    test('stale metadata recomputes from the entry state; an unusable entry state refuses, never raw text', async () => {
      const r = mulberry32(67);
      const slug = 'notes/stale';
      const pageId = await importSegmented(engine, slug, pageContent(privacyText(r, 1_300_000)));
      const want = await inlineProjection(engine, slug, pageId);
      await engine.executeRaw("UPDATE page_body_manifest SET protected_regions='[]'::jsonb WHERE page_id=$1", [pageId]);
      await engine.executeRaw('UPDATE pages SET segmenter_version=0 WHERE id=$1', [pageId]);
      const recomputed = await readRange(engine, { pageId, space: 'projected', start: 0, end: Infinity, audience: 'remote' });
      expect(recomputed.bytes.equals(want)).toBe(true);
      await engine.executeRaw("UPDATE page_body_manifest SET entry_state='{}'::jsonb WHERE page_id=$1", [pageId]);
      const err = await readRange(engine, { pageId, space: 'stored', start: 0, end: 1000, audience: 'remote' }).catch(e => e);
      expect(err?.code).toBe('page_projection_stale');
    }, 240_000);

    test('a facts fence longer than a segment cannot match byte for byte and never shows more', async () => {
      const r = mulberry32(79);
      const slug = 'notes/crossing';
      const pageId = await importSegmented(engine, slug, pageContent(privacyText(r, 300_000) + crossingFacts() + privacyText(r, 400_000)));
      const want = (await inlineProjection(engine, slug, pageId)).toString('utf8');
      const got = (await readRange(engine, { pageId, space: 'projected', start: 0, end: Infinity, audience: 'remote' })).bytes.toString('utf8');
      expect(got.length).toBeLessThan(want.length);
      expect(privateTokensIn(got, { ledger: false })).toEqual([]);
      expect(KEYS(got)).toBeLessThanOrEqual(KEYS(want));
      expect(isSubsequence(got, want)).toBe(true);
    }, 240_000);
  });
}

/** `a`'s lines appear in `b` in order (per-segment projection only drops lines whole-body sanitization keeps). */
function isSubsequence(a: string, b: string): boolean {
  let at = 0;
  for (const line of a.split('\n')) {
    const found = b.indexOf(line, at);
    if (found === -1) return false;
    at = found + line.length;
  }
  return true;
}
