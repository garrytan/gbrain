import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { testBackends, requirePostgresTestDatabase } from './helpers/test-backends.ts';
import { mirrorBrain } from '../src/core/hydradb-mirror.ts';
import { HYDRADB_CONFIG, HYDRADB_API_KEY_ENV, hydraDocId } from '../src/core/hydradb.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { newSource, page, putPage as journalPutPage } from './helpers/pinned-questions-fixture.ts';

const backend = testBackends()[0];
const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
let engine: BrainEngine;
async function putPage(engine: BrainEngine, source: string, slug: string, content: string): Promise<void> {
  if (backend !== 'postgres') return journalPutPage(engine, source, slug, content);
  // Legacy storage fixtures exercise the real PostgreSQL SQL without installing a writer service.
  const title = /^title: (.*)$/m.exec(content)![1]!;
  await engine.putPage(slug, { type: 'note', title, compiled_truth: content.replace(/^---[\s\S]*?---\n/, ''), timeline: '', frontmatter: {} }, { sourceId: source });
}
let source: string;
let mode = 'ok';
let uploads: Array<{ filename: string; text: string; metadata: unknown }> = [];
let queries = 0;
let removals: string[] = [];
let ingestHook: ((files: File[], metadata: any[]) => Promise<void>) | undefined;
const originalFetch = globalThis.fetch;
const conn = { database: 'review-synthetic', apiKey: 'hk_synthetic.fake' };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown, init: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/context/ingest') {
      const form = init.body as FormData;
      const metadata = JSON.parse(String(form.get('document_metadata')));
      const files = form.getAll('documents') as File[];
      for (let i = 0; i < files.length; i++) uploads.push({ filename: files[i]!.name, text: await files[i]!.text(), metadata: metadata[i] });
      await ingestHook?.(files, metadata);
      return reply({ success_count: mode === 'ingest-failed' ? 0 : files.length, failed_count: mode === 'ingest-failed' ? files.length : 0,
        results: files.map((file, i) => ({ id: metadata[i].id, filename: file.name, status: mode === 'ingest-failed' ? 'failed' : 'queued', error: mode === 'ingest-failed' ? 'queue unavailable' : '' })) }, 202);
    }
    if (path === '/context' && init.method === 'DELETE') {
      const body = JSON.parse(String(init.body));
      removals.push(...body.ids);
      return reply({ deleted_count: mode === 'delete-failed' ? 0 : body.ids.length, results: body.ids.map((id: string) => ({ id, deleted: mode !== 'delete-failed', error: mode === 'delete-failed' ? 'source still indexing' : '' })) });
    }
    if (path === '/context/status') return reply({ statuses: (new URL(String(input)).searchParams.get('ids') ?? '').split(',').map(id => ({ id, indexing_status: mode === 'index-failed' ? 'failed' : mode === 'index-errored' ? 'errored' : 'completed', ...(mode === 'index-errored' ? { error_code: 'E9001' } : {}) })) });
    if (path === '/query') {
      queries++;
      return reply({ chunks: [{ source_title: 'Cloud remote answer', chunk_content: 'The synthetic deployment uses cobalt widgets.', additional_metadata: { gbrain_source: source, gbrain_slug: 'notes/remote-only' } }] });
    }
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch;
  engine = backend === 'postgres' ? new (await import('../src/core/postgres-engine.ts')).PostgresEngine() : new PGLiteEngine();
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : {});
  await engine.initSchema();
}, 120_000);

beforeEach(async () => {
  delete process.env[HYDRADB_API_KEY_ENV];
  for (const key of Object.values(HYDRADB_CONFIG)) await engine.unsetConfig(key);
  source = await newSource(engine);
  mode = 'ok'; uploads = []; queries = 0; removals = []; ingestHook = undefined;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  delete process.env[HYDRADB_API_KEY_ENV];
  await engine.disconnect();
});

const settle = () => engine.executeRaw("UPDATE pages SET updated_at = '2020-01-01T00:00:00Z' WHERE deleted_at IS NULL");

test('redacts a detected secret from the uploaded title AND filename', async () => {
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  await putPage(engine, source, 'notes/title-probe', page('note', `CI ${secret}`, 'A harmless body.'));
  await settle();
  await mirrorBrain(engine, conn, { full: true });
  const upload = uploads.find(u => (u.metadata as any).additional_metadata.gbrain_source === source)!;
  expect(upload.text).not.toContain(secret);
  expect(upload.filename).not.toContain(secret);
});

