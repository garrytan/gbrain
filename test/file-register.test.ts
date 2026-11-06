/**
 * GBRA-283 Wave C: file_register, for an embedding host that stores a file's bytes itself.
 * Contributed by @bradgessler (#8457); rewritten on master. Real PGLite engines and a real local storage backend.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openEngine, type EngineSettings, type EngineStorageSettings } from '../src/core/engine-open.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isCallable } from '../src/core/ops/callable.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-file-register-'));
const storageRoot = join(root, 'store');
const storage: EngineStorageSettings = { backend: 'local', localPath: storageRoot };
const unreachable: EngineStorageSettings = { backend: 's3', bucket: 'test', endpoint: 'http://127.0.0.1:1', region: 'us-east-1', accessKeyId: 'test-key', secretAccessKey: 'test-secret' };
const settings = (over: Partial<EngineSettings> = {}): EngineSettings => ({ embedded_core: true, engine: 'pglite', database: {}, host: { id: randomUUID() }, embedding: { model: 'openai:text-embedding-3-small', dimensions: 1536 }, storage, ...over });
const ctxFor = (engine: BrainEngine, over: Partial<OperationContext> = {}): OperationContext => ({
  engine, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false, ...over,
} as unknown as OperationContext);
const run = (op: string, ctx: OperationContext, params: Record<string, unknown>) => operationsByName[op]!.handler(ctx, params);
const failure = async (work: () => Promise<unknown>) => {
  try { await work(); return null; } catch (error) { return error as Error & { code?: string }; }
};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function store(path: string, bytes: Buffer): void {
  mkdirSync(dirname(join(storageRoot, path)), { recursive: true });
  writeFileSync(join(storageRoot, path), bytes);
}
const addPage = (engine: BrainEngine, slug: string) => importFromContent(engine, slug, ['---', 'type: note', `title: ${slug}`, '---', `# ${slug}`, '', 'Plan body.'].join('\n'));
const fileRows = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM files'))[0]!.n);

const engines: BrainEngine[] = [];
async function embedded(over: Partial<EngineSettings> = {}): Promise<BrainEngine> {
  const engine = await openEngine(settings(over));
  await engine.initSchema();
  engines.push(engine);
  return engine;
}
afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.disconnect()));
  rmSync(storageRoot, { recursive: true, force: true });
  __resetPrivateVisibilityCacheForTests();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('file_register', () => {
  test('records one row for an object stored at the file_upload path, and registering again updates it', async () => {
    const engine = await embedded();
    await addPage(engine, 'notes/plan');
    const bytes = Buffer.from('report bytes');
    store('notes/plan/report.pdf', bytes);
    const params = { storage_path: 'notes/plan/report.pdf', filename: 'report.pdf', page_slug: 'notes/plan', content_hash: sha(bytes), size_bytes: bytes.length, mime_type: 'application/pdf' };
    expect(await run('file_register', ctxFor(engine), params)).toEqual({ status: 'registered', storage_path: 'notes/plan/report.pdf', size_bytes: bytes.length });
    const next = Buffer.from('report bytes, revised');
    store('notes/plan/report.pdf', next);
    await run('file_register', ctxFor(engine), { ...params, content_hash: sha(next), size_bytes: next.length });
    const rows = await engine.executeRaw<{ page_slug: string; content_hash: string; size_bytes: unknown }>('SELECT page_slug, content_hash, size_bytes FROM files');
    expect(rows.map(r => ({ ...r, size_bytes: Number(r.size_bytes) }))).toEqual([{ page_slug: 'notes/plan', content_hash: sha(next), size_bytes: next.length }]);
    expect(await run('file_register', ctxFor(engine, { dryRun: true }), { ...params, filename: 'other.pdf', storage_path: 'notes/plan/other.pdf' }))
      .toEqual({ dry_run: true, action: 'file_register', storage_path: 'notes/plan/other.pdf' });
    expect(await fileRows(engine)).toBe(1);
  });

  test('an empty object registers with size 0, and a negative size refuses invalid_params and writes nothing', async () => {
    const engine = await embedded();
    await addPage(engine, 'notes/plan');
    const empty = Buffer.alloc(0);
    store('notes/plan/empty.txt', empty);
    const params = { storage_path: 'notes/plan/empty.txt', filename: 'empty.txt', page_slug: 'notes/plan', content_hash: sha(empty), size_bytes: 0 };
    expect(await run('file_register', ctxFor(engine), params)).toEqual({ status: 'registered', storage_path: 'notes/plan/empty.txt', size_bytes: 0 });
    expect((await failure(() => run('file_register', ctxFor(engine), { ...params, storage_path: 'notes/plan/neg.txt', filename: 'neg.txt', size_bytes: -1 })))?.code).toBe('invalid_params');
    expect(await fileRows(engine)).toBe(1);
  });

  test('records the page and source a registration belongs to, so purging that page in a non-default source finds it', async () => {
    const engine = await embedded();
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT DO NOTHING");
    await importFromContent(engine, 'notes/plan', ['---', 'type: note', 'title: plan', '---', '# plan', '', 'Body.'].join('\n'), { sourceId: 'source-a' });
    const bytes = Buffer.from('source-a bytes');
    store('notes/plan/a.txt', bytes);
    await run('file_register', ctxFor(engine, { sourceId: 'source-a' }), { storage_path: 'notes/plan/a.txt', filename: 'a.txt', page_slug: 'notes/plan', content_hash: sha(bytes), size_bytes: bytes.length });
    const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/plan' AND source_id='source-a'");
    expect(await engine.executeRaw('SELECT source_id, page_id FROM files')).toEqual([{ source_id: 'source-a', page_id: page!.id }]);
    expect((await failure(() => run('file_register', ctxFor(engine, { sourceId: 'default' }), { storage_path: 'notes/plan/a.txt', filename: 'a.txt', page_slug: 'notes/plan', content_hash: sha(bytes), size_bytes: bytes.length })))?.code).toBe('page_not_found');
  });

  test('refuses a registration that would move an existing row to another page, keeping the row as it was', async () => {
    const engine = await embedded();
    await addPage(engine, 'unsorted');
    const old = Buffer.from('loose file');
    const path = `unsorted/${sha(old).slice(0, 8)}-x.txt`;
    store(path, old);
    await run('file_register', ctxFor(engine), { storage_path: path, filename: 'x.txt', content_hash: sha(old), size_bytes: old.length });
    const next = Buffer.from('bytes for the page');
    store(path, next);
    const err = await failure(() => run('file_register', ctxFor(engine), { storage_path: path, filename: `${sha(old).slice(0, 8)}-x.txt`, page_slug: 'unsorted', content_hash: sha(next), size_bytes: next.length }));
    expect(err?.code).toBe('invalid_params');
    expect(await engine.executeRaw('SELECT page_slug, filename, content_hash FROM files')).toEqual([{ page_slug: null, filename: 'x.txt', content_hash: sha(old) }]);
  });

  test('refuses a registration that would re-attribute a row to another page that took the same slug, keeping the row as it was', async () => {
    const engine = await embedded();
    await addPage(engine, 'notes/plan');
    const old = Buffer.from('first page bytes');
    store('notes/plan/a.txt', old);
    const params = { storage_path: 'notes/plan/a.txt', filename: 'a.txt', page_slug: 'notes/plan' };
    await run('file_register', ctxFor(engine), { ...params, content_hash: sha(old), size_bytes: old.length });
    const [first] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/plan'");
    await engine.updateSlug('notes/plan', 'notes/moved');
    await importFromContent(engine, 'notes/plan', ['---', 'type: note', 'title: Replacement', '---', '# Replacement', '', 'A new page under the old slug.'].join('\n'));
    const next = Buffer.from('second page bytes');
    store('notes/plan/a.txt', next);
    const err = await failure(() => run('file_register', ctxFor(engine), { ...params, content_hash: sha(next), size_bytes: next.length }));
    expect(err?.code).toBe('invalid_params');
    expect(await engine.executeRaw('SELECT page_id, content_hash FROM files')).toEqual([{ page_id: first!.id, content_hash: sha(old) }]);
  });

  test('refuses a page that does not exist and an object it cannot read back, recording nothing', async () => {
    const engine = await embedded();
    const bytes = Buffer.from('orphan');
    store('notes/none/o.txt', bytes);
    expect((await failure(() => run('file_register', ctxFor(engine), { storage_path: 'notes/none/o.txt', filename: 'o.txt', page_slug: 'notes/none', content_hash: sha(bytes), size_bytes: bytes.length })))?.code).toBe('page_not_found');
    await addPage(engine, 'notes/plan');
    mkdirSync(join(storageRoot, 'notes/plan/dir.txt'), { recursive: true });
    expect((await failure(() => run('file_register', ctxFor(engine), { storage_path: 'notes/plan/dir.txt', filename: 'dir.txt', page_slug: 'notes/plan', content_hash: sha(bytes), size_bytes: bytes.length })))?.code).toBe('store_unavailable');
    expect(await fileRows(engine)).toBe(0);
  });

  test('refuses a path other than the file_upload layout, a missing or different object and bad inputs, recording nothing', async () => {
    const engine = await embedded();
    const bytes = Buffer.from('loose bytes');
    const hash = sha(bytes);
    store(`unsorted/${hash.slice(0, 8)}-scan.png`, bytes);
    store('elsewhere/scan.png', bytes);
    const base = { storage_path: `unsorted/${hash.slice(0, 8)}-scan.png`, filename: 'scan.png', content_hash: hash, size_bytes: bytes.length };
    const cases: Array<[Record<string, unknown>, string, OperationContext?]> = [
      [{ ...base, storage_path: 'elsewhere/scan.png' }, 'invalid_params'],
      [{ ...base, storage_path: '../outside/scan.png' }, 'invalid_params'],
      [{ ...base, content_hash: 'A'.repeat(64) }, 'invalid_params'],
      [{ ...base, size_bytes: 1.5 }, 'invalid_params'],
      [{ ...base, filename: '../scan.png' }, 'invalid_params'],
      [{ ...base, size_bytes: bytes.length + 1 }, 'storage_error'],
      [{ ...base, filename: 'other.png', storage_path: `unsorted/${hash.slice(0, 8)}-other.png` }, 'storage_error'],
    ];
    for (const [params, code, ctx] of cases) expect([params, (await failure(() => run('file_register', ctx ?? ctxFor(engine), params)))?.code]).toEqual([params, code]);
    expect(await fileRows(engine)).toBe(0);
    await run('file_register', ctxFor(engine), base);
    expect(await fileRows(engine)).toBe(1);
  });

  test('an engine opened without settings.storage refuses even when the process has a storage config', async () => {
    const engine = await embedded({ storage: undefined });
    const bytes = Buffer.from('loose bytes');
    store(`unsorted/${sha(bytes).slice(0, 8)}-scan.png`, bytes);
    const params = { storage_path: `unsorted/${sha(bytes).slice(0, 8)}-scan.png`, filename: 'scan.png', content_hash: sha(bytes), size_bytes: bytes.length };
    expect((await failure(() => run('file_register', ctxFor(engine, { config: { storage } } as never), params)))?.code).toBe('storage_error');
    expect(await fileRows(engine)).toBe(0);
  });

  test('two brains sharing one store under different prefixes register only their own objects', async () => {
    const a = await embedded({ storage: { ...storage, prefix: 'brain-a' } });
    const b = await embedded({ storage: { ...storage, prefix: 'brain-b' } });
    await Promise.all([addPage(a, 'notes/plan'), addPage(b, 'notes/plan')]);
    const bytes = Buffer.from('brain a bytes');
    store('brain-a/notes/plan/a.txt', bytes);
    const params = { storage_path: 'notes/plan/a.txt', filename: 'a.txt', page_slug: 'notes/plan', content_hash: sha(bytes), size_bytes: bytes.length };
    await run('file_register', ctxFor(a), params);
    expect((await failure(() => run('file_register', ctxFor(b), params)))?.code).toBe('storage_error');
    expect(await fileRows(b)).toBe(0);
    const [{ metadata }] = await a.executeRaw<{ metadata: unknown }>('SELECT metadata FROM files');
    expect(metadata).toEqual({ storage: 'local', prefix: 'brain-a' });
  });

  test('a store that cannot be reached is store_unavailable and records nothing', async () => {
    const engine = await embedded({ storage: unreachable });
    const bytes = Buffer.from('x');
    const error = await failure(() => run('file_register', ctxFor(engine), { storage_path: `unsorted/${sha(bytes).slice(0, 8)}-a.txt`, filename: 'a.txt', content_hash: sha(bytes), size_bytes: 1 }));
    expect(error?.code).toBe('store_unavailable');
    expect(await fileRows(engine)).toBe(0);
  });

  test('an s3 store sends the read-back to its settings endpoint, never one named by AWS_* variables', async () => {
    const hits = { settings: 0, env: 0 };
    const settingsServer = Bun.serve({ port: 0, fetch: () => { hits.settings++; return new Response(null, { status: 404 }); } });
    const envServer = Bun.serve({ port: 0, fetch: () => { hits.env++; return new Response(null, { status: 200 }); } });
    try {
      await withEnv({ AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${envServer.port}`, AWS_ENDPOINT_URL: `http://127.0.0.1:${envServer.port}` }, async () => {
        const engine = await embedded({ storage: { ...unreachable, endpoint: `http://127.0.0.1:${settingsServer.port}` } });
        const bytes = Buffer.from('s3');
        const error = await failure(() => run('file_register', ctxFor(engine), { storage_path: `unsorted/${sha(bytes).slice(0, 8)}-s.txt`, filename: 's.txt', content_hash: sha(bytes), size_bytes: 2 }));
        expect([error?.code, hits.env, hits.settings > 0]).toEqual(['storage_error', 0, true]);
      });
    } finally {
      settingsServer.stop(true);
      envServer.stop(true);
    }
  });
});

describe('who may call file_register', () => {
  let cliEngine: PGLiteEngine;
  beforeAll(async () => {
    cliEngine = new PGLiteEngine();
    await cliEngine.connect({});
    await cliEngine.initSchema();
  });
  afterAll(() => cliEngine.disconnect());

  test('an engine the CLI opens refuses with embedded_engine_required and records nothing', async () => {
    const bytes = Buffer.from('cli');
    store(`unsorted/${sha(bytes).slice(0, 8)}-c.txt`, bytes);
    const params = { storage_path: `unsorted/${sha(bytes).slice(0, 8)}-c.txt`, filename: 'c.txt', content_hash: sha(bytes), size_bytes: 3 };
    expect((await failure(() => run('file_register', ctxFor(cliEngine), params)))?.code).toBe('embedded_engine_required');
    expect(await fileRows(cliEngine)).toBe(0);
  });

  test('it is not listed or callable over MCP, stdio included', async () => {
    const engine = await embedded();
    for (const transport of ['stdio', 'http'] as const) expect(isCallable(operationsByName.file_register!, { transport, surface: 'full', scopes: ['admin'], publishGates: {} })).toBe(false);
    const result = await dispatchToolCall(engine, 'file_register', {}, { remote: true, transport: 'stdio' } as never);
    expect(result.isError).toBe(true);
    const refusal = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect([refusal.code, refusal.fix?.argv?.slice(0, 3), refusal.fix?.inputs]).toEqual(['trusted_local_only', ['gbrain', 'files', 'verify'], undefined]);
    expect(await fileRows(engine)).toBe(0);
  });

  test('a caller under the read policy cannot attach to or replace a file on a page it cannot read; a local caller can', async () => {
    const engine = await embedded();
    await importFromContent(engine, 'notes/secret', ['---', 'type: note', 'title: Secret', 'visibility: private', '---', '# Secret', '', 'Private body.'].join('\n'));
    const bytes = Buffer.from('secret attachment');
    store('notes/secret/s.txt', bytes);
    const params = { storage_path: 'notes/secret/s.txt', filename: 's.txt', page_slug: 'notes/secret', content_hash: sha(bytes), size_bytes: bytes.length };
    const remote = ctxFor(engine, { remote: true });
    expect((await failure(() => run('file_register', remote, params)))?.code).toBe('page_not_found');
    expect(await fileRows(engine)).toBe(0);
    await run('file_register', ctxFor(engine), params);
    expect((await failure(() => run('file_register', remote, params)))?.code).toBe('page_not_found');
    expect(await fileRows(engine)).toBe(1);
  });

  test('a page naming its readers stays closed to an unlisted remote caller even with the private-pages hatch open', async () => {
    const engine = await embedded();
    await importFromContent(engine, 'notes/members', ['---', 'type: note', 'title: Members', 'readable_by: [alice-example]', '---', '# Members', '', 'Member body.'].join('\n'));
    const bytes = Buffer.from('member attachment');
    store('notes/members/m.txt', bytes);
    const params = { storage_path: 'notes/members/m.txt', filename: 'm.txt', page_slug: 'notes/members', content_hash: sha(bytes), size_bytes: bytes.length };
    await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
      __resetPrivateVisibilityCacheForTests();
      expect((await failure(() => run('file_register', ctxFor(engine, { remote: true }), params)))?.code).toBe('page_not_found');
      expect(await fileRows(engine)).toBe(0);
    });
  });
});
