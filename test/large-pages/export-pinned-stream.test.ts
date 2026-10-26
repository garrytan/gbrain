/**
 * Wave C 1E (spec §5 "Export", §10 1E C4a): export streams segmented pages after its snapshot commits, pinned to the
 * generation the snapshot read.
 *
 * 1. Protects: export reads no segment text inside its REPEATABLE READ snapshot (the transaction ends before the first
 *    segment text is read), so a large page never holds a snapshot open while it streams; the file is byte-identical to
 *    the snapshot's page even when an append, version pruning and a segment sweep land between the snapshot and the
 *    stream (the export's read pin is a GC root); when the generation is gone anyway (its pin released and swept) the
 *    export refuses and publishes nothing complete, never a short file.
 * 2. Fails when: segmented bodies stream inside the snapshot transaction (master), the export pin is not a GC root, or
 *    the stream reads the live generation instead of the snapshot's.
 * 3. GBRAIN_TEST_LARGE_EXPORT=1 adds a 256 MiB page (PGLite): no segment text read in the snapshot and a byte-identical
 *    round trip. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { exportProbe, runExport } from '../../src/commands/export.ts';
import { READ_PIN_TTL_MS } from '../../src/core/page-body/read-pins.ts';
import { exportBodyLedger, readExportPage, readExportWithdrawals, segmentedExportHead, segmentedExportMarkdown } from '../../src/core/export-snapshot.ts';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { testBackends } from '../helpers/test-backends.ts';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const dir = mkdtempSync(join(tmpdir(), 'export-pinned-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, error } = console;
  const exit = process.exit;
  const messages: string[] = [];
  console.log = console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
  process.exit = ((code: number) => { throw new Error(`EXIT:${code} ${messages.join('\n')}`); }) as never;
  try { return await fn(); } finally { console.log = log; console.error = error; process.exit = exit; }
}

/** Counts segment text reads inside engine.transaction and records when the last transaction ended and texts were read after it. */
function watchSnapshot(engine: BrainEngine) {
  const seen = { inTx: 0, after: 0, open: false };
  const transaction = engine.transaction.bind(engine), read = engine.readSegmentTexts.bind(engine);
  const count = (tx: boolean, inner: BrainEngine['readSegmentTexts']): BrainEngine['readSegmentTexts'] =>
    ((...args: Parameters<BrainEngine['readSegmentTexts']>) => { if (tx || seen.open) seen.inTx++; else seen.after++; return inner(...args); }) as BrainEngine['readSegmentTexts'];
  engine.transaction = (async <T>(fn: (tx: BrainEngine) => Promise<T>, opts?: Parameters<BrainEngine['transaction']>[1]) => {
    seen.open = true;
    try {
      return await transaction(async (tx: BrainEngine) => {
        tx.readSegmentTexts = count(true, tx.readSegmentTexts.bind(tx));
        return fn(tx);
      }, opts);
    } finally { seen.open = false; }
  }) as BrainEngine['transaction'];
  engine.readSegmentTexts = count(false, read);
  return { seen, restore: () => { delete (engine as Partial<BrainEngine>).transaction; delete (engine as Partial<BrainEngine>).readSegmentTexts; } };
}

/** The page's file as the snapshot reads it, streamed inside one transaction (the reference the export must equal). */
async function reference(engine: BrainEngine, slug: string): Promise<Buffer> {
  return engine.transaction(async tx => {
    const [key] = await tx.executeRaw<{ id: string; source_id: string; slug: string }>("SELECT id::text, source_id, slug FROM pages WHERE source_id='default' AND slug=$1", [slug]);
    const withdrawals = await readExportWithdrawals(tx, 'default');
    const snapshot = await readExportPage(tx, key!, withdrawals);
    const parts: Buffer[] = [];
    for await (const piece of segmentedExportMarkdown(tx, snapshot.page, exportBodyLedger(slug, withdrawals), segmentedExportHead(snapshot))) parts.push(Buffer.from(piece));
    return Buffer.concat(parts);
  });
}

let exports = 0;
async function exportSlug(engine: BrainEngine, slug: string): Promise<{ file: Buffer | null; out: string }> {
  const out = join(dir, `out-${++exports}`);
  await quietly(() => runExport(engine, ['--dir', out, '--slug-prefix', slug]));
  return { file: readFileSync(join(out, `${slug}.md`)), out };
}

