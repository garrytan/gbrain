/**
 * remember on a page that already has fence-numbered facts rows in the database
 * but no facts fence in its stored body: the new row is numbered past the rows
 * the database holds, not from the (absent) fence in compiled_truth.
 *
 * Protects (PGLite; the managed arm claims a worktree so every write goes
 * through the coordinator): an entity page whose stored body carries no fence
 * while a facts row already references it (source_markdown_slug = the page,
 * row_num 1) — the state the facts extraction path leaves when it files rows
 * under an entity page without rewriting that page (seen in the field on 22
 * entity pages, one with 35 active rows and a 298-char body). The next
 * remember must land as row 2.
 * Fails when: memory-prepare numbers the row from compiled_truth alone
 * (max fence row + 1, else 1): the insert collides on idx_facts_fence_key,
 * returns no id, and every later remember on that page dies with
 * storage_error "The new canonical fact row was not indexed."
 * Existing coverage: none at this boundary (fence tests start from a body that
 * carries the fence).
 * Seams: embedding transport only; the fixture row is inserted with the writer
 * guard paused, as the connector fixtures do. Synthetic names only.
 * Backends: PGLite here; with a safe DATABASE_URL also Postgres.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer, persistenceConsumerStatus } from '../src/core/persistence/service.ts';

const DIM = 1536;
const MODEL = 'openai:text-embedding-3-large';
const SLUG = 'projects/acme-example';
let engine: BrainEngine;
let sourceId: string;
let home: string;
const vectors = new Map<string, number[]>();
let nextAxis = 1;

function embedding(text: string): number[] {
  if (!vectors.has(text)) { const v = Array(DIM).fill(0); v[nextAxis++] = 1; vectors.set(text, v); }
  return vectors.get(text)!;
}
async function settled() {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise(r => setTimeout(r, 10))) {
    const s = persistenceConsumerStatus(engine);
    if (s.active_preparations === 0 && s.active_worktrees === 0) return;
  }
  throw new Error('persistence consumer did not settle');
}
async function remember(fact: string) {
  const r = await dispatchToolCall(engine, 'remember', { fact, entity: SLUG, provenance: 'user told me' }, { remote: false, sourceId });
  await settled();
  return r;
}
async function rows() {
  return engine.executeRaw<{ row_num: number; fact: string }>(
    'SELECT row_num::int AS row_num, fact FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL ORDER BY row_num',
    [sourceId, SLUG]);
}
async function withGuardPaused(edit: () => Promise<unknown>) {
  const [{ enabled }] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (enabled) { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
  try { await edit(); } finally { if (enabled) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
async function storedBody() {
  const [row] = await engine.executeRaw<{ compiled_truth: string | null }>(
    'SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, SLUG]);
  return row?.compiled_truth ?? '';
}
/** A fresh source with the one synthetic entity page; `managed` claims a worktree so writes go through the coordinator. */
async function freshSource(mode: 'unmanaged' | 'managed') {
  sourceId = `rr-${randomUUID().slice(0, 8)}`;
  const root = mkdtempSync(join(home, 'root-'));
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, mode === 'managed' ? root : null]);
  if (mode === 'managed') {
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
  const body = 'Acme Example is a synthetic entity.';
  if (mode === 'unmanaged') await engine.putPage(SLUG, { type: 'project', title: 'Acme Example', compiled_truth: body }, { sourceId });
  else {
    const r = await dispatchToolCall(engine, 'put_page', { slug: SLUG, content: `---\ntitle: Acme Example\ntype: project\n---\n\n${body}\n` }, { remote: false, sourceId });
    expect(r.isError).toBeFalsy();
  }
  await settled();
}

for (const backend of testBackends()) describe(`remember row numbering with database-only rows on ${backend}`, () => {
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
    await engine.setConfig('embedding_model', MODEL);
    await engine.setConfig('embedding_dimensions', String(DIM));
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); });
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-remember-rownum-'));
    vectors.clear();
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIM, env: { OPENAI_API_KEY: 'synthetic-only' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ values, warnings: [], usage: { tokens: 1 },
      embeddings: values.map(embedding) })) as never);
  });
  afterEach(async () => {
    __setEmbedTransportForTests(null); resetGateway();
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(home, { recursive: true, force: true });
  });

  for (const mode of ['unmanaged', 'managed'] as const) {
    const run = (fn: () => Promise<void>) => withEnv({ GBRAIN_HOME: home }, async () => { await freshSource(mode); await fn(); });

    test(`(${mode}) remember lands as row 2 when the database already holds row 1 and the stored body has no fence`, () => run(async () => {
      expect(await storedBody()).not.toContain('gbrain:facts:begin');
      // The field state: the extraction path filed a row under this page without rewriting it.
      await withGuardPaused(() => engine.executeRaw(
        `INSERT INTO facts(source_id, source_markdown_slug, row_num, entity_slug, fact, kind, visibility, confidence, notability, source, valid_from)
         VALUES($1, $2, 1, $2, $3, 'fact', 'private', 1, 'medium', 'test fixture', now())`,
        [sourceId, SLUG, 'Acme Example ships its entity module in November']));
      expect((await rows()).map(r => r.row_num)).toEqual([1]);
      expect(await storedBody()).not.toContain('gbrain:facts:begin');

      const second = await remember('Acme Example hired a chief financial officer');
      expect(second.isError).toBeFalsy();
      expect((await rows()).map(r => [r.row_num, r.fact])).toEqual([
        [1, 'Acme Example ships its entity module in November'],
        [2, 'Acme Example hired a chief financial officer'],
      ]);
    }), 60_000);
  }
});
