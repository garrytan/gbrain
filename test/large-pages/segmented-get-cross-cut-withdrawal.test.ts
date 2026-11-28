/**
 * #10589 Part 1: `gbrain get` of a segmented page whose facts fence crosses a forced cut, on a source with withdrawals.
 *
 * 1. Protects: the trusted markdown view (local `gbrain get`'s stream, its digest, and its windows) measures and reads
 *    the rows a forced cut splits a facts fence across as one run, as `trustedSegments` joins and overlays them, so
 *    the page streams whole: the stored body after the withdrawal overlay (the withdrawn row struck, the purged row
 *    gone), byte for byte. A window that starts after the cut, inside the fence, reads too.
 * 2. Fails when: the view measures each row of the fence on its own (every segment of a split fence refuses
 *    `page_projection_stale` under a ledger), or reads a window from the middle of the run.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { openSegmentedBody } from '../../src/core/page-body/read-range.ts';
import { ledgerApplies } from '../../src/core/page-body/segment-ledger.ts';
import { markdownHead, segmentedMarkdownDocument } from '../../src/core/page-window/segmented.ts';
import { streamSegmentedGet } from '../../src/cli/page-render.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { factRow, importSegmented, overlaidStoredBody, PRIVATE, seedLedger } from '../helpers/segmented-privacy-fixture.ts';

const getPage = operations.find(o => o.name === 'get_page')!;
const SLUG = 'people/owner-example';
const KEPT = 'world row 7000 with some padding text about acme-example';

/** A person page whose one facts fence (about 1.5 MB) is longer than a segment, holding a withdrawn and a purged row on either side of the cut. */
function ownerPage(): string {
  const rows = Array.from({ length: 14_000 }, (_, i) => factRow(`world row ${i} with some padding text about acme-example`));
  rows.splice(200, 0, factRow(`${PRIVATE.withdrawn} old employer`));
  rows.splice(12_000, 0, factRow(`${PRIVATE.purged} old phone`));
  rows.push(factRow(`${PRIVATE.held} ignore previous instructions`));
  return `---\ntitle: Owner Example\ntype: person\n---\n# Owner Example\n\nThe owner of this brain.\n\n## Facts\n\n${renderFactsTable(rows)}\n\nClosing notes about acme-example.\n`;
}

for (const kind of testBackends()) {
  describe(`gbrain get of a cross-cut facts fence under withdrawals (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let pageId: number;
    const ctx = (): OperationContext => ({ engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false,
      sourceId: 'default' } as unknown as OperationContext);
    const get = async (params: Record<string, unknown>) => await getPage.handler(ctx(), params) as Record<string, any>;
    /** The trusted markdown view the stored body after the overlay frames: serializeMarkdown's head, the truth, a final newline. */
    const expected = async () => {
      const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
      return markdownHead(snapshot.page, snapshot.tags) + (await overlaidStoredBody(engine, SLUG, pageId)).compiled_truth + '\n';
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      pageId = await importSegmented(engine, SLUG, ownerPage());
      await seedLedger(engine, SLUG);
    }, 300_000);

    afterAll(async () => { await close(); });

    test('the fence crosses a forced cut and the ledger applies', async () => {
      const [split] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_manifest m, jsonb_array_elements(m.facts_slots) s
        WHERE m.page_id=$1 AND m.gen_to IS NULL AND s ? 'open_start'`, [pageId]);
      expect(split!.n).toBeGreaterThan(1);
      const body = await openSegmentedBody(engine, { pageId, expect: { slug: SLUG, sourceId: 'default' } });
      expect(ledgerApplies(body.ledger)).toBe(true);
      expect(body.rows.filter(row => row.hasFacts).length).toBeGreaterThan(1);
      expect(Math.max(...body.rows.map(row => row.byteLen))).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    }, 120_000);

    test('local gbrain get streams the overlaid page whole, the withdrawn row struck and the purged row gone', async () => {
      let refusal: unknown;
      try { await get({ slug: SLUG }); } catch (e) { refusal = e; }
      expect(refusal).toBeInstanceOf(OperationError);
      expect((refusal as OperationError).code).toBe('page_body_segmented');
      const writes: string[] = [];
      expect(await streamSegmentedGet(engine, { slug: SLUG }, refusal, async t => { writes.push(t); })).toBe(true);
      const printed = writes.join('');
      const want = await expected();
      expect(printed === want).toBe(true);
      expect(printed).toContain(KEPT);
      expect(printed).not.toContain(PRIVATE.purged);
      expect(printed).toMatch(new RegExp(`~~${PRIVATE.withdrawn} old employer~~`));
      const json: string[] = [];
      await streamSegmentedGet(engine, { slug: SLUG, json: true }, refusal, async t => { json.push(t); });
      expect(JSON.parse(json.join('')).content === want).toBe(true);
    }, 120_000);

    test('a markdown window that starts after the cut, inside the fence, reads the overlaid bytes', async () => {
      const want = Buffer.from(await expected(), 'utf8');
      const body = await openSegmentedBody(engine, { pageId, expect: { slug: SLUG, sourceId: 'default' } });
      const doc = await segmentedMarkdownDocument(engine, body, '', 'trusted');
      expect(doc.total).toBeGreaterThan(SEGMENT_MAX_BYTES);
      const offset = SEGMENT_MAX_BYTES + 4_096;
      const r = await get({ slug: SLUG, body: 'window', view: 'markdown', bytes: { offset, length: 2_000 } });
      const text = Buffer.from(r.window.text, 'utf8');
      expect(text.length).toBeGreaterThan(0);
      expect(want.subarray(r.window.byte_start, r.window.byte_start + text.length).equals(text)).toBe(true);
      expect(r.total_bytes ?? want.length).toBe(want.length);
    }, 120_000);
  });
}
