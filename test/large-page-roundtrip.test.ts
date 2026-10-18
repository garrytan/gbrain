/**
 * Large pages (Wave A, T4/T13/T22): a windowed read can never be written back
 * as the whole page, and every client that prints a page prints all of it.
 *
 *   - get(auto) of a 2 MB page, then put_page of what came back, is refused
 *     (page_shrink_refused); force cannot stand in for expected_revision.
 *   - the local `gbrain get` prints the page byte-for-byte as it was written.
 *   - the thin client, refused a whole page, pages the round-trip markdown to
 *     its end and checks size + sha256; a page edited mid-read restarts, a
 *     mismatch fails without printing.
 *
 * Hermetic in-memory PGLite.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { formatGetPage, readWholePageMarkdown, wantsWholePage } from '../src/cli/page-render.ts';

let engine: PGLiteEngine;
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
const getPage = operations.find(o => o.name === 'get_page')!;
const putPage = operations.find(o => o.name === 'put_page')!;
const CLIENT = 'client-large-pages-example';

const localCtx = (): OperationContext => ({ engine, config: {} as GBrainConfig, logger: noopLogger, dryRun: false, remote: false, sourceId: 'default' } as OperationContext);
const remoteCtx = (extra: Partial<OperationContext> = {}): OperationContext => ({ ...localCtx(), remote: true, transport: 'http',
  auth: { token: 'fixture', clientId: CLIENT, principal: { kind: 'oauth_client', id: CLIENT }, scopes: ['read', 'write'], sourceId: 'default', allowedSources: ['default'] },
  writeWaitMs: 60_000, ...extra } as unknown as OperationContext);

const get = async (ctx: OperationContext, params: Record<string, unknown>) => await getPage.handler(ctx, params) as Record<string, any>;
async function refusal(p: Promise<unknown>): Promise<OperationError> {
  try { await p; } catch (e) { if (e instanceof OperationError) return e; throw e; }
  throw new Error('expected a refusal');
}
const codeOf = (e: OperationError) => (e as any).canonical ?? e.code;

function bigBody(marker: string): string {
  const lines = ['# Conversation log with acme-example', ''];
  for (let i = 0; i < 34_000; i++) lines.push(`**bob-example:** 2026-03-${String(1 + (i % 28)).padStart(2, '0')} ${marker} line ${i} about the widget plan`);
  return lines.join('\n');
}
const SOURCE = serializeMarkdown({ source: 'chat-export' }, bigBody('v1'), '- 2026-03-01: Kickoff with acme-example', { type: 'note', title: 'Big log', tags: ['log'] });

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Wave A inline behaviour: pin segmented storage off (segmented reads of get_page and gbrain get are lane 2a's).
  await engine.setConfig('pages.segmented_storage', 'off');
  await registerLocalWriter(engine, 'cli');
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id)
    VALUES($1,'fixture-hash','example-client','read write','default')`, [CLIENT]);
  expect(Buffer.byteLength(SOURCE)).toBeGreaterThan(2 * 1024 * 1024);
  expect((await importFromContent(engine, 'logs/big-example', SOURCE, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
}, 120_000);

afterAll(async () => { resetGateway(); await engine.disconnect(); }, 30_000);

describe('local gbrain get', () => {
  test('prints the 2 MB page byte-for-byte as its source file (frontmatter adds only the import size stamps)', async () => {
    const out = formatGetPage(await get(localCtx(), { slug: 'logs/big-example' }));
    const split = (md: string) => { const end = md.indexOf('\n---\n', 4) + 5; return { fm: md.slice(0, end), body: md.slice(end) }; };
    // The oversized-page import stamps (embed_skip, content_flag) are the ingest policy's, not the read's.
    const unstamped = split(out).fm.replace(/^(embed_skip|content_flag):\n(?: {2}.*\n)+/gm, '');
    expect(split(out).body === split(SOURCE).body).toBe(true);
    expect(unstamped).toBe(split(SOURCE).fm);
    expect(out.endsWith('- 2026-03-01: Kickoff with acme-example\n')).toBe(true);
  }, 60_000);

  test('a partial response prints only its window and says so on stderr', async () => {
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const r = await get(localCtx(), { slug: 'logs/big-example', body: 'window', lines: { from: 10, count: 2 } });
      const out = formatGetPage(r);
      expect(out.split('\n').filter(Boolean)).toHaveLength(2);
      expect(String(err.mock.calls[0]?.[0])).toContain('partial page: bytes');
    } finally { err.mockRestore(); }
  });
});

describe('put_page after a windowed read', () => {
  test('get(auto) then put of what came back is page_shrink_refused, and nothing changes', async () => {
    const r = await get(remoteCtx(), { slug: 'logs/big-example' });
    expect(r.compiled_truth).toBeUndefined();
    expect(r.content).toBeUndefined();
    const before = (await engine.getPage('logs/big-example'))!.compiled_truth;
    const naive = serializeMarkdown(r.frontmatter, r.window.text, '', { type: r.type, title: r.title, tags: r.tags });
    const e = await refusal(putPage.handler(remoteCtx(), { slug: 'logs/big-example', content: naive, expected_revision: r.revision }));
    expect(e.code).toBe('page_shrink_refused');
    expect(e.suggestion).toContain('edit_page');
    expect(e.suggestion).toContain('allow_shrink');
    expect(e.fix?.mcp).toMatchObject({ tool: 'get_page', arguments: { slug: 'logs/big-example', body: 'none' } });
    expect((await engine.getPage('logs/big-example'))!.compiled_truth).toBe(before);
  }, 60_000);

  test('force does not stand in for expected_revision on a large page', async () => {
    const e = await refusal(putPage.handler(remoteCtx(), { slug: 'logs/big-example', content: SOURCE, force: true }));
    expect(e.code).toBe('revision_required');
  }, 60_000);

  test('the complete page read through windows writes back unchanged in size', async () => {
    const paged = await readWholePageMarkdown(p => get(remoteCtx(), p), { slug: 'logs/big-example' });
    const edited = paged.markdown.replace('v1 line 33999', 'v1 line 33999 (edited)');
    const res = await putPage.handler(remoteCtx(), { slug: 'logs/big-example', content: edited, expected_revision: paged.revision }) as Record<string, any>;
    expect(res.status ?? res.write_request?.status).toBeDefined();
    expect((await engine.getPage('logs/big-example'))!.compiled_truth).toContain('v1 line 33999 (edited)');
  }, 120_000);

  test('allow_shrink: true lets an intended smaller page through', async () => {
    await putPage.handler(localCtx(), { slug: 'logs/shrink-example', content: SOURCE });
    const r = await get(remoteCtx(), { slug: 'logs/shrink-example', body: 'none' });
    await putPage.handler(remoteCtx(), { slug: 'logs/shrink-example', content: '---\ntype: note\ntitle: Short\n---\n\nSummary only.\n', expected_revision: r.revision, allow_shrink: true });
    expect((await engine.getPage('logs/shrink-example'))!.compiled_truth.trim()).toBe('Summary only.');
  }, 120_000);
});

describe('thin client', () => {
  const thin = () => remoteCtx({ thinClient: true });

  test('naming no mode, the whole page is refused over HTTP, never sent partial', async () => {
    expect(wantsWholePage({ slug: 'logs/big-example' })).toBe(true);
    const e = await refusal(get(thin(), { slug: 'logs/big-example' }));
    expect(codeOf(e)).toBe('page_too_large_for_inline');
  });

  test('pages the round-trip markdown to its end and it equals include_content', async () => {
    const whole = (await get(localCtx(), { slug: 'logs/big-example', include_content: true })).content as string;
    const paged = await readWholePageMarkdown(p => get(thin(), p), { slug: 'logs/big-example' });
    expect(paged.windows).toBeGreaterThan(3);
    expect(paged.markdown === whole).toBe(true);
  }, 60_000);

  test('a page edited mid-read restarts and returns the new page whole', async () => {
    await putPage.handler(localCtx(), { slug: 'logs/moving-example', content: SOURCE });
    let calls = 0;
    const paged = await readWholePageMarkdown(async p => {
      if (++calls === 2) {
        const cur = await get(localCtx(), { slug: 'logs/moving-example', include_content: true });
        await putPage.handler(localCtx(), { slug: 'logs/moving-example', content: cur.content.replace('v1 line 3 ', 'v2 line 3 '), expected_revision: cur.revision });
      }
      return get(thin(), p);
    }, { slug: 'logs/moving-example' });
    expect(paged.markdown).toContain('v2 line 3 ');
    expect(paged.markdown).toBe((await get(localCtx(), { slug: 'logs/moving-example', include_content: true })).content);
  }, 120_000);

  test('a copy that does not match the reported sha256 fails without returning text', async () => {
    let calls = 0;
    await expect(readWholePageMarkdown(async p => {
      const r = await get(thin(), p);
      if (++calls === 2) r.window.text = r.window.text.replace('line', 'LINE');
      return r;
    }, { slug: 'logs/big-example' })).rejects.toThrow(/does not match/);
  }, 60_000);
});
