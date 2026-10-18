/**
 * Wave B PR 2 (spec 7.2, read-privacy 1): get_page over a segmented page shows a
 * remote caller nothing the whole-body read projection hides.
 *
 * 1. Protects: every remote get_page shape of a segmented page (body none, auto,
 *    every outline page, windows by bytes and lines, a cursor walk to the end,
 *    view: 'markdown' paged to its end) over pages seeded with takes, private
 *    facts rows, private keys, ledger rows and a takes block left open to EOF.
 *    The paged markdown view must hash to the advertised size.sha256, and the
 *    remote tail digest is withheld when the tail rows hold a protected region.
 *    A remote caller's sizes (body none, the full-read refusal) are projected
 *    totals; only a trusted read reports the stored body_bytes.
 * 2. Fails when: a segmented window, outline or markdown page is cut from the
 *    stored body instead of the read projection, the markdown digest hashes
 *    trusted text, tail_sha256 hashes hidden text, or a remote response
 *    carries the stored body size. PUBLIC tokens must still appear.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import { PRIVATE, PUBLIC, crossingFacts, importSegmented, pageContent, privacyText, privateTokensIn, seedLedger } from '../helpers/segmented-privacy-fixture.ts';

const getPage = operations.find(o => o.name === 'get_page')!;
let engine: BrainEngine;

const ctx = (remote: boolean): OperationContext => ({ engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote,
  sourceId: 'default', ...(remote ? { transport: 'http', auth: { token: 'fixture', clientId: 'privacy-client', principal: { kind: 'oauth_client', id: 'privacy-client' },
    scopes: ['read'], sourceId: 'default', allowedSources: ['default'] } } : {}) } as unknown as OperationContext);
const get = async (params: Record<string, unknown>, remote = true) => await getPage.handler(ctx(remote), params) as Record<string, any>;

/** Every remote get_page shape of `slug`: none may hold a private token, and the windows together show every public one. */
async function expectNoLeak(slug: string, ledger = false): Promise<Record<string, any>> {
  const responses: Array<Record<string, any>> = [];
  const windowTexts: string[] = [];
  const none = await get({ slug, body: 'none' });
  expect(none.body_storage).toBe('segmented');
  responses.push(none, await get({ slug }));
  for (let from: number | undefined = 0; from !== undefined;) {
    const r = await get({ slug, body: 'outline', outline_from: from });
    responses.push(r);
    from = r.outline.next_from_index;
  }
  const total = Number(none.size.total_bytes);
  for (const at of [0, 0.13, 0.5, 0.77, 0.99]) responses.push(await get({ slug, body: 'window', bytes: { offset: Math.floor(total * at), length: 30_000 } }));
  for (const from of [1, 2_000, 9_000, 20_000]) responses.push(await get({ slug, body: 'window', lines: { from, count: 300 } }));
  for (const view of ['read', 'markdown'] as const) {
    let r = await get({ slug, body: 'window', view, max_bytes: 250_000 });
    const parts: string[] = [r.window.text];
    responses.push(r);
    while (r.next_cursor) {
      r = await get({ slug, view, cursor: r.next_cursor });
      parts.push(r.window.text);
      responses.push(r);
    }
    const whole = parts.join('');
    windowTexts.push(whole);
    if (view === 'markdown') {
      expect(Buffer.byteLength(whole)).toBe(r.size.total_bytes);
      expect(createHash('sha256').update(whole).digest('hex')).toBe(r.size.sha256);
    } else {
      expect(Buffer.byteLength(whole)).toBe(total);
    }
  }
  for (const [i, r] of responses.entries()) expect({ i, leaked: privateTokensIn(JSON.stringify(r), { ledger }) }).toEqual({ i, leaked: [] });
  for (const text of windowTexts) for (const token of Object.values(PUBLIC)) expect(text).toContain(token);
  return none;
}

for (const kind of testBackends()) {
  describe(`remote get_page of a segmented page (${kind})`, () => {
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
    });

    test('none, auto, outline pages, windows and the markdown view show nothing private', async () => {
      const r = mulberry32(201);
      const slug = 'notes/get-windows';
      await importSegmented(engine, slug, pageContent(privacyText(r, 1_600_000) + crossingFacts(), privacyText(r, 300_000)));
      const none = await expectNoLeak(slug);
      // A remote caller sees projected totals only, as for an inline page: the stored size would say how much the
      // projection hides. The trusted read keeps it.
      expect(none.size.body_bytes).toBeUndefined();
      expect(none.size.body_lines).toBeUndefined();
      const local = await get({ slug, body: 'none' }, false);
      expect(local.size.body_bytes).toBeGreaterThan(1_900_000);
      expect(none.size.total_bytes).toBeLessThan(local.size.body_bytes);
      const refusal = await get({ slug, body: 'full' }).then(() => null, (e: { code?: string; message: string; detail?: string }) => e);
      expect(refusal?.code).toBe('page_body_segmented');
      expect(JSON.parse(refusal!.detail!).total_bytes).toBe(none.size.total_bytes);
      expect(refusal!.message).toContain(`its ${none.size.total_bytes}-byte body`);
      expect(refusal!.message).not.toContain(String(local.size.body_bytes));
      const localRefusal = await get({ slug, body: 'full' }, false).then(() => null, (e: { message: string }) => e);
      expect(localRefusal!.message).toContain(`its ${local.size.body_bytes}-byte body`);
    }, 300_000);

    test('withdrawn, purged and held rows stay hidden once the ledger records them', async () => {
      const r = mulberry32(203);
      const slug = 'notes/get-ledger';
      await importSegmented(engine, slug, pageContent(privacyText(r, 1_400_000), privacyText(r, 200_000)));
      const before = await get({ slug, body: 'window', view: 'markdown', max_bytes: 2_000_000 });
      expect(before.window.text).toContain(PRIVATE.withdrawn);
      await seedLedger(engine, slug);
      await expectNoLeak(slug, true);
    }, 300_000);

    test('a takes block left open to the end hides the tail and withholds its digest from a remote caller', async () => {
      const r = mulberry32(207);
      const slug = 'notes/get-tail';
      const tail = `<!--- gbrain:takes:begin -->\n${privacyText(r, 1_200_000, { keys: false }).replaceAll('zzpublic', `${PRIVATE.tail} `)}\n${PRIVATE.tail} last words\n`;
      await importSegmented(engine, slug, pageContent(privacyText(r, 1_200_000) + tail));
      const none = await expectNoLeak(slug);
      expect(none.size.tail_sha256).toBeUndefined();
      const local = await get({ slug, body: 'none' }, false);
      expect(local.size.tail_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(local.size.tail_region).toBe('truth');
    }, 300_000);
  });
}
