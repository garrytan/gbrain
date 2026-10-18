/**
 * Wave B PR 2 (spec 7.4): `gbrain get` of a segmented page over PAGE_MAX_BYTES.
 *
 * 1. Protects: the local `gbrain get` streams a 26 MB page in writes no larger
 *    than a segment, and the stream hashes to the trusted markdown view's
 *    size.sha256; the thin client pages the page to its end, verified, and
 *    prints it window by window. `--json` would hold the page in one string,
 *    so it is refused on both paths with a fix that drops `--json`.
 * 2. Fails when: either path joins the page into one string above the ceiling,
 *    or `--json` builds the document anyway.
 * 3. PGLite only, under the memory-heavy budget: one 26 MB import.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy, SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { printPagedPage, REMOTE_PAGE_WINDOW_BYTES, streamSegmentedGet } from '../../src/cli/page-render.ts';

const getPage = operations.find(o => o.name === 'get_page')!;
const SLUG = 'logs/over-ceiling';
let engine: PGLiteEngine;
let dir: string;

const ctx = (remote: boolean): OperationContext => ({ engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote,
  sourceId: 'default', ...(remote ? { transport: 'http', thinClient: true, auth: { token: 'fixture', clientId: 'ceiling-client', principal: { kind: 'oauth_client', id: 'ceiling-client' },
    scopes: ['read'], sourceId: 'default', allowedSources: ['default'] } } : {}) } as unknown as OperationContext);
const get = async (params: Record<string, unknown>, remote = false) => await getPage.handler(ctx(remote), params) as Record<string, any>;
async function refusal(p: Promise<unknown>): Promise<OperationError> {
  try { await p; } catch (e) { if (e instanceof OperationError) return e; throw e; }
  throw new Error('expected a refusal');
}
const codeOf = (e: OperationError) => (e as any).canonical ?? e.code;

describe('gbrain get of a segmented page over PAGE_MAX_BYTES', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('pages.segmented_storage', 'on');
    dir = mkdtempSync(join(tmpdir(), 'gb-over-ceiling-'));
    const lines: string[] = ['---\ntitle: Over the ceiling\ntype: note\n---\n'];
    for (let day = 0, size = 0; size < PAGE_MAX_BYTES + 1_000_000; day++) {
      const block = [`## Day ${day}`, '', ...Array.from({ length: 160 }, (_, i) => `- ${day}.${i} alice-example asked acme-example about the widget plan`), ''].join('\n') + '\n';
      lines.push(block);
      size += block.length;
    }
    const file = join(dir, 'page.md');
    writeFileSync(file, lines.join(''));
    expect((await importFromFile(engine, file, `${SLUG}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).status).toBe('imported');
    expect((await get({ slug: SLUG, body: 'none' })).size.body_bytes).toBeGreaterThan(PAGE_MAX_BYTES);
  }, 600_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('locally, the page streams in segment-sized writes that hash to the markdown view', async () => {
    const e = await refusal(get({ slug: SLUG }));
    expect(e.code).toBe('page_body_segmented');
    const hash = createHash('sha256');
    let bytes = 0, writes = 0, largest = 0;
    expect(await streamSegmentedGet(engine, { slug: SLUG }, e, async t => {
      const n = Buffer.byteLength(t);
      hash.update(t);
      bytes += n;
      writes++;
      largest = Math.max(largest, n);
    })).toBe(true);
    const view = await get({ slug: SLUG, body: 'window', view: 'markdown', max_bytes: 1_000 });
    expect(bytes).toBe(view.size.total_bytes);
    expect(hash.digest('hex')).toBe(view.size.sha256);
    expect(writes).toBeGreaterThan(PAGE_MAX_BYTES / SEGMENT_MAX_BYTES);
    expect(largest).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
  }, 300_000);

  test('locally, --json is refused with a fix that drops it, and nothing is written', async () => {
    const e = await refusal(get({ slug: SLUG }));
    const writes: string[] = [];
    const json = await refusal(streamSegmentedGet(engine, { slug: SLUG, json: true }, e, async t => { writes.push(t); }));
    expect(codeOf(json)).toBe('page_too_large_for_inline');
    expect(json.fix?.argv).toEqual(['gbrain', 'get', '--source', 'default', '--', SLUG]);
    expect(writes).toEqual([]);
  }, 60_000);

  test('the thin client pages, verifies and prints window by window; --json is refused', async () => {
    expect(codeOf(await refusal(get({ slug: SLUG }, true)))).toBe('page_too_large_for_inline');
    const hash = createHash('sha256');
    let bytes = 0, writes = 0, largest = 0, total = 0;
    await printPagedPage(async p => { const r = await get(p, true); total = r.size.total_bytes; return r; }, { slug: SLUG }, async t => {
      const n = Buffer.byteLength(t);
      hash.update(t);
      bytes += n;
      writes++;
      largest = Math.max(largest, n);
    });
    expect(bytes).toBe(total);
    expect(writes).toBeGreaterThan(PAGE_MAX_BYTES / REMOTE_PAGE_WINDOW_BYTES);
    expect(largest).toBeLessThanOrEqual(REMOTE_PAGE_WINDOW_BYTES);
    expect(hash.digest('hex')).toBe((await get({ slug: SLUG, body: 'window', view: 'markdown', max_bytes: 1_000 }, true)).size.sha256);
    const writesJson: string[] = [];
    const json = await refusal(printPagedPage(p => get(p, true), { slug: SLUG, json: true }, async t => { writesJson.push(t); }));
    expect(codeOf(json)).toBe('page_too_large_for_inline');
    expect(json.fix?.argv).toEqual(['gbrain', 'get', '--', SLUG]);
    expect(writesJson).toEqual([]);
  }, 600_000);
});
