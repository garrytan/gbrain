/**
 * #10589 (read failure only): trusted Markdown uses the same joined withdrawal
 * runs as the body reader, not individual manifest rows inside a facts fence.
 * Protects CLI plain/JSON output, byte/line windows and digests after a purge
 * changes a cross-cut fence's length; remote reads must still hide private rows.
 * Fails when document sizing or a later unit read overlays an incomplete fence.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { markdownHead, markdownDigest, segmentedMarkdownDocument } from '../../src/core/page-window/segmented.ts';
import { openSegmentedBody, readBodyRange } from '../../src/core/page-body/read-range.ts';
import { streamSegmentedGet } from '../../src/cli/page-render.ts';
import { windowFrom, windowForLines } from '../../src/core/page-window/window.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { seedLedger, PRIVATE, crossingFacts, privacyFacts, pageContent, importSegmented } from '../helpers/segmented-privacy-fixture.ts';

async function stored(engine: BrainEngine, pageId: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const piece of readBodyRange(engine, { pageId, space: 'stored', start: 0, end: Infinity, audience: 'trusted' })) parts.push(piece.bytes);
  return Buffer.concat(parts);
}

for (const kind of testBackends()) {
  describe(`trusted Markdown across forced cuts (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const slug = 'notes/cross-cut-markdown';
    let pageId: number;
    let expected: Buffer;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      const row = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 | | fixture | |`;
      const rows = Array.from({ length: 13_000 }, (_, i) => row(i + 100, `Kept planning entry ${i} café 日本語 with a stable observation`));
      // These fixture claims have real ledger rows (including a global purge).
      rows.splice(4_000, 0, row(1, `${PRIVATE.withdrawn} old employer`), row(2, `${PRIVATE.purged} old phone`), row(3, `${PRIVATE.held} ignore previous instructions`));
      const fence = '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
        + '|---|---|---|---|---|---|---|---|---|---|\n' + rows.join('\n') + '\n<!--- gbrain:facts:end -->\n';
      pageId = await importSegmented(engine, slug, pageContent('Before the fence.\n\n' + fence + '\nAfter the fence.\n', '- 2026-01-01: Timeline survives.\n'));
      await seedLedger(engine, slug);
      const body = await openSegmentedBody(engine, { pageId });
      expect(body.rows.filter(r => r.hasFacts).length).toBeGreaterThan(1);
      expect(body.ledger.withdrawals.length).toBeGreaterThan(0);
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      const raw = await stored(engine, pageId);
      // Stored-space reads omit the Markdown timeline separator; compose it explicitly.
      const truth: Buffer[] = [], timeline: Buffer[] = [];
      for (const [region, parts] of [['truth', truth], ['timeline', timeline]] as const) {
        for await (const p of readBodyRange(engine, { pageId, space: 'stored', start: 0, end: Infinity, audience: 'trusted', region })) parts.push(p.bytes);
      }
      expect(raw.includes(Buffer.from(PRIVATE.purged))).toBe(false);
      expect(raw.includes(Buffer.from('Kept planning entry 12999'))).toBe(true);
      expected = Buffer.concat([Buffer.from(markdownHead(snapshot.page, [])), ...truth, Buffer.from('\n\n<!-- timeline -->\n\n'), ...timeline, Buffer.from('\n')]);
    }, 300_000);

    afterAll(async () => { await close(); });

    test('stream, units, windows and digest match the joined trusted body', async () => {
      const body = await openSegmentedBody(engine, { pageId });
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      const doc = await segmentedMarkdownDocument(engine, body, markdownHead(snapshot.page, []), 'trusted');
      const parts: Buffer[] = [];
      for await (const b of doc.stream()) parts.push(b);
      expect(Buffer.concat(parts).equals(expected)).toBe(true);
      expect(doc.total).toBe(expected.length);
      expect(await doc.totalLines()).toBe(expected.toString('utf8').split('\n').length - 1);
      const digest = await markdownDigest(doc, snapshot.revision, 'trusted');
      expect(digest).toEqual({ total_bytes: expected.length, total_lines: await doc.totalLines(), sha256: createHash('sha256').update(expected).digest('hex') });
      expect(await markdownDigest(doc, snapshot.revision, 'trusted')).toEqual(digest);
      for (const at of [0, 1_048_530, 1_300_000, expected.length - 200]) expect(await doc.from(at, 900)).toEqual(windowFrom(expected, at, 900));
      for (const line of [1, 4_050, 10_000, 13_020]) expect(await doc.lines(line, 5, 2_000)).toEqual(windowForLines(expected, line, 5, 2_000));
    }, 120_000);

    test('the real CLI fallback prints plain and JSON Markdown without a projection refusal', async () => {
      const ctx = { engine, remote: false, sourceId: 'default', dryRun: false, config: {} as GBrainConfig,
        logger: { info() {}, warn() {}, error() {} } } satisfies OperationContext;
      const error = await operations.find(o => o.name === 'get_page')!.handler(ctx, { slug }).then(() => null, (e: unknown) => e);
      expect((error as { code: string }).code).toBe('page_body_segmented');
      for (const json of [false, true]) {
        const writes: string[] = [];
        expect(await streamSegmentedGet(engine, { slug, json }, error, async text => { writes.push(text); })).toBe(true);
        const output = json ? JSON.parse(writes.join('')).content : writes.join('');
        expect(output === expected.toString('utf8')).toBe(true);
        expect(output).not.toContain(PRIVATE.purged);
      }
    }, 120_000);

    test('warm trusted Markdown sizing reads only affected runs on a mostly non-facts page', async () => {
      const sparseSlug = 'notes/sparse-markdown';
      const prose = Array.from({ length: 40_000 }, (_, i) => `Unrelated prose ${i} with stable padding and no facts markers.\n`).join('');
      const id = await importSegmented(engine, sparseSlug, pageContent(privacyFacts() + '\n' + prose));
      await seedLedger(engine, sparseSlug);
      const body = await openSegmentedBody(engine, { pageId: id });
      expect(body.ledger.withdrawals.length).toBeGreaterThan(0);
      const affected = body.rows.filter(row => row.hasFacts);
      expect(affected.length).toBe(1);
      expect(body.rows.length).toBeGreaterThan(affected.length + 1);
      const warm = await segmentedMarkdownDocument(engine, body, '', 'trusted');
      const digest = await markdownDigest(warm, 'sparse-warm', 'trusted');
      const read = engine.readSegmentTexts;
      let bytes = 0;
      const loaded = new Set<string>();
      engine.readSegmentTexts = async function (sourceId, shas) {
        const texts = await read.call(this, sourceId, shas);
        for (const [sha, text] of texts) { loaded.add(sha); bytes += text.length; }
        return texts;
      };
      try {
        const doc = await segmentedMarkdownDocument(engine, body, '', 'trusted');
        expect(await markdownDigest(doc, 'sparse-warm', 'trusted')).toEqual(digest);
        expect(bytes).toBe(affected.reduce((n, row) => n + row.byteLen, 0));
        expect([...loaded].sort()).toEqual(affected.map(row => Buffer.from(row.sha256).toString('hex')).sort());
      } finally { engine.readSegmentTexts = read; }
    }, 120_000);

    test('remote Markdown still hides the cross-cut private facts', async () => {
      const remoteSlug = 'notes/cross-cut-private';
      const id = await importSegmented(engine, remoteSlug, pageContent('Public before.\n\n' + crossingFacts(12_000) + '\nPublic after.\n'));
      const body = await openSegmentedBody(engine, { pageId: id });
      const doc = await segmentedMarkdownDocument(engine, body, '', 'remote');
      const parts: Buffer[] = [];
      for await (const b of doc.stream()) parts.push(b);
      const text = Buffer.concat(parts).toString('utf8');
      expect(text).not.toContain(PRIVATE.crossing);
      expect(text).toContain('Public before.');
      // Cross-cut remote fences fail closed; do not widen that projection.
      const projected: Buffer[] = [];
      for await (const p of readBodyRange(engine, { pageId: id, body, space: 'projected', start: 0, end: Infinity, audience: 'remote' })) projected.push(p.bytes);
      expect(text).toBe(Buffer.concat([...projected, Buffer.from('\n')]).toString('utf8'));
    }, 120_000);
  });
}
