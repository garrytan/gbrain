/**
 * #6007: put_pages — the batch write path for remote agents, plus put_page's
 * transport-only wait_ms. Every page is an ordinary put_page write request
 * admitted with the others in one transaction; a replay of the identical
 * batch writes nothing new, a changed batch is refused, and put_pages with
 * only its request_id reads progress without resending content.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { pageBatchChildRequestId, PAGE_BATCH_MAX_PAGES } from '../src/core/persistence/page-batch.ts';
import { journalLimitKey } from '../src/core/persistence/limits.ts';
import { pendingWriteHint } from '../src/core/persistence/health.ts';
import { buildMcpInstructions } from '../src/mcp/instructions.ts';

const putPages = operations.find(op => op.name === 'put_pages')!;
const putPage = operations.find(op => op.name === 'put_page')!;
let engine: PGLiteEngine;

const ctx = (extra: Partial<OperationContext> = {}): OperationContext => ({
  engine, config: { engine: 'pglite', embedding_disabled: true } as any,
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default', ...extra,
} as OperationContext);
const page = (slug: string, body = 'Body text.') => ({ slug, content: `---\ntype: note\ntitle: ${slug}\n---\n\n${body}\n` });
const requestCount = async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests'))[0]!.n);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
beforeEach(async () => { await disposePersistenceConsumer(engine); await resetPgliteState(engine); });

describe('put_pages', () => {
  test('commits every page with one receipt and deterministic child request ids', async () => {
    const batch = randomUUID();
    const result = await putPages.handler(ctx(), { request_id: batch, pages: [page('notes/a'), page('notes/b'), page('notes/c')] }) as any;
    expect(result).toMatchObject({ batch_request_id: batch, state: 'committed', terminal: true,
      counts: { total: 3, committed: 3, pending: 0, failed: 0 }, next: { action: 'done' } });
    expect(result.pages.map((p: any) => [p.index, p.slug, p.state, p.request_id])).toEqual(
      ['notes/a', 'notes/b', 'notes/c'].map((slug, index) => [index, slug, 'committed', pageBatchChildRequestId(batch, index)]));
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).not.toBeNull();
  });

  test('an identical replay writes nothing new; status-only reads the same receipt', async () => {
    const batch = randomUUID();
    const pages = [page('notes/r1'), page('notes/r2')];
    const first = await putPages.handler(ctx(), { request_id: batch, pages }) as any;
    const count = await requestCount();
    const replay = await putPages.handler(ctx(), { request_id: batch, pages, wait_ms: 1000 }) as any;
    expect(await requestCount()).toBe(count);
    expect(replay.pages.map((p: any) => p.revision)).toEqual(first.pages.map((p: any) => p.revision));
    const status = await putPages.handler(ctx(), { request_id: batch }) as any;
    expect(status).toMatchObject({ state: 'committed', counts: { total: 2, committed: 2 } });
    expect(status.pages.map((p: any) => p.slug)).toEqual(['notes/r1', 'notes/r2']);
  });

  test('a changed replay is refused and admits nothing', async () => {
    const batch = randomUUID();
    await putPages.handler(ctx(), { request_id: batch, pages: [page('notes/c1'), page('notes/c2')] });
    const count = await requestCount();
    await expect(putPages.handler(ctx(), { request_id: batch, pages: [page('notes/c1'), page('notes/c2', 'Changed.')] }))
      .rejects.toMatchObject({ code: 'idempotency_conflict', message: expect.stringContaining('notes/c2') });
    await expect(putPages.handler(ctx(), { request_id: batch, pages: [page('notes/c1'), page('notes/c2'), page('notes/c3')] }))
      .rejects.toMatchObject({ code: 'idempotency_conflict', message: expect.stringContaining('2 pages') });
    expect(await requestCount()).toBe(count);
    expect(await engine.readPageSnapshot('notes/c3', { sourceId: 'default' })).toBeNull();
  });

  test('a page refused before admission does not stop the others', async () => {
    const result = await putPages.handler(ctx(), { request_id: randomUUID(), pages: [page('notes/ok'), page('../escape')] }) as any;
    expect(result).toMatchObject({ state: 'partial', terminal: true, counts: { committed: 1, failed: 1 }, next: { action: 'fix_pages' } });
    expect(result.pages[1]).toMatchObject({ slug: '../escape', state: 'refused', error: { code: expect.any(String) } });
    expect(await engine.readPageSnapshot('notes/ok', { sourceId: 'default' })).not.toBeNull();
  });

  test('caps and a missing request_id refuse before anything is written', async () => {
    const count = await requestCount();
    const tooMany = Array.from({ length: PAGE_BATCH_MAX_PAGES + 1 }, (_, i) => page(`notes/m${i}`));
    await expect(putPages.handler(ctx(), { request_id: randomUUID(), pages: tooMany })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(putPages.handler(ctx(), { request_id: randomUUID(), pages: [page('notes/huge', 'x'.repeat(9 * 1024 * 1024))] }))
      .rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('bytes') });
    await expect(putPages.handler(ctx(), { request_id: randomUUID(), pages: [{ ...page('notes/k'), kind: 'managed_file_import' }] }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(putPages.handler(ctx(), { pages: [page('notes/n')] })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(putPages.handler(ctx(), { request_id: randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
    expect(await requestCount()).toBe(count);
  });

  test('a byte-identical repeat of a slug is one write; status and replay report it as a repeat', async () => {
    const batch = randomUUID();
    const pages = [page('notes/same', 'One session.'), page('notes/other'), page('notes/same', 'One session.')];
    const before = await requestCount();
    const result = await putPages.handler(ctx(), { request_id: batch, pages }) as any;
    expect(result).toMatchObject({ state: 'committed', terminal: true, counts: { total: 3, committed: 3, failed: 0 }, next: { action: 'done' } });
    expect(result.pages[2]).toMatchObject({ index: 2, slug: 'notes/same', state: 'committed', repeat_of: 0, request_id: result.pages[0].request_id, revision: result.pages[0].revision });
    expect(result.pages[0].repeat_of).toBeUndefined();
    expect(await requestCount()).toBe(before + 2);
    const status = await putPages.handler(ctx(), { request_id: batch }) as any;
    expect(status.pages.map((p: any) => [p.index, p.slug, p.state, p.repeat_of])).toEqual([[0, 'notes/same', 'committed', undefined], [1, 'notes/other', 'committed', undefined], [2, 'notes/same', 'committed', 0]]);
    await putPages.handler(ctx(), { request_id: batch, pages, wait_ms: 1000 });
    expect(await requestCount()).toBe(before + 2);
  });

  test('repeats of a slug that differ are each refused with their own error; the rest of the batch is written', async () => {
    const result = await putPages.handler(ctx(), { request_id: randomUUID(), pages: [page('notes/x', 'First.'), page('notes/y'), page('notes/x', 'Second.'), page('Notes/X', 'First.')] }) as any;
    expect(result).toMatchObject({ state: 'partial', terminal: true, counts: { total: 4, committed: 1, failed: 3 }, next: { action: 'fix_pages' } });
    expect(result.pages[1]).toMatchObject({ slug: 'notes/y', state: 'committed' });
    for (const index of [0, 2, 3]) {
      expect(result.pages[index]).toMatchObject({ state: 'refused', error: { code: 'invalid_params' } });
      expect(result.pages[index].error.message).toContain(`pages[${index}]`);
    }
    expect(result.pages[0].error.message).toContain('pages[2], pages[3]');
    expect(await engine.readPageSnapshot('notes/x', { sourceId: 'default' })).toBeNull();
    expect(await engine.readPageSnapshot('notes/y', { sourceId: 'default' })).not.toBeNull();
  });

  test('capacity is reserved for the whole batch or none of it', async () => {
    await engine.setConfig(journalLimitKey('principalOutstanding'), '2');
    try {
      await expect(putPages.handler(ctx(), { request_id: randomUUID(), wait_ms: 0, pages: [page('notes/q1'), page('notes/q2'), page('notes/q3')] }))
        .rejects.toMatchObject({ code: 'queue_capacity', message: expect.stringContaining('No page of batch') });
      expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE slug LIKE 'notes/q%'")).toEqual([]);
    } finally {
      await engine.unsetConfig(journalLimitKey('principalOutstanding'));
    }
  });

  test('every page needs put_page permission', async () => {
    const clientId = 'put-pages-batch-only';
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations)
      VALUES($1,'Batch-only fixture','read write','default',$2)`, [clientId, ['put_pages']]);
    const caller = ctx({ auth: { token: 'synthetic', clientId, principal: { kind: 'oauth_client', id: clientId },
      sourceId: 'default', scopes: ['read', 'write'], allowedOperations: ['put_pages'] } as any });
    await expect(putPages.handler(caller, { request_id: randomUUID(), pages: [page('notes/denied'), page('notes/denied-2')] }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect(await engine.readPageSnapshot('notes/denied', { sourceId: 'default' })).toBeNull();
  });
});

describe('put_pages links', () => {
  test('forward references inside a batch become mention links without a status poll', async () => {
    const batch = randomUUID();
    const result = await putPages.handler(ctx(), { request_id: batch, pages: [
      page('notes/fwd-a', 'See [[notes/fwd-b]] for details.'), page('notes/fwd-b', 'Back to [[notes/fwd-a]].')] }) as any;
    expect(result.state).toBe('committed');
    const edges = async () => engine.executeRaw<{ edge: string }>(`SELECT f.slug || '>' || t.slug AS edge FROM links l
      JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE l.link_source='mcp-remote-mention' ORDER BY 1`);
    const deadline = Date.now() + 15_000;
    while ((await edges()).length < 2 && Date.now() < deadline) await Bun.sleep(100);
    expect((await edges()).map(row => row.edge)).toEqual(['notes/fwd-a>notes/fwd-b', 'notes/fwd-b>notes/fwd-a']);
    // The last page's publication re-armed every page's links pass once, so an
    // earlier page whose pass ran before its target existed is linked anyway.
    const rearmed = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE kind='links' AND data ? 'batch_reconciled'");
    expect(rearmed[0]!.n).toBe(2);
  }, 30_000);
});

describe('put_page wait_ms', () => {
  test('is not part of the write identity: a replay with another wait is not a conflict', async () => {
    const request_id = randomUUID();
    const first = await putPage.handler(ctx(), { ...page('notes/w'), request_id, wait_ms: 20000 }) as any;
    const replay = await putPage.handler(ctx(), { ...page('notes/w'), request_id }) as any;
    expect(replay.revision ?? replay.write_request?.revision).toBe(first.revision ?? first.write_request?.revision);
    const [row] = await engine.executeRaw<{ intent: Record<string, unknown> }>('SELECT intent FROM persistence_requests WHERE request_id=$1::uuid', [request_id]);
    expect(row!.intent).not.toHaveProperty('wait_ms');
  });

  test('out of range refuses with invalid_write_wait before admission', async () => {
    const request_id = randomUUID();
    await expect(putPage.handler(ctx(), { ...page('notes/wx'), request_id, wait_ms: 30_001 })).rejects.toMatchObject({ code: 'invalid_write_wait' });
    await expect(putPage.handler(ctx(), { ...page('notes/wx'), request_id, wait_ms: -1 })).rejects.toMatchObject({ code: 'invalid_write_wait' });
    expect(await engine.executeRaw('SELECT 1 FROM persistence_requests WHERE request_id=$1::uuid', [request_id])).toEqual([]);
  });

  test('a caller cannot forge batch membership through put_page', async () => {
    const request_id = randomUUID();
    await putPage.handler(ctx(), { ...page('notes/forged'), request_id, page_batch: { id: randomUUID(), index: 0, size: 1 } });
    const [row] = await engine.executeRaw<{ intent: Record<string, unknown> }>('SELECT intent FROM persistence_requests WHERE request_id=$1::uuid', [request_id]);
    expect(row!.intent).not.toHaveProperty('page_batch');
  });
});

describe('agent guidance', () => {
  const all = (name: string) => name !== '__none__';
  test('instructions name put_pages and wait_ms only when callable', () => {
    expect(buildMcpInstructions({ tools: { callable: all } })).toContain('use put_pages');
    expect(buildMcpInstructions({ tools: { callable: all } })).toContain('wait_ms');
    const pageOnly = buildMcpInstructions({ tools: { callable: name => name !== 'put_pages' } });
    expect(pageOnly).not.toContain('put_pages');
    expect(pageOnly).toContain('wait_ms');
    const readOnly = buildMcpInstructions({ tools: { callable: name => !['put_page', 'put_pages'].includes(name) } });
    expect(readOnly).not.toContain('wait_ms');
  });

  test('a pending put_page names wait_ms and put_pages; other verbs do not', () => {
    const receipt = { request_id: randomUUID(), state: 'queued', retry_after_ms: 800 } as any;
    expect(pendingWriteHint(receipt, 'put_page')).toContain('wait_ms');
    expect(pendingWriteHint(receipt, 'put_page')).toContain('put_pages');
    expect(pendingWriteHint(receipt, 'remember')).not.toContain('put_pages');
  });
});
