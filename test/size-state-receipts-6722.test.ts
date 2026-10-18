/**
 * #6722: every page up to the ceiling is chunked (keyword search), and the
 * write, remember and sync receipts say what a write left a large or
 * embed_skip page's embedding in, in one shape: `size_state` per page
 * (`{ embedding, reason, bytes }`) and the sync tally `size_states`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync.ts';
import { sizeStateLines } from '../src/core/page-embedding-budget.ts';
import { withEnv } from './helpers/with-env.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runEmbedCore } from '../src/commands/embed.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
let engine: PGLiteEngine;
let providerTexts = 0;
const dirs: string[] = [];

const prose = (bytes: number, needle = '') => {
  const line = 'alice-example and bob-example talked about acme-example plans today.\n';
  return line.repeat(Math.ceil(bytes / line.length)) + (needle ? `The marker word is ${needle}.\n` : '');
};
const markdown = (title: string, body: string, type = 'note') => `---\ntitle: ${title}\ntype: ${type}\n---\n\n${body}`;

async function call(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: false });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async (input: { values: string[] }) => {
    providerTexts += input.values.length;
    return { embeddings: input.values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: input.values.length * 4 } };
  }) as never);
}, 60_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  providerTexts = 0;
});

describe('put_page receipts', () => {
  test('an ordinary page carries no size_state; a large page says its embedding is deferred', async () => {
    const small = await call('put_page', { slug: 'notes/small', content: markdown('Small', prose(2_000)) });
    expect(small.isError).toBe(false);
    expect(small.body.size_state).toBeUndefined();

    for (const setting of ['off', 'on']) {
      await engine.setConfig('pages.segmented_storage', setting);
      const large = await call('put_page', { slug: `notes/large-${setting}`, content: markdown('Large', prose(1_100_000)) });
      expect(large.isError).toBe(false);
      expect((await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [`notes/large-${setting}`]))[0]?.body_storage)
        .toBe(setting === 'on' ? 'segmented' : 'inline');
      // Wave B: a new segmented page publishes with its projection pending (chunked by the projection job), not empty.
      expect(large.body.chunk_skip_reason).toBeUndefined();
      if (setting === 'off') expect(large.body.chunks).toBeGreaterThan(100);
      else expect(large.body.chunks > 100 || large.body.projection === 'pending').toBe(true);
      expect((await engine.getChunks(`notes/large-${setting}`)).length).toBeGreaterThan(100);
      expect(large.body.size_state).toEqual({ embedding: 'deferred', reason: 'large_page', bytes: expect.any(Number) });
      expect(large.body.size_state.bytes).toBeGreaterThan(1024 ** 2);
    }
  }, 120_000);

  test('a page over the operator bytes_block keeps its chunks, says skipped: oversized, and its embedding effect calls no provider', async () => {
    await engine.setConfig('content_sanity.bytes_block', '500000');
    try {
      const context: OperationContext = { engine, sourceId: 'default', config: { engine: 'pglite' }, remote: false, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } } as OperationContext;
      const requestId = randomUUID();
      const receipt = await operationsByName.put_page.handler(context, { slug: 'chats/over-block', request_id: requestId,
        content: markdown('Over block', prose(600_000, 'quillfeatherbeacon')) }) as Record<string, any>;
      expect(receipt).toMatchObject({ state: 'committed', size_state: { embedding: 'skipped', reason: 'oversized' } });
      expect(receipt.chunks).toBeGreaterThan(50);
      expect(receipt.chunk_skip_reason).toBeUndefined();
      expect((await engine.searchKeyword('quillfeatherbeacon', { limit: 5 })).map(hit => hit.slug)).toEqual(['chats/over-block']);

      const embedded: string[] = [];
      await runPersistenceEffects(engine, { engine: 'pglite' }, { hostId: localHostId(), limit: 20,
        embedding: { signature: `${MODEL}:${DIMS}`, model: MODEL, embed: async texts => { embedded.push(...texts); return texts.map(() => new Float32Array(DIMS).fill(0.001)); } } });
      expect(embedded).toEqual([]);
      expect(providerTexts).toBe(0);
      const effects = await engine.executeRaw<{ state: string; outcome: Record<string, unknown> | null }>(`SELECT e.state, e.outcome FROM persistence_effects e
        JOIN persistence_requests r ON r.id = e.request_id WHERE r.request_id = $1::uuid AND e.kind = 'embedding'`, [requestId]);
      for (const effect of effects) expect(effect).toEqual({ state: 'committed', outcome: { embedding: 'skipped', reason: 'embed_skip' } });
      const chunks = await engine.getChunks('chats/over-block');
      expect(chunks.every(chunk => chunk.embedding == null && chunk.embedded_at == null)).toBe(true);
    } finally {
      await engine.unsetConfig('content_sanity.bytes_block');
    }
  }, 120_000);
});

describe('embed_skip pages are chunked and never embedded', () => {
  test('an explicit slug embed (as sync runs after an incremental import) leaves an embed_skip page keyword-only', async () => {
    await engine.setConfig('content_sanity.bytes_block', '500000');
    try {
      await importFromContent(engine, 'chats/slug-embed', markdown('Slug embed', prose(600_000)), { noEmbed: true });
      expect((await engine.getChunks('chats/slug-embed')).length).toBeGreaterThan(50);
      await runEmbedCore(engine, { slugs: ['chats/slug-embed'], quiet: true });
      expect(providerTexts).toBe(0);
      expect((await engine.getChunks('chats/slug-embed')).every(chunk => chunk.embedding == null)).toBe(true);
      await runEmbedCore(engine, { stale: true, quiet: true });
      expect(providerTexts).toBe(0);
    } finally {
      await engine.unsetConfig('content_sanity.bytes_block');
    }
  }, 120_000);
});

describe('remember receipts', () => {
  test('a fact appended to a large entity page carries the page size_state; one on an ordinary page carries none', async () => {
    for (const setting of ['off', 'on']) {
      await engine.setConfig('pages.segmented_storage', setting);
      const slug = `people/alice-example-${setting}`;
      expect((await call('put_page', { slug, content: markdown('Alice Example', prose(1_100_000), 'person') })).isError).toBe(false);
      const large = await call('remember', { fact: 'Alice Example prefers async standups.', provenance: 'test', entity: slug });
      expect(large.isError).toBe(false);
      expect(large.body.size_state).toEqual({ embedding: 'deferred', reason: 'large_page', bytes: expect.any(Number) });
    }

    expect((await call('put_page', { slug: 'people/bob-example', content: markdown('Bob Example', 'A person.\n', 'person') })).isError).toBe(false);
    const small = await call('remember', { fact: 'Bob Example lives in Porto.', provenance: 'test', entity: 'people/bob-example' });
    expect(small.isError).toBe(false);
    expect(small.body.size_state).toBeUndefined();
  }, 120_000);
});

describe('sync receipts', () => {
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  function repo(): { dir: string; root: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-6722-sync-')); dirs.push(dir);
    const root = join(dir, 'brain'); mkdirSync(join(root, 'notes'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    writeFileSync(join(root, 'notes/small.md'), markdown('Small', prose(2_000)));
    writeFileSync(join(root, 'notes/big.md'), markdown('Big', prose(1_100_000)));
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'add notes');
    return { dir, root };
  }
  const expected = (path?: string) => ({ total: 1, pages: [{ slug: 'notes/big', ...(path ? { path } : {}), embedding: 'deferred' as const, reason: 'large_page', bytes: expect.any(Number) }] });

  test('a legacy sync lists the large page in size_states on the first (full) and an incremental run, and the output names it', async () => {
    const { dir, root } = repo();
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['legacy-6722', root]);
      const first = await performSync(engine, { repoPath: root, sourceId: 'legacy-6722', noPull: true, noEmbed: true });
      expect(first.status).toBe('first_sync');
      expect(first.size_states).toEqual(expected());
      expect(sizeStateLines(first.size_states).join('\n')).toContain('notes/big');

      writeFileSync(join(root, 'notes/big.md'), markdown('Big', prose(1_200_000)));
      writeFileSync(join(root, 'notes/small.md'), markdown('Small', prose(3_000)));
      git(root, 'commit', '-qam', 'grow notes');
      const next = await performSync(engine, { repoPath: root, sourceId: 'legacy-6722', noPull: true, noEmbed: true });
      expect(next.status).toBe('synced');
      expect(next.size_states).toEqual(expected());
      expect(next.size_states!.pages[0]!.bytes).toBeGreaterThan(1_200_000);
    });
  }, 120_000);

  test('a managed sync carries each committed page size_state into size_states', async () => {
    const { dir, root } = repo();
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['managed-6722', root]);
      await claimWorktree(engine, 'managed-6722', root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        const result = await performSync(engine, { repoPath: root, sourceId: 'managed-6722', noPull: true, noEmbed: true });
        expect(result.status).not.toBe('blocked_by_failures');
        expect(result.size_states).toEqual(expected('notes/big.md'));
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    });
  }, 120_000);
});
