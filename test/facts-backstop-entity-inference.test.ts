/**
 * #5836 — the facts backstop infers a missing subject (zero LLM) from the
 * page being written or one exact mention, applies it only where the fact is
 * fenced, notes it in the context cell, and keeps remote callers inside
 * their fences and readable pages. Every write is followed by the
 * extract_facts reconcile, whose legacy guard must stay clear.
 *
 * PGLite, unmanaged (persistence off), chat stubbed. Synthetic names only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop, runFactsPipeline, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
let dir: string;
const BODY = 'notes from the quarterly planning review with the whole team present '.repeat(3);

function chatStub(facts: Array<{ fact: string; entity?: string | null }>) {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts: facts.map(f => ({ fact: f.fact, kind: 'fact', entity: f.entity ?? null, confidence: 1, notability: 'high' })) }),
    blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
  }));
}
const ctx = (overrides: Partial<FactsBackstopCtx> = {}): FactsBackstopCtx =>
  ({ engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline', visibility: 'world', ...overrides });
const remoteOp = (overrides: Partial<OperationContext> = {}): OperationContext =>
  ({ engine, remote: true, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false, logger: console, ...overrides } as OperationContext);
async function rows(ids: number[]) {
  return engine.executeRaw<{ id: number; fact: string; entity_slug: string | null; context: string | null; row_num: number | null; expired_at: Date | null }>(
    'SELECT id,fact,entity_slug,context,row_num,expired_at FROM facts WHERE id=ANY($1::int[]) ORDER BY id', [ids]);
}
async function expectGuardClear() {
  const reconcile = await runExtractFacts(engine, { sourceId: 'default' });
  expect(reconcile.legacyRowsPending).toBe(0);
}
async function backstopPage(slug: string, type: 'note' | 'meeting') {
  const r = await runFactsBackstop({ slug, type, compiled_truth: BODY, frontmatter: {} }, ctx());
  if (r.mode !== 'inline') throw new Error('expected inline');
  return r;
}

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  const page = (slug: string, title: string, type: string, frontmatter: Record<string, unknown> = {}) =>
    engine.putPage(slug, { type: type as never, title, compiled_truth: `# ${title}\n\n${BODY}`, frontmatter }, { sourceId: 'default' });
  await page('companies/acme-example', 'Acme Example', 'note');
  await page('companies/widget-example', 'Widget Example', 'company');
  await page('people/dana-private-example', 'Dana Private-Example', 'person', { visibility: 'private' });
  await page('meetings/2026-09-30-planning', 'Planning Review', 'meeting');
}, 60_000);
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'backstop-infer-'));
  await engine.executeRaw(`UPDATE sources SET local_path=$1 WHERE id='default'`, [dir]);
  _resetWriteThroughCacheForTest();
});
afterEach(async () => {
  __setChatTransportForTests(null); resetGateway(); __resetFactsQueueForTests();
  await engine.unsetConfig('sync.write_through'); await engine.unsetConfig('facts.entity_inference');
  await engine.executeRaw(`UPDATE sources SET local_path=NULL WHERE id='default'`);
  _resetWriteThroughCacheForTest();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => { await engine.disconnect(); });

describe('facts backstop write-time inference (#5836)', () => {
  test('a subjectless fact on an entity page lands on that page fence with the inference note', async () => {
    chatStub([{ fact: 'Raised a seed round led by a new fund' }]);
    const r = await backstopPage('companies/acme-example', 'note');
    expect(r.inserted).toBe(1);
    const [row] = await rows(r.fact_ids);
    expect(row).toMatchObject({ entity_slug: 'companies/acme-example', context: 'entity inferred from page' });
    expect(row.row_num).not.toBeNull();
    expect((r as { entity_slugs?: string[] }).entity_slugs).toEqual(['companies/acme-example']);
    const file = readFileSync(join(dir, 'companies/acme-example.md'), 'utf8');
    expect(file).toContain('Raised a seed round led by a new fund');
    expect(file).toContain('entity inferred from page');
    await expectGuardClear();
  });

  test('a meeting page never becomes a subject; an exact mention on it still links', async () => {
    chatStub([{ fact: 'The team agreed to ship in October' }, { fact: 'Widget Example asked for a pilot extension' }]);
    const r = await backstopPage('meetings/2026-09-30-planning', 'meeting');
    const [unlinked, linked] = await rows(r.fact_ids);
    expect(unlinked.entity_slug).toBeNull();
    expect(linked).toMatchObject({ entity_slug: 'companies/widget-example', context: 'entity inferred from mention' });
    await expectGuardClear();
  });

  test('a remote extract_facts never infers from source_slug, a private page or an out-of-fence entity', async () => {
    chatStub([{ fact: 'Opened a second office in the spring' }]);
    const local = await runFactsPipeline('turn', ctx({ source: 'mcp:extract_facts', sourceSlug: 'companies/acme-example',
      operationContext: remoteOp({ remote: false }) }));
    expect((await rows(local.fact_ids))[0].entity_slug).toBe('companies/acme-example');
    const remoteSlug = await runFactsPipeline('turn', ctx({ source: 'mcp:extract_facts', sourceSlug: 'companies/acme-example',
      remote: true, operationContext: remoteOp() }));
    expect((await rows(remoteSlug.fact_ids))[0].entity_slug).toBeNull();

    chatStub([{ fact: 'Dana Private-Example is relocating to the coast' }]);
    const hidden = await runFactsPipeline('turn', ctx({ source: 'mcp:extract_facts', remote: true, operationContext: remoteOp() }));
    expect((await rows(hidden.fact_ids))[0].entity_slug).toBeNull();

    chatStub([{ fact: 'Widget Example renewed the annual contract' }]);
    const fenced = await runFactsPipeline('turn', ctx({ source: 'mcp:extract_facts', remote: true,
      operationContext: remoteOp({ auth: { token: 'fixture', clientId: 'c', scopes: ['read', 'write'], boundSlugPrefixes: ['people/'] } as OperationContext['auth'] }) }));
    expect((await rows(fenced.fact_ids))[0].entity_slug).toBeNull();
    const open = await runFactsPipeline('turn', ctx({ source: 'mcp:extract_facts', remote: true, operationContext: remoteOp() }));
    expect(open.duplicate + open.inserted).toBe(1);
    expect((await rows(open.fact_ids))[0].entity_slug).toBe('companies/widget-example');
    await expectGuardClear();
  });

  test('the unmanaged DB-only branch never applies an inferred subject', async () => {
    await engine.setConfig('sync.write_through', 'false');
    _resetWriteThroughCacheForTest();
    chatStub([{ fact: 'Acme Example hired a VP of engineering' }]);
    const off = await backstopPage('meetings/2026-09-30-planning', 'meeting');
    expect((await rows(off.fact_ids))[0]).toMatchObject({ entity_slug: null, row_num: null });
    await expectGuardClear();
    await engine.unsetConfig('sync.write_through');
    _resetWriteThroughCacheForTest();
    chatStub([{ fact: 'Acme Example hired a VP of sales' }]);
    const on = await backstopPage('meetings/2026-09-30-planning', 'meeting');
    expect((await rows(on.fact_ids))[0].entity_slug).toBe('companies/acme-example');
    await expectGuardClear();
  });

  test('the facts.entity_inference kill switch leaves the fact unlinked', async () => {
    await engine.setConfig('facts.entity_inference', 'off');
    chatStub([{ fact: 'Closed the bridge round in August' }]);
    const r = await backstopPage('companies/acme-example', 'note');
    expect((await rows(r.fact_ids))[0].entity_slug).toBeNull();
    await expectGuardClear();
    await engine.unsetConfig('facts.entity_inference');
    chatStub([{ fact: 'Closed the bridge round in September' }]);
    const on = await backstopPage('companies/acme-example', 'note');
    expect((await rows(on.fact_ids))[0].entity_slug).toBe('companies/acme-example');
    await expectGuardClear();
  });
});
