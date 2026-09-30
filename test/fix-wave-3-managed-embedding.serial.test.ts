/**
 * Fix wave 3 cross-lane check: #4616 (Lane C) on a managed brain. Managed
 * writes embed through the persistence consumer's embedding effect, not the
 * import path Lane C's own suite drives.
 *
 * Authoring gate. (1) Protects the #4616 contract where most writes embed: one
 * degenerate vector refuses only its chunk; the page's other vectors install,
 * the page signature stays unstamped so `gbrain embed --stale` finds the
 * refused chunk, the effect ends terminally as `embedding_zero_norm` (never
 * retried), and the write receipt carries the recovery command. (2) Fails when
 * the effect throws the whole page's vectors away or records the refusal as
 * `embedding_configuration`, as it did before this integration.
 * (3) test/embedding-zero-norm-4616.serial.test.ts covers the gateway, import
 * and `gbrain embed` paths on an unmanaged brain only. (4) The provider is the
 * gateway's process-global transport seam, so this file is serial.
 */
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const DIMS = 1536;
// Installed per test, not in beforeAll: the Postgres arm imports this file beside suites that reset the gateway.
let degenerate = true;
function installProvider() {
  degenerate = true;
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async (input: { values: string[] }) => ({
    embeddings: input.values.map(text => new Array(DIMS).fill(degenerate && text.includes('DEGENERATE') ? 0 : 0.01)), usage: { tokens: input.values.length },
  })) as never);
}
afterAll(() => { __setEmbedTransportForTests(null); resetGateway(); });

const section = (n: number, marker = '') => `## Section ${n}\n\n${Array.from({ length: 120 }, (_, i) => `Example sentence ${n}.${i} about the plan${marker}.`).join(' ')}\n`;

for (const backend of testBackends()) test(`${backend}: a degenerate vector in a managed embedding effect refuses only its chunk and delivers the recovery command`, async () => {
  installProvider();
  await managedBrain(async ({ engine, ctx: base }) => {
    const ctx = { ...base, config: { engine: engine.kind } } as OperationContext;
    const slug = 'notes/zero-norm-example';
    const body = [section(1), section(2, ' DEGENERATE'), section(3)].join('\n');
    const receipt = await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
      content: `---\ntype: note\ntitle: Zero norm example\n---\n\n${body}` } }) as { state: string; request_id: string };
    expect(receipt.state).toBe('committed');
    const effect = async () => (await engine.executeRaw<{ state: string; error_code: string | null }>(
      "SELECT e.state,e.error_code FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.slug=$1 AND e.kind='embedding'", [slug]))[0];
    const deadline = Date.now() + 30_000;
    while (!['failed', 'committed'].includes((await effect())?.state ?? '') && Date.now() < deadline) await Bun.sleep(100);
    expect(await effect()).toEqual({ state: 'failed', error_code: 'embedding_zero_norm' });
    const chunks = await engine.executeRaw<{ text: string; embedded: boolean }>(
      "SELECT c.chunk_text AS text,c.embedding IS NOT NULL AS embedded FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1 ORDER BY c.chunk_index", [slug]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.embedded).toBe(!chunk.text.includes('DEGENERATE'));
    expect(chunks.some(chunk => chunk.embedded)).toBe(true);
    const [page] = await engine.executeRaw<{ signature: string | null }>('SELECT embedding_signature AS signature FROM pages WHERE slug=$1', [slug]);
    expect(page!.signature).toBeNull();
    const op = operations.find(o => o.name === 'get_write_request')!;
    const status = await op.handler(ctx, { request_id: receipt.request_id }) as { effects: Array<{ kind: string; reason?: string; suggestion?: string; docs?: string }> };
    expect(status.effects.find(e => e.kind === 'embedding')).toMatchObject({ state: 'failed', reason: 'embedding_zero_norm',
      docs: 'docs/guides/write-refusals.md#embedding_zero_norm' });
    expect(status.effects.find(e => e.kind === 'embedding')!.suggestion).toContain(`gbrain embed ${slug}`);
  }, { databaseUrl: backend === 'postgres' ? process.env.DATABASE_URL : undefined });
}, 120_000);

for (const backend of testBackends()) test(`${backend}: a refused chunk that held an earlier vector is cleared, and the page is not left looking fully embedded`, async () => {
  installProvider();
  degenerate = false;
  await managedBrain(async ({ engine, ctx: base }) => {
    const ctx = { ...base, config: { engine: engine.kind } } as OperationContext;
    const slug = 'notes/zero-norm-reembed';
    const put = async (lead: string) => {
      const current = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      return submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), ...(current ? { expected_revision: current.revision } : {}),
        content: `---\ntype: note\ntitle: Zero norm reembed\n---\n\n${lead}\n\n${[section(1), section(2, ' DEGENERATE'), section(3)].join('\n')}` } });
    };
    const settled = async () => {
      const deadline = Date.now() + 30_000;
      const state = async () => (await engine.executeRaw<{ state: string }>(
        "SELECT e.state FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.slug=$1 AND e.kind='embedding' ORDER BY e.id DESC LIMIT 1", [slug]))[0]?.state;
      while (!['failed', 'committed'].includes((await state()) ?? '') && Date.now() < deadline) await Bun.sleep(100);
      return state();
    };
    await put('First version.');
    expect(await settled()).toBe('committed');
    // Every chunk now has a vector. Under per-chunk synopsis every chunk is re-embedded on the next edit.
    await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode='per_chunk_synopsis' WHERE slug=$1", [slug]).catch(async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode='per_chunk_synopsis' WHERE slug=$1", [slug]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    });
    degenerate = true;
    await put('Second version.');
    expect(await settled()).toBe('failed');
    const chunks = await engine.executeRaw<{ text: string; embedded: boolean }>(
      "SELECT c.chunk_text AS text,c.embedding IS NOT NULL AS embedded FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1 ORDER BY c.chunk_index", [slug]);
    for (const chunk of chunks.filter(c => c.text.includes('DEGENERATE'))) expect(chunk.embedded).toBe(false);
    const [page] = await engine.executeRaw<{ signature: string | null }>('SELECT embedding_signature AS signature FROM pages WHERE slug=$1', [slug]);
    expect(page!.signature).toBeNull();
  }, { databaseUrl: backend === 'postgres' ? process.env.DATABASE_URL : undefined });
}, 120_000);