test('does not advance the page cursor past HTTP 202 failed ingest items', async () => {
  await putPage(engine, source, 'notes/queue-probe', page('note', 'Queue probe', 'Retry this page.'));
  await settle();
  mode = 'ingest-failed';
  let failed = false;
  try { await mirrorBrain(engine, conn, { full: true }); } catch { failed = true; }
  const cursor = await engine.getConfig(HYDRADB_CONFIG.pagesCursor);
  expect(failed || cursor === null).toBe(true);
});

test('does not advance deletion cursor past HTTP 200 per-item failures', async () => {
  await putPage(engine, source, 'notes/delete-probe', page('note', 'Delete probe', 'Delete this page.'));
  await engine.softDeletePage('notes/delete-probe', { sourceId: source });
  await engine.executeRaw("UPDATE pages SET deleted_at = '2020-01-01T00:00:00Z' WHERE source_id = $1", [source]);
  const old = '2019-01-01T00:00:00.000000Z';
  await engine.setConfig(HYDRADB_CONFIG.deletedSince, old);
  mode = 'delete-failed';
  let failed = false;
  try { await mirrorBrain(engine, conn); } catch { failed = true; }
  const cursor = await engine.getConfig(HYDRADB_CONFIG.deletedSince);
  expect(failed || cursor === old).toBe(true);
});

test('full backfill preserves same-slug pages across a batch boundary', async () => {
  const sources: string[] = [];
  for (let i = 0; i < 51; i++) {
    const id = await newSource(engine); sources.push(id);
    await putPage(engine, id, 'notes/shared', page('note', `Shared ${i}`, 'Same slug across sources.'));
  }
  await settle();
  await mirrorBrain(engine, conn, { full: true });
  const sent = uploads.filter(u => sources.includes((u.metadata as any).additional_metadata.gbrain_source));
  expect(sent).toHaveLength(51);
}, 60_000);

test('a keyless GBrain with only a HydraDB key queries a remote-only page', async () => {
  process.env[HYDRADB_API_KEY_ENV] = conn.apiKey;
  await engine.setConfig(HYDRADB_CONFIG.database, conn.database);
  await engine.setConfig(HYDRADB_CONFIG.primary, 'true');
  const r = await handleToolCall(engine, 'query', { query: 'synthetic deployment cobalt widgets', expand: false, source_id: source, limit: 8 });
  expect(JSON.stringify(r)).toContain('The synthetic deployment uses cobalt widgets.');
  expect(queries).toBeGreaterThan(0);
});

test('a keyless GBrain with only a HydraDB key recalls a remote-only page', async () => {
  process.env[HYDRADB_API_KEY_ENV] = conn.apiKey;
  await engine.setConfig(HYDRADB_CONFIG.database, conn.database);
  await engine.setConfig(HYDRADB_CONFIG.primary, 'true');
  await engine.setConfig('embedding_disabled', 'true');
  const r = await handleToolCall(engine, 'recall', { query: 'synthetic deployment cobalt widgets', source_id: source, limit: 8 });
  expect(JSON.stringify(r)).toContain('The synthetic deployment uses cobalt widgets.');
  expect(queries).toBeGreaterThan(0);
});

test('failed asynchronous indexing does not advance the page cursor', async () => {
  await putPage(engine, source, 'notes/index-probe', page('note', 'Index probe', 'Retry failed indexing.'));
  await settle(); mode = 'index-failed';
  await expect(mirrorBrain(engine, conn, { full: true })).rejects.toThrow('indexing failed');
  expect(await engine.getConfig(HYDRADB_CONFIG.pagesCursor)).toBeNull();
  mode = 'ok';
  await mirrorBrain(engine, conn, { full: true }); // failed transfer released the shared lock
  expect(await engine.getConfig(HYDRADB_CONFIG.pagesCursor)).not.toBeNull();
});

