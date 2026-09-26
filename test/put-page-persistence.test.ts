import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test as bunTest } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { publicEffectsForRequest } from '../src/core/persistence/effect-journal.ts';
import { withEnv } from './helpers/with-env.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { contentHashLegacy } from '../src/core/utils.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';

let engine: PGLiteEngine;
let root: string;
let fixtureDir: string;
let registration: LocalRegistration;
const auth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] };
const content = (body: string, tags = 'original') => `---\ntitle: Example\ntype: note\ntags: [${tags}]\n---\n\n${body}`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  resetGateway();
  _resetWriteThroughCacheForTest();
  fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-put-persistence-'));
  root = join(fixtureDir, 'brain'); mkdirSync(root);
  await engine.setConfig('sync.repo_path', root);
});

afterEach(async () => {
  await disposePersistenceConsumer(engine);
  __setEmbedTransportForTests(null);
  resetGateway();
  _resetWriteThroughCacheForTest();
  rmSync(fixtureDir, { recursive: true, force: true });
});

function test(name: string, run: () => Promise<void>, timeout = 20_000) {
  bunTest(name, () => withEnv({ GBRAIN_HOME: join(fixtureDir, 'home') }, async () => {
    registration = await registerLocalWriter(engine, 'stdio', {
      sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'],
    });
    try { await run(); } finally { await disposePersistenceConsumer(engine); }
  }), timeout);
}
async function dispatch(name: string, params: Record<string, unknown>, sourceId = 'default') {
  const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, name, params, {
    remote: true, config: { engine: 'pglite' }, sourceId, auth: { ...auth, sourceId },
    logger: { info() {}, warn() {}, error() {} },
  }));
  return { response, payload: JSON.parse((response.content[0] as { text: string }).text), params, sourceId };
}
async function put(slug: string, body: string, sourceId = 'default') {
  const current = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  return dispatch('put_page', { slug, content: body, request_id: randomUUID(),
    ...(current ? { expected_revision: current.revision } : {}) }, sourceId);
}
async function replay(result: Awaited<ReturnType<typeof put>>) {
  return dispatch('put_page', result.params, result.sourceId);
}
async function embedding(result: Awaited<ReturnType<typeof put>>, expectFailure = false) {
  const deadline = Date.now() + 10_000;
  let observed: Awaited<ReturnType<typeof publicEffectsForRequest>>[number] | undefined;
  while (Date.now() < deadline) {
    const receipt = await dispatch('get_write_request', { request_id: result.params.request_id }, result.sourceId);
    expect(receipt.response.isError).not.toBe(true);
    observed = receipt.payload.effects?.find((effect: { kind: string }) => effect.kind === 'embedding');
    if (observed?.state === 'committed' || expectFailure && observed?.reason === 'effect_unavailable') return observed;
    await Bun.sleep(25);
  }
  throw new Error(`Embedding effect did not settle: ${JSON.stringify(observed)}`);
}
async function holdRoot() {
  const binding = await getWorktreeBinding(engine, 'default');
  expect(binding).not.toBeNull();
  const lock = await acquireWorktree(binding!);
  expect(lock).not.toBeNull();
  return lock!;
}
async function snapshot(slug: string) {
  return engine.transaction(async tx => ({
    snapshot: await tx.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }),
    chunks: await tx.getChunks(slug, { sourceId: 'default' }),
    versions: await tx.executeRaw('SELECT * FROM page_versions ORDER BY id'),
  }));
}

