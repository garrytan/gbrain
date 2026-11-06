/**
 * GBRA-283 Wave C: settings.storage and file_verify, for an embedding host that keeps a brain's files in its own store.
 * Contributed by @bradgessler (#8457); rewritten on master. Real PGLite engines and a real local storage backend.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { embeddedSettings, openEngine, type EngineSettings, type EngineStorageSettings } from '../src/core/engine-open.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isCallable } from '../src/core/ops/callable.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-embedded-file-store-'));
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
const addRow = (engine: BrainEngine, path: string, bytes: Buffer, pageSlug: string | null = null) =>
  engine.executeRaw('INSERT INTO files (page_slug, filename, storage_path, content_hash, size_bytes) VALUES ($1, $2, $3, $4, $5)', [pageSlug, path.split('/').pop()!, path, sha(bytes), bytes.length]);
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

describe('embedded file store', () => {
  test('an engine opened without settings.storage refuses even when the process has a storage config', async () => {
    const engine = await embedded({ storage: undefined });
    const ctx = ctxFor(engine, { config: { storage } } as never);
    expect((await failure(() => run('file_verify', ctx, {})))?.code).toBe('storage_error');
    expect(await fileRows(engine)).toBe(0);
  });

  test('two brains sharing one store under different prefixes see only their own objects', async () => {
    const a = await embedded({ storage: { ...storage, prefix: 'brain-a' } });
    const b = await embedded({ storage: { ...storage, prefix: 'brain-b' } });
    await Promise.all([addPage(a, 'notes/plan'), addPage(b, 'notes/plan')]);
    const source = join(root, 'a.txt');
    writeFileSync(source, 'brain a bytes');
    await run('file_upload', ctxFor(a), { path: source, page_slug: 'notes/plan' });
    await addRow(b, 'notes/plan/a.txt', Buffer.from('brain a bytes'), 'notes/plan');
    expect(existsSync(join(storageRoot, 'brain-a/notes/plan/a.txt'))).toBe(true);
    expect(await run('file_verify', ctxFor(b), { slug: 'notes/plan' })).toEqual([{ storage_path: 'notes/plan/a.txt', page_slug: 'notes/plan', present: false }]);
    expect(await run('file_verify', ctxFor(a), { storage_path: 'notes/plan/a.txt' })).toEqual({ storage_path: 'notes/plan/a.txt', present: true, size_matches: true, hash_matches: true });
    const [{ metadata }] = await a.executeRaw<{ metadata: unknown }>('SELECT metadata FROM files');
    expect(metadata).toEqual({ storage: 'local', prefix: 'brain-a' });
  });

  test('file_upload and file_url on an engine opened from settings use its store and prefix, never the process store', async () => {
    const engine = await embedded({ storage: { ...storage, prefix: 'brain-a' } });
    await addPage(engine, 'notes/plan');
    const source = join(root, 'upload.txt');
    writeFileSync(source, 'uploaded bytes');
    const processStore = { backend: 'local', bucket: 'test', localPath: join(root, 'process-store') };
    const ctx = ctxFor(engine, { config: { storage: processStore } } as never);
    expect(await run('file_upload', ctx, { path: source, page_slug: 'notes/plan' })).toMatchObject({ status: 'uploaded', storage_path: 'notes/plan/upload.txt' });
    expect(readFileSync(join(storageRoot, 'brain-a/notes/plan/upload.txt'), 'utf8')).toBe('uploaded bytes');
    expect(existsSync(join(root, 'process-store'))).toBe(false);
    expect(await run('file_url', ctx, { storage_path: 'notes/plan/upload.txt' })).toEqual({ storage_path: 'notes/plan/upload.txt', url: `file://${join(storageRoot, 'brain-a/notes/plan/upload.txt')}` });
    expect(await run('file_verify', ctx, { storage_path: 'notes/plan/upload.txt' })).toMatchObject({ present: true, hash_matches: true });
  });

  test('file_upload on an engine opened without settings.storage refuses and never writes the process store', async () => {
    const engine = await embedded({ storage: undefined });
    await addPage(engine, 'notes/plan');
    const source = join(root, 'refused.txt');
    writeFileSync(source, 'refused bytes');
    const ctx = ctxFor(engine, { config: { storage: { backend: 'local', bucket: 'test', localPath: join(root, 'process-store-2') } } } as never);
    expect((await failure(() => run('file_upload', ctx, { path: source, page_slug: 'notes/plan' })))?.code).toBe('storage_error');
    expect([existsSync(join(root, 'process-store-2')), await fileRows(engine)]).toEqual([false, 0]);
  });

  test('a purge on an engine opened from settings deletes its blobs from that store, never the process store', async () => {
    const engine = await embedded({ storage: { ...storage, prefix: 'brain-a' } });
    const processDir = join(root, 'process-store-3');
    store('brain-a/notes/plan/p.txt', Buffer.from('embedded'));
    mkdirSync(join(processDir, 'notes/plan'), { recursive: true });
    writeFileSync(join(processDir, 'notes/plan/p.txt'), 'another brain');
    const { finishPagePurge } = await import('../src/core/persistence/page-purge.ts');
    const purged = { status: 'purged', source_id: 'default', slug: 'notes/plan', request_id: randomUUID(), purge: { blobs: ['notes/plan/p.txt'], removed: {} } };
    const result = await finishPagePurge({ engine, config: { storage: { backend: 'local', bucket: 'test', localPath: processDir } } } as never, purged) as { purge: { blobs_remaining: string[] } };
    expect([result.purge.blobs_remaining, existsSync(join(storageRoot, 'brain-a/notes/plan/p.txt')), existsSync(join(processDir, 'notes/plan/p.txt'))]).toEqual([[], false, true]);
    const bare = await embedded({ storage: undefined });
    const kept = await finishPagePurge({ engine: bare, config: { storage: { backend: 'local', bucket: 'test', localPath: processDir } } } as never, { ...purged, request_id: randomUUID() }) as { purge: { blobs_remaining: string[] } };
    expect([kept.purge.blobs_remaining, existsSync(join(processDir, 'notes/plan/p.txt'))]).toEqual([['notes/plan/p.txt'], true]);
  });

  test('a purge never counts a blob missing from settings.storage as deleted (an older row whose object is in the process store)', async () => {
    const engine = await embedded({ storage: { ...storage, prefix: 'brain-a' } });
    const processDir = join(root, 'process-store-4');
    mkdirSync(join(processDir, 'notes/plan'), { recursive: true });
    writeFileSync(join(processDir, 'notes/plan/old.txt'), 'uploaded before this release');
    store('brain-a/notes/plan/new.txt', Buffer.from('embedded'));
    const { finishPagePurge } = await import('../src/core/persistence/page-purge.ts');
    const purged = { status: 'purged', source_id: 'default', slug: 'notes/plan', request_id: randomUUID(), purge: { blobs: ['notes/plan/old.txt', 'notes/plan/new.txt'], removed: {} } };
    const result = await finishPagePurge({ engine, config: { storage: { backend: 'local', bucket: 'test', localPath: processDir } } } as never, purged) as { purge: { blobs_remaining: string[]; blobs_deleted: number } };
    expect([result.purge.blobs_remaining, result.purge.blobs_deleted]).toEqual([['notes/plan/old.txt'], 1]);
    expect([existsSync(join(processDir, 'notes/plan/old.txt')), existsSync(join(storageRoot, 'brain-a/notes/plan/new.txt'))]).toEqual([true, false]);
  });

  test('a store that cannot be reached is store_unavailable, never a file reported missing', async () => {
    const engine = await embedded({ storage: unreachable });
    await addRow(engine, 'unsorted/a.txt', Buffer.from('x'));
    for (const params of [{}, { storage_path: 'unsorted/a.txt' }]) expect((await failure(() => run('file_verify', ctxFor(engine), params)))?.code).toBe('store_unavailable');
    expect((await failure(() => run('file_url', ctxFor(engine), { storage_path: 'unsorted/a.txt' })))?.code).toBe('store_unavailable');
  });
});

describe('settings.storage', () => {
  test('openEngine refuses a store missing a value it needs, an unknown backend, field or prefix, and the view hides its secret', async () => {
    const cases: Array<[unknown, string]> = [
      [{ backend: 'nope' }, 'storage.backend'], [{ backend: 'local' }, 'storage.localPath'],
      [{ backend: 'supabase', bucket: 'b' }, 'storage.backend'], [{ ...unreachable, endpoint: undefined }, 'storage.endpoint'], [{ ...unreachable, secretAccessKey: '' }, 'storage.secretAccessKey'],
      [{ ...storage, region2: 'x' }, 'storage.region2'], [{ ...storage, prefix: '../a' }, 'storage.prefix'], [{ ...storage, prefix: 'a/b' }, 'storage.prefix'],
    ];
    for (const [given, setting] of cases) {
      const error = await failure(() => openEngine(settings({ storage: given as EngineStorageSettings })));
      expect([setting, error?.code, error?.message]).toEqual([setting, 'engine_settings_invalid', `The ${setting} setting is invalid.`]);
    }
    const engine = await embedded({ storage: unreachable });
    expect(embeddedSettings(engine)!.storage).toEqual({ backend: 's3', bucket: 'test', endpoint: 'http://127.0.0.1:1', region: 'us-east-1', accessKeyId: 'test-key', hasSecret: true });
    expect(JSON.stringify(embeddedSettings(engine))).not.toContain('test-secret');
  });
});

describe('prefixedStorage', () => {
  test("refuses a key that would leave its prefix, so one brain never reaches another brain's objects", async () => {
    const { LocalStorage } = await import('../src/core/storage/local.ts');
    const { prefixedStorage } = await import('../src/core/storage.ts');
    store('brain-b/notes/x.txt', Buffer.from('brain b bytes'));
    const a = prefixedStorage(new LocalStorage(storageRoot), 'brain-a');
    for (const path of ['../brain-b/notes/x.txt', 'notes/../../brain-b/notes/x.txt', './notes/x.txt', 'notes//x.txt', '/notes/x.txt', '', 'notes/x.txt/']) {
      for (const call of [() => a.exists(path), () => a.download(path), () => a.delete(path), () => a.upload(path, Buffer.from('overwrite')), () => a.getUrl(path)]) {
        expect([path, (await failure(call))?.message]).toEqual([path, `Path traversal blocked: ${path} resolves outside storage prefix brain-a`]);
      }
    }
    expect((await failure(() => a.list('../brain-b')))?.message).toBe('Path traversal blocked: ../brain-b resolves outside storage prefix brain-a');
    expect(readFileSync(join(storageRoot, 'brain-b/notes/x.txt'), 'utf8')).toBe('brain b bytes');
    await a.upload('notes/x.txt', Buffer.from('brain a bytes'));
    expect([await a.exists('notes/x.txt'), readFileSync(join(storageRoot, 'brain-a/notes/x.txt'), 'utf8')]).toEqual([true, 'brain a bytes']);
    expect(await a.list('notes')).toEqual(['notes/x.txt']);
  });
});

describe('hashing a stored object', () => {
  test('S3 streams the object body into its size and SHA-256', async () => {
    const { S3Storage } = await import('../src/core/storage/s3.ts');
    const parts = [Buffer.from('first part, '), Buffer.from('second part')];
    const client = { send: async () => ({ Body: (async function* () { yield* parts; })() }) };
    const s3 = new S3Storage({ backend: 's3', bucket: 'test' }, client as never);
    expect(await s3.hashObject('a/b.txt')).toEqual({ size: 23, sha256: sha(Buffer.concat(parts)) });
  });

  test('an s3 store with an endpoint builds file URLs from it', async () => {
    const { S3Storage } = await import('../src/core/storage/s3.ts');
    const s3 = new S3Storage({ backend: 's3', bucket: 'test', endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' });
    expect(await s3.getUrl('notes/plan/a.txt')).toBe('http://127.0.0.1:9000/test/notes/plan/a.txt');
  });

  test('a backend without hashObject is hashed from one download', async () => {
    const { hashStoredObject } = await import('../src/core/storage.ts');
    const bytes = Buffer.from('downloaded');
    expect(await hashStoredObject({ download: async () => bytes } as never, 'a.txt')).toEqual({ size: bytes.length, sha256: sha(bytes) });
  });

  test('an s3 store sends every request to its settings endpoint, never one named by AWS_* variables', async () => {
    const hits = { settings: 0, env: 0 };
    const settingsServer = Bun.serve({ port: 0, fetch: () => { hits.settings++; return new Response(null, { status: 404 }); } });
    const envServer = Bun.serve({ port: 0, fetch: () => { hits.env++; return new Response(null, { status: 200 }); } });
    try {
      await withEnv({ AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${envServer.port}`, AWS_ENDPOINT_URL: `http://127.0.0.1:${envServer.port}` }, async () => {
        const engine = await embedded({ storage: { ...unreachable, endpoint: `http://127.0.0.1:${settingsServer.port}` } });
        await addRow(engine, 'unsorted/s.txt', Buffer.from('s3'));
        const result = await run('file_verify', ctxFor(engine), { storage_path: 'unsorted/s.txt' }) as { present: boolean };
        expect([result.present, hits.env, hits.settings > 0]).toEqual([false, 0, true]);
      });
    } finally {
      settingsServer.stop(true);
      envServer.stop(true);
    }
  });
});

describe('file_verify', () => {
  test('lists presence per row, reads one object back, and notices bytes changed underneath', async () => {
    const engine = await embedded();
    await addPage(engine, 'notes/plan');
    const a = Buffer.from('alpha'), b = Buffer.from('bravo');
    store('notes/plan/a.txt', a);
    store('notes/plan/b.txt', b);
    for (const [name, bytes] of [['a.txt', a], ['b.txt', b]] as const) await addRow(engine, `notes/plan/${name}`, bytes, 'notes/plan');
    rmSync(join(storageRoot, 'notes/plan/b.txt'));
    expect(await run('file_verify', ctxFor(engine), { slug: 'notes/plan' })).toEqual([
      { storage_path: 'notes/plan/a.txt', page_slug: 'notes/plan', present: true },
      { storage_path: 'notes/plan/b.txt', page_slug: 'notes/plan', present: false },
    ]);
    expect(await run('file_verify', ctxFor(engine), { storage_path: 'notes/plan/a.txt' })).toEqual({ storage_path: 'notes/plan/a.txt', present: true, size_matches: true, hash_matches: true });
    store('notes/plan/a.txt', Buffer.from('ALPHA'));
    expect(await run('file_verify', ctxFor(engine), { storage_path: 'notes/plan/a.txt' })).toEqual({ storage_path: 'notes/plan/a.txt', present: true, size_matches: true, hash_matches: false });
  });
});

describe('who may call them', () => {
  let cliEngine: PGLiteEngine;
  beforeAll(async () => {
    cliEngine = new PGLiteEngine();
    await cliEngine.connect({});
    await cliEngine.initSchema();
  });
  afterAll(() => cliEngine.disconnect());

  test('an engine the CLI opens refuses file_verify with embedded_engine_required', async () => {
    expect((await failure(() => run('file_verify', ctxFor(cliEngine), {})))?.code).toBe('embedded_engine_required');
  });

  test('file_verify is not listed or callable over MCP, stdio included', async () => {
    const engine = await embedded();
    for (const op of ['file_verify']) {
      for (const transport of ['stdio', 'http'] as const) expect(isCallable(operationsByName[op]!, { transport, surface: 'full', scopes: ['admin'], publishGates: {} })).toBe(false);
      const result = await dispatchToolCall(engine, op, {}, { remote: true, transport: 'stdio' } as never);
      expect(result.isError).toBe(true);
      expect(await fileRows(engine)).toBe(0);
    }
  });

  test('a caller under the read policy cannot see or check a file on a page it cannot read; a local caller can', async () => {
    const engine = await embedded();
    await importFromContent(engine, 'notes/secret', ['---', 'type: note', 'title: Secret', 'visibility: private', '---', '# Secret', '', 'Private body.'].join('\n'));
    const bytes = Buffer.from('secret attachment');
    store('notes/secret/s.txt', bytes);
    await addRow(engine, 'notes/secret/s.txt', bytes, 'notes/secret');
    const remote = ctxFor(engine, { remote: true });
    expect(await run('file_verify', remote, {})).toEqual([]);
    expect((await failure(() => run('file_verify', remote, { storage_path: 'notes/secret/s.txt' })))?.code).toBe('storage_error');
    expect(await run('file_verify', ctxFor(engine), {})).toEqual([{ storage_path: 'notes/secret/s.txt', page_slug: 'notes/secret', present: true }]);
  });

  test('a page naming its readers stays closed to an unlisted remote caller even with the private-pages hatch open', async () => {
    const engine = await embedded();
    await importFromContent(engine, 'notes/members', ['---', 'type: note', 'title: Members', 'readable_by: [alice-example]', '---', '# Members', '', 'Member body.'].join('\n'));
    const bytes = Buffer.from('member attachment');
    store('notes/members/m.txt', bytes);
    await addRow(engine, 'notes/members/m.txt', bytes, 'notes/members');
    await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
      __resetPrivateVisibilityCacheForTests();
      const remote = ctxFor(engine, { remote: true });
      expect(await run('file_verify', remote, { slug: 'notes/members' })).toEqual([]);
      expect((await failure(() => run('file_verify', remote, { storage_path: 'notes/members/m.txt' })))?.code).toBe('storage_error');
    });
  });
});
