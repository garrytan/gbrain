/**
 * Wave B PR 2 lane 2r: the read refusals and partial reads of a page stored in
 * segments, next to the same content stored inline.
 *
 * 1. Protects:
 *    - get_page body 'full' refuses with page_body_segmented for a trusted local
 *      caller and for a remote MCP caller alike, with a fix that reads it in
 *      pieces (body 'auto', argv and mcp); gbrain's thin client keeps its
 *      paging signal, page_too_large_for_inline. The fix runs and answers.
 *    - grammar_diagnostics on a segmented page answers the read with a
 *      structured `line_grammar: { state: 'skipped', reason }` instead of
 *      throwing; an inline page still gets its report.
 *    - entity builds the same card (identity excerpt included) for the
 *      segmented page as for the inline one when the excerpt's lines sit in
 *      the lead it reads (EXCERPT_LEAD_BYTES).
 *    - window byte offsets are coordinates of size.total_bytes on both
 *      storages: a tail window computed from total_bytes returns the last
 *      bytes, and an offset at or past total_bytes returns the same empty
 *      window for the inline and the segmented page.
 * 2. Fails when: the local and remote refusals carry different codes, a fix
 *    points at body 'none', grammar_diagnostics or entity read the body
 *    getters of a segmented page, or the two storages answer a window
 *    differently.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { OperationError, type OperationContext } from '../../src/core/ops/contract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { EXCERPT_LEAD_BYTES } from '../../src/core/verbs/entity-card-identity.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const SLUG = 'people/zara-example';
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** A person page over 1 MiB whose identity lines and a typed relation line sit in its first few KB. */
function content(): string {
  const lead = ['# Zara Example', '', 'Zara Example, also known as Z. Example, founded Acme Example.', '', '- Role: founder at Widget Co',
    '- Board: Northwind Example', '- advises [[companies/acme-example]]', '', 'Met Bob Example and Carol Example at the launch.', ''].join('\n');
  return `---\ntype: person\ntitle: Zara Example\n---\n\n${lead}\n${conversationBody(1_300_000, { seed: 9 })}\n`;
}

