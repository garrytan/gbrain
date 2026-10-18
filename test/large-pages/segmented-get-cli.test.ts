/**
 * Wave B PR 2 (spec 7.2, 7.4): around_chunk_id on a segmented page and both
 * `gbrain get` paths of one.
 *
 * 1. Protects: around_chunk_id resolves a segmented chunk from its occurrence
 *    and segment-relative span (anchor stored_span, chunk_span holding the
 *    chunk), and a chunk whose occurrence an edit retired is revision_changed
 *    rather than a guess. The local `gbrain get` streams a segmented page
 *    segment by segment, byte-identical to the same page stored inline; the
 *    thin client pages it, verifies size + sha256, and prints window by window.
 * 2. Fails when: around_chunk_id falls back to the page offset or a text match,
 *    a retired chunk resolves, the local stream holds more than a segment per
 *    write or differs from the inline print, or the thin client prints an
 *    unverified copy.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { formatGetPage, printPagedPage, streamSegmentedGet } from '../../src/cli/page-render.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { importSegmented } from '../helpers/segmented-privacy-fixture.ts';

const getPage = operations.find(o => o.name === 'get_page')!;
let engine: BrainEngine;

const ctx = (remote: boolean, thinClient = false): OperationContext => ({ engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote,
  sourceId: 'default', ...(remote ? { transport: 'http', thinClient, auth: { token: 'fixture', clientId: 'cli-client', principal: { kind: 'oauth_client', id: 'cli-client' },
    scopes: ['read'], sourceId: 'default', allowedSources: ['default'] } } : {}) } as unknown as OperationContext);
const get = async (params: Record<string, unknown>, remote = false, thin = false) => await getPage.handler(ctx(remote, thin), params) as Record<string, any>;
async function refusal(p: Promise<unknown>): Promise<OperationError> {
  try { await p; } catch (e) { if (e instanceof OperationError) return e; throw e; }
  throw new Error('expected a refusal');
}

function content(edit = ''): string {
  const day = (d: number) => [`## Day ${d}`, '', ...Array.from({ length: 120 }, (_, i) => `- ${d}.${i} alice-example asked acme-example about the widget plan${d === 300 ? edit : ''}`), ''].join('\n');
  const truth = Array.from({ length: 700 }, (_, d) => day(d)).join('\n');
  const timeline = Array.from({ length: 4_000 }, (_, i) => `- 2024-01-${String(1 + (i % 28)).padStart(2, '0')}: entry ${i} with acme-example`).join('\n');
  return `---\ntitle: Widget log\ntype: note\ntags: [log]\n---\n${truth}\n\n<!-- timeline -->\n\n${timeline}\n`;
}

const SLUG = 'logs/cli-segmented';
const TWIN = 'logs/cli-inline';

for (const kind of testBackends()) {
  describe(`gbrain get and around_chunk_id on a segmented page (${kind})`, () => {
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await importSegmented(engine, SLUG, content());
      await engine.setConfig('pages.segmented_storage', 'off');
      await importFromContent(engine, TWIN, content(), { sourceId: 'default', noEmbed: true });
      const [twin] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [TWIN]);
      expect(twin?.body_storage).toBe('inline');
    }, 300_000);

    afterAll(async () => { await close(); });

    test('around_chunk_id anchors on the chunk\'s occurrence and segment-relative span, locally and remotely', async () => {
      const chunks = await engine.executeRaw<{ id: unknown; chunk_text: string }>(`SELECT c.id, c.chunk_text FROM content_chunks c JOIN pages p ON p.id = c.page_id
        WHERE p.slug = $1 AND c.occurrence_id IS NOT NULL ORDER BY c.id`, [SLUG]);
      expect(chunks.length).toBeGreaterThan(20);
      const picks = [chunks[1]!, chunks[Math.floor(chunks.length / 2)]!, chunks[chunks.length - 2]!];
      for (const remote of [false, true]) {
        for (const chunk of picks) {
          const r = await get({ slug: SLUG, body: 'window', around_chunk_id: Number(chunk.id), context_lines: 3 }, remote);
          expect(r.anchor).toBe('stored_span');
          expect(r.window.text.replace(/\s+/g, '')).toContain(chunk.chunk_text.replace(/\s+/g, ''));
          const { byte_start: start, byte_end: end } = r.chunk_span;
          const around = (await get({ slug: SLUG, body: 'window', bytes: { offset: start, length: end - start + 4_000 } }, remote)).window;
          expect(around.byte_start).toBeLessThanOrEqual(start);
          const text = Buffer.from(around.text).subarray(start - around.byte_start, end - around.byte_start).toString('utf8');
          expect(text.replace(/\s+/g, '')).toBe(chunk.chunk_text.replace(/\s+/g, ''));
        }
      }
    }, 120_000);

    test('a chunk whose occurrence an edit retired is revision_changed, and a live one still resolves', async () => {
      const slug = 'logs/cli-retired';
      await importSegmented(engine, slug, content());
      const before = await engine.executeRaw<{ id: unknown; occurrence_id: unknown; chunk_text: string }>(`SELECT c.id, c.occurrence_id, c.chunk_text FROM content_chunks c
        JOIN pages p ON p.id = c.page_id WHERE p.slug = $1 AND c.chunk_text LIKE '%- 300.5 %'`, [slug]);
      expect(before.length).toBe(1);
      const [{ row: stale }] = await engine.executeRaw<{ row: Record<string, unknown> }>('SELECT row_to_json(c) AS row FROM content_chunks c WHERE id=$1', [before[0]!.id]) as any;
      await importSegmented(engine, slug, content(' (edited)'));
      const live = await engine.executeRaw<{ n: unknown }>(`SELECT count(*) AS n FROM page_body_manifest m JOIN pages p ON p.id = m.page_id
        WHERE p.slug = $1 AND m.occurrence_id = $2 AND m.gen_to IS NULL`, [slug, before[0]!.occurrence_id]);
      expect(Number(live[0]!.n)).toBe(0);
      const e = await refusal(get({ slug, body: 'window', around_chunk_id: Number(before[0]!.id) }, true));
      expect(e.code === 'revision_changed' || (e as any).canonical === 'revision_changed').toBe(true);
      // A chunk row that outlives its occurrence (the chunk index behind the manifest) is refused the same way, not
      // resolved by offset or text.
      await engine.executeRaw(`INSERT INTO content_chunks SELECT * FROM json_populate_record(NULL::content_chunks, ($1::text)::json)`, [JSON.stringify({ ...stale, retired_generation: null })]);
      const lagging = await refusal(get({ slug, body: 'window', around_chunk_id: Number(before[0]!.id) }, true));
      expect(lagging.code === 'revision_changed' || (lagging as any).canonical === 'revision_changed').toBe(true);
      const [current] = await engine.executeRaw<{ id: unknown }>(`SELECT c.id FROM content_chunks c JOIN pages p ON p.id = c.page_id
        WHERE p.slug = $1 AND c.chunk_text LIKE '%- 300.5 % (edited)%'`, [slug]);
      expect((await get({ slug, body: 'window', around_chunk_id: Number(current!.id) }, true)).anchor).toBe('stored_span');
    }, 300_000);

    test('local gbrain get streams the page segment by segment, byte-identical to the inline print', async () => {
      const e = await refusal(get({ slug: SLUG }));
      expect(e.code).toBe('page_body_segmented');
      const writes: string[] = [];
      expect(await streamSegmentedGet(engine, { slug: SLUG }, e, async t => { writes.push(t); })).toBe(true);
      expect(writes.length).toBeGreaterThan(4);
      expect(Math.max(...writes.map(w => Buffer.byteLength(w)))).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
      const inline = formatGetPage(await get({ slug: TWIN }));
      expect(writes.join('') === inline).toBe(true);
      const json: string[] = [];
      await streamSegmentedGet(engine, { slug: SLUG, json: true }, e, async t => { json.push(t); });
      expect(JSON.parse(json.join('')).content === inline).toBe(true);
    }, 120_000);

    test('the thin client pages the page, verifies size and sha256, and prints it window by window', async () => {
      const e = await refusal(get({ slug: SLUG }, true, true));
      expect((e as any).canonical ?? e.code).toBe('page_too_large_for_inline');
      const writes: string[] = [];
      await printPagedPage(p => get(p, true, true), { slug: SLUG }, async t => { writes.push(t); });
      expect(writes.length).toBeGreaterThan(3);
      expect(writes.join('') === formatGetPage(await get({ slug: TWIN }))).toBe(true);
      let calls = 0;
      const bad: string[] = [];
      await expect(printPagedPage(async p => {
        const r = await get(p, true, true);
        if (++calls === 2) r.window.text = r.window.text.replace('widget', 'WIDGET');
        return r;
      }, { slug: SLUG }, async t => { bad.push(t); })).rejects.toThrow(/does not match/);
      expect(bad).toEqual([]);
    }, 120_000);
  });
}