describe('put_page persistence boundary', () => {
  test('actual writes bind the scanner path but exact no-ops do not heal metadata or rewrite files', async () => {
    const slug = 'notes/path-binding';
    const first = await put(slug, content('Canonical path metadata.'));
    expect(first.payload.state).toBe('committed');
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.source_path).toBe(`${slug}.md`);
    await engine.executeRaw('UPDATE pages SET source_path=NULL WHERE source_id=$1 AND slug=$2', ['default', slug]);
    const before = await snapshot(slug);
    const bytes = readFileSync(join(root, `${slug}.md`), 'utf8');
    const noop = await put(slug, bytes);
    expect(noop.payload.noop).toBe(true);
    expect(noop.payload.revision).toBe(first.payload.revision);
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.source_path).toBeNull();
    expect(await snapshot(slug)).toEqual(before);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe(bytes);
    const replayed = await replay(noop);
    expect(replayed.payload.revision).toBe(noop.payload.revision);
  });

  test('scoped Git roots bind scanner-relative paths and preserve an existing recorded target', async () => {
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    const scoped = join(root, 'public'); mkdirSync(scoped);
    await engine.setConfig('sync.repo_path', scoped);
    const slug = 'notes/scoped-path';
    expect((await put(slug, content('Original scoped body.'))).payload.state).toBe('committed');
    const initial = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(initial.page.source_path).toBe('public/notes/scoped-path.md');
    const recorded = 'public/notes/scanner-name.md';
    const recordedFile = join(root, recorded);
    renameSync(join(scoped, `${slug}.md`), recordedFile);
    await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', [recorded, 'default', slug]);
    const edited = await put(slug, content('Updated scoped body.'));
    expect(edited.payload.state).toBe('committed');
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.source_path).toBe(recorded);
    expect(readFileSync(recordedFile, 'utf8')).toContain('Updated scoped body.');
    expect(existsSync(join(scoped, `${slug}.md`))).toBe(false);
    expect(JSON.stringify(edited.response)).not.toContain(root);
  });

  test('a stale queued embedding reports superseded without invoking its provider', async () => {
    await engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
    try {
      const slug = 'notes/stale-before-provider';
      const stale = await put(slug, content('Old queued embedding.'));
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour'");
      const latest = await put(slug, content('Current canonical body.'));
      await disposePersistenceConsumer(engine);
      expect(await engine.executeRaw("SELECT state FROM persistence_effects WHERE request_id=(SELECT id FROM persistence_requests WHERE request_id=$1::uuid) AND kind='embedding'", [stale.payload.request_id]))
        .toEqual([{ state: 'queued' }]);
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour'");
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=(SELECT id FROM persistence_requests WHERE request_id=$1::uuid) AND kind='embedding'", [stale.payload.request_id]);
      let calls = 0;
      await runPersistenceEffects(engine, { engine: 'pglite' }, { hostId: localHostId(), limit: 1,
        embedding: { signature: 'test:1536', model: 'test', embed: async () => { calls++; throw new Error('stale provider must not run'); } } });
      expect(calls).toBe(0);
      expect(await embedding(stale)).toMatchObject({ state: 'committed', reason: 'revision_changed' });
      expect((await replay(stale)).payload.revision).toBe(stale.payload.revision);
      expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision).toBe(latest.payload.revision);
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Current canonical body.');
    } finally {
      await engine.executeRaw('ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT now()');
    }
  });

  test('contended worktree durably queues existing and new pages while another root writes', async () => {
    const slug = 'notes/existing';
    await put(slug, content('Original durable body.'));
    const before = await snapshot(slug);
    const disk = readFileSync(join(root, `${slug}.md`), 'utf8');
    const otherRoot = join(fixtureDir, 'other'); mkdirSync(otherRoot);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', $1)", [otherRoot]);
    await claimWorktree(engine, 'other', otherRoot, localHostId());
    const holder = await holdRoot();
    let accepted: Awaited<ReturnType<typeof put>>[] = [];
    try {
      const writes = Promise.all([
        put(slug, content('Rejected replacement.', 'replacement')),
        put('notes/new', content('Rejected creation.')),
      ]);
      const independent = await put('notes/independent', content('Independent content.'), 'other');
      expect(independent.response.isError).not.toBe(true);
      expect(readFileSync(join(otherRoot, 'notes/independent.md'), 'utf8')).toContain('Independent content.');
      accepted = await writes;
      expect(await snapshot(slug)).toEqual(before);
      expect(await engine.getPage('notes/new', { sourceId: 'default' })).toBeNull();
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe(disk);
      expect(existsSync(join(root, 'notes/new.md'))).toBe(false);
      for (const result of accepted) {
        expect(result.response.isError).toBe(true);
        expect(result.payload.error).toBe('write_pending');
        expect(result.payload.write_request.request_id).toBe(result.params.request_id);
        expect(['queued', 'running']).toContain(result.payload.write_request.state);
        expect(result.payload.suggestion).toContain('same operation');
      }
    } finally {
      await holder.release();
    }
    for (const acceptedWrite of accepted) {
      const committed = await replay(acceptedWrite);
      expect(committed.response.isError).not.toBe(true);
      expect(committed.payload.state).toBe('committed');
      expect(committed.payload.request_id).toBe(acceptedWrite.params.request_id);
      expect((await replay(acceptedWrite)).payload.revision).toBe(committed.payload.revision);
    }
    expect((await snapshot(slug)).versions).toHaveLength(1);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Rejected replacement.');
    expect(readFileSync(join(root, 'notes/new.md'), 'utf8')).toContain('Rejected creation.');
  }, 15_000);

  test('rename failure rolls back the existing page, tags, chunks, and version snapshot', async () => {
    const slug = 'notes/rename-failure';
    await put(slug, content('Original before failed rename.'));
    const before = await snapshot(slug);
    const file = join(root, `${slug}.md`);
    const original = readFileSync(file, 'utf8');
    renameSync(file, `${file}.original`);
    mkdirSync(file);
    const failed = await put(slug, content('Must not replace the visible page.', 'rejected'));
    expect(failed.response.isError).toBe(true);
    expect(failed.payload.error).toBe('storage_error');
    expect(await snapshot(slug)).toEqual(before);
    expect(readFileSync(`${file}.original`, 'utf8')).toBe(original);
  });

  test('an unchanged legacy-hash page also rolls back when its canonical file is refused', async () => {
    const slug = 'notes/legacy-hash';
    const body = content('Unchanged legacy body.');
    await put(slug, body);
    const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
    await engine.executeRaw('UPDATE pages SET content_hash = $1 WHERE id = $2', [contentHashLegacy(page), page.id]);
    const before = await snapshot(slug);
    const file = join(root, `${slug}.md`);
    renameSync(file, `${file}.original`);
    mkdirSync(file);
    const failed = await put(slug, body);
    expect(failed.response.isError).toBe(true);
    expect(await snapshot(slug)).toEqual(before);
  });

  test('source-path bookkeeping failure rolls back the page and restores its canonical file', async () => {
    const slug = 'notes/source-path-failure';
    await put(slug, content('Original canonical content.'));
    await engine.executeRaw('UPDATE pages SET source_path = NULL WHERE slug = $1', [slug]);
    const before = await snapshot(slug);
    const file = join(root, `${slug}.md`);
    const originalFile = readFileSync(file, 'utf8');
    const executeRaw = engine.executeRaw;
    let rejected = false;
    engine.executeRaw = function<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (sql.includes('SET source_path = $1')) {
        rejected = true;
        throw new Error('fixture source-path write rejected');
      }
      return executeRaw.call(this, sql, params) as Promise<T[]>;
    };
    try {
      const result = await put(slug, content('Rejected replacement.', 'replacement'));
      expect(rejected).toBe(true);
      expect(result.response.isError).toBe(true);
      expect(result.payload.error).toBe('storage_error');
    } finally {
      engine.executeRaw = executeRaw;
    }
    expect(await snapshot(slug)).toEqual(before);
    expect(readFileSync(file, 'utf8')).toBe(originalFile);
  });

  test('a waiter sees no visible mutation until the holder releases, then writes exactly once', async () => {
    const slug = 'notes/short-wait';
    await put(slug, content('Before waiting.'));
    const before = await snapshot(slug);
    const holder = await holdRoot();
    const pending = put(slug, content('After waiting.'));
    try {
      await Bun.sleep(100);
      expect(await snapshot(slug)).toEqual(before);
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Before waiting.');
    } finally {
      await holder.release();
      await pending;
    }
    expect((await pending).response.isError).not.toBe(true);
    expect((await replay(await pending)).payload.revision).toBe((await pending).payload.revision);
    expect((await snapshot(slug)).versions).toHaveLength(1);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('After waiting.');
  });

  test('canonical page is committed before an embedding failure and remains a successful persisted write', async () => {
    const slug = 'notes/embed-failure';
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    let calls = 0;
    let observedCommitted = false;
    __setEmbedTransportForTests(async () => {
      calls++;
      observedCommitted = (await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth.includes('Survives embedding failure.') === true
        && existsSync(join(root, `${slug}.md`))
        && readFileSync(join(root, `${slug}.md`), 'utf8').includes('Survives embedding failure.');
      throw new Error('fixture embedding rejected');
    });
    const result = await put(slug, content('Survives embedding failure.'));
    expect(await embedding(result, true)).toMatchObject({ state: 'queued', reason: 'effect_unavailable' });
    expect(calls).toBeGreaterThan(0);
    expect(observedCommitted).toBe(true);
    expect(result.response.isError).not.toBe(true);
    expect(result.payload.status).toBe('created_or_updated');
    expect((await replay(result)).payload.state).toBe('committed');
    expect(result.payload.write_through.written).toBe(true);
    expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  });

  test('successful post-persistence embeddings fill only the written page', async () => {
    const slug = 'notes/embed-success';
    await put('notes/unrelated', content('Unrelated unembedded body.'));
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Page-scoped enrichment.');
      expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('Page-scoped enrichment.');
      return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const result = await put(slug, content('Page-scoped enrichment.'));
    expect(result.response.isError).not.toBe(true);
    expect(await embedding(result)).toMatchObject({ state: 'committed' });
    expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => !chunk.embedding_is_null)).toBe(true);
    expect((await engine.getChunks('notes/unrelated', { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  });

  test('slow optional embedding releases the worktree and cannot overwrite a newer file-backed revision', async () => {
    const slug = 'notes/slow-embedding';
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      if (values.some(value => value.includes('Older revision waiting for embedding.'))) {
        started.resolve();
        await release.promise;
      }
      return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const pending = put(slug, content('Older revision waiting for embedding.'));
    await started.promise;
    try {
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Older revision waiting for embedding.');
      const independent = await put('notes/independent-embedding', content('Another page in the same worktree.'));
      expect(independent.response.isError).not.toBe(true);
      expect(independent.payload.state).toBe('committed');
      const replacement = await put(slug, content('Newer file-backed revision.'));
      expect(replacement.response.isError).not.toBe(true);
      expect(replacement.payload.state).toBe('committed');
    } finally {
      release.resolve();
      await pending;
    }
    expect(await embedding(await pending)).toMatchObject({ state: 'committed', reason: 'revision_changed' });
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Newer file-backed revision.');
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('Newer file-backed revision.');
    expect((await engine.getChunks(slug, { sourceId: 'default' })).map(chunk => chunk.chunk_text)).toEqual(['Newer file-backed revision.']);
  }, 15_000);

  test('successful MCP persistence never returns credentials from an embedding error', async () => {
    const slug = 'notes/embed-error-redaction';
    const credentialUrl = 'https://fixture-user:PLACEHOLDER@embed.example/v1?token=fixture-private-token';
    const bearer = 'Bearer fixture-private-bearer';
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async () => {
      throw new Error(`Embedding request failed at ${credentialUrl}; Authorization: ${bearer}`);
    });
    const result = await put(slug, content('Persisted without disclosing provider credentials.'));
    expect(result.response.isError).not.toBe(true);
    expect(result.payload.status).toBe('created_or_updated');
    expect(await embedding(result, true)).toMatchObject({ state: 'queued', reason: 'effect_unavailable' });
    const receipt = await dispatch('get_write_request', { request_id: result.params.request_id });
    expect(receipt.payload.state).toBe('committed');
    const responseText = JSON.stringify([result.response, receipt.response]);
    for (const sensitive of [credentialUrl, 'fixture-user', 'PLACEHOLDER', 'embed.example', 'fixture-private-token', bearer, 'fixture-private-bearer']) {
      expect(responseText.includes(sensitive)).toBe(false);
    }
    expect(receipt.payload.effects).toContainEqual({ kind: 'embedding', state: 'queued', reason: 'effect_unavailable' });
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('Persisted without disclosing provider credentials.');
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Persisted without disclosing provider credentials.');
    expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
  });

  test('a concurrent DB-only revision cannot receive stale post-persistence chunks', async () => {
    const slug = 'notes/embed-superseded';
    await engine.setConfig('sync.repo_path', '');
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      await importFromContent(engine, slug, content('Intervening revision.'), { noEmbed: true, sourceId: 'default' });
      return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const result = await put(slug, content('Older revision being embedded.'));
    expect(result.response.isError).not.toBe(true);
    expect(await embedding(result)).toMatchObject({ state: 'committed', reason: 'revision_changed' });
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('Intervening revision.');
    const chunks = await engine.getChunks(slug, { sourceId: 'default' });
    expect(chunks.map(chunk => chunk.chunk_text)).toEqual(['Intervening revision.']);
    expect(chunks.every(chunk => chunk.embedding_is_null)).toBe(true);
  });

  test('rechunking unchanged content cannot be undone by an older embedding completion', async () => {
    const slug = 'notes/rechunk-superseded';
    const body = content('Content with a replaced chunk generation.');
    await engine.setConfig('sync.repo_path', '');
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      await importFromContent(engine, slug, body, { noEmbed: true, sourceId: 'default', forceRechunk: true });
      return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const result = await put(slug, body);
    expect(result.response.isError).not.toBe(true);
    expect(await embedding(result)).toMatchObject({ state: 'committed', reason: 'revision_changed' });
    expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
  });

  for (const action of ['soft-delete', 'hard-delete', 'recreate'] as const) {
    test(`late embedding cannot revive or replace a ${action} page`, async () => {
      const slug = 'notes/deleted-embedding';
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
      __setEmbedTransportForTests(async ({ values }) => {
        if (action === 'soft-delete') await engine.softDeletePage(slug, { sourceId: 'default' });
        else await engine.deletePage(slug, { sourceId: 'default' });
        if (action === 'recreate') {
          await importFromContent(engine, slug, content('Recreated content.'), { noEmbed: true, sourceId: 'default' });
        }
        return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
      });
      const result = await put(slug, content('Old page content.'));
      expect(await embedding(result)).toMatchObject({ state: 'committed', reason: 'revision_changed' });
      const page = await engine.getPage(slug, { sourceId: 'default' });
      if (action === 'recreate') {
        expect(page?.compiled_truth).toBe('Recreated content.');
        expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
      } else {
        expect(page).toBeNull();
      }
    });
  }
});