async function refusal(run: Promise<unknown>): Promise<OperationError> {
  try { await run; } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

for (const kind of testBackends()) {
  describe(`segmented read refusals and partial reads (${kind})`, () => {
    const engines = {} as Record<'inline' | 'segmented', BrainEngine>;
    const closers: Array<() => Promise<void>> = [];

    beforeAll(async () => {
      for (const storage of ['inline', 'segmented'] as const) {
        let engine: BrainEngine;
        if (kind === 'postgres') {
          const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
          engine = pg.engine; closers.push(pg.close);
        } else {
          engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
          closers.push(() => engine.disconnect());
        }
        await engine.setConfig('pages.segmented_storage', storage === 'segmented' ? 'on' : 'off');
        await importFromContent(engine, SLUG, content(), { sourceId: 'default', noEmbed: true });
        const [row] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [SLUG]);
        expect(row?.body_storage).toBe(storage);
        engines[storage] = engine;
      }
    }, 300_000);

    afterAll(async () => { for (const close of closers) await close(); });

    const ctx = (engine: BrainEngine, remote: boolean, thinClient = false): OperationContext => ({ engine, config: {} as GBrainConfig, logger: noopLogger,
      dryRun: false, remote, sourceId: 'default', ...(remote ? { transport: 'stdio', thinClient, auth: { token: 'fixture', clientId: 'refusal-client',
        principal: { kind: 'oauth_client', id: 'refusal-client' }, scopes: ['read'], sourceId: 'default', allowedSources: ['default'] } } : {}) } as unknown as OperationContext);
    const call = async (storage: 'inline' | 'segmented', op: string, params: Record<string, unknown>, remote = false, thin = false) =>
      await operationsByName[op]!.handler(ctx(engines[storage], remote, thin), params) as Record<string, any>;

    test('body full refuses page_body_segmented locally and remotely, with a fix that reads it in pieces', async () => {
      const local = await refusal(call('segmented', 'get_page', { slug: SLUG, body: 'full' }));
      const remote = await refusal(call('segmented', 'get_page', { slug: SLUG, body: 'full' }, true));
      const implicit = await refusal(call('segmented', 'get_page', { slug: SLUG }));
      for (const e of [local, remote, implicit]) {
        expect(e.code).toBe('page_body_segmented');
        expect(e.canonicalCode).toBe('page_body_segmented');
        expect(e.fix?.mcp).toEqual({ tool: 'get_page', arguments: { slug: SLUG, source_id: 'default', body: 'auto' } });
        expect(e.fix?.argv).toEqual(['gbrain', 'get', '--source', 'default', '--body', 'auto', '--', SLUG]);
        expect(e.suggestion).toContain("body: 'auto'");
      }
      const thin = await refusal(call('segmented', 'get_page', { slug: SLUG }, true, true));
      expect(thin.canonicalCode).toBe('page_too_large_for_inline');
      for (const remoteCall of [false, true]) {
        const auto = await call('segmented', 'get_page', local.fix!.mcp!.arguments as Record<string, unknown>, remoteCall);
        expect(auto).toMatchObject({ body: 'outline', body_storage: 'segmented', truncated: true, auto_reason: 'over_inline_bytes' });
        expect(auto.window.text).toContain('Zara Example, also known as');
      }
    }, 120_000);

    test('grammar_diagnostics is skipped with a reason on a segmented page, never thrown', async () => {
      for (const remote of [false, true]) {
        const segmented = await call('segmented', 'get_page', { slug: SLUG, body: 'none', grammar_diagnostics: true }, remote);
        expect(segmented.body).toBe('none');
        expect(segmented.line_grammar).toMatchObject({ state: 'skipped', reason: 'page_body_segmented' });
        expect(segmented.line_grammar.fix.mcp).toEqual({ tool: 'get_page', arguments: { slug: SLUG, source_id: 'default', body: 'auto' } });
        const inline = await call('inline', 'get_page', { slug: SLUG, body: 'none', grammar_diagnostics: true }, remote);
        expect(inline.line_grammar.state).toBe('ok');
      }
    }, 120_000);

    test('entity builds the same card from the segmented lead as from the inline body', async () => {
      expect(content().indexOf('Met Bob Example')).toBeLessThan(EXCERPT_LEAD_BYTES);
      for (const remote of [false, true]) {
        const [inline, segmented] = await Promise.all((['inline', 'segmented'] as const).map(s => call(s, 'entity', { name: 'Zara Example' }, remote)));
        expect(segmented.found).toBe(true);
        expect(segmented.card.identity_excerpt?.length).toBeGreaterThan(0);
        const comparable = (r: Record<string, any>) => {
          const card = JSON.parse(JSON.stringify(r.card));
          delete card.last_touched;
          delete card.coverage;
          return card;
        };
        expect(comparable(segmented)).toEqual(comparable(inline));
      }
    }, 120_000);

    test('window offsets are size.total_bytes coordinates; past the end both storages return the same empty window', async () => {
      for (const remote of [false, true]) {
        const [inlineNone, segmentedNone] = await Promise.all((['inline', 'segmented'] as const).map(s => call(s, 'get_page', { slug: SLUG, body: 'none' }, remote)));
        const total = inlineNone.size.total_bytes;
        expect(segmentedNone.size.total_bytes).toBe(total);
        for (const bytes of [{ offset: total - 64, length: 64 }, { offset: total, length: 64 }, { offset: total + 10_000, length: 64 }]) {
          const [inline, segmented] = await Promise.all((['inline', 'segmented'] as const).map(s => call(s, 'get_page', { slug: SLUG, body: 'window', bytes }, remote)));
          expect(segmented.window).toEqual(inline.window);
          expect(segmented.truncated).toBe(inline.truncated);
          expect(segmented.next_cursor).toBe(inline.next_cursor);
          if (bytes.offset >= total) expect(segmented.window).toMatchObject({ text: '', byte_start: total, byte_end: total });
          else expect(segmented.window.byte_end).toBe(total);
        }
      }
    }, 120_000);
  });
}
