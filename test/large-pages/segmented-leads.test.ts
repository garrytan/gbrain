/**
 * Wave B PR 2 (spec 7.4): bounded leads of a segmented page.
 *
 * 1. Protects: a segmented page's lead is its stored truth_lead; when the
 *    lead holds a facts fence it is overlaid alone with the page's withdrawal
 *    ledger (no segment text is read), so the lead shows the page's opening
 *    prose and public facts and never a withdrawn, purged or private row,
 *    takes or a key, and starts like the lead of the same body stored inline
 *    (leads do not apply the fence overlay's holds, inline or segmented); the
 *    exact-slug and alias snippets (which read the page through getPage) show
 *    that lead.
 * 2. Fails when: a segmented lead with a facts fence comes back empty (PR 1
 *    failed closed: the snapshot read has no body to overlay), the lead is
 *    shown raw, the overlay reads the page's segments, or the getPage
 *    snippets read the throwing body getters (PR 1: the exact-slug tier
 *    skipped the page, the alias hop threw page_body_segmented).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { boundedBodyPrefixSql, overlaidBoundedRows, projectedLead } from '../../src/core/page-window/bounded-lead.ts';
import { boundedProjectedPrefix } from '../../src/core/page-window/document.ts';
import { structuralExactLookup } from '../../src/core/search/exact-lookup.ts';
import { applyAliasHop } from '../../src/core/search/alias-hop.ts';
import { normalizeAlias } from '../../src/core/search/alias-normalize.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import { PEM_BLOCK } from '../helpers/segment-bodies.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import {
  PRIVATE, PUBLIC, importSegmented, pageContent, privacyFacts, privacyTakes, privacyText, privateTokensIn, seedLedger,
} from '../helpers/segmented-privacy-fixture.ts';

let engine: BrainEngine;
const SLUG = 'people/lead-example';
const INLINE = 'people/lead-inline-example';
const OPENING = 'Lead Example runs research at acme-example and writes about widgets.';

for (const kind of testBackends()) {
  describe(`bounded leads of a segmented page (${kind})`, () => {
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
      const r = mulberry32(401);
      const content = pageContent(`${OPENING}\n\n${privacyFacts()}\n${privacyTakes()}\n${PEM_BLOCK}\n${privacyText(r, 1_500_000)}`);
      await engine.setConfig('pages.segmented_storage', 'off');
      await importFromContent(engine, INLINE, content, { sourceId: 'default', noEmbed: true });
      await importSegmented(engine, SLUG, content);
      await seedLedger(engine, SLUG);
      await seedLedger(engine, INLINE);
    }, 240_000);

    test('a lead that holds a facts fence is overlaid alone: public rows show, withdrawn and private rows do not, no segment is read', async () => {
      const [row, inline] = await engine.executeRaw<{ slug: string; source_id: string; compiled_truth: string; body_storage: string }>(
        `SELECT p.slug, p.source_id, p.body_storage, ${boundedBodyPrefixSql('p')} AS compiled_truth FROM pages p WHERE p.slug = ANY($1::text[]) ORDER BY p.slug = $2 DESC`, [[SLUG, INLINE], SLUG]);
      expect([row!.body_storage, inline!.body_storage]).toEqual(['segmented', 'inline']);
      let segmentReads = 0;
      const read = engine.readSegmentTexts.bind(engine);
      engine.readSegmentTexts = async (sourceId, shas) => { segmentReads++; return read(sourceId, shas); };
      const [overlaid] = await overlaidBoundedRows(engine, [row!]);
      const lead = await projectedLead(engine, row!);
      engine.readSegmentTexts = read;
      expect(segmentReads).toBe(0);
      expect(lead).toContain(OPENING);
      expect(lead).toContain(PUBLIC.fact);
      expect(privateTokensIn(lead, { ledger: false })).toEqual([]);
      for (const token of [PRIVATE.withdrawn, PRIVATE.purged]) expect(lead).not.toContain(token);
      // The inline row's 65,536-character prefix is cut to bytes in coarser steps than the stored 64 KiB lead, so the
      // two leads end at different bytes; what a snippet shows is the same.
      const inlineLead = await projectedLead(engine, inline!);
      expect(inlineLead.length).toBeGreaterThan(4000);
      expect(lead.slice(0, 4000)).toBe(inlineLead.slice(0, 4000));
      expect(overlaid!.compiled_truth).toContain(PUBLIC.fact);
      expect(boundedProjectedPrefix(overlaid!.compiled_truth)).toBe(lead);
    }, 120_000);

    test('the exact-slug and alias snippets read the stored lead', async () => {
      await engine.setPageAliases(SLUG, 'default', [normalizeAlias('lead exemplar')]);
      const [exact] = await structuralExactLookup(engine, SLUG, { sourceId: 'default' });
      expect(exact?.slug).toBe(SLUG);
      expect(exact!.chunk_text).toContain('Lead Example runs research');
      const [alias] = await applyAliasHop(engine, [], 'lead exemplar', { sourceId: 'default' });
      expect(alias?.slug).toBe(SLUG);
      expect(alias!.chunk_text).toContain('Lead Example runs research');
      for (const text of [exact!.chunk_text, alias!.chunk_text]) expect(privateTokensIn(text, { ledger: false })).toEqual([]);
    }, 120_000);
  });
}
