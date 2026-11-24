/**
 * Failback test worlds (test/engine-swap-failback.test.ts, test/engine-swap-failback-cli.test.ts): an old primary at
 * the end state of a forward swap (fenced, graduation row at cutover, a succeeded run record) and a second engine that
 * stands in for the Rust engine, holding the same brain plus the writes made after the swap. Each test file opens a
 * world in beforeAll and closes it in afterAll.
 */
import { expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { fencePrimary, markPrimaryCutover } from '../../src/core/engine-swap/fence.ts';
import { writeSwapRecord, type SwapRecord } from '../../src/core/engine-swap/record.ts';
import { verifyFailback, type FailbackDeps } from '../../src/core/engine-swap/failback.ts';

export const RUN = '00000000-0000-4000-8000-00000000fb01';
export const HOST = '00000000-0000-4000-8000-00000000fb02';

export async function embeddingDims(engine: BrainEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ dims: number }>(
    `SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`);
  return Number(row!.dims);
}

export function vector(dims: number, seed: number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = ((i * 7 + seed * 13) % 17) / 17;
  return v;
}

/** The same brain on both engines before the swap: what the seed and the follower would have copied. */
export async function writeBrain(engine: BrainEngine): Promise<void> {
  const dims = await embeddingDims(engine);
  for (const [slug, body] of [['people/alice-example', 'Alice runs widget-co.'], ['companies/widget-co', 'A company.'], ['notes/old-example', 'Removed on Rust later.']] as const) {
    await engine.putPage(slug, { type: slug.split('/')[0] === 'people' ? 'person' : 'note', title: slug, compiled_truth: body, timeline: '', frontmatter: { tags: [] } });
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth', embedding: vector(dims, slug.length), model: 'test-model', token_count: 4 }]);
  }
  await engine.addTag('people/alice-example', 'founder');
  await engine.addLink('people/alice-example', 'companies/widget-co', 'runs', 'works_at');
  await engine.addTimelineEntry('people/alice-example', { date: '2026-01-02', source: 'test', summary: 'Joined', detail: '' });
  await engine.putRawData('people/alice-example', 'test-feed', { a: 1 });
  await engine.insertFact({ fact: 'Alice prefers mornings', entity_slug: 'people/alice-example', source: 'test' }, { source_id: 'default' });
  await engine.setConfig('example.setting', 'before');
}

/** The seed copies rows verbatim, timestamps included; two engines written a moment apart differ only there. */
export async function alignTimestamps(primary: BrainEngine, rust: BrainEngine): Promise<void> {
  for (const p of await primary.executeRaw<{ slug: string; source_id: string; created_at: string; updated_at: string }>(
    `SELECT slug, source_id, created_at::text AS created_at, updated_at::text AS updated_at FROM pages`)) {
    await rust.executeRaw('UPDATE pages SET created_at = $1::timestamptz, updated_at = $2::timestamptz WHERE slug = $3 AND source_id = $4', [p.created_at, p.updated_at, p.slug, p.source_id]);
  }
  for (const r of await primary.executeRaw<{ slug: string; source: string; fetched_at: string }>(
    `SELECT p.slug, r.source, r.fetched_at::text AS fetched_at FROM raw_data r JOIN pages p ON p.id = r.page_id`)) {
    await rust.executeRaw('UPDATE raw_data SET fetched_at = $1::timestamptz WHERE source = $2 AND page_id = (SELECT id FROM pages WHERE slug = $3)', [r.fetched_at, r.source, r.slug]);
  }
  for (const f of await primary.executeRaw<{ id: number; created_at: string; valid_from: string | null }>(`SELECT id, created_at::text AS created_at, valid_from::text AS valid_from FROM facts`)) {
    await rust.executeRaw('UPDATE facts SET created_at = $1::timestamptz, valid_from = $2::timestamptz WHERE id = $3', [f.created_at, f.valid_from, f.id]);
  }
  for (const c of await primary.executeRaw<{ key: string; value: string }>(`SELECT key, value FROM config WHERE key LIKE '%_at'`)) await rust.setConfig(c.key, c.value);
  for (const s of await primary.executeRaw<{ id: string; created_at: string }>(`SELECT id, created_at::text AS created_at FROM sources`)) {
    await rust.executeRaw('UPDATE sources SET created_at = $1::timestamptz WHERE id = $2', [s.created_at, s.id]);
  }
}