for (const kind of testBackends()) {
  describe(`export streams segmented pages after its snapshot (${kind})`, () => {
    let brain: AppendBrain;
    beforeAll(async () => { brain = await openAppendBrain(kind); }, 600_000);
    afterAll(async () => { exportProbe.beforeStream = undefined; await brain.close(); }, 120_000);

    const seed = async (slug: string, bytes: number) => {
      await brain.seed(slug, conversationPage(bytes, { seed: bytes }));
      expect((await brain.body(slug)).storage).toBe('segmented');
      return Number((await brain.engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.id);
    };

    test('no segment text is read inside the snapshot transaction, and the file is the snapshot page byte for byte', async () => {
      const slug = 'notes/export-pinned-a';
      await seed(slug, 3_000_000);
      const expected = await reference(brain.engine, slug);
      const watch = watchSnapshot(brain.engine);
      let file: Buffer | null;
      try { ({ file } = await exportSlug(brain.engine, slug)); } finally { watch.restore(); }
      expect(watch.seen.inTx).toBe(0);
      expect(watch.seen.after).toBeGreaterThan(0);
      expect(sha(file!)).toBe(sha(expected));
    }, 300_000);

    test("an append, version pruning and a sweep between the snapshot and the stream leave the snapshot's file", async () => {
      const slug = 'notes/export-pinned-b';
      const id = await seed(slug, 3_000_000);
      const expected = await reference(brain.engine, slug);
      exportProbe.beforeStream = async pageId => {
        if (pageId !== id) return;
        exportProbe.beforeStream = undefined;
        const res = await brain.call('append_page', { slug, text: '\n\nAppended while the export streamed.\n', request_id: randomUUID() });
        expect(res.isError).toBe(false);
        await brain.engine.executeRaw('DELETE FROM page_versions WHERE page_id=$1', [id]);
        await brain.engine.sweepSegments({ pageId: id });
      };
      const { file } = await exportSlug(brain.engine, slug);
      expect(exportProbe.beforeStream).toBeUndefined();
      expect(sha(file!)).toBe(sha(expected));
      expect(sha(await reference(brain.engine, slug))).not.toBe(sha(expected));
    }, 300_000);

    test("every export pin is taken before the first stream: a page waiting behind another keeps the snapshot's generation", async () => {
      const first = 'notes/export-pinned-d1', second = 'notes/export-pinned-d2';
      const ids = [await seed(first, 3_000_000), await seed(second, 3_100_000)];
      const expected = await reference(brain.engine, second);
      let mutated = false;
      exportProbe.beforeStream = async pageId => {
        if (mutated) return;
        mutated = true;
        expect(pageId).toBe(ids[0]!);
        const res = await brain.call('append_page', { slug: second, text: '\n\nAppended while another page streamed.\n', request_id: randomUUID() });
        expect(res.isError).toBe(false);
        await brain.engine.executeRaw('DELETE FROM page_versions WHERE page_id=$1', [ids[1]]);
        await brain.engine.sweepSegments({ pageId: ids[1] });
      };
      const out = join(dir, `out-${++exports}`);
      try { await quietly(() => runExport(brain.engine, ['--dir', out, '--slug-prefix', 'notes/export-pinned-d'])); } finally { exportProbe.beforeStream = undefined; }
      expect(mutated).toBe(true);
      expect(sha(readFileSync(join(out, `${second}.md`)))).toBe(sha(expected));
    }, 300_000);

    test('an export pin that can no longer be renewed refuses the export instead of streaming an unpinned generation', async () => {
      const slug = 'notes/export-pinned-e';
      const id = await seed(slug, 3_000_000);
      const now = Date.now;
      exportProbe.beforeStream = async pageId => {
        if (pageId !== id) return;
        exportProbe.beforeStream = undefined;
        await brain.engine.executeRaw('DELETE FROM page_read_pins WHERE page_id=$1', [id]);
        const late = now() + READ_PIN_TTL_MS;
        Date.now = () => late;
      };
      const out = join(dir, `out-${++exports}`);
      try {
        await expect(quietly(() => runExport(brain.engine, ['--dir', out, '--slug-prefix', slug]))).rejects.toThrow(/export read pin expired/);
      } finally { Date.now = now; exportProbe.beforeStream = undefined; }
      expect(existsSync(join(out, `${slug}.md`))).toBe(false);
    }, 300_000);

    test('a generation collected before the stream refuses the export; nothing is published complete', async () => {
      const slug = 'notes/export-pinned-c';
      const id = await seed(slug, 3_000_000);
      exportProbe.beforeStream = async pageId => {
        if (pageId !== id) return;
        exportProbe.beforeStream = undefined;
        const res = await brain.call('append_page', { slug, text: '\n\nAppended, then the pin is lost.\n', request_id: randomUUID() });
        expect(res.isError).toBe(false);
        await brain.engine.executeRaw('DELETE FROM page_read_pins WHERE page_id=$1', [id]);
        await brain.engine.executeRaw('DELETE FROM page_versions WHERE page_id=$1', [id]);
        await brain.engine.sweepSegments({ pageId: id });
      };
      const out = join(dir, `out-${++exports}`);
      await expect(quietly(() => runExport(brain.engine, ['--dir', out, '--slug-prefix', slug]))).rejects.toThrow(/EXIT:1/);
      const status = join(out, '.gbrain-export-status');
      expect(existsSync(status) ? readFileSync(status, 'utf8') : '').not.toContain('COMPLETE');
      expect(existsSync(join(out, `${slug}.md`))).toBe(false);
    }, 300_000);
  });
}

describe.skipIf(process.env.GBRAIN_TEST_LARGE_EXPORT !== '1' || !testBackends().includes('pglite'))('256 MiB export (PGLite)', () => {
  test('streams after the snapshot and round-trips byte-identical', async () => {
    const brain = await openAppendBrain('pglite');
    try {
      const slug = 'notes/export-pinned-256';
      await brain.seed(slug, conversationPage(256 * 1024 * 1024 - 64 * 1024, { seed: 256 }));
      expect((await brain.body(slug)).storage).toBe('segmented');
      const expected = sha(await reference(brain.engine, slug));
      const watch = watchSnapshot(brain.engine);
      let file: Buffer | null;
      try { ({ file } = await exportSlug(brain.engine, slug)); } finally { watch.restore(); }
      expect(watch.seen.inTx).toBe(0);
      expect(sha(file!)).toBe(expected);
    } finally { await brain.close(); }
  }, 3_600_000);
});
