/**
 * Wave B PR 2 fix lane C2 (D2): think and compile-context on segmented pages.
 *
 * 1. Protects: think's gather reads a segmented page's lead from its stored
 *    truth_lead (overlaid with the page's withdrawal ledger), so an anchored
 *    think hydrates the anchor row and the temporal-window floor keeps the
 *    page; compile-context renders the page's excerpt and relationship-note
 *    summary from the same lead. Each matches the same body stored inline
 *    (parity: the same opening text) and shows no private, withdrawn or
 *    purged row.
 * 2. Fails when: gather or compile-context reads Page.compiled_truth of a
 *    segmented page (the getter throws page_body_segmented: the anchored
 *    think rejects, the window floor drops every page with
 *    GATHER_WINDOW_FLOOR_FAILED, compile-context aborts).
 * 3. Serial: the embed transport is stubbed process-wide (keyword-only gather).
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runGather } from '../../src/core/think/gather.ts';
import { parseTemporalWindow } from '../../src/core/think/temporal-window.ts';
import { compileView } from '../../src/core/context/compile-view.ts';
import { loadSensitivityConfig } from '../../src/core/context/sensitivity-scan.ts';
import { __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import { PRIVATE, importSegmented, pageContent, privacyFacts, privacyText, privateTokensIn, seedLedger } from '../helpers/segmented-privacy-fixture.ts';

const SLUG = 'people/think-lead-example';
const INLINE = 'people/think-lead-inline-example';
const OPENING = 'Think Lead Example runs research at acme-example and writes about widgets.';
/** Leads do not apply the fence overlay's holds, inline or segmented (segmented-leads.test.ts), so a held row is not counted. */
const leaked = (text: string) => privateTokensIn(text).filter(token => token !== PRIVATE.held);
/**
 * Lead parity as segmented-leads.test.ts states it: the same opening text. The two bounded prefixes are cut at
 * different points (the segmented lead is overlaid alone), so the shorter is a prefix of the longer.
 */
function expectSameLead(segmented: string, inline: string): void {
  expect(Math.min(segmented.length, inline.length)).toBeGreaterThan(4000);
  const [shorter, longer] = segmented.length <= inline.length ? [segmented, inline] : [inline, segmented];
  expect(longer.startsWith(shorter)).toBe(true);
}
const tmp = mkdtempSync(join(tmpdir(), 'segmented-think-compile-'));

beforeAll(() => { __setEmbedTransportForTests(() => { throw new Error('keyword-only test'); }); });
afterAll(() => { __setEmbedTransportForTests(null); rmSync(tmp, { recursive: true, force: true }); });

for (const kind of testBackends()) {
  describe(`think and compile-context leads of a segmented page (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      const content = pageContent(`${OPENING}\n\n${privacyFacts()}\n${privacyText(mulberry32(907), 1_500_000)}`);
      await engine.setConfig('pages.segmented_storage', 'off');
      await importFromContent(engine, INLINE, content, { sourceId: 'default', noEmbed: true });
      await importSegmented(engine, SLUG, content);
      await seedLedger(engine, SLUG);
      await seedLedger(engine, INLINE);
      await engine.executeRaw(`UPDATE pages SET effective_date='2026-07-17T12:00:00Z', updated_at='2026-07-17T12:00:00Z' WHERE slug = ANY($1::text[])`, [[SLUG, INLINE]]);
    }, 240_000);

    afterAll(async () => { await close(); });

    test('an anchored think hydrates the segmented anchor with the inline lead', async () => {
      const leads: Record<string, string> = {};
      for (const slug of [SLUG, INLINE]) {
        const gathered = await runGather(engine, { question: 'qqnomatchquestion', anchor: slug });
        expect(gathered.warnings).toEqual([]);
        leads[slug] = gathered.pages.find(p => p.slug === slug)!.chunk_text;
      }
      expect(leads[SLUG]).toContain(OPENING);
      expect(leaked(leads[SLUG]!)).toEqual([]);
      expectSameLead(leads[SLUG]!, leads[INLINE]!);
    }, 120_000);

    test('the temporal-window floor keeps the segmented page with the inline lead', async () => {
      const gathered = await runGather(engine, { question: 'qqnomatchquestion', window: parseTemporalWindow('2026-07-17', '2026-07-18')! });
      expect(gathered.warnings).toEqual([]);
      const lead = (slug: string) => gathered.pages.find(p => p.slug === slug)?.chunk_text;
      expect(lead(SLUG)).toContain(OPENING);
      expect(leaked(lead(SLUG)!)).toEqual([]);
      expectSameLead(lead(SLUG)!, lead(INLINE)!);
    }, 120_000);

    test('compile-context renders the segmented excerpt as it renders the inline one', async () => {
      const view = await compileView({ engine, sourceId: 'default', target: 'claude-code', budget: 8000,
        scanConfig: loadSensitivityConfig({ workspaceRoot: tmp, blocklist: '', userPatternsPath: join(tmp, 'no-such-patterns.txt') }) });
      const entry = (slug: string) => view.text.split('\n\n## ').find(block => block.includes(`(brain://${slug})`))?.trim();
      expect(entry(SLUG)).toContain(OPENING);
      expect(leaked(entry(SLUG)!)).toEqual([]);
      expect(entry(SLUG)!.replace(SLUG, 'SLUG')).toBe(entry(INLINE)!.replace(INLINE, 'SLUG'));
    }, 120_000);
  });
}
