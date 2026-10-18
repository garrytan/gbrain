/**
 * Wave B PR 2 fix lane C1 (finding C1): a U+FEFF in a segmented body survives every read, as it does inline.
 *
 * 1. Protects: a byte order mark that starts a segment (every line here starts with one, so every cut, forced or
 *    structural, lands before a BOM) or the body is kept by export, by get_page windows (local and remote, default
 *    and markdown views), by the trusted body read and by the derived passes' blocks: the segmented page answers
 *    exactly what the same page stored inline answers. At a region start the inline path drops the BOM: it is
 *    whitespace to the body trim (String.prototype.trim, and body-scan.ts WS_UNITS on the streamed path), so a
 *    stored region never starts with one, and the segmented page drops exactly those two too.
 * 2. Fails when: a segment's bytes are decoded with a TextDecoder that strips a leading BOM (the default
 *    ignoreBOM: false), which drops three bytes at the body start and at every segment start while the export
 *    still reports complete.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { runExport } from '../../src/commands/export.ts';
import { readBodyRange } from '../../src/core/page-body/read-range.ts';
import { bodyBlocks } from '../../src/core/page-body/segment-blocks.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const getPage = operations.find(o => o.name === 'get_page')!;
const SLUG = 'notes/bom-example';
const BOM = '\uFEFF';
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** About 2.5 MiB of lines that each start with a BOM, a blank line every 200 lines, and a timeline of BOM bullets. */
function content(): string {
  const lines: string[] = [];
  for (let i = 0; i < 36_000; i++) lines.push(i % 200 === 199 ? '' : BOM + 'line ' + String(i).padStart(6, '0') + ' acme-example noted the widget plan ✓');
  const timeline = Array.from({ length: 300 }, (_, i) => BOM + '- **2025-0' + (1 + (i % 9)) + '-1' + (i % 10) + '** | entry ' + i).join('\n');
  return '---\ntitle: BOM example\ntype: note\n---\n' + lines.join('\n') + '\n\n<!-- timeline -->\n\n' + timeline + '\n';
}

const count = (text: string) => text.split(BOM).length - 1;

async function quietExport(engine: BrainEngine, out: string): Promise<string> {
  const { log, error } = console;
  const exit = process.exit;
  const messages: string[] = [];
  console.log = console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
  process.exit = ((code: number) => { throw new Error('EXIT:' + code + ' ' + messages.join('\n')); }) as never;
  try { await runExport(engine, ['--dir', out]); } finally { console.log = log; console.error = error; process.exit = exit; }
  const file = readdirSync(out, { recursive: true }).map(String).find(f => f.endsWith('bom-example.md'));
  expect(file).toBeDefined();
  return readFileSync(join(out, file!), 'utf8');
}

for (const kind of testBackends()) {
  describe('a BOM in a segmented body (' + kind + ')', () => {
    const engines: Record<'inline' | 'segmented', BrainEngine> = {} as never;
    const closers: Array<() => Promise<void>> = [];
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-segmented-bom-'));

    beforeAll(async () => {
      for (const storage of ['inline', 'segmented'] as const) {
        let engine: BrainEngine;
        if (kind === 'postgres') {
          const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
          engine = pg.engine;
          closers.push(pg.close);
        } else {
          engine = new PGLiteEngine();
          await engine.connect({});
          await engine.initSchema();
          closers.push(() => engine.disconnect());
        }
        await engine.setConfig('pages.segmented_storage', storage === 'segmented' ? 'on' : 'off');
        expect((await importFromContent(engine, SLUG, content(), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
        const [row] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [SLUG]);
        expect(row?.body_storage).toBe(storage);
        engines[storage] = engine;
      }
      const rows = await engines.segmented.executeRaw<{ n: unknown }>('SELECT count(*) AS n FROM page_body_manifest');
      expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(3);
    }, 300_000);

    afterAll(async () => {
      for (const close of closers) await close();
      rmSync(dir, { recursive: true, force: true });
    });

    test('export writes the same file, every BOM included', async () => {
      const inline = await quietExport(engines.inline, join(dir, 'inline-' + kind));
      const segmented = await quietExport(engines.segmented, join(dir, 'segmented-' + kind));
      expect(count(inline)).toBe(count(content()) - 2);
      expect(count(segmented)).toBe(count(inline));
      expect(Buffer.byteLength(segmented)).toBe(Buffer.byteLength(inline));
      expect(segmented === inline).toBe(true);
    }, 180_000);

    test('the trusted body read and the derived blocks keep the BOM every segment starts with', async () => {
      const [page] = await engines.segmented.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1', [SLUG]);
      const parts: Buffer[] = [];
      for await (const piece of readBodyRange(engines.segmented, { pageId: Number(page!.id), space: 'stored', start: 0, end: Infinity, audience: 'trusted' })) parts.push(piece.bytes);
      const [inline] = await engines.inline.executeRaw<{ compiled_truth: string; timeline: string }>('SELECT compiled_truth, timeline FROM pages WHERE slug=$1', [SLUG]);
      expect(inline!.compiled_truth.startsWith(BOM) || inline!.timeline.startsWith(BOM)).toBe(false);
      expect(count(inline!.compiled_truth + inline!.timeline)).toBe(count(content()) - 2);
      expect(Buffer.concat(parts).toString('utf8') === inline!.compiled_truth + inline!.timeline).toBe(true);
      let joined = '';
      for await (const block of bodyBlocks(engines.segmented, { id: Number(page!.id), slug: SLUG })) joined += block.text;
      expect(count(joined)).toBe(count(inline!.compiled_truth + inline!.timeline));
      expect(joined === inline!.compiled_truth + '\n' + inline!.timeline).toBe(true);
    }, 120_000);

    for (const remote of [false, true]) {
      const ctx = (engine: BrainEngine): OperationContext => ({ engine, config: {} as GBrainConfig, logger: noopLogger, dryRun: false, remote,
        sourceId: 'default', ...(remote ? { transport: 'http', auth: { token: 'fixture', clientId: 'bom-client', principal: { kind: 'oauth_client', id: 'bom-client' },
          scopes: ['read'], sourceId: 'default', allowedSources: ['default'] } } : {}) } as unknown as OperationContext);
      for (const view of ['text', 'markdown'] as const) {
        test((remote ? 'remote' : 'local') + ' get_page ' + view + ' windows walked to the end give the inline text', async () => {
          const extra = view === 'markdown' ? { view } : {};
          const walk = async (engine: BrainEngine) => {
            const texts: string[] = [];
            let r = await getPage.handler(ctx(engine), { slug: SLUG, body: 'window', max_bytes: 300_000, ...extra }) as Record<string, any>;
            const first = r;
            for (;;) {
              texts.push(String(r.window?.text ?? ''));
              if (!r.next_cursor) break;
              r = await getPage.handler(ctx(engine), { slug: SLUG, cursor: r.next_cursor, ...extra }) as Record<string, any>;
            }
            return { text: texts.join(''), first };
          };
          const [inline, segmented] = await Promise.all([walk(engines.inline), walk(engines.segmented)]);
          expect(count(inline.text)).toBeGreaterThan(30_000);
          expect(count(segmented.text)).toBe(count(inline.text));
          expect(segmented.text === inline.text).toBe(true);
          expect(JSON.stringify(segmented.first.size?.total_bytes)).toBe(JSON.stringify(inline.first.size?.total_bytes));
        }, 180_000);
      }
    }
  });
}