test('keyword-only configuration still uses the opted-in cloud backend for normal search', async () => {
  process.env[HYDRADB_API_KEY_ENV] = conn.apiKey;
  await engine.setConfig(HYDRADB_CONFIG.database, conn.database);
  await engine.setConfig(HYDRADB_CONFIG.primary, 'true');
  await engine.setConfig('search.mcp_keyword_only', 'true');
  const r = await handleToolCall(engine, 'search', { query: 'synthetic deployment cobalt widgets', source_id: source, limit: 8 });
  expect(JSON.stringify(r)).toContain('The synthetic deployment uses cobalt widgets.');
  expect(queries).toBe(1);
  await engine.unsetConfig('search.mcp_keyword_only');
});


test('source archive cleanup and restore ignore an already advanced page cursor', async () => {
  const slug = 'notes/archive-probe';
  await putPage(engine, source, slug, page('note', 'Archive probe', 'Source visibility changes.'));
  await settle(); await mirrorBrain(engine, conn, { full: true });
  const cursor = await engine.getConfig(HYDRADB_CONFIG.pagesCursor);
  try {
    await engine.executeRaw('UPDATE sources SET archived = true WHERE id = $1', [source]);
    await mirrorBrain(engine, conn);
    expect(removals).toContain(hydraDocId(source, slug));
    expect(await engine.getConfig(HYDRADB_CONFIG.pagesCursor)).toBe(cursor);
    uploads = [];
    await engine.executeRaw('UPDATE sources SET archived = false WHERE id = $1', [source]);
    await mirrorBrain(engine, conn);
    expect(uploads.some(u => (u.metadata as any).id === hydraDocId(source, slug))).toBe(true);
  } finally { await engine.executeRaw('UPDATE sources SET archived = false WHERE id = $1', [source]); }
});

if (backend === 'postgres') test('a separate process cannot let an old snapshot overwrite newer memory', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'hydra-ordering-'));
  const stored = join(scratch, 'cloud-document.txt');
  const ready = join(scratch, 'child-ready');
  const slug = 'notes/process-ordering';
  await putPage(engine, source, slug, page('note', 'Ordering probe', 'OLD synthetic memory.'));
  await settle();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const paused = new Promise<void>(r => { entered = r; });
  ingestHook = async (files, metadata) => {
    const i = metadata.findIndex(item => item.additional_metadata.gbrain_source === source && item.additional_metadata.gbrain_slug === slug);
    if (i < 0) return;
    const text = await files[i]!.text();
    entered(); await gate;
    writeFileSync(stored, text); // emulate an old request landing after the newer one
  };
  const older = mirrorBrain(engine, conn, { full: true });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let childDone = false;
  try {
    await Promise.race([paused, older.then(() => { throw new Error('Expected paused upload'); })]);
    await putPage(engine, source, slug, page('note', 'Ordering probe', 'NEW synthetic memory.'));
    child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'hydradb-concurrent-mirror.ts'), source, slug, stored, ready],
      { env: { ...process.env, DATABASE_URL: databaseUrl!, [HYDRADB_API_KEY_ENV]: '' }, stdout: 'pipe', stderr: 'pipe' });
    void child.exited.then(() => { childDone = true; });
    const deadline = Date.now() + 15_000;
    let blocked = false;
    while (Date.now() < deadline && !childDone) {
      if (existsSync(ready)) {
        const [row] = await engine.executeRaw<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS waiting`);
        if (row?.waiting) { blocked = true; break; }
      }
      await Bun.sleep(20);
    }
    expect(blocked).toBe(true); // original per-engine WeakMap lets the child finish immediately
    release(); await older;
    expect(await child.exited).toBe(0);
    expect(readFileSync(stored, 'utf8')).toContain('NEW synthetic memory.');
    expect(readFileSync(stored, 'utf8')).not.toContain('OLD synthetic memory.');
  } finally {
    release(); await older.catch(() => undefined);
    if (child && !childDone) { child.kill(); await child.exited; }
    ingestHook = undefined;
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);

test('terminal errored indexing rejects promptly without advancing the mirror cursor', async () => {
  await putPage(engine, source, 'notes/errored-probe', page('note', 'Index error probe', 'Retry this source after the indexing error.'));
  await settle(); mode = 'index-errored';
  await expect(mirrorBrain(engine, conn, { full: true })).rejects.toThrow('indexing failed (E9001)');
  expect(await engine.getConfig(HYDRADB_CONFIG.pagesCursor)).toBeNull();
  mode = 'ok'; await mirrorBrain(engine, conn, { full: true });
  expect(await engine.getConfig(HYDRADB_CONFIG.pagesCursor)).not.toBeNull();
});