/** Writes made on the Rust engine after the swap: an edit, a new page with every dependent row, a delete, a fact, a key. */
export async function writeAfterSwap(rust: BrainEngine): Promise<void> {
  const dims = await embeddingDims(rust);
  await rust.putPage('people/alice-example', { type: 'person', title: 'people/alice-example', compiled_truth: 'Alice now runs acme-example.', timeline: '', frontmatter: { tags: [] } });
  await rust.deleteChunks('people/alice-example');
  await rust.upsertChunks('people/alice-example', [{ chunk_index: 0, chunk_text: 'Alice now runs acme-example.', chunk_source: 'compiled_truth', embedding: vector(dims, 99), model: 'test-model', token_count: 5 }]);
  await rust.removeTag('people/alice-example', 'founder');
  await rust.addTag('people/alice-example', 'operator');
  await rust.putPage('companies/acme-example', { type: 'note', title: 'companies/acme-example', compiled_truth: 'Made after the swap.', timeline: '', frontmatter: { tags: [] } });
  await rust.upsertChunks('companies/acme-example', [{ chunk_index: 0, chunk_text: 'Made after the swap.', chunk_source: 'compiled_truth', embedding: vector(dims, 7), model: 'test-model', token_count: 4 }]);
  await rust.addTag('companies/acme-example', 'new');
  await rust.addLink('people/alice-example', 'companies/acme-example', 'runs', 'works_at');
  await rust.addTimelineEntry('companies/acme-example', { date: '2026-11-25', source: 'test', summary: 'Founded', detail: 'after swap' });
  await rust.putRawData('companies/acme-example', 'test-feed', { b: 2 });
  const [page] = await rust.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'companies/acme-example'`);
  await rust.addTakesBatch([{ page_id: page!.id, row_num: 1, claim: 'It will grow', kind: 'bet', holder: 'brain', weight: 0.6 }]);
  await rust.upsertFile({ page_slug: 'companies/acme-example', page_id: page!.id, filename: 'deck.pdf', storage_path: 'files/deck.pdf', content_hash: 'ab'.repeat(32), mime_type: 'application/pdf', size_bytes: 10 });
  await rust.upsertOpenLoop({ sourceId: 'default', dedupKey: 'loop-1', loopType: 'commitment_owed_by_me', summary: 'Send the deck', evidence: [], detector: 'manual' });
  await rust.deletePage('notes/old-example');
  // A fact changed on Rust (expired): failback copies the change. A fact added on Rust refuses failback (its own test).
  const [fact] = await rust.listFactsKeyset('default', null, { activeOnly: false });
  await rust.expireFact(Number(fact!.id), { at: new Date('2026-11-25T00:00:00Z') });
  await rust.setConfig('example.setting', 'after');
}

/** The old primary's engine and identity in the swap record. */
export interface FailbackArm { name: string; open(): Promise<{ engine: BrainEngine; close(): Promise<void> }>; previous: SwapRecord['brain'] }

export async function openPglite(): Promise<{ engine: BrainEngine; close(): Promise<void> }> {
  const e = new PGLiteEngine();
  await e.connect({});
  await e.initSchema();
  return { engine: e, close: () => e.disconnect() };
}

export interface FailbackWorld { home: string; primary: BrainEngine; rust: BrainEngine; deps: FailbackDeps; close(): Promise<void> }

/** A swapped brain: both engines hold the same brain, the primary is fenced at cutover and the run record says succeeded. */
export async function openFailbackWorld(arm: FailbackArm, over: (w: { primary: BrainEngine; rust: BrainEngine }) => Partial<FailbackDeps> = () => ({})): Promise<FailbackWorld> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-failback-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const store = join(home, 'shadow', 'store');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: store }));
  const { engine: primary, close: closePrimary } = await arm.open();
  const { engine: rust, close: closeRust } = await openPglite();
  await writeBrain(primary);
  await writeBrain(rust);
  await alignTimestamps(primary, rust);
  expect((await verifyFailback(rust, primary)).mismatches).toEqual([]);
  // The forward swap's end state: the primary is fenced and its graduation row records cutover for the run.
  await fencePrimary(primary, RUN, { hostId: HOST, config: { engine: arm.previous.engine } as unknown as GBrainConfig });
  await markPrimaryCutover(primary, RUN);
  const recordPath = join(home, '.gbrain', 'engine-swap', arm.previous.key, 'run.json');
  const at = new Date('2026-11-24T20:00:00Z').toISOString();
  const record: SwapRecord = {
    version: 1, run_id: RUN, plan_hash: 'swapplan', policy_hash: 'policy', brain: arm.previous, rust_store: store,
    shadow_dir: join(home, 'shadow'), state: 'succeeded', started_at: at, updated_at: at,
    switch: { previous: { engine: arm.previous.engine, database_path: arm.previous.database_path }, at }, error: null,
  };
  writeSwapRecord(recordPath, record);
  const deps: FailbackDeps = {
    primary, rust, recordPath, brainKey: arm.previous.key, runDir: join(home, '.gbrain', 'engine-swap', arm.previous.key),
    writers: async () => null,
    prober: async () => ({ effective_engine: arm.previous.engine, database_path: arm.previous.database_path || null, ok: true }),
    ...over({ primary, rust }),
  };
  return { home, primary, rust, deps, close: async () => {
    await closeRust().catch(() => undefined);
    await closePrimary().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  } };
}

export interface CliWorld { home: string; primary: PGLiteEngine; rust: PGLiteEngine; store: string; out: string[]; errors: unknown[] }

/** The CLI's world: one page edited on the stand-in Rust engine after the swap; the record is found by its store. */
export async function openFailbackCliWorld(run: string): Promise<CliWorld> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-failback-cli-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const store = join(home, '.gbrain', 'shadow', 'pglite-abc', 'store');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: store }));
  const primary = (await openPglite()).engine as PGLiteEngine;
  const rust = (await openPglite()).engine as PGLiteEngine;
  for (const e of [primary, rust]) await e.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'Before.', timeline: '' });
  for (const p of await primary.executeRaw<{ created_at: string; updated_at: string }>(`SELECT created_at::text AS created_at, updated_at::text AS updated_at FROM pages`)) {
    await rust.executeRaw('UPDATE pages SET created_at = $1::timestamptz, updated_at = $2::timestamptz', [p.created_at, p.updated_at]);
  }
  for (const s of await primary.executeRaw<{ created_at: string }>(`SELECT created_at::text AS created_at FROM sources`)) {
    await rust.executeRaw('UPDATE sources SET created_at = $1::timestamptz', [s.created_at]);
  }
  for (const c of await primary.executeRaw<{ key: string; value: string }>(`SELECT key, value FROM config WHERE key LIKE '%_at'`)) await rust.setConfig(c.key, c.value);
  await fencePrimary(primary, run, { hostId: '00000000-0000-4000-8000-00000000fc02', config: { engine: 'pglite' } as unknown as GBrainConfig });
  await markPrimaryCutover(primary, run);
  const at = '2026-11-24T20:00:00.000Z';
  const record: SwapRecord = {
    version: 1, run_id: run, plan_hash: 'swapplan', policy_hash: 'policy', brain: { key: 'pglite-abc', engine: 'pglite', database_path: join(home, 'old.pglite') },
    rust_store: store, shadow_dir: join(home, '.gbrain', 'shadow', 'pglite-abc'), state: 'succeeded', started_at: at, updated_at: at,
    switch: { previous: { engine: 'pglite', database_path: join(home, 'old.pglite') }, at }, error: null,
  };
  writeSwapRecord(join(home, '.gbrain', 'engine-swap', 'pglite-abc', 'run.json'), record);
  await rust.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'Edited on Rust.', timeline: '' });
  return { home, primary, rust, store, out: [], errors: [] };
}

