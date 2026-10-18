/**
 * Wave B PR 2 (spec 7.2, 13 "PR 2" tests): a get_page read of a segmented page
 * costs the size of what it returns, not the size of the page.
 *
 * 1. Protects: body: 'none', the first outline page and a 40 KB window in the
 *    middle of a 10 MB and a 40 MB page load the same bounded segment text
 *    (readSegmentTexts spy) and scan the same bounded bytes (segmentedReadWork,
 *    deterministic counters), visit a few document units per segment and no
 *    more, and a window reads at most the window plus two segments of text.
 * 2. Fails when: a read materializes or projects the whole body (Wave A's
 *    readPageDocument / pageOutline over the full text), the line count reads
 *    every segment, or a window loads segments it does not cut from.
 * 3. PGLite only: one 10 MB and one 40 MB import; the counts do not depend on
 *    the engine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { segmentedReadWork } from '../../src/core/page-window/segmented.ts';

const getPage = operations.find(o => o.name === 'get_page')!;
const WINDOW = 40_000;
/** segmented.ts's per-page cap on outline segment reads. */
const OUTLINE_READ_BYTES = 4 * 1024 * 1024;
let engine: PGLiteEngine;
let dir: string;

/** About `bytes` of a conversation log: a dated heading every ~16 KB, then lines. */
function log(bytes: number): string {
  const parts: string[] = ['---\ntitle: Read cost\ntype: note\n---\n'];
  let size = 0;
  for (let day = 0; size < bytes; day++) {
    const head = `## Day ${day} 2024-${String(1 + (day % 12)).padStart(2, '0')}-${String(1 + (day % 28)).padStart(2, '0')}\n\n`;
    parts.push(head);
    size += head.length;
    for (let i = 0; i < 160; i++) {
      const line = `- ${day}.${i} alice-example asked acme-example about the widget plan and the shipping date\n`;
      parts.push(line);
      size += line.length;
    }
  }
  return parts.join('');
}

const remote = (): OperationContext => ({ engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true,
  transport: 'http', sourceId: 'default', auth: { token: 'fixture', clientId: 'read-cost', principal: { kind: 'oauth_client', id: 'read-cost' }, scopes: ['read'],
    sourceId: 'default', allowedSources: ['default'] } } as unknown as OperationContext);
const get = async (params: Record<string, unknown>) => await getPage.handler(remote(), params) as Record<string, any>;

/** Segment text a call loads from storage (readSegmentTexts) and the counted work, after one warm-up call fills the view caches. */
async function measure(call: () => Promise<unknown>): Promise<{ loaded: number; units: number; bytes: number }> {
  await call();
  const original = engine.readSegmentTexts.bind(engine);
  let loaded = 0;
  engine.readSegmentTexts = async (sourceId, hashes) => {
    const texts = await original(sourceId, hashes);
    for (const text of texts.values()) loaded += text.byteLength;
    return texts;
  };
  segmentedReadWork.units = 0;
  segmentedReadWork.bytes = 0;
  try { await call(); } finally { engine.readSegmentTexts = original; }
  return { loaded, ...segmentedReadWork };
}

describe('segmented get_page read cost', () => {
  const pages = { small: { slug: 'logs/read-cost-10mb', bytes: 10_000_000, size: 0, rows: 0 }, large: { slug: 'logs/read-cost-40mb', bytes: 40_000_000, size: 0, rows: 0 } };
  let segment = 0;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('pages.segmented_storage', 'on');
    dir = mkdtempSync(join(tmpdir(), 'gb-read-cost-'));
    for (const page of Object.values(pages)) {
      // The 40 MB page is over the single-string ceiling: it streams in from a file.
      const file = join(dir, 'page.md');
      writeFileSync(file, log(page.bytes));
      expect((await importFromFile(engine, file, `${page.slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).status).toBe('imported');
      const none = await get({ slug: page.slug, body: 'none' });
      expect(none.body_storage).toBe('segmented');
      page.size = none.size.total_bytes;
      const [rows] = await engine.executeRaw<{ n: unknown; max: unknown }>(`SELECT count(*) AS n, max(m.byte_len) AS max FROM page_body_manifest m JOIN pages p ON p.id = m.page_id
        WHERE p.slug = $1 AND m.gen_to IS NULL`, [page.slug]);
      page.rows = Number(rows!.n);
      segment = Math.max(segment, Number(rows!.max));
    }
    expect(pages.large.rows).toBeGreaterThan(3 * pages.small.rows);
  }, 600_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const reads: Array<[string, (size: number) => Record<string, unknown>, (segment: number) => number]> = [
    ['body none', () => ({ body: 'none' }), segment => 2 * segment],
    ['the first outline page', () => ({ body: 'outline' }), segment => OUTLINE_READ_BYTES + 2 * segment],
    ['a window in the middle', size => ({ body: 'window', bytes: { offset: Math.floor(size / 2), length: WINDOW } }), segment => WINDOW + 2 * segment],
  ];
  for (const [name, params, bound] of reads) {
    test(`${name}: 40 MB loads and scans what 10 MB does`, async () => {
      const small = await measure(() => get({ slug: pages.small.slug, ...params(pages.small.size) }));
      const large = await measure(() => get({ slug: pages.large.slug, ...params(pages.large.size) }));
      for (const [page, m] of [[pages.small, small], [pages.large, large]] as const) {
        expect({ name, size: page.bytes, loaded: m.loaded <= bound(segment), scanned: m.bytes <= 3 * bound(segment), units: m.units <= 8 * page.rows + 64 })
          .toEqual({ name, size: page.bytes, loaded: true, scanned: true, units: true });
      }
      expect(large.loaded).toBeLessThanOrEqual(small.loaded + 2 * segment);
      expect(large.bytes).toBeLessThanOrEqual(small.bytes + 6 * segment);
    }, 300_000);
  }

  test('a window reads at most the window plus two segments of segment text', async () => {
    const original = engine.readSegmentTexts.bind(engine);
    let bytes = 0;
    engine.readSegmentTexts = async (sourceId, hashes) => {
      const texts = await original(sourceId, hashes);
      for (const text of texts.values()) bytes += text.byteLength;
      return texts;
    };
    try {
      for (const at of [0.1, 0.5, 0.97]) {
        await get({ slug: pages.large.slug, body: 'none' });
        bytes = 0;
        const r = await get({ slug: pages.large.slug, body: 'window', bytes: { offset: Math.floor(pages.large.size * at), length: WINDOW } });
        expect(Buffer.byteLength(r.window.text)).toBeGreaterThan(WINDOW / 2);
        expect(bytes).toBeLessThanOrEqual(WINDOW + 2 * segment);
      }
    } finally {
      engine.readSegmentTexts = original;
    }
  }, 120_000);
});
